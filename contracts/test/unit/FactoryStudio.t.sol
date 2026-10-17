// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IKeyframeEscrowFactory as IF} from "../../src/interfaces/IKeyframeEscrowFactory.sol";
import {KeyframeBase} from "../utils/KeyframeBase.sol";
import {ERC1271Wallet, PlainDelegate} from "../utils/Mocks.sol";

contract FactoryStudioTest is KeyframeBase {
    uint32 internal constant RW = 1 days;

    function setUp() public {
        vm.warp(1_790_000_000);
        _deployLocal();
    }

    // ───────────────────────────── deliver ─────────────────────────────

    function test_deliver_recordsDelivery() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        bytes32 h = _open(t);
        vm.expectEmit(address(factory));
        emit IF.Delivered(h, MANIFEST);
        vm.prank(seller);
        factory.deliver(t, MANIFEST);
        IF.OrderView memory v = factory.order(h);
        assertEq(uint8(v.status), uint8(IF.Status.Delivered));
        assertEq(v.deliveredAt, block.timestamp);
        assertEq(v.manifestHash, MANIFEST);
        assertEq(_e(t).code.length, 0, "delivery moves no funds");
    }

    function test_deliver_atDeadlineInclusive() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        _open(t);
        vm.warp(t.deadline);
        vm.prank(operator);
        factory.deliver(t, MANIFEST);
    }

    function test_deliver_revert_notSellerSide() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        _open(t);
        vm.prank(buyer);
        vm.expectRevert(IF.NotAuthorized.selector);
        factory.deliver(t, MANIFEST);
    }

    function test_deliver_revert_instantTerms() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.Open)));
        factory.deliver(t, MANIFEST);
    }

    function test_deliver_revert_unregisteredOrTwice() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.None)));
        factory.deliver(t, MANIFEST);
        _openDelivered(t);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.Delivered)));
        factory.deliver(t, MANIFEST);
    }

    function test_deliver_revert_tooLate() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        _open(t);
        vm.warp(t.deadline + 1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.TooLate.selector, t.deadline));
        factory.deliver(t, MANIFEST);
    }

    function test_deliver_honoursNonZeroContentHash() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        t.contentHash = MANIFEST;
        _open(t);
        vm.prank(operator);
        vm.expectRevert(IF.ManifestMismatch.selector);
        factory.deliver(t, keccak256("other"));
        vm.prank(operator);
        factory.deliver(t, MANIFEST);
    }

    function test_deliver_revert_underfunded() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        _open(t);
        deal(usdc, _e(t), 1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.Underfunded.selector, 1, 25_000_000));
        factory.deliver(t, MANIFEST);
    }

    // ───────────────────────────── decide ─────────────────────────────

    function test_decide_accept() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        bytes32 h = _openDelivered(t);
        vm.expectEmit(address(factory));
        emit IF.Decided(h, true, 0);
        vm.prank(buyer);
        factory.decide(t, true);
        IF.OrderView memory v = factory.order(h);
        assertTrue(v.accepted);
        assertEq(uint8(v.status), uint8(IF.Status.Delivered));
        vm.prank(buyer);
        factory.decide(t, true); // idempotent
    }

    function test_decide_rejectPaysKillFee() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        bytes32 h = _openDelivered(t);
        vm.expectEmit(address(factory));
        emit IF.Decided(h, false, 5_000_000);
        vm.prank(buyer);
        factory.decide(t, false);
        assertEq(_bal(seller), 5_000_000);
        assertEq(_bal(buyer), 20_000_000);
        IF.OrderView memory v = factory.order(h);
        assertEq(uint8(v.status), uint8(IF.Status.Rejected));
        assertEq(v.toSeller, 5_000_000);
        assertEq(v.toBuyer, 20_000_000);
        assertEq(v.key, bytes32(0), "key never revealed on reject");
    }

    function test_decide_rejectZeroKillFee() public {
        IF.Terms memory t = _studio(25_000_000, RW, 0);
        _openDelivered(t);
        vm.prank(buyer);
        factory.decide(t, false);
        assertEq(_bal(seller), 0);
        assertEq(_bal(buyer), 25_000_000);
    }

    function test_decide_rejectFeeCappedByBalance() public {
        IF.Terms memory t = _studio(25_000_000, RW, 5000);
        _openDelivered(t);
        deal(usdc, _e(t), 1000); // not reachable via the protocol
        vm.prank(buyer);
        factory.decide(t, false);
        assertEq(_bal(seller), 1000);
        assertEq(_bal(buyer), 0);
    }

    function test_decide_revert_notBuyer() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        _openDelivered(t);
        vm.prank(operator);
        vm.expectRevert(IF.NotAuthorized.selector);
        factory.decide(t, false);
    }

    function test_decide_revert_notDelivered() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        _open(t);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.Open)));
        factory.decide(t, false);
    }

    function test_decide_revert_afterWindow() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        _openDelivered(t);
        uint256 reviewEnd = block.timestamp + RW;
        vm.warp(reviewEnd);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(IF.TooLate.selector, reviewEnd));
        factory.decide(t, false);
    }

    function test_decide_revert_rejectAfterAccept() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        _openDelivered(t);
        vm.startPrank(buyer);
        factory.decide(t, true);
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.Delivered)));
        factory.decide(t, false);
        vm.stopPrank();
    }

    // ───────────────────────────── decideBySig ─────────────────────────────

    function test_decideBySig_ecdsaRejectRelayedByAnyone() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        bytes32 h = _openDelivered(t);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _signDecision(buyerPk, h, false, dl);
        vm.prank(keeper);
        factory.decideBySig(t, false, dl, sig);
        assertEq(uint8(_status(t)), uint8(IF.Status.Rejected));
        // Replay is harmless: terminal state.
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.Rejected)));
        factory.decideBySig(t, false, dl, sig);
    }

    function test_decideBySig_accept() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        bytes32 h = _openDelivered(t);
        uint256 dl = block.timestamp + 1 hours;
        factory.decideBySig(t, true, dl, _signDecision(buyerPk, h, true, dl));
        assertTrue(factory.order(h).accepted);
    }

    function test_decideBySig_atDeadlineInclusive() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        bytes32 h = _openDelivered(t);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _signDecision(buyerPk, h, false, dl);
        vm.warp(dl);
        factory.decideBySig(t, false, dl, sig);
    }

    function test_decideBySig_revert_expired() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        bytes32 h = _openDelivered(t);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _signDecision(buyerPk, h, false, dl);
        vm.warp(dl + 1);
        vm.expectRevert(IF.SignatureExpired.selector);
        factory.decideBySig(t, false, dl, sig);
    }

    function test_decideBySig_revert_wrongSigner() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        bytes32 h = _openDelivered(t);
        uint256 dl = block.timestamp + 1 hours;
        (, uint256 pk) = makeAddrAndKey("operator-key");
        vm.expectRevert(IF.BadSignature.selector);
        factory.decideBySig(t, false, dl, _signDecision(pk, h, false, dl));
    }

    function test_decideBySig_revert_flagNotSigned() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        bytes32 h = _openDelivered(t);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory acceptSig = _signDecision(buyerPk, h, true, dl);
        vm.expectRevert(IF.BadSignature.selector);
        factory.decideBySig(t, false, dl, acceptSig);
        vm.expectRevert(IF.BadSignature.selector);
        factory.decideBySig(t, true, dl + 1, acceptSig);
    }

    function test_decideBySig_revert_malformed() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        _openDelivered(t);
        vm.expectRevert(IF.BadSignature.selector);
        factory.decideBySig(t, false, block.timestamp, hex"1234");
        vm.expectRevert(IF.BadSignature.selector);
        factory.decideBySig(t, false, block.timestamp, new bytes(65));
    }

    function test_decideBySig_revert_highS() public {
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        bytes32 h = _openDelivered(t);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _signDecision(buyerPk, h, false, dl);
        (bytes32 r, bytes32 s, uint8 v) = (bytes32(_slice(sig, 0)), bytes32(_slice(sig, 32)), uint8(sig[64]));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory malleated = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(IF.BadSignature.selector);
        factory.decideBySig(t, false, dl, malleated);
    }

    function test_decideBySig_erc1271ContractBuyer() public {
        (address owner, uint256 ownerPk) = makeAddrAndKey("wallet-owner");
        address wallet = address(new ERC1271Wallet(owner));
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        t.buyer = wallet;
        bytes32 h = _openDelivered(t);
        uint256 dl = block.timestamp + 1 hours;
        // ECDSA recovers `owner` != buyer, so the ERC-1271 path decides.
        factory.decideBySig(t, false, dl, _signDecision(ownerPk, h, false, dl));
        assertEq(_bal(wallet), 20_000_000);
    }

    function test_decideBySig_7702DelegatedBuyerSignsWithEcdsa() public {
        // The buyer EOA delegates to a contract with no ERC-1271: it has code, but ECDSA must still be accepted.
        PlainDelegate impl = new PlainDelegate();
        vm.signAndAttachDelegation(address(impl), buyerPk);
        assertEq(buyer.code, abi.encodePacked(hex"ef0100", address(impl)));
        IF.Terms memory t = _studio(25_000_000, RW, 2000);
        bytes32 h = _openDelivered(t);
        uint256 dl = block.timestamp + 1 hours;
        factory.decideBySig(t, false, dl, _signDecision(buyerPk, h, false, dl));
        assertEq(uint8(_status(t)), uint8(IF.Status.Rejected));
        assertEq(_bal(buyer), 20_000_000);
    }

    function _slice(bytes memory b, uint256 offset) private pure returns (uint256 word) {
        assembly ("memory-safe") {
            word := mload(add(add(b, 0x20), offset))
        }
    }
}

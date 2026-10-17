// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IKeyframeEscrowFactory as IF} from "../../src/interfaces/IKeyframeEscrowFactory.sol";
import {KeyframeBase} from "../utils/KeyframeBase.sol";
import {MockUSDC} from "../utils/MockUSDC.sol";

contract FactoryReleaseTest is KeyframeBase {
    function setUp() public {
        vm.warp(1_790_000_000);
        _deployLocal();
    }

    // ───────────────────────────── Instant ─────────────────────────────

    function test_instant_releaseFullCharge() public {
        IF.Terms memory t = _instant(4_000_000);
        bytes32 h = _open(t);
        address e = _e(t);

        vm.expectEmit(address(factory));
        emit IF.Released(h, KEY, MANIFEST, 4_000_000, 0);
        vm.prank(operator);
        factory.release(t, KEY, 4_000_000, MANIFEST);

        assertEq(_bal(seller), 4_000_000);
        assertEq(_bal(e), 0);
        IF.OrderView memory v = factory.order(h);
        assertEq(uint8(v.status), uint8(IF.Status.Released));
        assertEq(v.key, KEY);
        assertEq(v.manifestHash, MANIFEST);
        assertEq(v.toSeller, 4_000_000);
        assertEq(v.toBuyer, 0);
        assertEq(v.finalAt, block.timestamp);
        assertGt(e.code.length, 0);
    }

    function test_instant_releaseBySeller() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.prank(seller);
        factory.release(t, KEY, 1_000_000, MANIFEST);
        assertEq(_bal(seller), 1_000_000);
    }

    function test_instant_uptoChangeGoesToBuyer() public {
        IF.Terms memory t = _instant(5_000_000);
        _open(t);
        vm.prank(operator);
        factory.release(t, KEY, 3_250_000, MANIFEST);
        assertEq(_bal(seller), 3_250_000);
        assertEq(_bal(buyer), 1_750_000);
    }

    function test_instant_zeroChargeRefundsEverything() public {
        IF.Terms memory t = _instant(1_000_000);
        bytes32 h = _open(t);
        vm.prank(operator);
        factory.release(t, KEY, 0, MANIFEST);
        assertEq(_bal(seller), 0);
        assertEq(_bal(buyer), 1_000_000);
        assertEq(factory.order(h).key, KEY);
    }

    function test_instant_duplicateFundingReturnedToBuyer() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        _fundEscrow(t, 1_000_000); // second payment
        vm.prank(operator);
        factory.release(t, KEY, 1_000_000, MANIFEST);
        assertEq(_bal(seller), 1_000_000);
        assertEq(_bal(buyer), 1_000_000);
    }

    function test_instant_slaDecay() public {
        IF.Terms memory t = _instant(4_000_000);
        t.dueAt = uint64(block.timestamp + 10 minutes);
        t.deadline = uint64(block.timestamp + 30 minutes);
        t.slaFloorBps = 5000;
        _open(t);
        vm.warp(t.dueAt + 10 minutes); // halfway through decay: 4.0 -> 3.0
        uint256 max = factory.payoutAt(t, block.timestamp);
        assertEq(max, 3_000_000);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.ChargeTooHigh.selector, max));
        factory.release(t, KEY, max + 1, MANIFEST);
        vm.prank(operator);
        factory.release(t, KEY, max, MANIFEST);
        assertEq(_bal(seller), 3_000_000);
        assertEq(_bal(buyer), 1_000_000);
    }

    function test_instant_releaseAtDeadlineInclusive() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.warp(t.deadline);
        vm.prank(operator);
        factory.release(t, KEY, 1_000_000, MANIFEST);
    }

    function test_instant_anyManifestWhenNoContentHash() public {
        IF.Terms memory t = _instant(1_000_000);
        t.contentHash = bytes32(0);
        bytes32 h = _open(t);
        vm.prank(operator);
        factory.release(t, KEY, 1_000_000, keccak256("whatever"));
        assertEq(factory.order(h).manifestHash, keccak256("whatever"));
    }

    function test_instant_revert_thirdPartyWithKey() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.prank(attacker);
        vm.expectRevert(IF.NotAuthorized.selector);
        factory.release(t, KEY, 1_000_000, MANIFEST);
        vm.prank(buyer);
        vm.expectRevert(IF.NotAuthorized.selector);
        factory.release(t, KEY, 0, MANIFEST);
    }

    function test_instant_revert_badKey() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.prank(operator);
        vm.expectRevert(IF.BadKey.selector);
        factory.release(t, bytes32(uint256(KEY) ^ 1), 1_000_000, MANIFEST);
    }

    function test_instant_revert_tooLate() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.warp(t.deadline + 1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.TooLate.selector, t.deadline));
        factory.release(t, KEY, 1_000_000, MANIFEST);
    }

    function test_instant_revert_manifestMismatch() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.prank(operator);
        vm.expectRevert(IF.ManifestMismatch.selector);
        factory.release(t, KEY, 1_000_000, keccak256("other file"));
    }

    function test_instant_revert_unregistered() public {
        IF.Terms memory t = _instant(1_000_000);
        _fundEscrow(t, t.amount);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.None)));
        factory.release(t, KEY, 1_000_000, MANIFEST);
    }

    function test_instant_revert_doubleRelease() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.startPrank(operator);
        factory.release(t, KEY, 1_000_000, MANIFEST);
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.Released)));
        factory.release(t, KEY, 1_000_000, MANIFEST);
        vm.stopPrank();
    }

    function test_instant_revert_underfunded() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        deal(usdc, _e(t), 10); // impossible through the protocol; exercises the guard
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.Underfunded.selector, 10, 1_000_000));
        factory.release(t, KEY, 10, MANIFEST);
    }

    function test_release_revert_invalidTerms() public {
        IF.Terms memory t = _instant(1_000_000);
        t.seller = attacker; // a seller other than SELLER can never be paid
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IF.BadTerms.selector, uint8(3)));
        factory.release(t, KEY, 1_000_000, MANIFEST);
    }

    function test_instant_blacklistedSellerCannotBlockRefund() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        MockUSDC(usdc).blacklist(seller);
        vm.prank(operator);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        factory.release(t, KEY, 1_000_000, MANIFEST);
        vm.warp(t.deadline + 1);
        vm.prank(attacker);
        factory.refund(t);
        assertEq(_bal(buyer), 1_000_000);
    }

    // ───────────────────────────── Studio ─────────────────────────────

    function test_studio_releaseAfterAccept() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        bytes32 h = _openDelivered(t);
        vm.prank(buyer);
        factory.decide(t, true);
        vm.expectEmit(address(factory));
        emit IF.Released(h, KEY, MANIFEST, 25_000_000, 0);
        vm.prank(operator);
        factory.release(t, KEY, 25_000_000, MANIFEST);
        assertEq(_bal(seller), 25_000_000);
        assertTrue(factory.order(h).accepted);
    }

    function test_studio_releaseAfterSilentReview() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        _openDelivered(t);
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        factory.release(t, KEY, 25_000_000, MANIFEST);
        assertEq(_bal(seller), 25_000_000);
    }

    function test_studio_releaseAtGraceEndInclusive() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        _openDelivered(t);
        vm.warp(block.timestamp + 1 days + 3 days);
        vm.prank(operator);
        factory.release(t, KEY, 25_000_000, MANIFEST);
    }

    function test_studio_slaMeasuredAtDelivery() public {
        IF.Terms memory t = _studio(10_000_000, 1 days, 0);
        t.dueAt = uint64(block.timestamp + 1 days);
        t.deadline = uint64(block.timestamp + 3 days);
        t.slaFloorBps = 0;
        _open(t);
        vm.warp(t.dueAt + 1 days); // delivered halfway through decay
        vm.prank(operator);
        factory.deliver(t, MANIFEST);
        vm.warp(block.timestamp + 1 days + 1 days); // later release does not decay further
        uint256 max = factory.payoutAt(t, block.timestamp - 2 days);
        assertEq(max, 5_000_000);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.ChargeTooHigh.selector, 5_000_000));
        factory.release(t, KEY, 5_000_001, MANIFEST);
        vm.prank(operator);
        factory.release(t, KEY, 5_000_000, MANIFEST);
        assertEq(_bal(seller), 5_000_000);
        assertEq(_bal(buyer), 5_000_000);
    }

    function test_studio_revert_tooEarly() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        _openDelivered(t);
        uint256 reviewEnd = block.timestamp + 1 days;
        vm.warp(reviewEnd - 1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.TooEarly.selector, reviewEnd));
        factory.release(t, KEY, 25_000_000, MANIFEST);
    }

    function test_studio_revert_tooLateAfterGrace() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        _openDelivered(t);
        uint256 graceEnd = block.timestamp + 1 days + 3 days;
        vm.warp(graceEnd + 1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.TooLate.selector, graceEnd));
        factory.release(t, KEY, 25_000_000, MANIFEST);
    }

    function test_studio_revert_manifestMustMatchDelivered() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        _openDelivered(t);
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        vm.expectRevert(IF.ManifestMismatch.selector);
        factory.release(t, KEY, 25_000_000, keccak256("swapped"));
    }

    function test_studio_revert_releaseBeforeDelivery() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        _open(t);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.Open)));
        factory.release(t, KEY, 25_000_000, MANIFEST);
    }

    function test_studio_revert_badKey() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        _openDelivered(t);
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        vm.expectRevert(IF.BadKey.selector);
        factory.release(t, bytes32(0), 25_000_000, MANIFEST);
    }
}

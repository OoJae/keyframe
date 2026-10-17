// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KeyframeEscrowFactory} from "../../src/KeyframeEscrowFactory.sol";
import {IKeyframeEscrowFactory} from "../../src/interfaces/IKeyframeEscrowFactory.sol";
import {TermsLib} from "../../src/libraries/TermsLib.sol";
import {KeyframeBase} from "../utils/KeyframeBase.sol";
import {stdError} from "forge-std/StdError.sol";

contract FactoryViewsTest is KeyframeBase {
    string internal constant FROZEN_TERMS_TYPE =
        "Terms(address buyer,address seller,address operator,address token,uint256 amount,uint64 dueAt,uint64 deadline,uint32 reviewWindow,uint16 slaFloorBps,uint16 killFeeBps,bytes32 keyHash,bytes32 specHash,bytes32 contentHash,bytes32 salt)";

    function setUp() public {
        vm.warp(1_790_000_000);
        _deployLocal();
    }

    function test_constants() public view {
        assertEq(factory.USDC(), usdc);
        assertEq(factory.SELLER(), seller);
        assertEq(factory.MIN_AMOUNT(), 100_000);
        assertEq(factory.MAX_AMOUNT(), 50_000_000);
        assertEq(factory.MAX_LIFETIME(), 30 days);
        assertEq(factory.RELEASE_GRACE(), 3 days);
        assertEq(factory.MAX_REVIEW_WINDOW(), 14 days);
        assertEq(factory.MAX_KILL_FEE_BPS(), 5000);
        assertEq(factory.registryLength(), 0);
        assertEq(factory.scanFrom(), 0);
    }

    function test_vaultImpl_isFactoryNonce1() public view {
        assertEq(factory.VAULT_IMPL(), vm.computeCreateAddress(address(factory), 1));
        assertEq(factory.VAULT_IMPL(), TermsLib.vaultImplOf(address(factory)));
        assertGt(factory.VAULT_IMPL().code.length, 0);
        // Factory performed exactly one CREATE (nonce 1 -> 2).
        assertEq(vm.getNonce(address(factory)), 2);
    }

    function test_constructor_rejectsCodelessUsdc() public {
        vm.expectRevert(abi.encodeWithSelector(IKeyframeEscrowFactory.BadTerms.selector, uint8(1)));
        new KeyframeEscrowFactory(makeAddr("eoa"), seller);
    }

    function test_constructor_rejectsZeroSeller() public {
        vm.expectRevert(abi.encodeWithSelector(IKeyframeEscrowFactory.BadTerms.selector, uint8(3)));
        new KeyframeEscrowFactory(usdc, address(0));
    }

    function test_eip712Domain_erc5267() public view {
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = factory.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, "Keyframe Escrow");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(factory));
        assertEq(salt, bytes32(0));
        assertEq(extensions.length, 0);
    }

    function test_typehashes_matchFrozenStrings() public pure {
        assertEq(TermsLib.TERMS_TYPEHASH, keccak256(bytes(FROZEN_TERMS_TYPE)));
        assertEq(TermsLib.DECISION_TYPEHASH, keccak256("Decision(bytes32 termsHash,bool accept,uint256 deadline)"));
    }

    function test_hashTerms_matchesFieldByFieldEncoding() public view {
        IKeyframeEscrowFactory.Terms memory t = _studio(4_000_000, 1 days, 2000);
        t.dueAt = uint64(block.timestamp + 1 hours);
        t.slaFloorBps = 5000;
        bytes memory head = abi.encode(
            keccak256(bytes(FROZEN_TERMS_TYPE)), t.buyer, t.seller, t.operator, t.token, t.amount, t.dueAt, t.deadline
        );
        bytes memory tail =
            abi.encode(t.reviewWindow, t.slaFloorBps, t.killFeeBps, t.keyHash, t.specHash, t.contentHash, t.salt);
        bytes32 structHash = keccak256(bytes.concat(head, tail));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Keyframe Escrow"),
                keccak256("1"),
                block.chainid,
                address(factory)
            )
        );
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        assertEq(factory.hashTerms(t), expected);
        assertEq(TermsLib.digest(t, address(factory), block.chainid), expected);
    }

    function test_hashTerms_bindsSaltAndChain() public {
        IKeyframeEscrowFactory.Terms memory t = _instant(1_000_000);
        bytes32 h = factory.hashTerms(t);
        t.salt = bytes32(uint256(t.salt) ^ 1);
        assertNotEq(factory.hashTerms(t), h);
        t.salt = bytes32(uint256(t.salt) ^ 1);
        assertEq(factory.hashTerms(t), h);
        vm.chainId(8453);
        assertNotEq(factory.hashTerms(t), h);
    }

    function test_escrowOf_matchesFrozenCreate2Formula() public view {
        bytes32 h = factory.hashTerms(_instant(1_000_000));
        bytes memory initCode = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", factory.VAULT_IMPL(), hex"5af43d82803e903d91602b57fd5bf3"
        );
        address expected = vm.computeCreate2Address(h, keccak256(initCode), address(factory));
        assertEq(factory.escrowOf(h), expected);
        assertEq(TermsLib.escrowAt(address(factory), h), expected);
    }

    function test_escrow_codelessUntilFirstOutflow_thenCanonicalClone() public {
        IKeyframeEscrowFactory.Terms memory t = _instant(1_000_000);
        address e = _e(t);
        _open(t);
        assertEq(e.code.length, 0, "codeless while funded");
        vm.prank(operator);
        factory.release(t, KEY, t.amount, MANIFEST);
        assertEq(
            e.code,
            abi.encodePacked(hex"363d3d373d3d3d363d73", factory.VAULT_IMPL(), hex"5af43d82803e903d91602b57fd5bf3")
        );
    }

    function test_order_defaultIsNone() public view {
        IKeyframeEscrowFactory.OrderView memory v = factory.order(bytes32(uint256(123)));
        assertEq(uint8(v.status), 0);
        assertEq(v.buyer, address(0));
        assertEq(v.openedAt, 0);
        assertEq(v.toSeller + v.toBuyer, 0);
    }

    function test_payoutAt_examples() public view {
        IKeyframeEscrowFactory.Terms memory t = _instant(1_000_000);
        t.dueAt = 1000;
        t.deadline = 2000;
        t.slaFloorBps = 2500;
        assertEq(factory.payoutAt(t, 0), 1_000_000);
        assertEq(factory.payoutAt(t, 1000), 1_000_000);
        assertEq(factory.payoutAt(t, 1001), 1_000_000 - 750_000 * 1 / 1000);
        assertEq(factory.payoutAt(t, 1500), 625_000);
        assertEq(factory.payoutAt(t, 2000), 250_000);
        assertEq(factory.payoutAt(t, type(uint256).max), 250_000);
        t.dueAt = 0;
        assertEq(factory.payoutAt(t, type(uint256).max), 1_000_000, "dueAt 0 = no decay");
    }

    function test_payoutAt_absurdAmountPanicsLikeTheFormula() public {
        IKeyframeEscrowFactory.Terms memory t = _instant(1_000_000);
        t.amount = type(uint256).max;
        t.dueAt = 1;
        t.deadline = 3;
        t.slaFloorBps = 5000;
        vm.expectRevert(stdError.arithmeticError);
        factory.payoutAt(t, 2);
    }

    function test_noEthEntryPoints() public {
        vm.deal(attacker, 1 ether);
        vm.startPrank(attacker);
        (bool ok,) = address(factory).call{value: 1}("");
        assertFalse(ok, "factory accepts ETH");
        (ok,) = factory.VAULT_IMPL().call{value: 1}("");
        assertFalse(ok, "impl accepts ETH");
        vm.stopPrank();
    }
}

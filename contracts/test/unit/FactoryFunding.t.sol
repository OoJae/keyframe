// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IKeyframeEscrowFactory as IF} from "../../src/interfaces/IKeyframeEscrowFactory.sol";
import {KeyframeBase} from "../utils/KeyframeBase.sol";
import {MockUSDC} from "../utils/MockUSDC.sol";
import {ERC1271Wallet} from "../utils/Mocks.sol";

contract FactoryFundingTest is KeyframeBase {
    function setUp() public {
        vm.warp(1_790_000_000);
        _deployLocal();
    }

    function _badTerms(uint8 code) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IF.BadTerms.selector, code);
    }

    // ───────────────────────────── register ─────────────────────────────

    function test_register_opens() public {
        IF.Terms memory t = _instant(4_000_000);
        bytes32 h = _h(t);
        address e = _e(t);
        _fundEscrow(t, t.amount);

        vm.expectEmit(address(factory));
        emit IF.Opened(h, e, buyer, t);
        vm.prank(attacker); // permissionless
        factory.register(t);

        IF.OrderView memory v = factory.order(h);
        assertEq(uint8(v.status), uint8(IF.Status.Open));
        assertEq(v.buyer, buyer);
        assertEq(v.deadline, t.deadline);
        assertEq(v.reviewWindow, 0);
        assertEq(v.openedAt, block.timestamp);
        assertEq(v.deliveredAt, 0);
        assertEq(v.finalAt, 0);
        assertEq(factory.registryLength(), 1);
        assertEq(e.code.length, 0, "registration deploys nothing");
    }

    function test_register_boundaries() public {
        IF.Terms memory t = _instant(100_000);
        t.deadline = uint64(block.timestamp + 30 days);
        _open(t);
        t = _instant(50_000_000);
        t.salt = bytes32(uint256(1));
        t.deadline = uint64(block.timestamp + 1);
        t.dueAt = uint64(block.timestamp);
        t.slaFloorBps = 0;
        t.killFeeBps = factory.MAX_KILL_FEE_BPS();
        t.reviewWindow = factory.MAX_REVIEW_WINDOW();
        t.contentHash = bytes32(0);
        _open(t);
        assertEq(factory.registryLength(), 2);
    }

    function test_register_overfundedIsFine() public {
        IF.Terms memory t = _instant(1_000_000);
        _fundEscrow(t, 3_000_000);
        factory.register(t);
        assertEq(uint8(_status(t)), uint8(IF.Status.Open));
    }

    function test_register_revert_token() public {
        IF.Terms memory t = _instant(1_000_000);
        t.token = makeAddr("other");
        vm.expectRevert(_badTerms(1));
        factory.register(t);
    }

    function test_register_revert_amountLow() public {
        IF.Terms memory t = _instant(99_999);
        vm.expectRevert(_badTerms(2));
        factory.register(t);
    }

    function test_register_revert_amountHigh() public {
        IF.Terms memory t = _instant(50_000_001);
        vm.expectRevert(_badTerms(2));
        factory.register(t);
    }

    function test_register_revert_seller() public {
        IF.Terms memory t = _instant(1_000_000);
        t.seller = attacker;
        vm.expectRevert(_badTerms(3));
        factory.register(t);
    }

    function test_register_revert_buyerZero() public {
        IF.Terms memory t = _instant(1_000_000);
        t.buyer = address(0);
        vm.expectRevert(_badTerms(4));
        factory.register(t);
    }

    function test_register_revert_slaFloorBps() public {
        IF.Terms memory t = _instant(1_000_000);
        t.slaFloorBps = 10_001;
        vm.expectRevert(_badTerms(5));
        factory.register(t);
    }

    function test_register_revert_killFeeBps() public {
        IF.Terms memory t = _instant(1_000_000);
        t.killFeeBps = 10_001;
        vm.expectRevert(_badTerms(5));
        factory.register(t);
    }

    /// @dev Audit L2: the kill fee is capped on-chain at MAX_KILL_FEE_BPS (50%), for Instant and Studio Terms alike.
    function test_register_revert_killFeeAboveCap() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 5001);
        _fundEscrow(t, t.amount);
        vm.expectRevert(_badTerms(5));
        factory.register(t);
        t.killFeeBps = 5000; // a different T, so a different E
        _open(t);
        assertEq(uint8(_status(t)), uint8(IF.Status.Open));
    }

    /// @dev Audit L2: a Studio review window is capped at MAX_REVIEW_WINDOW (14 days); BadTerms(9) is additive to v1.
    function test_register_revert_reviewWindowAboveCap() public {
        IF.Terms memory t = _studio(10_000_000, 14 days + 1, 0);
        _fundEscrow(t, t.amount);
        vm.expectRevert(_badTerms(9));
        factory.register(t);
        t.reviewWindow = type(uint32).max; // the audit's ~136-year lock
        vm.expectRevert(_badTerms(9));
        factory.register(t);
        t.reviewWindow = 14 days;
        _open(t);
        assertEq(factory.order(_h(t)).reviewWindow, 14 days);
    }

    /// @dev Audit Info 1: refunds to the factory, VAULT_IMPL or USDC would be stranded, so such buyers are invalid.
    function test_register_revert_buyerIsProtocolContract() public {
        address[3] memory bad = [address(factory), factory.VAULT_IMPL(), usdc];
        for (uint256 i; i < bad.length; ++i) {
            IF.Terms memory t = _instant(1_000_000);
            t.buyer = bad[i];
            _fundEscrow(t, t.amount);
            vm.expectRevert(_badTerms(4));
            factory.register(t);
            vm.expectRevert(_badTerms(4));
            factory.fundWithAuthorization(t, 0, block.timestamp + 5 minutes, bytes32(i), "");
        }
    }

    /// @dev Audit M1: an already-blacklisted buyer could never be refunded, so it is rejected at registration, before
    ///      any EIP-3009 pull. A buyer blacklisted after registration is handled by the keeper skip (AuditRegressions).
    function test_register_revert_blacklistedBuyer() public {
        IF.Terms memory t = _instant(1_000_000);
        _fundEscrow(t, t.amount);
        _give(buyer, t.amount);
        MockUSDC(usdc).blacklist(buyer);
        vm.expectRevert(_badTerms(4));
        factory.register(t);
        bytes32 nonce = keccak256("n-bl");
        bytes memory sig = _authFor(t, nonce);
        vm.expectRevert(_badTerms(4));
        factory.fundWithAuthorization(t, 0, block.timestamp + 5 minutes, nonce, sig);
        assertFalse(MockUSDC(usdc).authorizationState(buyer, nonce), "no pull attempted");
        MockUSDC(usdc).unBlacklist(buyer);
        factory.register(t);
        assertEq(uint8(_status(t)), uint8(IF.Status.Open));
    }

    function test_register_revert_dueAtNotBeforeDeadline() public {
        IF.Terms memory t = _instant(1_000_000);
        t.dueAt = t.deadline;
        vm.expectRevert(_badTerms(6));
        factory.register(t);
    }

    function test_register_revert_deadlineNow() public {
        IF.Terms memory t = _instant(1_000_000);
        t.deadline = uint64(block.timestamp);
        vm.expectRevert(_badTerms(7));
        factory.register(t);
    }

    function test_register_revert_deadlineBeyondLifetime() public {
        IF.Terms memory t = _instant(1_000_000);
        t.deadline = uint64(block.timestamp + 30 days + 1);
        vm.expectRevert(_badTerms(7));
        factory.register(t);
    }

    function test_register_revert_operatorZero() public {
        IF.Terms memory t = _instant(1_000_000);
        t.operator = address(0);
        vm.expectRevert(_badTerms(8));
        factory.register(t);
    }

    function test_register_revert_underfunded() public {
        IF.Terms memory t = _instant(1_000_000);
        _fundEscrow(t, 999_999);
        vm.expectRevert(abi.encodeWithSelector(IF.Underfunded.selector, 999_999, 1_000_000));
        factory.register(t);
    }

    function test_register_revert_alreadyRegistered() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.expectRevert(IF.AlreadyRegistered.selector);
        factory.register(t);
    }

    function test_register_revert_afterTerminalUnregistered() public {
        IF.Terms memory t = _instant(1_000_000);
        vm.prank(operator);
        factory.cancel(t); // void before funding
        _fundEscrow(t, t.amount);
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.Cancelled)));
        factory.register(t);
    }

    function test_register_revert_terminalRegistered() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.prank(operator);
        factory.cancel(t);
        _fundEscrow(t, t.amount);
        vm.expectRevert(IF.AlreadyRegistered.selector);
        factory.register(t);
    }

    // ───────────────────────────── fundWithAuthorization ─────────────────────────────

    function test_fundWithAuthorization_pullsAndOpens() public {
        IF.Terms memory t = _instant(4_000_000);
        _give(buyer, 10_000_000);
        bytes32 h = _h(t);
        address e = _e(t);
        bytes32 nonce = keccak256("n1");
        bytes memory sig = _authFor(t, nonce);

        vm.expectEmit(address(factory));
        emit IF.Opened(h, e, buyer, t);
        vm.prank(keeper); // any relayer
        factory.fundWithAuthorization(t, 0, block.timestamp + 5 minutes, nonce, sig);

        assertEq(_bal(e), 4_000_000);
        assertEq(_bal(buyer), 6_000_000);
        assertEq(e.code.length, 0);
        assertTrue(MockUSDC(usdc).authorizationState(buyer, nonce));
        assertEq(uint8(_status(t)), uint8(IF.Status.Open));
    }

    function test_fundWithAuthorization_frontRunFallsThroughToRegister() public {
        IF.Terms memory t = _instant(4_000_000);
        _give(buyer, 4_000_000);
        bytes32 nonce = keccak256("n1");
        bytes memory sig = _authFor(t, nonce);
        // Someone else settles the authorization first; funds land at E because `to` is signed.
        vm.prank(attacker);
        MockUSDC(usdc).transferWithAuthorization(buyer, _e(t), t.amount, 0, block.timestamp + 5 minutes, nonce, sig);

        factory.fundWithAuthorization(t, 0, block.timestamp + 5 minutes, nonce, sig);
        assertEq(uint8(_status(t)), uint8(IF.Status.Open));
        assertEq(_bal(_e(t)), t.amount);
    }

    function test_fundWithAuthorization_usedNonceButUnfunded() public {
        IF.Terms memory t = _instant(4_000_000);
        _give(buyer, 4_000_000);
        bytes32 nonce = keccak256("n1");
        // The buyer spent this nonce on an unrelated authorization.
        bytes memory other = _signAuth(buyerPk, buyer, attacker, 1, block.timestamp + 1 hours, nonce);
        MockUSDC(usdc).transferWithAuthorization(buyer, attacker, 1, 0, block.timestamp + 1 hours, nonce, other);

        bytes memory sig = _authFor(t, nonce);
        vm.expectRevert(abi.encodeWithSelector(IF.Underfunded.selector, 0, t.amount));
        factory.fundWithAuthorization(t, 0, block.timestamp + 5 minutes, nonce, sig);
    }

    function test_fundWithAuthorization_bubblesInvalidSignature() public {
        IF.Terms memory t = _instant(4_000_000);
        _give(buyer, 4_000_000);
        bytes32 nonce = keccak256("n1");
        (, uint256 wrongPk) = makeAddrAndKey("not-buyer");
        bytes memory sig = _signAuth(wrongPk, buyer, _e(t), t.amount, block.timestamp + 5 minutes, nonce);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        factory.fundWithAuthorization(t, 0, block.timestamp + 5 minutes, nonce, sig);
    }

    function test_fundWithAuthorization_signatureBindsEscrow() public {
        IF.Terms memory t = _instant(4_000_000);
        _give(buyer, 4_000_000);
        bytes32 nonce = keccak256("n1");
        // Authorization signed for a different payee cannot be redirected into E.
        bytes memory sig = _signAuth(buyerPk, buyer, attacker, t.amount, block.timestamp + 5 minutes, nonce);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        factory.fundWithAuthorization(t, 0, block.timestamp + 5 minutes, nonce, sig);
    }

    function test_fundWithAuthorization_bubblesExpired() public {
        IF.Terms memory t = _instant(4_000_000);
        _give(buyer, 4_000_000);
        bytes32 nonce = keccak256("n1");
        uint256 validBefore = block.timestamp + 5 minutes;
        bytes memory sig = _signAuth(buyerPk, buyer, _e(t), t.amount, validBefore, nonce);
        vm.warp(validBefore);
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        factory.fundWithAuthorization(t, 0, validBefore, nonce, sig);
    }

    function test_fundWithAuthorization_validatesBeforePulling() public {
        IF.Terms memory t = _instant(4_000_000);
        t.seller = attacker;
        _give(buyer, 4_000_000);
        bytes memory sig = _authFor(t, keccak256("n1"));
        vm.expectRevert(_badTerms(3));
        factory.fundWithAuthorization(t, 0, block.timestamp + 5 minutes, keccak256("n1"), sig);
        assertEq(_bal(buyer), 4_000_000);
    }

    function test_fundWithAuthorization_revert_alreadyRegistered_noPull() public {
        IF.Terms memory t = _instant(4_000_000);
        _open(t);
        _give(buyer, 4_000_000);
        bytes32 nonce = keccak256("n2");
        bytes memory sig = _authFor(t, nonce);
        vm.expectRevert(IF.AlreadyRegistered.selector);
        factory.fundWithAuthorization(t, 0, block.timestamp + 5 minutes, nonce, sig);
        assertEq(_bal(buyer), 4_000_000);
        assertFalse(MockUSDC(usdc).authorizationState(buyer, nonce));
    }

    function test_fundWithAuthorization_contractBuyerViaErc1271() public {
        // FiatToken verifies a signer with code through ERC-1271.
        (address owner, uint256 ownerPk) = makeAddrAndKey("wallet-owner");
        address wallet = address(new ERC1271Wallet(owner));
        IF.Terms memory t = _instant(1_000_000);
        t.buyer = wallet;
        _give(wallet, 1_000_000);
        bytes32 nonce = keccak256("n1");
        bytes memory sig = _signAuth(ownerPk, wallet, _e(t), t.amount, block.timestamp + 5 minutes, nonce);
        factory.fundWithAuthorization(t, 0, block.timestamp + 5 minutes, nonce, sig);
        assertEq(uint8(_status(t)), uint8(IF.Status.Open));
    }
}

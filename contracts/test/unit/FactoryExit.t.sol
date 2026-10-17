// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KeyframeVault} from "../../src/KeyframeVault.sol";
import {IKeyframeEscrowFactory as IF} from "../../src/interfaces/IKeyframeEscrowFactory.sol";
import {KeyframeBase} from "../utils/KeyframeBase.sol";
import {MockUSDC} from "../utils/MockUSDC.sol";
import {JunkToken, ReentrantToken} from "../utils/Mocks.sol";

/// @notice cancel, refund, sweep, refundExpired / refundableCount, and the vault itself.
contract FactoryExitTest is KeyframeBase {
    function setUp() public {
        vm.warp(1_790_000_000);
        _deployLocal();
    }

    // ───────────────────────────── cancel ─────────────────────────────

    function test_cancel_unfundedUnregistered_deploysNothing() public {
        IF.Terms memory t = _instant(1_000_000);
        bytes32 h = _h(t);
        vm.expectEmit(address(factory));
        emit IF.Cancelled(h, 0);
        vm.prank(operator);
        factory.cancel(t);
        IF.OrderView memory v = factory.order(h);
        assertEq(uint8(v.status), uint8(IF.Status.Cancelled));
        assertEq(v.buyer, buyer);
        assertEq(v.deadline, t.deadline);
        assertEq(v.openedAt, 0);
        assertEq(v.finalAt, block.timestamp);
        assertEq(_e(t).code.length, 0);
        assertEq(factory.registryLength(), 0);
    }

    function test_cancel_fundedUnregistered() public {
        IF.Terms memory t = _instant(1_000_000);
        _fundEscrow(t, 1_500_000);
        vm.prank(seller);
        factory.cancel(t);
        assertEq(_bal(buyer), 1_500_000);
        assertEq(factory.order(_h(t)).toBuyer, 1_500_000);
    }

    function test_cancel_open() public {
        IF.Terms memory t = _instant(1_000_000);
        bytes32 h = _open(t);
        vm.expectEmit(address(factory));
        emit IF.Cancelled(h, 1_000_000);
        vm.prank(operator);
        factory.cancel(t);
        assertEq(_bal(buyer), 1_000_000);
    }

    function test_cancel_delivered() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        _openDelivered(t);
        vm.prank(operator);
        factory.cancel(t);
        assertEq(_bal(buyer), 25_000_000);
        assertEq(_bal(seller), 0);
    }

    function test_cancel_revert_notSellerSide() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.prank(buyer);
        vm.expectRevert(IF.NotAuthorized.selector);
        factory.cancel(t);
    }

    function test_cancel_revert_terminal() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.startPrank(operator);
        factory.release(t, KEY, 1_000_000, MANIFEST);
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.Released)));
        factory.cancel(t);
        vm.stopPrank();
    }

    function test_cancel_thenLateFundsSweptToBuyer() public {
        IF.Terms memory t = _instant(1_000_000);
        vm.prank(operator);
        factory.cancel(t);
        _fundEscrow(t, 1_000_000); // buyer pays a voided quote
        vm.expectEmit(address(factory));
        emit IF.Swept(_h(t), usdc, 1_000_000);
        vm.prank(attacker);
        factory.sweep(t, usdc);
        assertEq(_bal(buyer), 1_000_000);
    }

    // ───────────────────────────── refund ─────────────────────────────

    function test_refund_openAfterDeadlineByStranger() public {
        IF.Terms memory t = _instant(1_000_000);
        bytes32 h = _open(t);
        vm.warp(t.deadline + 1);
        vm.expectEmit(address(factory));
        emit IF.Refunded(h, 1_000_000);
        vm.prank(attacker);
        factory.refund(t);
        assertEq(_bal(buyer), 1_000_000);
        assertEq(uint8(_status(t)), uint8(IF.Status.Refunded));
    }

    function test_refund_revert_atDeadline() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.warp(t.deadline);
        vm.expectRevert(abi.encodeWithSelector(IF.TooEarly.selector, t.deadline));
        factory.refund(t);
    }

    function test_refund_unregisteredFunded() public {
        IF.Terms memory t = _instant(1_000_000);
        _fundEscrow(t, 700_000); // underfunded, never registered
        vm.warp(t.deadline + 1);
        factory.refund(t);
        assertEq(_bal(buyer), 700_000);
        assertEq(factory.order(_h(t)).buyer, buyer);
    }

    function test_refund_unregisteredEmpty_noClone() public {
        IF.Terms memory t = _instant(1_000_000);
        vm.warp(t.deadline + 1);
        factory.refund(t);
        assertEq(uint8(_status(t)), uint8(IF.Status.Refunded));
        assertEq(_e(t).code.length, 0);
    }

    function test_refund_anyTokenForUnregisteredTerms() public {
        JunkToken junk = new JunkToken();
        IF.Terms memory t = _instant(1_000_000);
        t.token = address(junk);
        t.seller = attacker; // invalid for payout, still refundable
        junk.mint(_e(t), 42);
        vm.warp(t.deadline + 1);
        factory.refund(t);
        assertEq(junk.balanceOf(buyer), 42);
    }

    function test_refund_ethTermsForPreDeployEth() public {
        IF.Terms memory t = _instant(1_000_000);
        t.token = address(0);
        vm.deal(_e(t), 1 ether);
        vm.warp(t.deadline + 1);
        factory.refund(t);
        assertEq(buyer.balance, 1 ether);
    }

    function test_refund_deliveredAfterGrace() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        _openDelivered(t);
        uint256 end = block.timestamp + 1 days + 3 days;
        vm.warp(end);
        vm.expectRevert(abi.encodeWithSelector(IF.TooEarly.selector, end));
        factory.refund(t);
        vm.warp(end + 1);
        factory.refund(t);
        assertEq(_bal(buyer), 25_000_000);
    }

    function test_refund_deliveredAcceptedButNeverReleased() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        _openDelivered(t);
        vm.prank(buyer);
        factory.decide(t, true);
        vm.warp(block.timestamp + 4 days + 1);
        factory.refund(t);
        assertEq(_bal(buyer), 25_000_000);
    }

    function test_refund_revert_terminal() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.warp(t.deadline + 1);
        factory.refund(t);
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.Refunded)));
        factory.refund(t);
    }

    function test_refund_blacklistedBuyerStaysPending() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        MockUSDC(usdc).blacklist(buyer);
        vm.warp(t.deadline + 1);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        factory.refund(t);
        assertEq(uint8(_status(t)), uint8(IF.Status.Open));
        MockUSDC(usdc).unBlacklist(buyer);
        factory.refund(t);
        assertEq(_bal(buyer), 1_000_000);
    }

    // ───────────────────────────── sweep ─────────────────────────────

    function test_sweep_tokenAfterTerminal() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.prank(operator);
        factory.release(t, KEY, 1_000_000, MANIFEST);
        _fundEscrow(t, 250_000); // late duplicate
        factory.sweep(t, usdc);
        assertEq(_bal(buyer), 250_000);
        assertEq(_bal(seller), 1_000_000);
    }

    function test_sweep_revert_tokenWhileLive() public {
        IF.Terms memory t = _instant(1_000_000);
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.None)));
        factory.sweep(t, usdc);
        _open(t);
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.Open)));
        factory.sweep(t, usdc);
    }

    function test_sweep_strayTokenAnytime() public {
        JunkToken junk = new JunkToken();
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        junk.mint(_e(t), 77);
        vm.expectEmit(address(factory));
        emit IF.Swept(_h(t), address(junk), 77);
        factory.sweep(t, address(junk));
        assertEq(junk.balanceOf(buyer), 77);
        assertEq(uint8(_status(t)), uint8(IF.Status.Open), "status untouched");
        assertEq(_bal(_e(t)), 1_000_000, "escrowed USDC untouched");
    }

    function test_sweep_preDeployEth() public {
        IF.Terms memory t = _instant(1_000_000);
        vm.deal(_e(t), 0.5 ether);
        factory.sweep(t, address(0));
        assertEq(buyer.balance, 0.5 ether);
        // After deployment the clone refuses ETH (no receive/fallback).
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok,) = _e(t).call{value: 1}("");
        assertFalse(ok);
    }

    function test_sweep_zeroBalanceIsNoop() public {
        IF.Terms memory t = _instant(1_000_000);
        vm.recordLogs();
        factory.sweep(t, address(0));
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(_e(t).code.length, 0);
    }

    function test_sweep_reentrancyBlocked() public {
        ReentrantToken evil = new ReentrantToken();
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.warp(t.deadline + 1);
        evil.mint(_e(t), 5);
        evil.arm(factory, abi.encodeCall(IF.refund, (t)));
        factory.sweep(t, address(evil));
        assertTrue(evil.reentryAttempted());
        assertFalse(evil.reentrySucceeded());
        assertEq(evil.balanceOf(buyer), 5);
        assertEq(uint8(_status(t)), uint8(IF.Status.Open));
    }

    // ───────────────────────────── refundExpired / refundableCount ─────────────────────────────

    function _openN(uint256 n, uint64 deadline) internal returns (IF.Terms[] memory ts) {
        ts = new IF.Terms[](n);
        for (uint256 i; i < n; ++i) {
            ts[i] = _instant(1_000_000);
            ts[i].salt = bytes32(i + 1);
            ts[i].deadline = deadline;
            _open(ts[i]);
        }
    }

    function test_refundExpired_refundsAndAdvancesOverTerminalPrefix() public {
        IF.Terms[] memory ts = _openN(5, uint64(block.timestamp + 1 hours));
        vm.prank(operator);
        factory.release(ts[0], KEY, 1_000_000, MANIFEST);
        assertEq(factory.refundableCount(10), 0);
        vm.warp(block.timestamp + 1 hours + 1);
        assertEq(factory.refundableCount(10), 4);
        assertEq(factory.refundableCount(2), 1);

        vm.prank(keeper);
        assertEq(factory.refundExpired(2), 1);
        assertEq(factory.scanFrom(), 2);
        assertEq(_bal(buyer), 1_000_000);

        assertEq(factory.refundExpired(100), 3);
        assertEq(factory.scanFrom(), 5);
        assertEq(_bal(buyer), 4_000_000);
        assertEq(factory.refundExpired(100), 0);
        assertEq(factory.refundableCount(100), 0);
    }

    function test_refundExpired_stopsPrefixAtLiveEntry() public {
        IF.Terms[] memory ts = _openN(3, uint64(block.timestamp + 1 hours));
        IF.Terms memory late = _instant(1_000_000);
        late.salt = bytes32(uint256(99));
        late.deadline = uint64(block.timestamp + 10 hours);
        _open(late); // index 3
        vm.warp(block.timestamp + 1 hours + 1);
        assertEq(factory.refundExpired(10), 3);
        assertEq(factory.scanFrom(), 3, "stops in front of the live entry");
        assertEq(uint8(_status(ts[2])), uint8(IF.Status.Refunded));
        assertEq(uint8(_status(late)), uint8(IF.Status.Open));
    }

    function test_refundExpired_liveEntryInMiddleIsSkippedNotBlocking() public {
        IF.Terms[] memory ts = _openN(3, uint64(block.timestamp + 1 hours));
        IF.Terms memory late = _instant(1_000_000);
        late.salt = bytes32(uint256(99));
        late.deadline = uint64(block.timestamp + 10 hours);
        _open(late); // index 3 (live)
        IF.Terms memory after_ = _instant(1_000_000);
        after_.salt = bytes32(uint256(100));
        _open(after_); // index 4, expires with the first batch
        vm.warp(block.timestamp + 1 hours + 1);
        assertEq(factory.refundExpired(10), 4);
        assertEq(factory.scanFrom(), 3);
        assertEq(uint8(_status(after_)), uint8(IF.Status.Refunded));
        assertEq(uint8(_status(ts[0])), uint8(IF.Status.Refunded));
        vm.warp(late.deadline + 1);
        assertEq(factory.refundExpired(10), 1);
        assertEq(factory.scanFrom(), 5);
    }

    function test_refundExpired_skipsFailingTransferWithoutReverting() public {
        IF.Terms[] memory ts = _openN(2, uint64(block.timestamp + 1 hours));
        IF.Terms memory other = _instant(1_000_000);
        (other.buyer,) = makeAddrAndKey("buyer-2");
        other.salt = bytes32(uint256(7));
        _open(other); // index 2
        MockUSDC(usdc).blacklist(buyer); // indices 0 and 1 cannot be paid
        vm.warp(block.timestamp + 1 hours + 1);
        assertEq(factory.refundExpired(10), 1);
        assertEq(factory.scanFrom(), 0);
        assertEq(uint8(_status(ts[0])), uint8(IF.Status.Open));
        assertEq(uint8(_status(other)), uint8(IF.Status.Refunded));
        MockUSDC(usdc).unBlacklist(buyer);
        assertEq(factory.refundExpired(10), 2);
        assertEq(factory.scanFrom(), 3);
    }

    function test_refundExpired_deliveredAfterGrace() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        _openDelivered(t);
        vm.warp(block.timestamp + 4 days);
        assertEq(factory.refundableCount(1), 0);
        vm.warp(block.timestamp + 1);
        assertEq(factory.refundableCount(1), 1);
        assertEq(factory.refundExpired(1), 1);
        assertEq(_bal(buyer), 25_000_000);
    }

    function test_refundExpired_zeroAndEmpty() public {
        assertEq(factory.refundExpired(0), 0);
        assertEq(factory.refundExpired(type(uint256).max), 0);
        assertEq(factory.refundableCount(type(uint256).max), 0);
    }

    // ───────────────────────────── vault ─────────────────────────────

    function test_vault_onlyFactory() public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.prank(operator);
        factory.release(t, KEY, 0, MANIFEST); // deploys the clone
        address impl = factory.VAULT_IMPL();
        address e = _e(t);
        vm.startPrank(attacker);
        vm.expectRevert(KeyframeVault.OnlyFactory.selector);
        KeyframeVault(e).push(usdc, attacker, 0);
        vm.expectRevert(KeyframeVault.OnlyFactory.selector);
        KeyframeVault(impl).push(usdc, attacker, 0);
        vm.stopPrank();
    }

    function test_vault_pushesErc20AndEthForFactory() public {
        address impl = factory.VAULT_IMPL();
        _give(impl, 10);
        vm.deal(impl, 3);
        vm.startPrank(address(factory));
        KeyframeVault(impl).push(usdc, buyer, 10);
        KeyframeVault(impl).push(address(0), buyer, 3);
        vm.stopPrank();
        assertEq(_bal(buyer), 10);
        assertEq(buyer.balance, 3);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KeyframeEscrowFactory} from "../../src/KeyframeEscrowFactory.sol";
import {IKeyframeEscrowFactory as IF} from "../../src/interfaces/IKeyframeEscrowFactory.sol";
import {KeyframeBase} from "../utils/KeyframeBase.sol";
import {MockUSDC} from "../utils/MockUSDC.sol";
import {GasHungryToken, JunkToken} from "../utils/Mocks.sol";

/// @notice Token whose balanceOf lies and whose transfer is a no-op (stands in for any foreign token at E).
contract FakeToken {
    function balanceOf(address) external pure returns (uint256) {
        return 1e30;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}

/// @notice Regressions for the independent contracts audit (M1, L1, L2, Info 1-2), ported from the auditor's PoCs
///         (AuditPoC.t.sol). Each PoC asserted the broken behaviour; each test here asserts the fixed one.
contract AuditRegressionsTest is KeyframeBase {
    /// @dev A second buyer that Circle blacklists after registration (the registration-time check cannot catch that).
    address internal buyer2;

    function setUp() public {
        vm.warp(1_790_000_000);
        _deployLocal();
        buyer2 = makeAddr("buyer-2");
    }

    function _legit(uint256 i, uint64 deadline) internal view returns (IF.Terms memory t) {
        t = _instant(1_000_000);
        t.salt = keccak256(abi.encode("legit", i));
        t.deadline = deadline;
    }

    /// @dev Registered with buyer2; becomes refundable-but-unpayable (never terminal) once buyer2 is blacklisted.
    function _pinned(uint256 i, uint64 deadline) internal returns (IF.Terms memory t) {
        t = _instant(factory.MIN_AMOUNT());
        t.buyer = buyer2;
        t.salt = keccak256(abi.encode("pinned", i));
        t.deadline = deadline;
        _open(t);
    }

    function _spam(uint256 i, uint64 deadline) internal returns (IF.Terms memory t) {
        t = _instant(factory.MIN_AMOUNT());
        t.buyer = attacker;
        t.salt = keccak256(abi.encode("spam", i));
        t.deadline = deadline;
        _open(t);
    }

    /// @dev The API keeper's loop: `refundableCount(condScan) > 0` => `refundExpired(20)`, at most `rounds` times.
    function _keeper(uint256 condScan, uint256 rounds) internal returns (uint256 calls, uint256 refunded) {
        for (; calls < rounds; ++calls) {
            if (factory.refundableCount(condScan) == 0) break;
            vm.prank(keeper);
            refunded += factory.refundExpired(20);
        }
    }

    // ───────────────────────────── M1: keeper pinning / starvation ─────────────────────────────

    /// @dev PoC F1a/F1b registered orders for an already-blacklisted buyer (0.10 USDC each). That is now rejected.
    function test_M1_alreadyBlacklistedBuyerCannotBeRegistered() public {
        MockUSDC(usdc).blacklist(buyer2);
        IF.Terms memory t = _instant(factory.MIN_AMOUNT());
        t.buyer = buyer2;
        _give(attacker, t.amount);
        vm.startPrank(attacker);
        MockUSDC(usdc).transfer(_e(t), t.amount); // attacker and E are clean, so this still succeeds
        vm.expectRevert(abi.encodeWithSelector(IF.BadTerms.selector, uint8(4)));
        factory.register(t);
        vm.stopPrank();
        assertEq(factory.registryLength(), 0);
    }

    /// @dev PoC F1a: one never-terminal entry at the front pinned the window; 50 keeper calls refunded only 19 of 30
    ///      orders and refundableCount never returned to 0. Now the window rotates and unpayable entries do not count.
    function test_M1_unpayableEntryNoLongerPinsKeeper() public {
        uint64 dl = uint64(block.timestamp + 1 hours);
        IF.Terms memory p = _pinned(0, dl); // index 0
        IF.Terms[] memory ts = new IF.Terms[](30);
        for (uint256 i; i < 30; ++i) {
            ts[i] = _legit(i, dl);
            _open(ts[i]); // indices 1..30
        }
        MockUSDC(usdc).blacklist(buyer2);
        vm.warp(dl + 1);

        (uint256 calls, uint256 refunded) = _keeper(50, 50);
        assertEq(refunded, 30, "every payable order is refunded by keepers");
        assertEq(calls, 2, "and the keeper condition goes false");
        for (uint256 i; i < 30; ++i) {
            assertEq(uint8(_status(ts[i])), uint8(IF.Status.Refunded));
        }
        assertEq(factory.refundableCount(type(uint256).max), 0);
        assertEq(uint8(_status(p)), uint8(IF.Status.Open), "the unpayable order waits at E");
        assertEq(factory.scanFrom(), 0, "scanFrom keeps its meaning: it stops in front of the live entry");

        MockUSDC(usdc).unBlacklist(buyer2);
        assertEq(factory.refundableCount(type(uint256).max), 1);
        (, refunded) = _keeper(50, 5);
        assertEq(refunded, 1);
        assertEq(_bal(buyer2), factory.MIN_AMOUNT());
        assertEq(factory.refundExpired(100), 0);
        assertEq(factory.scanFrom(), 31, "the terminal prefix compacts once the entry is refunded");
    }

    /// @dev PoC F1b: 20 such entries (2 USDC) made refundExpired(20) a permanent no-op for every later order.
    function test_M1_twentyUnpayableEntriesDoNotStarveVictim() public {
        uint64 dl = uint64(block.timestamp + 1 hours);
        for (uint256 i; i < 20; ++i) {
            _pinned(i, dl);
        }
        IF.Terms memory victim = _legit(0, dl);
        _open(victim);
        MockUSDC(usdc).blacklist(buyer2);
        vm.warp(dl + 1);

        assertEq(factory.refundableCount(50), 1, "only the payable victim counts");
        (uint256 calls, uint256 refunded) = _keeper(50, 10);
        assertEq(refunded, 1);
        assertEq(calls, 2, "the first window holds only unpayable entries; the next one reaches the victim");
        assertEq(uint8(_status(victim)), uint8(IF.Status.Refunded));
        vm.warp(block.timestamp + 365 days);
        assertEq(factory.refundableCount(type(uint256).max), 0, "no keeper call fires for unpayable entries");
    }

    /// @dev PoC F1c: no blacklist needed: 20 live 30-day orders (2 USDC, refunded to the attacker later) delayed every
    ///      later refund by 30 days. Now the victim is refunded on the second keeper call.
    function test_M1_liveSpamDoesNotStarveVictim() public {
        for (uint256 i; i < 20; ++i) {
            _spam(i, uint64(block.timestamp + 30 days));
        }
        IF.Terms memory victim = _legit(0, uint64(block.timestamp + 1 hours));
        _open(victim);
        vm.warp(block.timestamp + 1 hours + 1);

        assertEq(factory.refundableCount(50), 1, "the keeper condition fires");
        vm.prank(keeper);
        assertEq(factory.refundExpired(20), 0, "the first window holds only live spam");
        vm.prank(keeper);
        assertEq(factory.refundExpired(20), 1, "the victim is refunded on the next call, not 30 days later");
        assertEq(uint8(_status(victim)), uint8(IF.Status.Refunded));
        assertEq(factory.refundableCount(type(uint256).max), 0);

        vm.warp(block.timestamp + 30 days);
        (, uint256 refunded) = _keeper(type(uint256).max, 5);
        assertEq(refunded, 20, "spam capital returns to the attacker only after its own deadline");
    }

    /// @dev A bounded condition cannot see past its window: with 60 live entries ahead of the cursor,
    ///      refundableCount(50) is 0. refundableCount(type(uint256).max) is exact over the whole live range and every
    ///      refundExpired call advances the rotation, so that condition always reaches the victim.
    function test_M1_fullRangeConditionReachesVictimBehindLargeGap() public {
        for (uint256 i; i < 60; ++i) {
            _spam(i, uint64(block.timestamp + 30 days));
        }
        IF.Terms memory victim = _legit(0, uint64(block.timestamp + 1 hours));
        _open(victim); // index 60
        vm.warp(block.timestamp + 1 hours + 1);

        assertEq(factory.refundableCount(50), 0, "a 50-entry window starting at the cursor sees only spam");
        assertEq(factory.refundableCount(type(uint256).max), 1);
        (uint256 calls, uint256 refunded) = _keeper(type(uint256).max, 10);
        assertEq(refunded, 1);
        assertEq(calls, 4, "ceil(61 / 20) windows");
    }

    function test_M1_refundableCountSkipsUnpayable() public {
        IF.Terms memory t = _legit(0, uint64(block.timestamp + 1 hours));
        _open(t);
        vm.warp(t.deadline + 1);
        assertEq(factory.refundableCount(1), 1);

        MockUSDC(usdc).blacklist(buyer);
        assertEq(factory.refundableCount(1), 0, "buyer blacklisted");
        assertEq(factory.refundExpired(1), 0, "and refundExpired agrees");
        MockUSDC(usdc).unBlacklist(buyer);

        MockUSDC(usdc).blacklist(_e(t));
        assertEq(factory.refundableCount(1), 0, "escrow blacklisted");
        assertEq(factory.refundExpired(1), 0);
        MockUSDC(usdc).unBlacklist(_e(t));

        MockUSDC(usdc).pause();
        assertEq(factory.refundableCount(1), 0, "USDC paused");
        assertEq(factory.refundExpired(1), 0);
        MockUSDC(usdc).unpause();

        assertEq(factory.refundableCount(1), 1);
        assertEq(factory.refundExpired(1), 1);
        assertEq(_bal(buyer), t.amount);
    }

    /// @dev Rotation liveness over any mix of live, expired, unpayable and terminal entries and any cursor position:
    ///      ceil(live / k) calls of refundExpired(k) refund exactly what refundableCount(max) counted, each call returns
    ///      what refundableCount(k) predicted, and afterwards nothing refundable is left.
    function testFuzz_M1_rotationReachesEveryRefundable(
        uint8 n,
        uint8 k,
        uint64 liveMask,
        uint64 unpayMask,
        uint64 doneMask,
        uint8 rot
    ) public {
        n = uint8(bound(n, 1, 40));
        k = uint8(bound(k, 1, 12));
        uint64 soon = uint64(block.timestamp + 1 hours);
        uint64 late = uint64(block.timestamp + 20 days);
        uint256 truth;
        for (uint256 i; i < n; ++i) {
            IF.Terms memory t = _instant(factory.MIN_AMOUNT());
            t.salt = keccak256(abi.encode("rot", i));
            bool live = (liveMask >> i) & 1 == 1;
            bool unpayable = (unpayMask >> i) & 1 == 1;
            bool done = (doneMask >> i) & 1 == 1;
            t.deadline = live ? late : soon;
            if (unpayable) t.buyer = buyer2;
            _open(t);
            if (done) {
                vm.prank(operator);
                factory.cancel(t); // terminal in place
            }
            if (!live && !unpayable && !done) ++truth;
        }
        for (uint256 r; r < rot % 5; ++r) {
            factory.refundExpired(1 + rot % 7); // move the cursor (and compact) before anything is refundable
        }
        MockUSDC(usdc).blacklist(buyer2);
        vm.warp(soon + 1);

        uint256 expected = factory.refundableCount(type(uint256).max);
        assertEq(expected, truth, "full-range count is exact");
        uint256 liveRange = factory.registryLength() - factory.scanFrom();
        uint256 got;
        for (uint256 c; c < (liveRange + k - 1) / k; ++c) {
            uint256 predicted = factory.refundableCount(k);
            uint256 r = factory.refundExpired(k);
            assertEq(r, predicted, "refundExpired(k) == refundableCount(k)");
            got += r;
        }
        assertEq(got, expected, "one rotation reaches every refundable entry");
        assertEq(factory.refundableCount(type(uint256).max), 0);
    }

    // ───────────────────────────── L1: buyer-side failure blocking the seller ─────────────────────────────

    /// @dev PoC F2: anyone can donate 1 unit so that change > 0; with an unpayable buyer the change push then reverted
    ///      the release and the seller could never be paid (K leaked in the reverted calldata). Now the seller push is
    ///      strict and the buyer push best-effort: the change stays at E and only ever leaves to the buyer.
    function test_L1_unpayableBuyerCannotBlockSellerPayout() public {
        IF.Terms memory t = _legit(0, uint64(block.timestamp + 1 hours));
        bytes32 h = _open(t);
        address e = _e(t);
        MockUSDC(usdc).blacklist(buyer);
        _give(attacker, 1);
        vm.prank(attacker);
        MockUSDC(usdc).transfer(e, 1);

        vm.expectEmit(address(factory));
        emit IF.Released(h, KEY, MANIFEST, t.amount, 0);
        vm.prank(operator);
        factory.release(t, KEY, t.amount, MANIFEST);
        assertEq(_bal(seller), t.amount, "seller paid");
        assertEq(_bal(e), 1, "undelivered change stays at E");
        IF.OrderView memory v = factory.order(h);
        assertEq(uint8(v.status), uint8(IF.Status.Released));
        assertEq(v.toSeller, t.amount);
        assertEq(v.toBuyer, 0, "toBuyer reports what was delivered");

        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        factory.sweep(t, usdc);
        MockUSDC(usdc).unBlacklist(buyer);
        vm.expectEmit(address(factory));
        emit IF.Swept(h, usdc, 1);
        vm.prank(attacker);
        factory.sweep(t, usdc);
        assertEq(_bal(buyer), 1);
        assertEq(_bal(attacker), 0);
    }

    function test_L1_uptoChangeStaysAtEscrowForUnpayableBuyer() public {
        IF.Terms memory t = _instant(5_000_000);
        bytes32 h = _open(t);
        MockUSDC(usdc).blacklist(buyer);
        vm.prank(operator);
        factory.release(t, KEY, 3_250_000, MANIFEST);
        assertEq(_bal(seller), 3_250_000);
        assertEq(_bal(_e(t)), 1_750_000);
        assertEq(factory.order(h).toBuyer, 0);
        // Released is terminal: the seller can never take the change; only the buyer can.
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.Released)));
        factory.release(t, KEY, 5_000_000, MANIFEST);
        MockUSDC(usdc).unBlacklist(buyer);
        factory.sweep(t, usdc);
        assertEq(_bal(buyer), 1_750_000);
        assertEq(_bal(seller), 3_250_000);
    }

    function test_L1_rejectPaysKillFeeWhenBuyerUnpayable() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        bytes32 h = _openDelivered(t);
        MockUSDC(usdc).blacklist(buyer);
        vm.expectEmit(address(factory));
        emit IF.Decided(h, false, 5_000_000);
        vm.prank(buyer); // a blacklisted address can still call contracts
        factory.decide(t, false);
        assertEq(_bal(seller), 5_000_000);
        assertEq(_bal(_e(t)), 20_000_000);
        IF.OrderView memory v = factory.order(h);
        assertEq(uint8(v.status), uint8(IF.Status.Rejected));
        assertEq(v.toSeller, 5_000_000);
        assertEq(v.toBuyer, 0);
        MockUSDC(usdc).unBlacklist(buyer);
        factory.sweep(t, usdc);
        assertEq(_bal(buyer), 20_000_000);
    }

    /// @dev Calls `target` with `data` from `from` and exactly `gasLimit` gas on a throwaway state copy; reports
    ///      success and what the buyer received in `token`.
    function _try(address target, address token, address from, bytes memory data, uint256 gasLimit)
        internal
        returns (bool ok, uint256 buyerGot)
    {
        uint256 snap = vm.snapshotState();
        uint256 before = JunkToken(token).balanceOf(buyer);
        vm.prank(from);
        (ok,) = target.call{gas: gasLimit}(data);
        buyerGot = JunkToken(token).balanceOf(buyer) - before;
        vm.revertToState(snap);
    }

    function _try(address from, bytes memory data, uint256 gasLimit) internal returns (bool ok, uint256 buyerGot) {
        return _try(address(factory), usdc, from, data, gasLimit);
    }

    /// @dev eth_estimateGas binary-searches for the lowest gas limit that does not revert. With USDC-like costs that
    ///      limit (and every limit above it) delivers the change: a ~40k push cannot be starved while the ~5k tail
    ///      still completes on the remaining 1/64.
    function test_L1_estimateGasMinimumDeliversChange() public {
        IF.Terms memory t = _instant(5_000_000);
        _open(t);
        bytes memory data = abi.encodeCall(IF.release, (t, KEY, 3_000_000, MANIFEST));
        uint256 lo = 30_000;
        uint256 hi = 1_000_000;
        (bool okHi,) = _try(operator, data, hi);
        assertTrue(okHi);
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            (bool ok,) = _try(operator, data, mid);
            if (ok) hi = mid;
            else lo = mid + 1;
        }
        for (uint256 g = lo; g < lo + 40_000; g += 97) {
            (bool ok, uint256 got) = _try(operator, data, g);
            if (ok) assertEq(got, 2_000_000, "a successful release always delivers the change");
        }
        (bool okLo, uint256 gotLo) = _try(operator, data, lo);
        assertTrue(okLo);
        assertEq(gotLo, 2_000_000, "the estimateGas minimum delivers the change");
    }

    /// @dev A factory over a token whose transfer to the buyer burns 600k gas: Circle can upgrade FiatToken, and the
    ///      factory is immutable. Then a window exists in which the nested push runs out of gas while the caller
    ///      still completes; the out-of-gas guard in `_tryPush` turns that into a revert.
    function _hungryFactory(IF.Terms memory t) internal returns (KeyframeEscrowFactory f, GasHungryToken tok) {
        tok = new GasHungryToken(600_000);
        f = new KeyframeEscrowFactory(address(tok), seller);
        t.token = address(tok);
        tok.mint(f.escrowOf(f.hashTerms(t)), t.amount);
        f.register(t);
        tok.setHungry(buyer);
    }

    /// @dev Release: at every gas limit the call either reverts or delivers the change (never a silent skip).
    function test_L1_buyerPushCannotBeGasStarved() public {
        IF.Terms memory t = _instant(5_000_000);
        (KeyframeEscrowFactory f, GasHungryToken tok) = _hungryFactory(t);
        bytes memory data = abi.encodeCall(IF.release, (t, KEY, 3_000_000, MANIFEST));
        uint256 succeeded;
        for (uint256 g = 100_000; g < 1_200_000; g += 4999) {
            (bool ok, uint256 got) = _try(address(f), address(tok), operator, data, g);
            if (!ok) continue;
            ++succeeded;
            assertEq(got, 2_000_000, "a successful release always delivers the change");
        }
        assertGt(succeeded, 0);
    }

    /// @dev Keeper batch: a gas-starved refund reverts the batch instead of silently skipping the entry.
    function test_L1_keeperRefundCannotBeGasStarved() public {
        IF.Terms memory t = _legit(0, uint64(block.timestamp + 1 hours));
        (KeyframeEscrowFactory f, GasHungryToken tok) = _hungryFactory(t);
        vm.warp(t.deadline + 1);
        bytes memory data = abi.encodeCall(IF.refundExpired, (1));
        uint256 succeeded;
        for (uint256 g = 100_000; g < 1_200_000; g += 4999) {
            (bool ok, uint256 got) = _try(address(f), address(tok), keeper, data, g);
            if (!ok) continue;
            ++succeeded;
            assertEq(got, t.amount, "a successful keeper call refunds the entry it scanned");
        }
        assertGt(succeeded, 0);
    }

    // ───────────────────────────── L2: unbounded review window / kill fee ─────────────────────────────

    /// @dev PoC F4: reviewWindow = type(uint32).max locked a delivered order's funds for ~136 years. Now capped: the
    ///      worst case is deadline (<= 30 days) + 14-day review + 3-day grace = 47 days after registration.
    function test_L2_unboundedReviewWindowRejected_worstCaseLockIs47Days() public {
        IF.Terms memory t = _studio(10_000_000, type(uint32).max, 5000);
        _fundEscrow(t, t.amount);
        vm.expectRevert(abi.encodeWithSelector(IF.BadTerms.selector, uint8(9)));
        factory.register(t);

        uint256 t0 = block.timestamp;
        t.reviewWindow = factory.MAX_REVIEW_WINDOW();
        t.deadline = uint64(t0 + factory.MAX_LIFETIME());
        t.salt = keccak256("worst-case");
        _open(t);
        vm.warp(t.deadline);
        vm.prank(operator);
        factory.deliver(t, MANIFEST); // as late as allowed
        uint256 end = t0 + 30 days + 14 days + 3 days;
        vm.warp(end);
        vm.expectRevert(abi.encodeWithSelector(IF.TooEarly.selector, end));
        factory.refund(t);
        vm.warp(end + 1);
        factory.refund(t);
        assertEq(_bal(buyer), 10_000_000);
    }

    function test_L2_killFeeAboveHalfRejected() public {
        IF.Terms memory t = _studio(10_000_000, 1 days, 5001);
        _fundEscrow(t, t.amount);
        vm.expectRevert(abi.encodeWithSelector(IF.BadTerms.selector, uint8(5)));
        factory.register(t);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IF.BadTerms.selector, uint8(5)));
        factory.release(t, KEY, 0, MANIFEST);
    }

    // ───────────────────────────── Info ─────────────────────────────

    /// @dev Info 1 / PoC F3: buyer == factory was registrable and its refund left USDC in the factory (I6). Rejected now.
    function test_info1_buyerIsFactoryRejected() public {
        IF.Terms memory t = _legit(0, uint64(block.timestamp + 1 hours));
        t.buyer = address(factory);
        _fundEscrow(t, t.amount);
        vm.expectRevert(abi.encodeWithSelector(IF.BadTerms.selector, uint8(4)));
        factory.register(t);
        assertEq(factory.registryLength(), 0);
    }

    /// @dev Info 2 (accepted, documented): `sweep` of any foreign token emits Swept(h, token, amount) with whatever the
    ///      token reports and may deploy the clone before the buyer pays. Indexers must not read Swept as USDC unless
    ///      token == USDC. The order stays fully usable.
    function test_info2_sweepOfForeignTokenIsHarmless() public {
        IF.Terms memory t = _instant(1_000_000); // a real quote, not yet paid
        bytes32 h = _h(t);
        address e = _e(t);
        FakeToken fake = new FakeToken();
        vm.expectEmit(address(factory));
        emit IF.Swept(h, address(fake), 1e30);
        vm.prank(attacker);
        factory.sweep(t, address(fake));
        assertGt(e.code.length, 0, "clone deployed before funding");
        _open(t);
        vm.prank(operator);
        factory.release(t, KEY, t.amount, MANIFEST);
        assertEq(_bal(seller), t.amount);
    }

    /// @dev Auditor check: dirty high bits in calldata never produce alias termsHashes (ABI decoder validation).
    function test_check_dirtyCalldataRejected() public {
        IF.Terms memory t = _legit(0, uint64(block.timestamp + 1 hours));
        bytes memory data = abi.encodeCall(factory.hashTerms, (t));
        data[4] = 0x01; // high byte of the buyer word
        (bool ok,) = address(factory).call(data);
        assertFalse(ok, "dirty address bits must revert");
        data = abi.encodeCall(factory.hashTerms, (t));
        data[4 + 5 * 32] = 0x01; // high byte of the dueAt (uint64) word
        (ok,) = address(factory).call(data);
        assertFalse(ok, "dirty uint64 bits must revert");
    }

    /// @dev The FiatToken pre-checks fail open: a token without isBlacklisted/paused reads as "not blocked", so
    ///      registration and the keeper view keep working and the transfer itself stays the authority.
    function test_usdcFlagQueriesFailOpen() public {
        JunkToken plain = new JunkToken();
        KeyframeEscrowFactory f = new KeyframeEscrowFactory(address(plain), seller);
        IF.Terms memory t = _instant(1_000_000);
        t.token = address(plain);
        plain.mint(f.escrowOf(f.hashTerms(t)), t.amount);
        f.register(t);
        vm.warp(t.deadline + 1);
        assertEq(f.refundableCount(1), 1);
        assertEq(f.refundExpired(1), 1);
        assertEq(plain.balanceOf(buyer), t.amount);
    }
}

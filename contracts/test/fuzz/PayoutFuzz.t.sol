// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IKeyframeEscrowFactory as IF} from "../../src/interfaces/IKeyframeEscrowFactory.sol";
import {TermsLib} from "../../src/libraries/TermsLib.sol";
import {KeyframeBase} from "../utils/KeyframeBase.sol";

/// @notice payoutAt properties and Terms hashing / derivation properties.
contract PayoutFuzzTest is KeyframeBase {
    /// @dev Domain on which the frozen formula cannot overflow for any 64-bit timestamps (2^128 * 2^64 < 2^256);
    ///      registrable Terms are capped at 50e6.
    uint256 internal constant MAX_SANE_AMOUNT = type(uint128).max;

    function setUp() public {
        vm.warp(1_790_000_000);
        _deployLocal();
    }

    function _terms(uint256 amount, uint64 dueAt, uint64 deadline, uint16 bps)
        internal
        view
        returns (IF.Terms memory t)
    {
        t = _instant(amount);
        t.dueAt = dueAt;
        t.deadline = deadline;
        t.slaFloorBps = bps;
    }

    function testFuzz_payoutAt_monotoneNonIncreasing(
        uint256 amount,
        uint64 dueAt,
        uint64 deadline,
        uint16 bps,
        uint256 ts1,
        uint256 ts2
    ) public view {
        amount = bound(amount, 0, MAX_SANE_AMOUNT);
        bps = uint16(bound(bps, 0, 10_000));
        IF.Terms memory t = _terms(amount, dueAt, deadline, bps);
        (uint256 a, uint256 b) = ts1 <= ts2 ? (ts1, ts2) : (ts2, ts1);
        assertGe(factory.payoutAt(t, a), factory.payoutAt(t, b));
    }

    function testFuzz_payoutAt_bounded(uint256 amount, uint64 dueAt, uint64 deadline, uint16 bps, uint256 ts)
        public
        view
    {
        amount = bound(amount, 0, MAX_SANE_AMOUNT);
        bps = uint16(bound(bps, 0, 10_000));
        IF.Terms memory t = _terms(amount, dueAt, deadline, bps);
        uint256 p = factory.payoutAt(t, ts);
        uint256 floor = TermsLib.payout(amount, 1, 1, bps, 2); // ts >= deadline branch == floor
        assertLe(p, amount);
        if (dueAt == 0 || ts <= dueAt) {
            assertEq(p, amount);
        } else {
            assertGe(p, floor);
            if (ts >= deadline) assertEq(p, floor);
        }
    }

    /// @dev Reference re-implementation of the frozen formula (independent of TermsLib).
    function testFuzz_payoutAt_equalsFrozenFormula(
        uint256 amount,
        uint64 dueAt,
        uint64 deadline,
        uint16 bps,
        uint256 ts
    ) public view {
        amount = bound(amount, 0, type(uint128).max);
        bps = uint16(bound(bps, 0, 10_000));
        ts = bound(ts, 0, type(uint64).max);
        IF.Terms memory t = _terms(amount, dueAt, deadline, bps);
        uint256 expected;
        if (dueAt == 0 || ts <= dueAt) {
            expected = amount;
        } else {
            uint256 floor = amount * bps / 10_000;
            expected = ts >= deadline ? floor : amount - (amount - floor) * (ts - dueAt) / (deadline - dueAt);
        }
        assertEq(factory.payoutAt(t, ts), expected);
    }

    function testFuzz_payoutAt_validTermsDecayWindow(uint256 amount, uint32 lead, uint32 span, uint16 bps, uint32 at)
        public
        view
    {
        amount = bound(amount, factory.MIN_AMOUNT(), factory.MAX_AMOUNT());
        span = uint32(bound(span, 1, 30 days));
        bps = uint16(bound(bps, 0, 10_000));
        uint64 dueAt = uint64(block.timestamp + bound(lead, 1, 1 days));
        IF.Terms memory t = _terms(amount, dueAt, dueAt + span, bps);
        uint256 ts = dueAt + bound(at, 0, span);
        uint256 p = factory.payoutAt(t, ts);
        assertLe(p, amount);
        assertGe(p, amount * bps / 10_000);
        if (ts > dueAt && ts < dueAt + span) assertLe(p, factory.payoutAt(t, ts - 1));
    }

    /// @dev Exhaustive over every timestamp of small and hour-long decay windows: complements fuzzing (random points)
    ///      and Halmos (bounds proven symbolically) with a complete monotonicity check on these domains.
    function test_payout_exhaustiveWindows() public pure {
        uint64[7] memory spans = [uint64(1), 2, 3, 7, 60, 997, 3600];
        uint256[3] memory amounts = [uint256(100_000), 4_000_000, 50_000_000];
        uint16[4] memory floors = [uint16(0), 2500, 9999, 10_000];
        uint64 dueAt = 1_790_000_000;
        for (uint256 a; a < amounts.length; ++a) {
            for (uint256 f; f < floors.length; ++f) {
                for (uint256 w; w < spans.length; ++w) {
                    uint64 deadline = dueAt + spans[w];
                    uint256 floor = amounts[a] * floors[f] / 10_000;
                    uint256 prev = type(uint256).max;
                    for (uint256 ts = dueAt - 1; ts <= deadline + 1; ++ts) {
                        uint256 p = TermsLib.payout(amounts[a], dueAt, deadline, floors[f], ts);
                        assertLe(p, prev);
                        assertLe(p, amounts[a]);
                        assertGe(p, floor);
                        prev = p;
                    }
                    assertEq(prev, floor);
                }
            }
        }
    }

    function testFuzz_hashTerms_anyFieldChangesHash(uint8 field, uint256 delta) public view {
        IF.Terms memory t = _studio(4_000_000, 1 days, 2000);
        t.dueAt = 1;
        bytes32 h = factory.hashTerms(t);
        field = uint8(bound(field, 0, 13));
        delta = bound(delta, 1, type(uint16).max); // non-zero and fits every member
        if (field == 0) t.buyer = address(uint160(t.buyer) ^ uint160(delta));
        else if (field == 1) t.seller = address(uint160(t.seller) ^ uint160(delta));
        else if (field == 2) t.operator = address(uint160(t.operator) ^ uint160(delta));
        else if (field == 3) t.token = address(uint160(t.token) ^ uint160(delta));
        else if (field == 4) t.amount ^= delta;
        else if (field == 5) t.dueAt ^= uint64(delta);
        else if (field == 6) t.deadline ^= uint64(delta);
        else if (field == 7) t.reviewWindow ^= uint32(delta);
        else if (field == 8) t.slaFloorBps ^= uint16(delta);
        else if (field == 9) t.killFeeBps ^= uint16(delta);
        else if (field == 10) t.keyHash ^= bytes32(delta);
        else if (field == 11) t.specHash ^= bytes32(delta);
        else if (field == 12) t.contentHash ^= bytes32(delta);
        else t.salt ^= bytes32(delta);
        bytes32 h2 = factory.hashTerms(t);
        assertNotEq(h2, h);
        assertNotEq(factory.escrowOf(h2), factory.escrowOf(h));
    }

    function testFuzz_derivation_matchesPureHelpers(address f, bytes32 h) public pure {
        address impl = TermsLib.vaultImplOf(f);
        bytes32 initHash = keccak256(
            abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3")
        );
        assertEq(TermsLib.escrowAt(f, h), vm.computeCreate2Address(h, initHash, f));
        assertEq(impl, vm.computeCreateAddress(f, 1));
    }
}

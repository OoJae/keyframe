// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KeyframeEscrowFactory} from "../../src/KeyframeEscrowFactory.sol";
import {IKeyframeEscrowFactory as IF} from "../../src/interfaces/IKeyframeEscrowFactory.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Test} from "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";

/// @notice Plain ERC-20 (no hooks, no blacklist) standing in for USDC in symbolic runs.
contract SymToken is ERC20 {
    constructor() ERC20("Sym USD", "SUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Halmos properties (run: see contracts/README.md). Terms are concrete so that E is a concrete address;
///         every other input (caller, key, charge, manifest, timestamps, the choice of function and its arguments)
///         is symbolic.
/// @dev `check_*` functions are ignored by `forge test` and executed by `halmos --contract KeyframeEscrowSymTest`.
contract KeyframeEscrowSymTest is SymTest, Test {
    address internal constant BUYER = address(0xB0B);
    address internal constant SELLER = address(0x5E11);
    address internal constant OPERATOR = address(0x0FE7);
    bytes32 internal constant KEY = bytes32(uint256(0xC0FFEE));
    uint256 internal constant AMOUNT = 4_000_000;
    uint256 internal constant T0 = 1_790_000_000;

    KeyframeEscrowFactory internal factory;
    SymToken internal token;
    IF.Terms internal instantT;
    IF.Terms internal studioT;
    address internal eInstant;
    address internal eStudio;

    function setUp() public {
        vm.warp(T0);
        token = new SymToken();
        factory = new KeyframeEscrowFactory(address(token), SELLER);

        instantT = IF.Terms({
            buyer: BUYER,
            seller: SELLER,
            operator: OPERATOR,
            token: address(token),
            amount: AMOUNT,
            dueAt: uint64(T0 + 10 minutes),
            deadline: uint64(T0 + 1 hours),
            reviewWindow: 0,
            slaFloorBps: 5000,
            killFeeBps: 0,
            keyHash: keccak256(abi.encodePacked(KEY)),
            specHash: bytes32(uint256(1)),
            contentHash: bytes32(uint256(2)),
            salt: bytes32(uint256(3))
        });
        studioT = instantT;
        studioT.reviewWindow = 1 days;
        studioT.killFeeBps = 2000;
        studioT.contentHash = bytes32(0);
        studioT.deadline = uint64(T0 + 3 days);
        studioT.salt = bytes32(uint256(4));

        eInstant = factory.escrowOf(factory.hashTerms(instantT));
        eStudio = factory.escrowOf(factory.hashTerms(studioT));
        token.mint(eInstant, AMOUNT);
        token.mint(eStudio, AMOUNT);
        factory.register(instantT);
        factory.register(studioT);
    }

    function _total() internal view returns (uint256) {
        return token.balanceOf(BUYER) + token.balanceOf(SELLER) + token.balanceOf(eInstant) + token.balanceOf(eStudio);
    }

    /// @dev One arbitrary factory call against the concrete Terms `t`, with every other argument symbolic.
    function _anyCall(IF.Terms memory t, uint8 which, address caller) internal returns (bool ok) {
        bytes memory data;
        uint8 w = which % 9;
        if (w == 0) {
            data = abi.encodeCall(
                IF.release, (t, svm.createBytes32("key"), svm.createUint256("charge"), svm.createBytes32("manifest"))
            );
        } else if (w == 1) {
            data = abi.encodeCall(IF.deliver, (t, svm.createBytes32("manifest")));
        } else if (w == 2) {
            data = abi.encodeCall(IF.cancel, (t));
        } else if (w == 3) {
            data = abi.encodeCall(IF.decide, (t, svm.createBool("accept")));
        } else if (w == 4) {
            data = abi.encodeCall(
                IF.decideBySig,
                (t, svm.createBool("accept"), svm.createUint256("sigDeadline"), svm.createBytes(65, "sig"))
            );
        } else if (w == 5) {
            data = abi.encodeCall(IF.refund, (t));
        } else if (w == 6) {
            // Concrete candidates keep the external balanceOf target concrete: T.token, ETH, a codeless address.
            uint256 pickToken = svm.createUint(2, "sweepToken");
            address tok = pickToken == 0 ? address(token) : pickToken == 1 ? address(0) : address(0xDEAD);
            data = abi.encodeCall(IF.sweep, (t, tok));
        } else if (w == 7) {
            data = abi.encodeCall(IF.refundExpired, (svm.createUint256("maxScan") % 4));
        } else {
            data = abi.encodeCall(IF.register, (t));
        }
        vm.prank(caller);
        (ok,) = address(factory).call(data);
    }

    function _outsider(address a) internal view returns (bool) {
        return a != BUYER && a != SELLER && a != eInstant && a != eStudio;
    }

    function _warp(string memory name) internal {
        uint256 dt = svm.createUint(32, name);
        vm.warp(block.timestamp + dt);
    }

    // ───────────────────────────── properties ─────────────────────────────

    /// Seller is paid only through release with the key preimage, by seller/operator, before the deadline.
    function check_releaseNeedsPreimage(bytes32 key, uint256 charge, bytes32 manifest, address caller) public {
        _warp("dt");
        vm.prank(caller);
        (bool ok,) = address(factory).call(abi.encodeCall(IF.release, (instantT, key, charge, manifest)));
        if (ok) {
            assert(keccak256(abi.encodePacked(key)) == instantT.keyHash);
            assert(caller == SELLER || caller == OPERATOR);
            assert(block.timestamp <= instantT.deadline);
            assert(manifest == instantT.contentHash);
            assert(token.balanceOf(SELLER) == charge);
            assert(charge <= factory.payoutAt(instantT, block.timestamp));
        } else {
            assert(token.balanceOf(SELLER) == 0);
        }
    }

    /// Any two calls by arbitrary callers at arbitrary times: value only moves between E, buyer and seller.
    function check_onlyPartiesReceive(uint8 w1, uint8 w2, bool studio1, bool studio2, address c1, address c2) public {
        uint256 before = _total();
        _warp("dt1");
        _anyCall(studio1 ? studioT : instantT, w1, c1);
        _warp("dt2");
        _anyCall(studio2 ? studioT : instantT, w2, c2);
        assert(_total() == before);
        assert(token.balanceOf(address(factory)) == 0);
        assert(token.balanceOf(factory.VAULT_IMPL()) == 0);
        if (_outsider(c1)) assert(token.balanceOf(c1) == 0);
        if (_outsider(c2)) assert(token.balanceOf(c2) == 0);
        assert(token.balanceOf(SELLER) <= AMOUNT * 2);
    }

    function _payoutCase(uint8 c) internal view returns (IF.Terms memory t) {
        t = instantT;
        uint8 k = c % 6;
        if (k == 0) {
            (t.amount, t.dueAt, t.deadline, t.slaFloorBps) = (50_000_000, uint64(T0), uint64(T0 + 1 hours), 5000);
        } else if (k == 1) {
            (t.amount, t.dueAt, t.deadline, t.slaFloorBps) = (100_000, uint64(T0), uint64(T0 + 1), 0);
        } else if (k == 2) {
            (t.amount, t.dueAt, t.deadline, t.slaFloorBps) = (4_000_000, uint64(T0), uint64(T0 + 30 days), 2500);
        } else if (k == 3) {
            (t.amount, t.dueAt, t.deadline, t.slaFloorBps) = (7_000_000, uint64(T0), uint64(T0 + 1 days), 10_000);
        } else if (k == 4) {
            (t.amount, t.dueAt, t.deadline, t.slaFloorBps) = (49_999_999, 1, type(uint64).max, 3333);
        } else {
            (t.amount, t.dueAt, t.deadline, t.slaFloorBps) = (25_000_000, 0, uint64(T0 + 1 days), 0);
        }
    }

    /// payoutAt stays within [floor, amount] for every 64-bit timestamp, with the exact value outside the decay window,
    /// over a table of representative Terms (cap/floor amounts, 0-100% floors, 1-second to 2^64-second windows).
    function check_payoutBounds(uint64 ts, uint8 c) public view {
        IF.Terms memory t = _payoutCase(c);
        uint256 p = factory.payoutAt(t, ts);
        uint256 floor = t.amount * t.slaFloorBps / 10_000;
        assert(p <= t.amount);
        assert(p >= floor);
        if (t.dueAt == 0 || ts <= t.dueAt) assert(p == t.amount);
        if (t.dueAt != 0 && ts >= t.deadline) assert(p == floor);
    }

    /// Bounds plus monotonicity for any ts1 <= ts2 where at least one point is outside the open decay window
    /// (before/at dueAt or at/after deadline), over the same table of Terms.
    /// @dev Monotonicity with both points strictly inside the window reduces to monotonicity of 256-bit EVM division,
    ///      which yices and z3 do not settle within 20 minutes; see `prove_payoutMonotoneInsideWindow`. That case is
    ///      covered by `test_payout_exhaustiveWindows` (every second of 7 windows × 12 Terms) and 20k-run fuzzing.
    function check_payoutBoundsMonotone(uint64 ts1, uint64 ts2, uint8 c) public view {
        vm.assume(ts1 <= ts2);
        IF.Terms memory t = _payoutCase(c);
        vm.assume(t.dueAt == 0 || ts1 <= t.dueAt || ts2 >= t.deadline);
        uint256 p1 = factory.payoutAt(t, ts1);
        uint256 p2 = factory.payoutAt(t, ts2);
        uint256 floor = t.amount * t.slaFloorBps / 10_000;
        assert(p1 >= p2);
        assert(p1 <= t.amount && p2 >= floor);
    }

    /// Not run by default (prefix): full intra-window monotonicity. Times out in SMT (nonlinear division); run with
    /// `--function prove_payoutMonotoneInsideWindow --solver-timeout-assertion 0` to retry with a stronger solver.
    function prove_payoutMonotoneInsideWindow(uint64 ts1, uint64 ts2, uint8 c) public view {
        vm.assume(ts1 <= ts2);
        IF.Terms memory t = _payoutCase(c);
        assert(factory.payoutAt(t, ts1) >= factory.payoutAt(t, ts2));
    }

    /// After any successful terminal transition, no further call changes the status or pays the seller.
    function check_noDoubleSettle(uint8 w1, uint8 w2, bool studio, address c1, address c2) public {
        IF.Terms memory t = studio ? studioT : instantT;
        bytes32 h = factory.hashTerms(t);
        _warp("dt1");
        _anyCall(t, w1, c1);
        if (studio && factory.order(h).status == IF.Status.Delivered) {
            _warp("dt-review");
            _anyCall(t, w1 >> 4, c1);
        }
        IF.Status s = factory.order(h).status;
        vm.assume(s >= IF.Status.Released);
        uint256 sellerBefore = token.balanceOf(SELLER);
        _warp("dt2");
        _anyCall(t, w2, c2);
        assert(factory.order(h).status == s);
        assert(token.balanceOf(SELLER) == sellerBefore);
    }

    /// Once the deadline has passed (Open order), anyone can refund and the buyer gets everything.
    function check_refundAfterDeadline(address caller, uint32 dt) public {
        vm.assume(dt > 1 hours);
        vm.warp(T0 + dt);
        vm.prank(caller);
        (bool ok,) = address(factory).call(abi.encodeCall(IF.refund, (instantT)));
        assert(ok);
        assert(token.balanceOf(BUYER) == AMOUNT);
        assert(token.balanceOf(eInstant) == 0);
        assert(factory.order(factory.hashTerms(instantT)).status == IF.Status.Refunded);
    }

    /// Studio reject pays at most the kill fee.
    function check_rejectFeeBound(address caller, uint32 dt) public {
        vm.prank(OPERATOR);
        factory.deliver(studioT, bytes32(uint256(9)));
        vm.warp(block.timestamp + dt);
        vm.prank(caller);
        (bool ok,) = address(factory).call(abi.encodeCall(IF.decide, (studioT, false)));
        if (ok) {
            assert(caller == BUYER);
            assert(token.balanceOf(SELLER) == AMOUNT * studioT.killFeeBps / 10_000);
            assert(token.balanceOf(BUYER) + token.balanceOf(SELLER) == AMOUNT);
        } else {
            assert(token.balanceOf(SELLER) == 0);
        }
    }

    /// Reachability guard: the concrete happy path must succeed under halmos (otherwise the properties above would
    /// hold vacuously).
    function check_reach_releaseSucceeds() public {
        vm.prank(OPERATOR);
        factory.release(instantT, KEY, AMOUNT, instantT.contentHash);
        assert(token.balanceOf(SELLER) == AMOUNT);
        assert(eInstant.code.length != 0);
    }

    /// escrowOf matches the frozen CREATE2 / EIP-1167 derivation for any terms hash. (Halmos assigns its own CREATE
    /// addresses, so VAULT_IMPL is read rather than derived from the factory nonce; that part is covered by forge.)
    function check_escrowOfMatchesDerivation(bytes32 h) public view {
        bytes32 initHash = keccak256(
            abi.encodePacked(
                hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", factory.VAULT_IMPL(), hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
        address expected =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), h, initHash)))));
        assert(factory.escrowOf(h) == expected);
    }
}

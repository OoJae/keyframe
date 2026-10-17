// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KeyframeVault} from "./KeyframeVault.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {IFiatTokenV2_2} from "./interfaces/IFiatTokenV2_2.sol";
import {IKeyframeEscrowFactory} from "./interfaces/IKeyframeEscrowFactory.sol";
import {TermsLib} from "./libraries/TermsLib.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Keyframe pay-on-delivery escrow factory (frozen-interfaces.md §1-§3)
/// @notice Ownerless and immutable. Each order's funds sit at E = escrowOf(hashTerms(T)), a counterfactual clone
///         deployed lazily by the first call that moves funds out. Recipients are always T.buyer or T.seller.
/// @dev Holds no funds and has no payable entry point. All mutators are nonReentrant (storage-based guard).
contract KeyframeEscrowFactory is IKeyframeEscrowFactory, EIP712, ReentrancyGuard {
    address public immutable USDC;
    address public immutable SELLER;
    address public immutable VAULT_IMPL;

    uint256 public constant MIN_AMOUNT = 100_000;
    uint256 public constant MAX_AMOUNT = 50_000_000;
    uint64 public constant MAX_LIFETIME = 30 days;
    uint64 public constant RELEASE_GRACE = 3 days;
    /// @notice Longest Studio review window; bounds how long a delivered order can hold the buyer's funds.
    uint32 public constant MAX_REVIEW_WINDOW = 14 days;
    /// @notice Largest kill fee (seller share of a rejected Studio order).
    uint16 public constant MAX_KILL_FEE_BPS = 5000;

    uint16 private constant BPS = 10_000;

    /// @dev slot 0: buyer, deadline, status, accepted; slot 1: openedAt, deliveredAt, finalAt, reviewWindow.
    ///      openedAt != 0 exactly when the order was registered.
    struct Record {
        address buyer;
        uint64 deadline;
        Status status;
        bool accepted;
        uint64 openedAt;
        uint64 deliveredAt;
        uint64 finalAt;
        uint32 reviewWindow;
        bytes32 key;
        bytes32 manifestHash;
        uint256 toSeller;
        uint256 toBuyer;
    }

    /// @dev Keeper scan state, packed in one slot. `from` (public as `scanFrom()`): every registry entry before it is
    ///      terminal. `cursor`: where the next keeper window starts; it is read clamped into [from, registry length).
    struct Scan {
        uint128 from;
        uint128 cursor;
    }

    mapping(bytes32 termsHash => Record) private _orders;
    bytes32[] private _registry;
    Scan private _scan;

    // forge-lint: disable-next-line(missing-zero-check)
    constructor(address usdc, address seller) EIP712(TermsLib.NAME, TermsLib.VERSION) {
        if (usdc.code.length == 0) revert BadTerms(1);
        if (seller == address(0)) revert BadTerms(3);
        USDC = usdc;
        SELLER = seller;
        // Must remain the only CREATE in this constructor: VAULT_IMPL == getContractAddress(factory, nonce 1).
        VAULT_IMPL = address(new KeyframeVault());
    }

    // ─────────────────────────────────────────────── views ───────────────────────────────────────────────

    function hashTerms(Terms calldata t) public view returns (bytes32) {
        return _hashTypedDataV4(TermsLib.structHash(t));
    }

    function escrowOf(bytes32 termsHash) public view returns (address) {
        return Clones.predictDeterministicAddress(VAULT_IMPL, termsHash, address(this));
    }

    function payoutAt(Terms calldata t, uint256 ts) external pure returns (uint256) {
        return TermsLib.payoutAt(t, ts);
    }

    function order(bytes32 termsHash) external view returns (OrderView memory v) {
        Record storage r = _orders[termsHash];
        v.status = r.status;
        v.buyer = r.buyer;
        v.deadline = r.deadline;
        v.reviewWindow = r.reviewWindow;
        v.openedAt = r.openedAt;
        v.deliveredAt = r.deliveredAt;
        v.finalAt = r.finalAt;
        v.accepted = r.accepted;
        v.key = r.key;
        v.manifestHash = r.manifestHash;
        v.toSeller = r.toSeller;
        v.toBuyer = r.toBuyer;
    }

    function registryLength() external view returns (uint256) {
        return _registry.length;
    }

    /// @notice Registry index before which every entry is terminal (the start of the keeper's live range).
    function scanFrom() external view returns (uint256) {
        return _scan.from;
    }

    /// @notice How many orders `refundExpired(maxScan)` would refund if called now: the same window (see there), counting
    ///         entries that are refundable and payable (USDC not paused; neither T.buyer nor E blacklisted).
    /// @dev `refundableCount(type(uint256).max)` is the exact number over the whole live range [scanFrom, length); use
    ///      that as the keeper condition. A smaller maxScan can return 0 while refundable orders sit further along.
    function refundableCount(uint256 maxScan) external view returns (uint256 count) {
        (uint256 from, uint256 i, uint256 n, uint256 len) = _window(maxScan);
        if (n == 0 || _usdcFlag(abi.encodeCall(IFiatTokenV2_2.paused, ()))) return 0;
        for (uint256 k; k < n; ++k) {
            bytes32 h = _registry[i];
            Record storage r = _orders[h];
            if (_refundable(r) && _payable(r.buyer, escrowOf(h))) ++count;
            if (++i == len) i = from;
        }
    }

    // ──────────────────────────────────────── funding / registration ────────────────────────────────────────

    /// @notice Contract-as-facilitator: pulls the buyer's EIP-3009 authorization (to = E) and registers T atomically.
    /// @dev If the authorization was already executed by someone else (front-run, other facilitator), the call
    ///      falls through to registration, which still requires E to hold T.amount.
    function fundWithAuthorization(
        Terms calldata t,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external nonReentrant {
        _validate(t, true);
        bytes32 h = hashTerms(t);
        Record storage r = _orders[h];
        _requireUnregistered(r);
        address e = escrowOf(h);
        // T.token == USDC (validated): a trusted token without transfer hooks.
        try IERC3009(USDC).transferWithAuthorization(t.buyer, e, t.amount, validAfter, validBefore, nonce, signature) {}
        catch (bytes memory reason) {
            if (!IERC3009(USDC).authorizationState(t.buyer, nonce)) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
        }
        _open(h, r, t, e);
    }

    function register(Terms calldata t) external nonReentrant {
        _validate(t, true);
        bytes32 h = hashTerms(t);
        Record storage r = _orders[h];
        _requireUnregistered(r);
        _open(h, r, t, escrowOf(h));
    }

    // ───────────────────────────────────────────── seller side ─────────────────────────────────────────────

    function release(Terms calldata t, bytes32 key, uint256 charge, bytes32 manifestHash) external nonReentrant {
        _onlySellerSide(t);
        _validate(t, false);
        if (keccak256(abi.encodePacked(key)) != t.keyHash) revert BadKey();
        bytes32 h = hashTerms(t);
        Record storage r = _orders[h];
        uint256 maxCharge =
            t.reviewWindow == 0 ? _instantMaxCharge(t, r, manifestHash) : _studioMaxCharge(t, r, manifestHash);

        address e = escrowOf(h);
        uint256 bal = IERC20(t.token).balanceOf(e);
        if (bal < t.amount) revert Underfunded(bal, t.amount);
        if (charge > maxCharge) revert ChargeTooHigh(maxCharge);

        r.status = Status.Released;
        r.key = key;
        r.manifestHash = manifestHash;
        r.toSeller = charge;
        r.finalAt = _now();

        _ensureClone(e, h, bal);
        _push(e, t.token, t.seller, charge);
        // charge <= maxCharge <= amount <= bal. Best effort: an unpayable buyer cannot block the seller's payout.
        uint256 toBuyer = _tryPush(e, t.token, t.buyer, bal - charge);
        r.toBuyer = toBuyer;
        emit Released(h, key, manifestHash, charge, toBuyer);
    }

    function deliver(Terms calldata t, bytes32 manifestHash) external nonReentrant {
        _onlySellerSide(t);
        bytes32 h = hashTerms(t);
        Record storage r = _orders[h];
        if (t.reviewWindow == 0 || r.status != Status.Open) revert BadStatus(uint8(r.status));
        if (block.timestamp > t.deadline) revert TooLate(t.deadline);
        // Studio Terms carry contentHash == 0; a non-zero commitment is still honoured.
        if (t.contentHash != 0 && manifestHash != t.contentHash) revert ManifestMismatch();
        uint256 bal = IERC20(t.token).balanceOf(escrowOf(h));
        if (bal < t.amount) revert Underfunded(bal, t.amount);

        r.status = Status.Delivered;
        r.deliveredAt = _now();
        r.manifestHash = manifestHash;
        emit Delivered(h, manifestHash);
    }

    /// @notice Void: everything at E goes to the buyer. Works for unregistered Terms too.
    function cancel(Terms calldata t) external nonReentrant {
        _onlySellerSide(t);
        bytes32 h = hashTerms(t);
        Record storage r = _orders[h];
        Status s = r.status;
        if (s != Status.None && s != Status.Open && s != Status.Delivered) revert BadStatus(uint8(s));
        (address e, uint256 toBuyer) = _close(h, r, t, Status.Cancelled);
        emit Cancelled(h, toBuyer);
        _payBuyer(e, h, t, toBuyer);
    }

    // ───────────────────────────────────────────── buyer side ─────────────────────────────────────────────

    function decide(Terms calldata t, bool accept) external nonReentrant {
        if (msg.sender != t.buyer) revert NotAuthorized();
        _decide(t, hashTerms(t), accept);
    }

    /// @dev ECDSA first, then ERC-1271. Deliberately not SignatureChecker.isValidSignatureNow: an EIP-7702-delegated
    ///      EOA has code yet signs with its own key. No nonce is needed: an accept replay is idempotent and a reject
    ///      can only ever succeed once (Rejected is terminal).
    function decideBySig(Terms calldata t, bool accept, uint256 sigDeadline, bytes calldata signature)
        external
        nonReentrant
    {
        if (block.timestamp > sigDeadline) revert SignatureExpired();
        bytes32 h = hashTerms(t);
        bytes32 digest = _hashTypedDataV4(TermsLib.decisionStructHash(h, accept, sigDeadline));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, signature);
        if (
            (err != ECDSA.RecoverError.NoError || signer != t.buyer)
                && !SignatureChecker.isValidERC1271SignatureNowCalldata(t.buyer, digest, signature)
        ) revert BadSignature();
        _decide(t, h, accept);
    }

    // ─────────────────────────────────────────────── anyone ───────────────────────────────────────────────

    function refund(Terms calldata t) external nonReentrant {
        bytes32 h = hashTerms(t);
        Record storage r = _orders[h];
        Status s = r.status;
        if (s == Status.None || s == Status.Open) {
            if (block.timestamp <= t.deadline) revert TooEarly(t.deadline);
        } else if (s == Status.Delivered) {
            uint256 end = _reviewEnd(r) + RELEASE_GRACE;
            if (block.timestamp <= end) revert TooEarly(end);
        } else {
            revert BadStatus(uint8(s));
        }
        (address e, uint256 toBuyer) = _close(h, r, t, Status.Refunded);
        emit Refunded(h, toBuyer);
        _payBuyer(e, h, t, toBuyer);
    }

    /// @notice Keeper entry point: refunds every eligible order in a rotating window of the live registry range.
    /// @dev Window: n = min(maxScan, length - scanFrom) entries, starting at a private cursor (clamped into
    ///      [scanFrom, length)) and wrapping from length - 1 back to scanFrom, so no entry is visited twice per call.
    ///      The cursor then moves to the entry after the window, so consecutive calls rotate over the whole live
    ///      range and a never-terminal entry cannot starve the ones behind it. `scanFrom` still only advances over a
    ///      contiguous terminal prefix. A refund whose transfer fails (USDC paused, buyer or E blacklisted) is
    ///      skipped rather than reverting the batch; that entry stays non-terminal and `refund(T)` stays available.
    function refundExpired(uint256 maxScan) external nonReentrant returns (uint256 refunded) {
        (uint256 from, uint256 start, uint256 n, uint256 len) = _window(maxScan);
        if (n == 0) return 0;
        uint256 i = start;
        uint256 next = from; // end of the terminal prefix starting at `from`, as far as this window saw it
        bool prefix = i == from;
        for (uint256 k; k < n; ++k) {
            bytes32 h = _registry[i];
            Record storage r = _orders[h];
            if (_refundable(r) && _tryRefundRegistered(h, r)) ++refunded;
            if (prefix) {
                if (_isTerminal(r.status)) next = i + 1;
                else prefix = false;
            }
            // Wrapping only happens when the window started after `from` (else it ends exactly here), so the prefix
            // walk restarts at `from` with `next` still equal to `from`.
            if (++i == len) {
                i = from;
                prefix = true;
            }
        }
        // Both fit in 128 bits: they are registry indices.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (next != from || i != start) _scan = Scan(uint128(next), uint128(i));
    }

    /// @notice Late, duplicate or stray assets at E go to T.buyer. T.token only once the order is terminal; any
    ///         other token (or ETH as address(0)) at any time.
    function sweep(Terms calldata t, address token) external nonReentrant {
        bytes32 h = hashTerms(t);
        Status s = _orders[h].status;
        if (token == t.token && !_isTerminal(s)) revert BadStatus(uint8(s));
        address e = escrowOf(h);
        uint256 bal = _balanceOf(token, e);
        if (bal == 0) return;
        emit Swept(h, token, bal);
        _ensureClone(e, h, bal);
        _push(e, token, t.buyer, bal);
    }

    // ────────────────────────────────────────────── internals ──────────────────────────────────────────────

    function _validate(Terms calldata t, bool atRegistration) private view {
        if (t.token != USDC) revert BadTerms(1);
        if (t.amount < MIN_AMOUNT || t.amount > MAX_AMOUNT) revert BadTerms(2);
        if (t.seller != SELLER) revert BadTerms(3);
        address b = t.buyer;
        // Refunds and change to any of these would be stranded in a contract with no exit.
        if (b == address(0) || b == address(this) || b == VAULT_IMPL || b == USDC) revert BadTerms(4);
        if (t.slaFloorBps > BPS || t.killFeeBps > MAX_KILL_FEE_BPS) revert BadTerms(5);
        if (t.dueAt != 0 && t.dueAt >= t.deadline) revert BadTerms(6);
        if (atRegistration && (t.deadline <= block.timestamp || t.deadline > block.timestamp + MAX_LIFETIME)) {
            revert BadTerms(7);
        }
        if (t.operator == address(0)) revert BadTerms(8);
        if (t.reviewWindow > MAX_REVIEW_WINDOW) revert BadTerms(9);
        // An already-blacklisted buyer could never be refunded; its order would sit in the keeper range for good.
        if (atRegistration && _usdcFlag(abi.encodeCall(IFiatTokenV2_2.isBlacklisted, (b)))) revert BadTerms(4);
    }

    function _requireUnregistered(Record storage r) private view {
        if (r.openedAt != 0) revert AlreadyRegistered();
        if (r.status != Status.None) revert BadStatus(uint8(r.status));
    }

    function _open(bytes32 h, Record storage r, Terms calldata t, address e) private {
        uint256 bal = IERC20(USDC).balanceOf(e);
        if (bal < t.amount) revert Underfunded(bal, t.amount);
        r.buyer = t.buyer;
        r.deadline = t.deadline;
        r.status = Status.Open;
        r.openedAt = _now();
        r.reviewWindow = t.reviewWindow;
        _registry.push(h);
        emit Opened(h, e, t.buyer, t);
    }

    function _onlySellerSide(Terms calldata t) private view {
        if (msg.sender != t.seller && msg.sender != t.operator) revert NotAuthorized();
    }

    function _instantMaxCharge(Terms calldata t, Record storage r, bytes32 manifestHash)
        private
        view
        returns (uint256)
    {
        if (r.status != Status.Open) revert BadStatus(uint8(r.status));
        if (block.timestamp > t.deadline) revert TooLate(t.deadline);
        if (t.contentHash != 0 && manifestHash != t.contentHash) revert ManifestMismatch();
        return TermsLib.payoutAt(t, block.timestamp);
    }

    function _studioMaxCharge(Terms calldata t, Record storage r, bytes32 manifestHash) private view returns (uint256) {
        if (r.status != Status.Delivered) revert BadStatus(uint8(r.status));
        if (manifestHash != r.manifestHash) revert ManifestMismatch();
        uint256 reviewEnd = _reviewEnd(r);
        if (!r.accepted && block.timestamp < reviewEnd) revert TooEarly(reviewEnd);
        if (block.timestamp > reviewEnd + RELEASE_GRACE) revert TooLate(reviewEnd + RELEASE_GRACE);
        return TermsLib.payoutAt(t, r.deliveredAt);
    }

    function _decide(Terms calldata t, bytes32 h, bool accept) private {
        Record storage r = _orders[h];
        if (r.status != Status.Delivered) revert BadStatus(uint8(r.status));
        uint256 reviewEnd = _reviewEnd(r);
        if (block.timestamp >= reviewEnd) revert TooLate(reviewEnd);
        if (accept) {
            r.accepted = true;
            emit Decided(h, true, 0);
            return;
        }
        if (r.accepted) revert BadStatus(uint8(Status.Delivered));

        address e = escrowOf(h);
        uint256 bal = IERC20(t.token).balanceOf(e);
        uint256 fee = Math.min(t.amount * t.killFeeBps / BPS, bal);
        r.status = Status.Rejected;
        r.toSeller = fee;
        r.finalAt = _now();
        emit Decided(h, false, fee);

        _ensureClone(e, h, bal);
        _push(e, t.token, t.seller, fee);
        r.toBuyer = _tryPush(e, t.token, t.buyer, bal - fee);
    }

    /// @dev Effects of a buyer-only terminal transition (everything at E in T.token goes to T.buyer). Records the
    ///      Terms summary for orders that were never registered so `order()` stays informative.
    function _close(bytes32 h, Record storage r, Terms calldata t, Status to)
        private
        returns (address e, uint256 toBuyer)
    {
        e = escrowOf(h);
        toBuyer = _balanceOf(t.token, e);
        if (r.status == Status.None) {
            r.buyer = t.buyer;
            r.deadline = t.deadline;
            r.reviewWindow = t.reviewWindow;
        }
        r.status = to;
        r.toBuyer = toBuyer;
        r.finalAt = _now();
    }

    function _payBuyer(address e, bytes32 h, Terms calldata t, uint256 amount) private {
        _ensureClone(e, h, amount);
        _push(e, t.token, t.buyer, amount);
    }

    /// @dev Registered orders always have token == USDC; the transfer is attempted and failure leaves state intact.
    function _tryRefundRegistered(bytes32 h, Record storage r) private returns (bool) {
        address e = escrowOf(h);
        // Bounded by maxScan; one trusted-token read per entry.
        // forge-lint: disable-next-line(calls-loop)
        uint256 bal = IERC20(USDC).balanceOf(e);
        _ensureClone(e, h, bal);
        // Interaction before effects is deliberate: the push targets USDC (no hooks), every entry point is
        // nonReentrant, and a failed push must leave the order untouched.
        if (_tryPush(e, USDC, r.buyer, bal) != bal) return false;
        r.status = Status.Refunded;
        r.toBuyer = bal;
        r.finalAt = _now();
        emit Refunded(h, bal);
        return true;
    }

    function _refundable(Record storage r) private view returns (bool) {
        Status s = r.status;
        if (s == Status.Open) return block.timestamp > r.deadline;
        if (s == Status.Delivered) return block.timestamp > _reviewEnd(r) + RELEASE_GRACE;
        return false;
    }

    function _reviewEnd(Record storage r) private view returns (uint256) {
        return uint256(r.deliveredAt) + r.reviewWindow;
    }

    function _now() private view returns (uint64) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp); // safe until year 584,942,417,355
    }

    function _isTerminal(Status s) private pure returns (bool) {
        return s >= Status.Released;
    }

    /// @dev The keeper window shared by `refundExpired` and `refundableCount`: `n` entries from `start`, wrapping at
    ///      `len` back to `from`.
    function _window(uint256 maxScan) private view returns (uint256 from, uint256 start, uint256 n, uint256 len) {
        Scan memory s = _scan;
        len = _registry.length;
        from = s.from;
        n = Math.min(maxScan, len - from);
        start = s.cursor;
        if (start < from || start >= len) start = from;
    }

    /// @dev Whether a USDC transfer from E to the buyer can currently succeed, as far as Circle's blacklist goes.
    function _payable(address buyer_, address e) private view returns (bool) {
        return !_usdcFlag(abi.encodeCall(IFiatTokenV2_2.isBlacklisted, (buyer_)))
            && !_usdcFlag(abi.encodeCall(IFiatTokenV2_2.isBlacklisted, (e)));
    }

    /// @dev Best-effort FiatTokenV2_2 flag query (isBlacklisted / paused). A failing or short answer reads as false,
    ///      so a USDC without these views degrades to the plain transfer outcome instead of blocking registration or
    ///      the keeper view. Pre-check only; transfers stay authoritative.
    function _usdcFlag(bytes memory query) private view returns (bool) {
        // forge-lint: disable-next-line(calls-loop)
        (bool ok, bytes memory ret) = USDC.staticcall(query);
        return ok && ret.length >= 32 && abi.decode(ret, (uint256)) != 0;
    }

    function _balanceOf(address token, address account) private view returns (uint256) {
        return token == address(0) ? account.balance : IERC20(token).balanceOf(account);
    }

    /// @dev Lazily deploys the persistent clone at E, only when something actually leaves E.
    function _ensureClone(address e, bytes32 h, uint256 outflow) private {
        if (outflow != 0 && e.code.length == 0) Clones.cloneDeterministic(VAULT_IMPL, h);
    }

    function _push(address e, address token, address to, uint256 amount) private {
        if (amount != 0) KeyframeVault(e).push(token, to, amount);
    }

    /// @dev Like `_push`, but a transfer the token refuses (USDC blacklist or pause) is swallowed: returns what was
    ///      actually sent (`amount` or 0). Whatever is not sent stays at E, where only `sweep` (T.token once terminal)
    ///      can move it, and only to T.buyer. An out-of-gas failure is not swallowed: otherwise a caller could starve
    ///      the push (63/64 rule) and gas estimation could settle on a limit at which it silently fails.
    function _tryPush(address e, address token, address to, uint256 amount) private returns (uint256) {
        if (amount == 0) return 0;
        uint256 gasBefore = gasleft();
        // forge-lint: disable-next-line(calls-loop)
        try KeyframeVault(e).push(token, to, amount) {
            return amount;
        } catch {
            // Running out of gas anywhere in the push (clone -> vault -> USDC proxy -> implementation; each nested call
            // keeps back 1/64) hands back about 1 - (63/64)^depth of gasBefore, under 1/8 for up to 8 levels. A
            // token-level revert (blacklist, pause) costs a few thousand gas and hands back nearly all of it.
            // Reverting inside the keeper loop is intended: a gas-starved batch must fail, not skip entries.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (gasleft() < gasBefore / 8) revert();
            return 0;
        }
    }
}

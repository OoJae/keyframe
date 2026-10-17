// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KeyframeEscrowFactory} from "../../src/KeyframeEscrowFactory.sol";
import {KeyframeVault} from "../../src/KeyframeVault.sol";
import {IKeyframeEscrowFactory as IF} from "../../src/interfaces/IKeyframeEscrowFactory.sol";
import {MockUSDC} from "../utils/MockUSDC.sol";
import {JunkToken} from "../utils/Mocks.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice Drives the factory with actors buyer(s) / seller / operator / attacker / keeper over a pool of Terms.
///         Every token movement out of an escrow is attributed from Transfer logs into ghost ledgers; protocol
///         violations are latched into flags the invariant contract asserts on.
contract Handler is CommonBase, StdCheats, StdUtils {
    bytes32 internal constant TRANSFER_SIG = keccak256("Transfer(address,address,uint256)");
    bytes32 internal constant TWA_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    uint256 internal constant MAX_POOL = 24;
    uint256 public constant ATTACKER_FUNDS = 1_000_000_000;

    KeyframeEscrowFactory public immutable factory;
    MockUSDC public immutable usdc;
    JunkToken public immutable junk;

    address public immutable seller;
    address public immutable operator;
    address public immutable attacker;
    address public immutable keeper;
    address[2] public buyers;
    uint256[2] internal buyerPks;

    struct Entry {
        IF.Terms t;
        bytes32 h;
        address e;
        bytes32 key;
        uint256 buyerIdx;
    }

    Entry[] internal pool;
    mapping(address escrow => uint256 idxPlusOne) internal entryOfEscrow;

    // ghost ledgers
    mapping(bytes32 h => uint256) public sellerPaid;
    mapping(bytes32 h => uint256) public buyerPaid;
    bytes32[] public ghostRegistry;
    uint256 public ethInjected;
    uint256 internal nonceCounter;

    // latched violations
    bool public badRecipient; // I1
    bool public sellerPaidWithoutRight; // I3
    bool public terminalChanged; // I4
    bool public sellerPaidAfterTerminal; // I5
    bool public overCapProgressed; // I9
    bool public thirdPartyReleased; // I10
    bool public vaultPushedByOutsider; // vault guard
    bool public unexpectedRevert; // liveness of exits
    string public unexpectedWhere;

    mapping(bytes32 => uint256) public calls;
    mapping(bytes32 => uint256) public successes;

    constructor(KeyframeEscrowFactory f, MockUSDC u, JunkToken j, address seller_) {
        factory = f;
        usdc = u;
        junk = j;
        seller = seller_;
        operator = makeAddr("inv-operator");
        attacker = makeAddr("inv-attacker");
        keeper = makeAddr("inv-keeper");
        (buyers[0], buyerPks[0]) = makeAddrAndKey("inv-buyer-0");
        (buyers[1], buyerPks[1]) = makeAddrAndKey("inv-buyer-1");
        usdc.mint(buyers[0], 1e15);
        usdc.mint(buyers[1], 1e15);
        usdc.mint(attacker, ATTACKER_FUNDS);
        junk.mint(attacker, 1e30);
        for (uint256 i; i < 8; ++i) {
            _addTerms(uint256(keccak256(abi.encode("seed", i))));
        }
    }

    // ───────────────────────────── views for invariants ─────────────────────────────

    function poolLength() external view returns (uint256) {
        return pool.length;
    }

    function entry(uint256 i) external view returns (IF.Terms memory t, bytes32 h, address e, bytes32 key) {
        Entry storage en = pool[i];
        return (en.t, en.h, en.e, en.key);
    }

    function ghostRegistryLength() external view returns (uint256) {
        return ghostRegistry.length;
    }

    function isInvalid(uint256 i) external view returns (bool) {
        return _invalid(pool[i].t);
    }

    /// @dev Terms the factory must never register or pay out on: over the amount cap, a foreign seller, or a kill fee /
    ///      review window above the on-chain caps.
    function _invalid(IF.Terms storage t) internal view returns (bool) {
        return t.amount > factory.MAX_AMOUNT() || t.seller != factory.SELLER()
            || t.killFeeBps > factory.MAX_KILL_FEE_BPS() || t.reviewWindow > factory.MAX_REVIEW_WINDOW();
    }

    /// @dev True when a push of E's USDC to T.buyer would fail because Circle blacklisted the buyer.
    function _buyerBlocked(Entry storage en) internal view returns (bool) {
        return usdc.isBlacklisted(en.t.buyer) && usdc.balanceOf(en.e) != 0;
    }

    // ───────────────────────────── pool ─────────────────────────────

    function _addTerms(uint256 seed) internal {
        if (pool.length >= MAX_POOL) return;
        uint256 bIdx = seed % 2;
        bytes32 key = keccak256(abi.encode("K", seed));
        uint256 kind = (seed >> 8) % 12;
        IF.Terms memory t;
        t.buyer = buyers[bIdx];
        t.seller = seller;
        t.operator = operator;
        t.token = address(usdc);
        t.amount = bound(seed >> 16, factory.MIN_AMOUNT(), factory.MAX_AMOUNT());
        t.deadline = uint64(block.timestamp + bound(seed >> 64, 1 hours, 10 days));
        t.slaFloorBps = 10_000;
        t.keyHash = keccak256(abi.encodePacked(key));
        t.specHash = keccak256(abi.encode("spec", seed));
        t.salt = keccak256(abi.encode("salt", seed, pool.length));
        if (kind <= 3) {
            t.contentHash = keccak256(abi.encode("manifest", seed)); // Instant, render-before-pay
        } else if (kind <= 6) {
            t.reviewWindow = uint32(bound(seed >> 96, 1 hours, 2 days)); // Studio
            t.killFeeBps = uint16(bound(seed >> 128, 0, factory.MAX_KILL_FEE_BPS()));
        } else if (kind == 10) {
            t.reviewWindow = uint32(bound(seed >> 96, factory.MAX_REVIEW_WINDOW() + 1, type(uint32).max)); // over cap
        } else if (kind == 11) {
            t.reviewWindow = 1 days;
            t.killFeeBps = uint16(bound(seed >> 128, factory.MAX_KILL_FEE_BPS() + 1, 10_000)); // over cap
        } else if (kind == 7) {
            t.amount = bound(seed >> 16, factory.MAX_AMOUNT() + 1, 2 * factory.MAX_AMOUNT()); // over cap
        } else if (kind == 8) {
            t.seller = attacker; // never payable
        }
        if ((seed >> 160) % 3 == 0) {
            t.dueAt = uint64(block.timestamp + bound(seed >> 168, 0, t.deadline - block.timestamp - 1));
            if (t.dueAt == 0) t.dueAt = 1;
            t.slaFloorBps = uint16(bound(seed >> 200, 0, 10_000));
        }
        bytes32 h = factory.hashTerms(t);
        address e = factory.escrowOf(h);
        pool.push(Entry({t: t, h: h, e: e, key: key, buyerIdx: bIdx}));
        entryOfEscrow[e] = pool.length;
    }

    function _pick(uint256 i) internal view returns (Entry storage) {
        return pool[bound(i, 0, pool.length - 1)];
    }

    uint8 internal constant ANY = 0;
    uint8 internal constant INSTANT = 1;
    uint8 internal constant STUDIO = 2;

    /// @dev State-aware selection: prefer entries whose status is in `statusMask` (bit per Status) and whose tier
    ///      matches, so multi-step paths (fund -> register -> deliver -> decide -> release) are reached often.
    ///      Falls back to any entry so invalid-state calls are still exercised.
    function _pickWhere(uint256 i, uint256 statusMask, uint8 tier) internal view returns (Entry storage) {
        uint256 n = pool.length;
        uint256[] memory cands = new uint256[](n);
        uint256 c;
        for (uint256 k; k < n; ++k) {
            IF.Terms storage t = pool[k].t;
            if (tier == INSTANT && t.reviewWindow != 0) continue;
            if (tier == STUDIO && t.reviewWindow == 0) continue;
            if (statusMask & (1 << uint8(factory.order(pool[k].h).status)) == 0) continue;
            cands[c++] = k;
        }
        if (c == 0 || i % 8 == 0) return _pick(i >> 3);
        return pool[cands[bound(i >> 3, 0, c - 1)]];
    }

    function _bit(IF.Status s) internal pure returns (uint256) {
        return 1 << uint8(s);
    }

    // ───────────────────────────── bookkeeping ─────────────────────────────

    /// @dev Runs before/after every action: snapshots statuses, records logs, attributes outflows.
    modifier tracked(bytes32 name) {
        calls[name]++;
        uint256 n = pool.length;
        IF.Status[] memory before = new IF.Status[](n);
        for (uint256 i; i < n; ++i) {
            before[i] = factory.order(pool[i].h).status;
        }
        vm.recordLogs();
        _;
        _afterAction(before);
    }

    function _afterAction(IF.Status[] memory before) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < before.length; ++i) {
            IF.Status nowS = factory.order(pool[i].h).status;
            if (_terminal(before[i]) && nowS != before[i]) terminalChanged = true;
        }
        for (uint256 k; k < logs.length; ++k) {
            Vm.Log memory lg = logs[k];
            if (lg.emitter == address(factory) && lg.topics[0] == IF.Opened.selector) ghostRegistry.push(lg.topics[1]);
            if (lg.topics.length != 3 || lg.topics[0] != TRANSFER_SIG) continue;
            address from = address(uint160(uint256(lg.topics[1])));
            uint256 idx = entryOfEscrow[from];
            if (idx == 0) continue;
            address to = address(uint160(uint256(lg.topics[2])));
            uint256 value = abi.decode(lg.data, (uint256));
            Entry storage en = pool[idx - 1];
            if (to == en.t.buyer) {
                if (lg.emitter == address(usdc)) buyerPaid[en.h] += value;
            } else if (to == en.t.seller) {
                if (lg.emitter == address(usdc)) sellerPaid[en.h] += value;
                _checkSellerPayment(en, idx - 1 < before.length ? before[idx - 1] : IF.Status.None, value);
            } else {
                badRecipient = true;
            }
        }
    }

    function _checkSellerPayment(Entry storage en, IF.Status prev, uint256 value) internal {
        IF.OrderView memory v = factory.order(en.h);
        if (_terminal(prev)) sellerPaidAfterTerminal = true;
        if (_invalid(en.t)) overCapProgressed = true;
        if (v.status == IF.Status.Released) {
            bool keyOk = keccak256(abi.encodePacked(v.key)) == en.t.keyHash;
            bool inTime = en.t.reviewWindow == 0
                ? block.timestamp <= en.t.deadline
                : block.timestamp <= uint256(v.deliveredAt) + en.t.reviewWindow + factory.RELEASE_GRACE()
                    && (v.accepted || block.timestamp >= uint256(v.deliveredAt) + en.t.reviewWindow);
            if (!keyOk || !inTime || value > en.t.amount) sellerPaidWithoutRight = true;
        } else if (v.status == IF.Status.Rejected) {
            if (value > en.t.amount * en.t.killFeeBps / 10_000) sellerPaidWithoutRight = true;
        } else {
            sellerPaidWithoutRight = true;
        }
    }

    function _terminal(IF.Status s) internal pure returns (bool) {
        return s >= IF.Status.Released;
    }

    function _flag(string memory where) internal {
        unexpectedRevert = true;
        unexpectedWhere = where;
    }

    // ───────────────────────────── actions ─────────────────────────────

    function addTerms(uint256 seed) external tracked("addTerms") {
        _addTerms(seed);
    }

    function warp(uint256 dt) external tracked("warp") {
        vm.warp(block.timestamp + bound(dt, 1 minutes, 12 hours));
    }

    /// @dev Circle blacklists or clears a buyer at any time; about a third of these calls leave it blacklisted.
    function setBuyerBlacklisted(uint256 who, uint256 seed) external tracked("blacklist") {
        address b = buyers[who % 2];
        if (seed % 3 == 0) usdc.blacklist(b);
        else usdc.unBlacklist(b);
    }

    function fundDirect(uint256 i, uint256 amountSeed, bool dust) external tracked("fundDirect") {
        Entry storage en = _pickWhere(i, _bit(IF.Status.None), ANY);
        if (usdc.isBlacklisted(en.t.buyer)) return; // a blacklisted buyer cannot pay
        uint256 amt = dust ? bound(amountSeed, 1, 1000) : en.t.amount;
        vm.prank(en.t.buyer);
        usdc.transfer(en.e, amt);
    }

    function donateByAttacker(uint256 i, uint256 amountSeed) external tracked("donate") {
        Entry storage en = _pick(i);
        uint256 bal = usdc.balanceOf(attacker);
        if (bal == 0) return;
        vm.prank(attacker);
        usdc.transfer(en.e, bound(amountSeed, 1, bal));
    }

    function donateJunk(uint256 i, uint256 amountSeed) external tracked("donateJunk") {
        Entry storage en = _pick(i);
        vm.prank(attacker);
        junk.transfer(en.e, bound(amountSeed, 1, 1e24));
    }

    function forceEth(uint256 i, uint256 amountSeed) external tracked("forceEth") {
        Entry storage en = _pick(i);
        uint256 amt = bound(amountSeed, 1, 10 ether);
        vm.deal(en.e, en.e.balance + amt); // models pre-deploy ETH / forced ETH
        ethInjected += amt;
    }

    function fundWithAuthorization(uint256 i, bool frontRun) external tracked("fundWithAuth") {
        Entry storage en = _pickWhere(i, _bit(IF.Status.None), ANY);
        bytes32 nonce = keccak256(abi.encode("nonce", nonceCounter++));
        uint256 validBefore = block.timestamp + 5 minutes;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(TWA_TYPEHASH, en.t.buyer, en.e, en.t.amount, 0, validBefore, nonce))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPks[en.buyerIdx], digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        if (frontRun) {
            vm.prank(attacker);
            try usdc.transferWithAuthorization(en.t.buyer, en.e, en.t.amount, 0, validBefore, nonce, sig) {} catch {}
        }
        vm.prank(keeper);
        try factory.fundWithAuthorization(en.t, 0, validBefore, nonce, sig) {
            if (_invalid(en.t)) overCapProgressed = true;
        } catch {}
    }

    function register(uint256 i) external tracked("register") {
        Entry storage en = _pickWhere(i, _bit(IF.Status.None), ANY);
        vm.prank(attacker);
        try factory.register(en.t) {
            if (_invalid(en.t)) overCapProgressed = true;
        } catch {}
    }

    function release(uint256 i, uint256 chargeSeed, bool bySeller) external tracked("release") {
        Entry storage en = _pickWhere(i, _bit(IF.Status.Open) | _bit(IF.Status.Delivered), ANY);
        IF.OrderView memory v = factory.order(en.h);
        uint256 maxCharge = factory.payoutAt(en.t, en.t.reviewWindow == 0 ? block.timestamp : v.deliveredAt);
        uint256 charge = bound(chargeSeed, 0, maxCharge);
        bytes32 manifest = en.t.reviewWindow == 0 ? en.t.contentHash : v.manifestHash;
        bool shouldWork = _releasable(en, v);
        vm.prank(bySeller ? en.t.seller : operator);
        try factory.release(en.t, en.key, charge, manifest) {
            successes["release"]++;
        } catch {
            if (shouldWork) _flag("release");
        }
    }

    /// @dev A blacklisted buyer does not matter here: the seller push is strict, the change push best-effort (L1).
    function _releasable(Entry storage en, IF.OrderView memory v) internal view returns (bool) {
        if (_invalid(en.t)) return false;
        if (usdc.balanceOf(en.e) < en.t.amount) return false;
        if (en.t.reviewWindow == 0) return v.status == IF.Status.Open && block.timestamp <= en.t.deadline;
        uint256 reviewEnd = uint256(v.deliveredAt) + en.t.reviewWindow;
        return v.status == IF.Status.Delivered && (v.accepted || block.timestamp >= reviewEnd)
            && block.timestamp <= reviewEnd + factory.RELEASE_GRACE();
    }

    function attackerRelease(uint256 i, uint256 chargeSeed) external tracked("attackerRelease") {
        Entry storage en = _pickWhere(i, _bit(IF.Status.Open) | _bit(IF.Status.Delivered), ANY);
        if (en.t.seller == attacker) return; // attacker is that (unpayable) T's seller by construction
        IF.OrderView memory v = factory.order(en.h);
        bytes32 manifest = en.t.reviewWindow == 0 ? en.t.contentHash : v.manifestHash;
        vm.prank(attacker);
        try factory.release(en.t, en.key, bound(chargeSeed, 0, en.t.amount), manifest) {
            thirdPartyReleased = true;
        } catch {}
    }

    function attackerPushVault(uint256 i) external tracked("attackerPush") {
        Entry storage en = _pick(i);
        address target = en.e.code.length != 0 ? en.e : factory.VAULT_IMPL();
        vm.prank(attacker);
        try KeyframeVault(target).push(address(usdc), attacker, 1) {
            vaultPushedByOutsider = true;
        } catch {}
    }

    function deliver(uint256 i) external tracked("deliver") {
        Entry storage en = _pickWhere(i, _bit(IF.Status.Open), STUDIO);
        vm.prank(operator);
        try factory.deliver(en.t, keccak256(abi.encode("studio-manifest", en.h))) {
            successes["deliver"]++;
        } catch {}
    }

    function decide(uint256 i, bool accept, bool bySig) external tracked("decide") {
        Entry storage en = _pickWhere(i, _bit(IF.Status.Delivered), STUDIO);
        if (!bySig) {
            vm.prank(en.t.buyer);
            try factory.decide(en.t, accept) {
                successes[accept ? bytes32("accept") : bytes32("reject")]++;
            } catch {}
            return;
        }
        uint256 dl = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domain(),
                keccak256(
                    abi.encode(keccak256("Decision(bytes32 termsHash,bool accept,uint256 deadline)"), en.h, accept, dl)
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPks[en.buyerIdx], digest);
        vm.prank(keeper);
        try factory.decideBySig(en.t, accept, dl, abi.encodePacked(r, s, v)) {
            successes[accept ? bytes32("acceptBySig") : bytes32("rejectBySig")]++;
        } catch {}
    }

    function _domain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Keyframe Escrow"),
                keccak256("1"),
                block.chainid,
                address(factory)
            )
        );
    }

    function cancel(uint256 i, bool bySeller) external tracked("cancel") {
        Entry storage en = _pickWhere(i, _bit(IF.Status.None) | _bit(IF.Status.Open) | _bit(IF.Status.Delivered), ANY);
        IF.Status s = factory.order(en.h).status;
        bool shouldWork = !_terminal(s) && !_buyerBlocked(en);
        vm.prank(bySeller ? en.t.seller : operator);
        try factory.cancel(en.t) {
            successes["cancel"]++;
        } catch {
            if (shouldWork) _flag("cancel");
        }
    }

    function refund(uint256 i) external tracked("refund") {
        Entry storage en = _pickWhere(i, _bit(IF.Status.None) | _bit(IF.Status.Open) | _bit(IF.Status.Delivered), ANY);
        IF.OrderView memory v = factory.order(en.h);
        bool shouldWork = ((v.status == IF.Status.None || v.status == IF.Status.Open)
                && block.timestamp > en.t.deadline)
            || (v.status == IF.Status.Delivered
                && block.timestamp > uint256(v.deliveredAt) + en.t.reviewWindow + factory.RELEASE_GRACE());
        shouldWork = shouldWork && !_buyerBlocked(en);
        vm.prank(attacker);
        try factory.refund(en.t) {
            successes["refund"]++;
        } catch {
            if (shouldWork) _flag("refund");
        }
    }

    function refundExpired(uint256 maxScan) external tracked("refundExpired") {
        uint256 expected = factory.refundableCount(bound(maxScan, 0, 32));
        vm.prank(keeper);
        try factory.refundExpired(bound(maxScan, 0, 32)) returns (uint256 n) {
            if (n != expected) _flag("refundExpired count");
            successes["refundExpired"] += n;
        } catch {
            _flag("refundExpired");
        }
    }

    function sweep(uint256 i, uint8 which) external tracked("sweep") {
        Entry storage en = _pick(i);
        address token = which % 3 == 0 ? address(usdc) : which % 3 == 1 ? address(junk) : address(0);
        bool shouldWork = token != en.t.token || _terminal(factory.order(en.h).status);
        if (token == address(usdc)) shouldWork = shouldWork && !_buyerBlocked(en);
        uint256 buyerEthBefore = en.t.buyer.balance;
        uint256 escrowEthBefore = en.e.balance;
        vm.prank(attacker);
        try factory.sweep(en.t, token) {
            if (token == address(0) && en.t.buyer.balance != buyerEthBefore + escrowEthBefore) badRecipient = true;
        } catch {
            if (shouldWork) _flag("sweep");
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KeyframeEscrowFactory} from "../../src/KeyframeEscrowFactory.sol";
import {IKeyframeEscrowFactory as IF} from "../../src/interfaces/IKeyframeEscrowFactory.sol";
import {MockUSDC} from "../utils/MockUSDC.sol";
import {JunkToken} from "../utils/Mocks.sol";
import {Handler} from "./Handler.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Frozen invariants I1-I10 (frozen-interfaces.md §3) plus structural properties.
contract KeyframeInvariants is Test {
    Handler internal handler;
    KeyframeEscrowFactory internal factory;
    MockUSDC internal usdc;
    JunkToken internal junk;
    address internal seller;

    function setUp() public {
        vm.warp(1_790_000_000);
        usdc = new MockUSDC();
        junk = new JunkToken();
        seller = makeAddr("inv-seller");
        factory = new KeyframeEscrowFactory(address(usdc), seller);
        handler = new Handler(factory, usdc, junk, seller);
        targetContract(address(handler));
    }

    function _entries() internal view returns (uint256) {
        return handler.poolLength();
    }

    /// I1: tokens leaving any E go only to T.buyer or T.seller.
    function invariant_I1_outflowsOnlyToParties() public view {
        assertFalse(handler.badRecipient());
    }

    /// I2: seller paid <= T.amount per T, and the on-chain ledger agrees with the observed transfers.
    function invariant_I2_sellerPaidAtMostAmount() public view {
        for (uint256 i; i < _entries(); ++i) {
            (IF.Terms memory t, bytes32 h,,) = handler.entry(i);
            uint256 paid = handler.sellerPaid(h);
            assertLe(paid, t.amount);
            assertEq(paid, factory.order(h).toSeller);
        }
    }

    /// I3: seller paid > 0 => (Released with the key preimage, in time) or (Rejected and fee <= kill fee).
    function invariant_I3_sellerPaidOnlyWithRight() public view {
        assertFalse(handler.sellerPaidWithoutRight());
        for (uint256 i; i < _entries(); ++i) {
            (IF.Terms memory t, bytes32 h,,) = handler.entry(i);
            if (handler.sellerPaid(h) == 0) continue;
            IF.OrderView memory v = factory.order(h);
            if (v.status == IF.Status.Released) {
                assertEq(keccak256(abi.encodePacked(v.key)), t.keyHash);
            } else {
                assertEq(uint8(v.status), uint8(IF.Status.Rejected));
                assertLe(handler.sellerPaid(h), t.amount * t.killFeeBps / 10_000);
            }
        }
    }

    /// I4: at most one terminal state per T; terminal is absorbing.
    function invariant_I4_terminalAbsorbing() public view {
        assertFalse(handler.terminalChanged());
    }

    /// I5: after terminal, residual / late funds reach only the buyer.
    function invariant_I5_afterTerminalOnlyBuyer() public view {
        assertFalse(handler.sellerPaidAfterTerminal());
    }

    /// I6: the factory and VAULT_IMPL never hold tokens or ETH.
    function invariant_I6_factoryAndImplHoldNothing() public view {
        address impl = factory.VAULT_IMPL();
        assertEq(usdc.balanceOf(address(factory)), 0);
        assertEq(usdc.balanceOf(impl), 0);
        assertEq(junk.balanceOf(address(factory)), 0);
        assertEq(junk.balanceOf(impl), 0);
        assertEq(address(factory).balance, 0);
        assertEq(impl.balance, 0);
    }

    /// I7: conservation across actors + escrows (USDC and ETH).
    function invariant_I7_conservation() public view {
        uint256 sum = usdc.balanceOf(handler.buyers(0)) + usdc.balanceOf(handler.buyers(1)) + usdc.balanceOf(seller)
            + usdc.balanceOf(handler.operator()) + usdc.balanceOf(handler.attacker()) + usdc.balanceOf(handler.keeper())
            + usdc.balanceOf(address(factory)) + usdc.balanceOf(factory.VAULT_IMPL());
        uint256 eth = handler.buyers(0).balance + handler.buyers(1).balance;
        for (uint256 i; i < _entries(); ++i) {
            (,, address e,) = handler.entry(i);
            sum += usdc.balanceOf(e);
            eth += e.balance;
        }
        assertEq(sum, usdc.totalSupply());
        assertEq(eth, handler.ethInjected());
    }

    /// I8: no function lets a caller choose a recipient: non-parties never gain anything.
    function invariant_I8_nonPartiesNeverGain() public view {
        assertLe(usdc.balanceOf(handler.attacker()), handler.ATTACKER_FUNDS());
        assertEq(usdc.balanceOf(handler.operator()), 0);
        assertEq(usdc.balanceOf(handler.keeper()), 0);
        assertLe(junk.balanceOf(handler.attacker()), 1e30);
        assertEq(handler.attacker().balance + handler.operator().balance + handler.keeper().balance, 0);
        assertEq(seller.balance + junk.balanceOf(seller), 0, "seller only ever receives USDC payouts");
    }

    /// I9: no T with amount > MAX_AMOUNT (nor a foreign seller, nor killFeeBps / reviewWindow above the on-chain caps)
    ///     is registered or pays a seller.
    function invariant_I9_overCapNeverProgresses() public view {
        assertFalse(handler.overCapProgressed());
        for (uint256 i; i < _entries(); ++i) {
            (, bytes32 h,,) = handler.entry(i);
            if (!handler.isInvalid(i)) continue;
            IF.OrderView memory v = factory.order(h);
            assertEq(v.openedAt, 0);
            assertTrue(v.status == IF.Status.None || v.status == IF.Status.Refunded || v.status == IF.Status.Cancelled);
        }
    }

    /// I10: a third party holding K cannot release; nobody but the factory can move funds from a vault.
    function invariant_I10_thirdPartyCannotRelease() public view {
        assertFalse(handler.thirdPartyReleased());
        assertFalse(handler.vaultPushedByOutsider());
    }

    /// Exits are always available when the frozen guards say so (no stuck funds).
    function invariant_exitsAreLive() public view {
        assertFalse(handler.unexpectedRevert(), handler.unexpectedWhere());
    }

    /// E is either codeless or exactly the canonical EIP-1167 clone of VAULT_IMPL.
    function invariant_escrowCodeIsCanonical() public view {
        bytes memory clone =
            abi.encodePacked(hex"363d3d373d3d3d363d73", factory.VAULT_IMPL(), hex"5af43d82803e903d91602b57fd5bf3");
        for (uint256 i; i < _entries(); ++i) {
            (,, address e,) = handler.entry(i);
            if (e.code.length != 0) assertEq(e.code, clone);
        }
    }

    /// The registry mirrors Opened events; scanFrom only ever sits after a terminal prefix.
    function invariant_registryAndScanFrom() public view {
        uint256 len = factory.registryLength();
        assertEq(len, handler.ghostRegistryLength());
        uint256 scanFrom = factory.scanFrom();
        assertLe(scanFrom, len);
        for (uint256 i; i < scanFrom; ++i) {
            assertGe(uint8(factory.order(handler.ghostRegistry(i)).status), uint8(IF.Status.Released));
        }
    }

    /// Keeper liveness (audit M1): from any reachable state, ceil(live / k) calls of refundExpired(k) refund exactly
    /// what refundableCount(type(uint256).max) counted (blacklisted buyers excluded), and nothing refundable is left.
    /// Runs on a state snapshot, so the campaign itself is unaffected.
    function invariant_keeperRotationReachesEveryRefundable() public {
        uint256 snap = vm.snapshotState();
        uint256 expected = factory.refundableCount(type(uint256).max);
        uint256 live = factory.registryLength() - factory.scanFrom();
        uint256 k = 1 + factory.registryLength() % 7;
        uint256 got;
        for (uint256 c; c < (live + k - 1) / k; ++c) {
            got += factory.refundExpired(k);
        }
        assertEq(got, expected);
        assertEq(factory.refundableCount(type(uint256).max), 0);
        vm.revertToState(snap);
    }

    /// L1 accounting: OrderView.toBuyer reports only what actually reached the buyer (undelivered change stays at E
    /// and later leaves through sweep), so it never exceeds the observed USDC transfers from E to T.buyer.
    function invariant_toBuyerNeverOverstated() public view {
        for (uint256 i; i < _entries(); ++i) {
            (, bytes32 h,,) = handler.entry(i);
            assertLe(factory.order(h).toBuyer, handler.buyerPaid(h));
        }
    }

    function afterInvariant() external view {
        // Coverage sanity: the campaign must actually reach the money-moving paths.
        assertGt(handler.calls("release") + handler.calls("refund") + handler.calls("cancel"), 0);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KeyframeEscrowFactory} from "../../src/KeyframeEscrowFactory.sol";
import {IKeyframeEscrowFactory as IF} from "../../src/interfaces/IKeyframeEscrowFactory.sol";
import {KeyframeBase} from "../utils/KeyframeBase.sol";
import {PlainDelegate, Self1271Delegate} from "../utils/Mocks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IFiatTokenV2_2 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function version() external view returns (string memory);
    function blacklister() external view returns (address);
    function pauser() external view returns (address);
    function blacklist(address account) external;
    function unBlacklist(address account) external;
    function isBlacklisted(address account) external view returns (bool);
    function pause() external;
    function unpause() external;
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

/// @notice Base mainnet fork against the real USDC (FiatTokenV2_2 proxy). Accounts are funded by pranking a large
///         USDC holder, never by stdstore (FiatToken v2.2 packs the blacklist flag into the balance slot).
/// @dev Skips unless BASE_RPC_URL is set. Pinned block => cached, reproducible state and gas.
contract BaseForkTest is KeyframeBase {
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant USDC_HOLDER = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB; // Aave v3 aBasUSDC
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint256 internal constant FORK_BLOCK = 52_705_000;
    string internal constant GAS_GROUP = "KeyframeFork";

    IFiatTokenV2_2 internal fiat;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, vm.envOr("FORK_BLOCK", FORK_BLOCK));
        _actors();
        usdc = BASE_USDC;
        fiat = IFiatTokenV2_2(BASE_USDC);
        factory = new KeyframeEscrowFactory(BASE_USDC, seller);
    }

    function _give(address to, uint256 amount) internal override {
        vm.prank(USDC_HOLDER);
        IERC20(BASE_USDC).transfer(to, amount);
    }

    function _usdcDomain() internal view override returns (bytes32) {
        return fiat.DOMAIN_SEPARATOR();
    }

    function _fundByAuth(IF.Terms memory t, bytes32 nonce) internal {
        _give(t.buyer, t.amount);
        bytes memory sig = _authFor(t, nonce);
        vm.prank(keeper);
        factory.fundWithAuthorization(t, 0, block.timestamp + 5 minutes, nonce, sig);
    }

    // ───────────────────────────── environment facts ─────────────────────────────

    function test_fork_environment() public view {
        assertEq(fiat.version(), "2");
        assertGt(CREATE2_DEPLOYER.code.length, 0, "deterministic deployer present on Base");
        assertGt(IERC20(BASE_USDC).balanceOf(USDC_HOLDER), 1e12);
        assertEq(factory.VAULT_IMPL(), vm.computeCreateAddress(address(factory), 1));
    }

    // ───────────────────────────── funding ─────────────────────────────

    function test_fork_fundWithAuthorization_codelessEscrow() public {
        IF.Terms memory t = _instant(4_000_000);
        address e = _e(t);
        _give(buyer, t.amount);
        bytes32 nonce = keccak256("fork-n1");
        bytes memory sig = _authFor(t, nonce);
        assertEq(sig.length, 65);
        vm.prank(keeper);
        factory.fundWithAuthorization(t, 0, block.timestamp + 5 minutes, nonce, sig);
        vm.snapshotGasLastFrame(GAS_GROUP, "fundWithAuthorization");
        assertEq(e.code.length, 0, "E stays codeless");
        assertEq(IERC20(BASE_USDC).balanceOf(e), t.amount);
        assertTrue(fiat.authorizationState(buyer, nonce));
        assertEq(uint8(_status(t)), uint8(IF.Status.Open));
    }

    function test_fork_frontRunThenRegister() public {
        IF.Terms memory t = _instant(4_000_000);
        _give(buyer, t.amount);
        bytes32 nonce = keccak256("fork-n2");
        bytes memory sig = _authFor(t, nonce);
        vm.prank(attacker); // a third party (or another facilitator) settles the authorization first
        fiat.transferWithAuthorization(buyer, _e(t), t.amount, 0, block.timestamp + 5 minutes, nonce, sig);
        // Our facilitator's late call still opens the order ...
        IF.Terms memory t2 = t;
        vm.prank(keeper);
        factory.fundWithAuthorization(t2, 0, block.timestamp + 5 minutes, nonce, sig);
        assertEq(uint8(_status(t)), uint8(IF.Status.Open));
        // ... and a separate register() is now a no-op error.
        vm.expectRevert(IF.AlreadyRegistered.selector);
        factory.register(t);
    }

    function test_fork_frontRunThenPlainRegister() public {
        IF.Terms memory t = _instant(4_000_000);
        _give(buyer, t.amount);
        bytes32 nonce = keccak256("fork-n3");
        bytes memory sig = _authFor(t, nonce);
        vm.prank(attacker);
        fiat.transferWithAuthorization(buyer, _e(t), t.amount, 0, block.timestamp + 5 minutes, nonce, sig);
        vm.prank(keeper);
        factory.register(t);
        vm.snapshotGasLastFrame(GAS_GROUP, "register");
        assertEq(uint8(_status(t)), uint8(IF.Status.Open));
    }

    // ───────────────────────────── Instant ─────────────────────────────

    function test_fork_instantRelease_uptoChange() public {
        IF.Terms memory t = _instant(5_000_000);
        _fundByAuth(t, keccak256("fork-n4"));
        uint256 buyerBefore = _bal(buyer);
        vm.prank(operator);
        factory.release(t, KEY, 3_500_000, MANIFEST);
        vm.snapshotGasLastFrame(GAS_GROUP, "release_instant_withChange_deploysClone");
        assertEq(_bal(seller), 3_500_000);
        assertEq(_bal(buyer) - buyerBefore, 1_500_000);
        assertEq(
            _e(t).code,
            abi.encodePacked(hex"363d3d373d3d3d363d73", factory.VAULT_IMPL(), hex"5af43d82803e903d91602b57fd5bf3")
        );
        assertEq(factory.order(_h(t)).key, KEY);
    }

    function test_fork_instantRelease_exact() public {
        IF.Terms memory t = _instant(100_000);
        _fundByAuth(t, keccak256("fork-n5"));
        vm.prank(operator);
        factory.release(t, KEY, 100_000, MANIFEST);
        vm.snapshotGasLastFrame(GAS_GROUP, "release_instant_exact_deploysClone");
        assertEq(_bal(seller), 100_000);
    }

    function test_fork_slaDecayPayout() public {
        IF.Terms memory t = _instant(4_000_000);
        t.dueAt = uint64(block.timestamp + 5 minutes);
        t.deadline = uint64(block.timestamp + 25 minutes);
        t.slaFloorBps = 2500;
        _fundByAuth(t, keccak256("fork-n6"));
        vm.warp(t.dueAt + 10 minutes); // halfway: 4.0 - 3.0/2 = 2.5
        uint256 max = factory.payoutAt(t, block.timestamp);
        assertEq(max, 2_500_000);
        vm.prank(operator);
        factory.release(t, KEY, max, MANIFEST);
        assertEq(_bal(seller), 2_500_000);
        assertEq(_bal(buyer), 1_500_000);
    }

    // ───────────────────────────── exits ─────────────────────────────

    function test_fork_refundByStrangerAfterDeadline() public {
        IF.Terms memory t = _instant(4_000_000);
        _fundByAuth(t, keccak256("fork-n7"));
        vm.warp(t.deadline + 1);
        address stranger = makeAddr("random-eoa");
        vm.prank(stranger);
        factory.refund(t);
        vm.snapshotGasLastFrame(GAS_GROUP, "refund_deploysClone");
        assertEq(_bal(buyer), 4_000_000);
        assertEq(_bal(stranger), 0);
    }

    function test_fork_cancelVoid() public {
        IF.Terms memory t = _instant(4_000_000);
        _fundByAuth(t, keccak256("fork-n8"));
        vm.prank(operator);
        factory.cancel(t);
        vm.snapshotGasLastFrame(GAS_GROUP, "cancel_open_deploysClone");
        assertEq(_bal(buyer), 4_000_000);
        assertEq(uint8(_status(t)), uint8(IF.Status.Cancelled));
    }

    function test_fork_cancelBeforeFunding_lateFundsSwept() public {
        IF.Terms memory t = _instant(4_000_000);
        vm.prank(operator);
        factory.cancel(t);
        vm.snapshotGasLastFrame(GAS_GROUP, "cancel_unfunded_noClone");
        assertEq(_e(t).code.length, 0);
        _give(buyer, t.amount);
        address e = _e(t);
        vm.prank(buyer);
        IERC20(BASE_USDC).transfer(e, t.amount); // pays a voided quote anyway
        factory.sweep(t, BASE_USDC);
        vm.snapshotGasLastFrame(GAS_GROUP, "sweep_deploysClone");
        assertEq(_bal(buyer), t.amount);
    }

    function test_fork_duplicateFundingThenSweep() public {
        IF.Terms memory t = _instant(4_000_000);
        _fundByAuth(t, keccak256("fork-n9"));
        vm.prank(operator);
        factory.release(t, KEY, 4_000_000, MANIFEST);
        _give(buyer, t.amount);
        address e = _e(t);
        vm.prank(buyer);
        IERC20(BASE_USDC).transfer(e, t.amount); // duplicate payment after settlement
        vm.prank(attacker);
        factory.sweep(t, BASE_USDC);
        vm.snapshotGasLastFrame(GAS_GROUP, "sweep_existingClone");
        assertEq(_bal(buyer), 4_000_000);
        assertEq(_bal(seller), 4_000_000);
        assertEq(_bal(attacker), 0);
    }

    // ───────────────────────────── Studio ─────────────────────────────

    function test_fork_studioDeliverThenRejectBySig() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        _fundByAuth(t, keccak256("fork-n10"));
        vm.prank(operator);
        factory.deliver(t, MANIFEST);
        vm.snapshotGasLastFrame(GAS_GROUP, "deliver");
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _signDecision(buyerPk, _h(t), false, dl);
        vm.prank(keeper);
        factory.decideBySig(t, false, dl, sig);
        vm.snapshotGasLastFrame(GAS_GROUP, "decideBySig_reject_deploysClone");
        assertEq(_bal(seller), 5_000_000, "kill fee 20%");
        assertEq(_bal(buyer), 20_000_000);
    }

    function test_fork_studioAcceptThenRelease() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        _fundByAuth(t, keccak256("fork-n11"));
        vm.prank(operator);
        factory.deliver(t, MANIFEST);
        vm.prank(buyer);
        factory.decide(t, true);
        vm.snapshotGasLastFrame(GAS_GROUP, "decide_accept");
        vm.prank(operator);
        factory.release(t, KEY, 25_000_000, MANIFEST);
        vm.snapshotGasLastFrame(GAS_GROUP, "release_studio_deploysClone");
        assertEq(_bal(seller), 25_000_000);
    }

    function test_fork_releaseGraceExpiryRefund() public {
        IF.Terms memory t = _studio(25_000_000, 1 days, 2000);
        _fundByAuth(t, keccak256("fork-n12"));
        vm.prank(operator);
        factory.deliver(t, MANIFEST);
        vm.warp(block.timestamp + 1 days + 3 days + 1);
        vm.prank(operator);
        vm.expectRevert();
        factory.release(t, KEY, 25_000_000, MANIFEST);
        factory.refund(t);
        assertEq(_bal(buyer), 25_000_000);
        assertEq(_bal(seller), 0);
    }

    // ───────────────────────────── keepers ─────────────────────────────

    function test_fork_refundExpiredBounded() public {
        uint256 n = 25;
        uint64 deadline = uint64(block.timestamp + 1 hours);
        for (uint256 i; i < n; ++i) {
            IF.Terms memory t = _instant(100_000);
            t.salt = bytes32(i + 1);
            t.deadline = deadline;
            _fundByAuth(t, keccak256(abi.encode("fork-batch", i)));
        }
        vm.warp(deadline + 1);
        assertEq(factory.refundableCount(100), n);
        vm.prank(keeper);
        uint256 refunded = factory.refundExpired(20);
        uint256 gas20 = vm.snapshotGasLastFrame(GAS_GROUP, "refundExpired_20_deployClones");
        assertEq(refunded, 20);
        assertEq(factory.scanFrom(), 20);
        assertLt(gas20, 3_000_000, "KeeperHub budget for maxScan=20");
        assertEq(factory.refundExpired(20), 5);
        assertEq(factory.refundableCount(100), 0);
        assertEq(_bal(buyer), n * 100_000);
        vm.prank(keeper);
        factory.refundExpired(20);
        vm.snapshotGasLastFrame(GAS_GROUP, "refundExpired_noop");
    }

    // ───────────────────────────── EIP-7702 buyers ─────────────────────────────

    /// @dev FiatTokenV2_2 routes any signer with code (incl. a 7702 designator) to ERC-1271, so an ECDSA EIP-3009
    ///      signature from a delegated EOA whose delegate lacks ERC-1271 is rejected by USDC. The direct rail
    ///      (USDC.transfer to E, then register) still works, and decideBySig still accepts the ECDSA signature.
    function test_fork_7702BuyerWithoutErc1271_directRail() public {
        PlainDelegate impl = new PlainDelegate();
        vm.signAndAttachDelegation(address(impl), buyerPk);
        assertEq(buyer.code, abi.encodePacked(hex"ef0100", address(impl)));

        IF.Terms memory t = _studio(10_000_000, 1 days, 2000);
        _give(buyer, t.amount);
        bytes32 nonce = keccak256("fork-7702-a");
        bytes memory sig = _authFor(t, nonce);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        factory.fundWithAuthorization(t, 0, block.timestamp + 5 minutes, nonce, sig);

        address e = _e(t);
        vm.prank(buyer);
        IERC20(BASE_USDC).transfer(e, t.amount); // keyframe_commission_direct
        factory.register(t);
        vm.prank(operator);
        factory.deliver(t, MANIFEST);
        uint256 dl = block.timestamp + 1 hours;
        factory.decideBySig(t, false, dl, _signDecision(buyerPk, _h(t), false, dl));
        assertEq(_bal(buyer), 8_000_000);
        assertEq(_bal(seller), 2_000_000);
    }

    function test_fork_7702BuyerWithErc1271Delegate_fundWithAuthorization() public {
        Self1271Delegate impl = new Self1271Delegate();
        vm.signAndAttachDelegation(address(impl), buyerPk);
        IF.Terms memory t = _instant(1_000_000);
        _fundByAuth(t, keccak256("fork-7702-b"));
        assertEq(uint8(_status(t)), uint8(IF.Status.Open));
    }

    // ───────────────────────────── Circle controls ─────────────────────────────

    function test_fork_blacklistedSellerCannotBlockBuyerRefund() public {
        IF.Terms memory t = _instant(4_000_000);
        _fundByAuth(t, keccak256("fork-bl-1"));
        vm.prank(fiat.blacklister());
        fiat.blacklist(seller);
        vm.prank(operator);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        factory.release(t, KEY, 4_000_000, MANIFEST);
        vm.warp(t.deadline + 1);
        vm.prank(makeAddr("random-eoa"));
        factory.refund(t);
        assertEq(_bal(buyer), 4_000_000);
    }

    function test_fork_blacklistedBuyer_documentedStuckThenRecovers() public {
        IF.Terms memory t = _instant(4_000_000);
        _fundByAuth(t, keccak256("fork-bl-2"));
        vm.prank(fiat.blacklister());
        fiat.blacklist(buyer);
        vm.warp(t.deadline + 1);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        factory.refund(t);
        assertEq(factory.refundExpired(10), 0, "keeper batch skips, does not revert");
        assertEq(uint8(_status(t)), uint8(IF.Status.Open));
        vm.prank(fiat.blacklister());
        fiat.unBlacklist(buyer);
        assertEq(factory.refundExpired(10), 1);
        assertEq(_bal(buyer), 4_000_000);
    }

    function test_fork_pausedUsdcBlocksThenRecovers() public {
        IF.Terms memory t = _instant(4_000_000);
        _fundByAuth(t, keccak256("fork-pause"));
        vm.prank(fiat.pauser());
        fiat.pause();
        vm.prank(operator);
        vm.expectRevert(bytes("Pausable: paused"));
        factory.release(t, KEY, 4_000_000, MANIFEST);
        vm.prank(fiat.pauser());
        fiat.unpause();
        vm.prank(operator);
        factory.release(t, KEY, 4_000_000, MANIFEST);
        assertEq(_bal(seller), 4_000_000);
    }
}

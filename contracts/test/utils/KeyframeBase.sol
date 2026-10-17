// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KeyframeEscrowFactory} from "../../src/KeyframeEscrowFactory.sol";
import {IKeyframeEscrowFactory} from "../../src/interfaces/IKeyframeEscrowFactory.sol";
import {TermsLib} from "../../src/libraries/TermsLib.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Shared fixtures: actors, Terms builders, EIP-3009 / Decision signing. Funding is virtual so the fork
///         suite can source real USDC from a holder instead of minting.
abstract contract KeyframeBase is Test {
    bytes32 internal constant KEY = keccak256("kf/kchain/v1/q_test");
    bytes32 internal constant MANIFEST = keccak256("manifest");
    bytes32 internal constant TWA_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    KeyframeEscrowFactory internal factory;
    address internal usdc;

    uint256 internal buyerPk;
    address internal buyer;
    address internal seller;
    address internal operator;
    address internal attacker;
    address internal keeper;

    function _actors() internal {
        (buyer, buyerPk) = makeAddrAndKey("buyer");
        seller = makeAddr("seller");
        operator = makeAddr("operator");
        attacker = makeAddr("attacker");
        keeper = makeAddr("keeper");
    }

    function _deployLocal() internal {
        _actors();
        usdc = address(new MockUSDC());
        factory = new KeyframeEscrowFactory(usdc, seller);
    }

    // ───────────────────────────── Terms builders ─────────────────────────────

    function _instant(uint256 amount) internal view returns (IKeyframeEscrowFactory.Terms memory t) {
        t = IKeyframeEscrowFactory.Terms({
            buyer: buyer,
            seller: seller,
            operator: operator,
            token: usdc,
            amount: amount,
            dueAt: 0,
            deadline: uint64(block.timestamp + 1 hours),
            reviewWindow: 0,
            slaFloorBps: 10_000,
            killFeeBps: 0,
            keyHash: keccak256(abi.encodePacked(KEY)),
            specHash: sha256("spec"),
            contentHash: MANIFEST,
            salt: keccak256("q_test")
        });
    }

    function _studio(uint256 amount, uint32 reviewWindow, uint16 killFeeBps)
        internal
        view
        returns (IKeyframeEscrowFactory.Terms memory t)
    {
        t = _instant(amount);
        t.reviewWindow = reviewWindow;
        t.killFeeBps = killFeeBps;
        t.contentHash = bytes32(0);
        t.deadline = uint64(block.timestamp + 3 days);
        t.salt = keccak256("q_studio");
    }

    function _h(IKeyframeEscrowFactory.Terms memory t) internal view returns (bytes32) {
        return factory.hashTerms(t);
    }

    function _e(IKeyframeEscrowFactory.Terms memory t) internal view returns (address) {
        return factory.escrowOf(factory.hashTerms(t));
    }

    function _bal(address who) internal view returns (uint256) {
        return IERC20(usdc).balanceOf(who);
    }

    function _status(IKeyframeEscrowFactory.Terms memory t) internal view returns (IKeyframeEscrowFactory.Status) {
        return factory.order(_h(t)).status;
    }

    // ───────────────────────────── funding ─────────────────────────────

    /// @dev Local default: mint. Fork suites override with a transfer from a real holder.
    function _give(address to, uint256 amount) internal virtual {
        MockUSDC(usdc).mint(to, amount);
    }

    function _fundEscrow(IKeyframeEscrowFactory.Terms memory t, uint256 amount) internal {
        _give(_e(t), amount);
    }

    function _open(IKeyframeEscrowFactory.Terms memory t) internal returns (bytes32 h) {
        _fundEscrow(t, t.amount);
        factory.register(t);
        h = _h(t);
    }

    function _openDelivered(IKeyframeEscrowFactory.Terms memory t) internal returns (bytes32 h) {
        h = _open(t);
        vm.prank(operator);
        factory.deliver(t, MANIFEST);
    }

    // ───────────────────────────── signatures ─────────────────────────────

    function _usdcDomain() internal view virtual returns (bytes32) {
        return MockUSDC(usdc).DOMAIN_SEPARATOR();
    }

    function _signAuth(uint256 pk, address from, address to, uint256 value, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(TWA_TYPEHASH, from, to, value, uint256(0), validBefore, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", _usdcDomain(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _authFor(IKeyframeEscrowFactory.Terms memory t, bytes32 nonce) internal view returns (bytes memory) {
        return _signAuth(buyerPk, t.buyer, _e(t), t.amount, block.timestamp + 5 minutes, nonce);
    }

    function _signDecision(uint256 pk, bytes32 termsHash, bool accept, uint256 sigDeadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                TermsLib.domainSeparator(address(factory), block.chainid),
                keccak256(
                    abi.encode(
                        keccak256("Decision(bytes32 termsHash,bool accept,uint256 deadline)"),
                        termsHash,
                        accept,
                        sigDeadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}

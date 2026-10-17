// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KeyframeEscrowFactory} from "../src/KeyframeEscrowFactory.sol";
import {IKeyframeEscrowFactory as IF} from "../src/interfaces/IKeyframeEscrowFactory.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Script, console} from "forge-std/Script.sol";

interface IUSDC3009 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice LOCAL smoke order on an anvil fork: fundWithAuthorization(0.10 USDC) -> release.
///         The buyer key is a public, label-derived test key (anvil's default accounts are EIP-7702-delegated by
///         sweeper bots on Base mainnet, so USDC would route their EIP-3009 signatures to ERC-1271 and reject them).
///         The operator is the broadcasting account.
/// @dev Env: FACTORY, KEYFRAME_SMOKE_LOCAL=1 (explicit opt-in). Run with --unlocked --sender <operator> against
///      http://127.0.0.1:8545 only. Holds no secrets; on a real chain the buyer has no USDC and simulation fails.
contract Smoke is Script {
    uint256 internal constant BUYER_TEST_KEY = uint256(keccak256("keyframe.smoke.buyer.v1")); // public, never funded on mainnet
    bytes32 internal constant TWA_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant MANIFEST = sha256("smoke-manifest");

    function run() external {
        require(vm.envOr("KEYFRAME_SMOKE_LOCAL", false), "set KEYFRAME_SMOKE_LOCAL=1 (local anvil only)");
        KeyframeEscrowFactory factory = KeyframeEscrowFactory(vm.envAddress("FACTORY"));
        uint256 buyerPk = BUYER_TEST_KEY;
        require(vm.addr(buyerPk).code.length == 0, "smoke buyer must be a plain EOA");
        bytes32 key = keccak256(abi.encode("kf/kchain/v1/smoke", block.timestamp));

        IF.Terms memory t = _terms(factory, vm.addr(buyerPk), key);
        bytes32 h = factory.hashTerms(t);
        address e = factory.escrowOf(h);
        console.log("termsHash", vm.toString(h));
        console.log("escrow   ", e);
        (uint256 validBefore, bytes32 nonce, bytes memory sig) = _authorize(t, e, buyerPk);
        uint256 sellerBefore = IERC20(t.token).balanceOf(t.seller);

        vm.startBroadcast();
        factory.fundWithAuthorization(t, 0, validBefore, nonce, sig);
        require(IERC20(t.token).balanceOf(e) == t.amount && e.code.length == 0, "funding");
        factory.release(t, key, t.amount, MANIFEST);
        vm.stopBroadcast();

        _verify(factory, t, h, e, key, sellerBefore);
    }

    function _terms(KeyframeEscrowFactory factory, address buyer, bytes32 key) internal view returns (IF.Terms memory) {
        return IF.Terms({
            buyer: buyer,
            seller: factory.SELLER(),
            operator: msg.sender,
            token: factory.USDC(),
            amount: 100_000,
            dueAt: 0,
            deadline: uint64(block.timestamp + 1 hours),
            reviewWindow: 0,
            slaFloorBps: 10_000,
            killFeeBps: 0,
            keyHash: keccak256(abi.encodePacked(key)),
            specHash: sha256("smoke-spec"),
            contentHash: MANIFEST,
            salt: keccak256(abi.encodePacked("q_smoke_", vm.toString(block.timestamp)))
        });
    }

    function _authorize(IF.Terms memory t, address e, uint256 buyerPk)
        internal
        view
        returns (uint256 validBefore, bytes32 nonce, bytes memory sig)
    {
        validBefore = block.timestamp + 5 minutes;
        nonce = keccak256(abi.encode("smoke-nonce", e));
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IUSDC3009(t.token).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(TWA_TYPEHASH, t.buyer, e, t.amount, uint256(0), validBefore, nonce))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _verify(
        KeyframeEscrowFactory factory,
        IF.Terms memory t,
        bytes32 h,
        address e,
        bytes32 key,
        uint256 sellerBefore
    ) internal view {
        IF.OrderView memory o = factory.order(h);
        require(o.status == IF.Status.Released && o.key == key, "release");
        require(IERC20(t.token).balanceOf(t.seller) - sellerBefore == t.amount, "payout");
        bytes memory clone =
            abi.encodePacked(hex"363d3d373d3d3d363d73", factory.VAULT_IMPL(), hex"5af43d82803e903d91602b57fd5bf3");
        require(keccak256(e.code) == keccak256(clone), "clone");
        console.log("smoke OK: 0.10 USDC buyer -> E -> seller; key published", vm.toString(key));
    }
}

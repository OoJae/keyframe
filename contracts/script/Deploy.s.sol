// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KeyframeEscrowFactory} from "../src/KeyframeEscrowFactory.sol";
import {TermsLib} from "../src/libraries/TermsLib.sol";
import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

/// @notice Deterministic deployment of KeyframeEscrowFactory through the canonical CREATE2 deployer.
///         factory = CREATE2(0x4e59…956C, keccak256("keyframe.escrow.v1"), initCode(USDC, SELLER));
///         VAULT_IMPL = CREATE(factory, nonce 1). Both depend only on bytecode + constructor args, never on the
///         broadcasting account.
/// @dev Env: USDC, SELLER (required); DEPLOYMENT_OUT (optional, default deployments/<chainid>.json).
///      Simulate:  forge script script/Deploy.s.sol --rpc-url $RPC
///      Broadcast: add --broadcast (see README; never from this repo's automation to mainnet).
contract Deploy is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant SALT = keccak256("keyframe.escrow.v1");

    struct Plan {
        address usdc;
        address seller;
        bytes initCode;
        bytes32 initCodeHash;
        address factory;
        address vaultImpl;
    }

    function plan(address usdc, address seller) public pure returns (Plan memory p) {
        p.usdc = usdc;
        p.seller = seller;
        p.initCode = abi.encodePacked(type(KeyframeEscrowFactory).creationCode, abi.encode(usdc, seller));
        p.initCodeHash = keccak256(p.initCode);
        p.factory = vm.computeCreate2Address(SALT, p.initCodeHash, CREATE2_DEPLOYER);
        p.vaultImpl = vm.computeCreateAddress(p.factory, 1);
    }

    function run() external returns (KeyframeEscrowFactory factory) {
        Plan memory p = plan(vm.envAddress("USDC"), vm.envAddress("SELLER"));
        require(p.usdc.code.length != 0, "USDC has no code on this chain");
        require(p.seller != address(0), "SELLER is zero");
        require(p.seller != p.factory && p.seller != p.vaultImpl, "SELLER cannot be a Keyframe contract");
        require(CREATE2_DEPLOYER.code.length != 0, "CREATE2 deployer missing");

        console.log("chainId          ", block.chainid);
        console.log("USDC             ", p.usdc);
        console.log("SELLER           ", p.seller);
        console.log("salt             ", vm.toString(SALT));
        console.log("initCodeHash     ", vm.toString(p.initCodeHash));
        console.log("predicted factory", p.factory);
        console.log("predicted impl   ", p.vaultImpl);

        bool existed = p.factory.code.length != 0;
        if (!existed) {
            vm.startBroadcast();
            (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, p.initCode));
            vm.stopBroadcast();
            require(ok && ret.length == 20 && address(bytes20(ret)) == p.factory, "CREATE2 deployment failed");
        }
        bool broadcasting =
            vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        console.log(existed ? "already deployed at the predicted address" : broadcasting ? "deployed" : "simulated");

        factory = KeyframeEscrowFactory(p.factory);
        require(factory.VAULT_IMPL() == p.vaultImpl, "VAULT_IMPL != CREATE(factory, 1)");
        require(factory.USDC() == p.usdc && factory.SELLER() == p.seller, "immutables mismatch");
        require(TermsLib.vaultImplOf(p.factory) == p.vaultImpl, "TermsLib derivation mismatch");
        // Only record what exists on the target chain: a dry run must never leave a deployments file behind.
        if (existed || broadcasting) _record(p);
    }

    function _record(Plan memory p) internal {
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "factory", p.factory);
        vm.serializeAddress(o, "vaultImpl", p.vaultImpl);
        vm.serializeAddress(o, "usdc", p.usdc);
        vm.serializeAddress(o, "seller", p.seller);
        vm.serializeAddress(o, "create2Deployer", CREATE2_DEPLOYER);
        vm.serializeBytes32(o, "salt", SALT);
        vm.serializeBytes32(o, "initCodeHash", p.initCodeHash);
        vm.serializeBytes32(o, "factoryRuntimeCodeHash", p.factory.codehash);
        vm.serializeBytes32(o, "vaultImplRuntimeCodeHash", p.vaultImpl.codehash);
        vm.serializeString(o, "compiler", "solc 0.8.30, cancun, optimizer 10000 runs, no via-IR, no CBOR metadata");
        string memory json = vm.serializeUint(o, "block", block.number);
        string memory out =
            vm.envOr("DEPLOYMENT_OUT", string.concat("deployments/", vm.toString(block.chainid), ".json"));
        vm.writeJson(json, out);
        console.log("wrote", out);
    }
}

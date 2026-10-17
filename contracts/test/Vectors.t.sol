// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KeyframeEscrowFactory} from "../src/KeyframeEscrowFactory.sol";
import {IKeyframeEscrowFactory as IF} from "../src/interfaces/IKeyframeEscrowFactory.sol";
import {TermsLib} from "../src/libraries/TermsLib.sol";
import {MockUSDC} from "./utils/MockUSDC.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Cross-language parity vectors. Reads docs/design/vectors/terms-v1.input.json, computes termsHash /
///         vaultImpl / escrow for the given (arbitrary) factory address with pure helpers, cross-checks them against
///         a real factory placed at that address, and writes test/vectors/terms-v1.output.json.
contract VectorsTest is Test {
    string internal constant INPUT = "../docs/design/vectors/terms-v1.input.json";
    string internal constant OUTPUT = "test/vectors/terms-v1.output.json";

    function _terms(string memory json, uint256 i) internal pure returns (IF.Terms memory t) {
        string memory p = string.concat(".terms[", vm.toString(i), "]");
        t.buyer = vm.parseJsonAddress(json, string.concat(p, ".buyer"));
        t.seller = vm.parseJsonAddress(json, string.concat(p, ".seller"));
        t.operator = vm.parseJsonAddress(json, string.concat(p, ".operator"));
        t.token = vm.parseJsonAddress(json, string.concat(p, ".token"));
        t.amount = vm.parseUint(vm.parseJsonString(json, string.concat(p, ".amount")));
        t.dueAt = uint64(vm.parseJsonUint(json, string.concat(p, ".dueAt")));
        t.deadline = uint64(vm.parseJsonUint(json, string.concat(p, ".deadline")));
        t.reviewWindow = uint32(vm.parseJsonUint(json, string.concat(p, ".reviewWindow")));
        t.slaFloorBps = uint16(vm.parseJsonUint(json, string.concat(p, ".slaFloorBps")));
        t.killFeeBps = uint16(vm.parseJsonUint(json, string.concat(p, ".killFeeBps")));
        t.keyHash = vm.parseJsonBytes32(json, string.concat(p, ".keyHash"));
        t.specHash = vm.parseJsonBytes32(json, string.concat(p, ".specHash"));
        t.contentHash = vm.parseJsonBytes32(json, string.concat(p, ".contentHash"));
        t.salt = vm.parseJsonBytes32(json, string.concat(p, ".salt"));
    }

    function _count(string memory json, string memory arr) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(arr, "[", vm.toString(n), "]"))) ++n;
    }

    /// @dev Places a real factory at `at` (contract nonce 1, like any CREATE/CREATE2-deployed contract).
    function _factoryAt(address at, address usdcAt) internal returns (KeyframeEscrowFactory f) {
        vm.etch(usdcAt, address(new MockUSDC()).code);
        vm.setNonce(at, 1);
        deployCodeTo("KeyframeEscrowFactory.sol:KeyframeEscrowFactory", abi.encode(usdcAt, address(0xBEEF)), at);
        f = KeyframeEscrowFactory(at);
    }

    function test_vectors_termsV1() public {
        string memory json = vm.readFile(INPUT);
        assertEq(vm.parseJsonUint(json, ".v"), 1);
        uint256 chainId = vm.parseJsonUint(json, ".chainId");
        address factoryAddr = vm.parseJsonAddress(json, ".factory");
        vm.chainId(chainId);
        KeyframeEscrowFactory f = _factoryAt(factoryAddr, vm.parseJsonAddress(json, ".usdc"));
        address impl = TermsLib.vaultImplOf(factoryAddr);
        assertEq(f.VAULT_IMPL(), impl, "VAULT_IMPL == getContractAddress(factory, 1)");

        uint256 nTerms = _count(json, ".terms");
        assertGt(nTerms, 0);
        IF.Terms[] memory ts = new IF.Terms[](nTerms);
        string memory termsOut = "[";
        for (uint256 i; i < nTerms; ++i) {
            ts[i] = _terms(json, i);
            bytes32 h = TermsLib.digest(ts[i], factoryAddr, chainId);
            address e = TermsLib.escrowAt(factoryAddr, h);
            assertEq(f.hashTerms(ts[i]), h, "hashTerms parity");
            assertEq(f.escrowOf(h), e, "escrowOf parity");
            termsOut = string.concat(
                termsOut,
                i == 0 ? "" : ",",
                '{"index":',
                vm.toString(i),
                ',"termsHash":"',
                vm.toString(h),
                '","vaultImpl":"',
                vm.toString(impl),
                '","escrow":"',
                vm.toString(e),
                '"}'
            );
        }
        termsOut = string.concat(termsOut, "]");

        uint256 nSamples = _count(json, ".payoutSamples");
        string memory samplesOut = "[";
        for (uint256 j; j < nSamples; ++j) {
            string memory p = string.concat(".payoutSamples[", vm.toString(j), "]");
            uint256 idx = vm.parseJsonUint(json, string.concat(p, ".termsIndex"));
            uint256 ts_ = vm.parseJsonUint(json, string.concat(p, ".ts"));
            IF.Terms memory t = ts[idx];
            uint256 payout = TermsLib.payout(t.amount, t.dueAt, t.deadline, t.slaFloorBps, ts_);
            assertEq(f.payoutAt(t, ts_), payout, "payoutAt parity");
            samplesOut = string.concat(
                samplesOut,
                j == 0 ? "" : ",",
                '{"termsIndex":',
                vm.toString(idx),
                ',"ts":',
                vm.toString(ts_),
                ',"payoutAt":"',
                vm.toString(payout),
                '"}'
            );
        }
        samplesOut = string.concat(samplesOut, "]");

        string memory out = string.concat(
            '{"v":1,"producer":"contracts (solc 0.8.30, KeyframeEscrowFactory + TermsLib)","input":"',
            "docs/design/vectors/terms-v1.input.json",
            '","inputSha256":"',
            vm.toString(sha256(bytes(json))),
            '","chainId":',
            vm.toString(chainId),
            ',"factory":"',
            vm.toString(factoryAddr),
            '","vaultImpl":"',
            vm.toString(impl),
            '","terms":',
            termsOut,
            ',"payoutSamples":',
            samplesOut,
            "}\n"
        );
        vm.writeFile(OUTPUT, out);
    }

    /// @dev Spot values that must never drift (frozen §5 decay formula, hand-computed).
    function test_vectors_payoutHandValues() public pure {
        // terms[1]: amount 100000, dueAt 1798760000, deadline 1798761600, floor 25%
        assertEq(TermsLib.payout(100_000, 1_798_760_000, 1_798_761_600, 2500, 1_798_759_999), 100_000);
        assertEq(TermsLib.payout(100_000, 1_798_760_000, 1_798_761_600, 2500, 1_798_760_000), 100_000);
        assertEq(TermsLib.payout(100_000, 1_798_760_000, 1_798_761_600, 2500, 1_798_760_800), 62_500);
        assertEq(TermsLib.payout(100_000, 1_798_760_000, 1_798_761_600, 2500, 1_798_761_600), 25_000);
        assertEq(TermsLib.payout(100_000, 1_798_760_000, 1_798_761_600, 2500, 1_798_800_000), 25_000);
    }
}

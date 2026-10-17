// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IKeyframeEscrowFactory} from "../interfaces/IKeyframeEscrowFactory.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title EIP-712 encoding of Terms v1 / Decision and the escrow address derivation (frozen-interfaces.md §1-§2)
/// @dev The pure helpers (`domainSeparator`, `digest`, `vaultImplOf`, `escrowAt`) reproduce what a factory deployed at
///      an arbitrary address computes, so off-chain parity vectors can be produced without deploying.
library TermsLib {
    bytes32 internal constant TERMS_TYPEHASH = keccak256(
        "Terms(address buyer,address seller,address operator,address token,uint256 amount,uint64 dueAt,uint64 deadline,"
        "uint32 reviewWindow,uint16 slaFloorBps,uint16 killFeeBps,bytes32 keyHash,bytes32 specHash,bytes32 contentHash,"
        "bytes32 salt)"
    );

    bytes32 internal constant DECISION_TYPEHASH = keccak256("Decision(bytes32 termsHash,bool accept,uint256 deadline)");

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    string internal constant NAME = "Keyframe Escrow";
    string internal constant VERSION = "1";

    /// @notice EIP-712 struct hash of Terms. Every member is a static type, so `abi.encode(typehash, t)` is exactly
    ///         `typehash ‖ enc(member_1) ‖ … ‖ enc(member_14)` with each member left-padded to 32 bytes.
    function structHash(IKeyframeEscrowFactory.Terms calldata t) internal pure returns (bytes32) {
        return keccak256(abi.encode(TERMS_TYPEHASH, t));
    }

    function structHashMem(IKeyframeEscrowFactory.Terms memory t) internal pure returns (bytes32) {
        return keccak256(abi.encode(TERMS_TYPEHASH, t));
    }

    function decisionStructHash(bytes32 termsHash, bool accept, uint256 sigDeadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(DECISION_TYPEHASH, termsHash, accept, sigDeadline));
    }

    function domainSeparator(address verifyingContract, uint256 chainId) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(NAME)), keccak256(bytes(VERSION)), chainId, verifyingContract)
        );
    }

    /// @notice termsHash as computed by a factory at `factory` on `chainId` (== viem `hashTypedData`).
    function digest(IKeyframeEscrowFactory.Terms memory t, address factory, uint256 chainId)
        internal
        pure
        returns (bytes32)
    {
        return MessageHashUtils.toTypedDataHash(domainSeparator(factory, chainId), structHashMem(t));
    }

    /// @notice VAULT_IMPL is the factory's first and only CREATE (contract nonce 1, EIP-161).
    function vaultImplOf(address factory) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes2(0xd694), factory, bytes1(0x01))))));
    }

    function escrowAt(address factory, bytes32 termsHash) internal pure returns (address) {
        return Clones.predictDeterministicAddress(vaultImplOf(factory), termsHash, factory);
    }

    /// @notice SLA decay, the frozen integer formula verbatim (frozen-interfaces.md §3). For any registrable Terms
    ///         (amount <= 50e6, bps <= 1e4, 64-bit timestamps) no product can overflow; absurd pure-call inputs
    ///         (amount above ~2^190) revert with an arithmetic panic, exactly as the formula implies.
    function payoutAt(IKeyframeEscrowFactory.Terms calldata t, uint256 ts) internal pure returns (uint256) {
        return payout(t.amount, t.dueAt, t.deadline, t.slaFloorBps, ts);
    }

    function payout(uint256 amount, uint64 dueAt, uint64 deadline, uint16 slaFloorBps, uint256 ts)
        internal
        pure
        returns (uint256)
    {
        if (dueAt == 0 || ts <= dueAt) return amount;
        uint256 floor = amount * slaFloorBps / 10_000;
        if (ts >= deadline) return floor;
        // dueAt < ts < deadline here, so the denominator is non-zero. Requires slaFloorBps <= 10_000 (valid Terms).
        return amount - (amount - floor) * (ts - dueAt) / (deadline - dueAt);
    }
}

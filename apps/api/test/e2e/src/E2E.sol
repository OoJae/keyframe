// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KeyframeEscrowFactory} from "keyframe/src/KeyframeEscrowFactory.sol";
import {MockUSDC} from "keyframe/test/utils/MockUSDC.sol";

/// @notice Test-only USDC stand-in: MockUSDC plus FiatTokenV2_2's (v, r, s) overload of transferWithAuthorization.
contract MockUSDCWithVRS is MockUSDC {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        this.transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }
}

/// @dev Forces the factory into this build.
abstract contract FactoryRef is KeyframeEscrowFactory {}

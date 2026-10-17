// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/// @title Keyframe escrow vault implementation
/// @notice Each escrow address E is a persistent EIP-1167 clone of this contract. The clone holds no logic of its
///         own: only the factory that created the implementation can move assets out, and the factory decides the
///         recipient from the Terms preimage of E (buyer or seller, never caller-chosen).
/// @dev No storage, no receive()/fallback(): ETH can only sit at E if it arrived before the clone was deployed.
///      FACTORY is an immutable of the implementation's runtime code, so every clone sees the same value.
contract KeyframeVault {
    using SafeERC20 for IERC20;

    address private immutable FACTORY = msg.sender;

    error OnlyFactory();

    /// @param token ERC-20 to move, or address(0) for native ETH
    function push(address token, address to, uint256 amount) external {
        if (msg.sender != FACTORY) revert OnlyFactory();
        if (token == address(0)) Address.sendValue(payable(to), amount);
        else IERC20(token).safeTransfer(to, amount);
    }
}

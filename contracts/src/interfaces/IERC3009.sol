// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice EIP-3009 subset used by the factory, as implemented by Circle FiatTokenV2_2 (Base USDC).
/// @dev The `bytes signature` overload is FiatTokenV2_2's; for a signer with code it verifies via ERC-1271.
interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

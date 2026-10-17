// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Read-only Blacklistable / Pausable subset of Circle FiatTokenV2_2 (Base USDC).
/// @dev The factory only uses these as best-effort pre-checks (registration, keeper view). Transfers stay the
///      authority: a USDC transfer fails exactly when the token is paused or either side is blacklisted.
interface IFiatTokenV2_2 {
    function isBlacklisted(address account) external view returns (bool);
    function paused() external view returns (bool);
}

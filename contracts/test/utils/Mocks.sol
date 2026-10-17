// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IKeyframeEscrowFactory} from "../../src/interfaces/IKeyframeEscrowFactory.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Plain ERC-20 for "stray token" deposits.
contract JunkToken is ERC20 {
    constructor() ERC20("Junk", "JNK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice ERC-20 that tries to re-enter the factory from inside `transfer`. Records whether the re-entry reverted.
contract ReentrantToken is ERC20 {
    IKeyframeEscrowFactory public factory;
    bytes public reentryCall;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor() ERC20("Reenter", "RNT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(IKeyframeEscrowFactory f, bytes calldata data) external {
        factory = f;
        reentryCall = data;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(factory) != address(0) && reentryCall.length != 0 && !reentryAttempted) {
            reentryAttempted = true;
            (reentrySucceeded,) = address(factory).call(reentryCall);
        }
    }
}

/// @notice ERC-1271 smart wallet owned by one ECDSA key (a "contract buyer").
contract ERC1271Wallet is IERC1271 {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
        return err == ECDSA.RecoverError.NoError && signer == owner ? IERC1271.isValidSignature.selector : bytes4(0);
    }
}

/// @notice EIP-7702 delegate without ERC-1271 (a typical batching account implementation).
contract PlainDelegate {
    function execute(address target, bytes calldata data) external payable returns (bytes memory) {
        require(msg.sender == address(this), "only self");
        (bool ok, bytes memory ret) = target.call{value: msg.value}(data);
        require(ok, "call failed");
        return ret;
    }
}

/// @notice EIP-7702 delegate that also answers ERC-1271 by checking the account's own ECDSA key.
contract Self1271Delegate is IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
        return
            err == ECDSA.RecoverError.NoError && signer == address(this)
                ? IERC1271.isValidSignature.selector
                : bytes4(0);
    }
}

/// @notice ERC-20 whose transfers to `hungry` burn a fixed amount of gas: models a token upgrade that makes transfers
///         expensive enough for the 63/64 rule to starve a nested push while the caller still completes.
contract GasHungryToken is ERC20 {
    uint256 public immutable burn;
    address public hungry;

    constructor(uint256 burn_) ERC20("Hungry", "HGR") {
        burn = burn_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHungry(address a) external {
        hungry = a;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to == hungry && to != address(0)) {
            uint256 start = gasleft();
            while (start - gasleft() < burn) {}
        }
        super._update(from, to, value);
    }
}

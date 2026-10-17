// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Keyframe escrow factory (frozen interface v1, docs/design/frozen-interfaces.md §1-§3)
/// @notice Every order is a set of Terms; its escrow address E is a counterfactual EIP-1167 clone at
///         CREATE2(factory, termsHash, cloneInitCode(VAULT_IMPL)). Funds at any E can only ever reach
///         `terms.buyer` or `terms.seller`.
interface IKeyframeEscrowFactory {
    struct Terms {
        address buyer; // payer; all refunds / change / late funds go here
        address seller; // payout address; must equal SELLER to ever be paid
        address operator; // studio hot key: may release / deliver / cancel; can never redirect funds
        address token; // must equal USDC to register / pay out (refunds work for any token)
        uint256 amount; // escrowed amount == x402 exact amount == max payout
        uint64 dueAt; // SLA start: 0 = no decay
        uint64 deadline; // reviewWindow == 0: last moment to release; > 0: last moment to deliver
        uint32 reviewWindow; // 0 = Instant (hash-lock); > 0 = Studio review seconds
        uint16 slaFloorBps; // payout share at deadline
        uint16 killFeeBps; // seller share if the buyer rejects during review
        bytes32 keyHash; // keccak256(K_chain)
        bytes32 specHash; // sha256(JCS(spec))
        bytes32 contentHash; // Instant: manifestHash; Studio: 0
        bytes32 salt; // keccak256(utf8(quote_id))
    }

    enum Status {
        None,
        Open,
        Delivered,
        Released,
        Refunded,
        Cancelled,
        Rejected
    }

    struct OrderView {
        Status status;
        address buyer;
        uint64 deadline;
        uint32 reviewWindow;
        uint64 openedAt;
        uint64 deliveredAt;
        uint64 finalAt;
        bool accepted;
        bytes32 key;
        bytes32 manifestHash;
        uint256 toSeller;
        uint256 toBuyer;
    }

    event Opened(bytes32 indexed termsHash, address indexed escrow, address indexed buyer, Terms terms);
    event Delivered(bytes32 indexed termsHash, bytes32 manifestHash);
    event Decided(bytes32 indexed termsHash, bool accepted, uint256 killFee);
    event Released(bytes32 indexed termsHash, bytes32 key, bytes32 manifestHash, uint256 toSeller, uint256 toBuyer);
    event Refunded(bytes32 indexed termsHash, uint256 toBuyer);
    event Cancelled(bytes32 indexed termsHash, uint256 toBuyer);
    event Swept(bytes32 indexed termsHash, address indexed token, uint256 toBuyer);

    /// @dev 1 token, 2 amount, 3 seller, 4 buyer0, 5 bps, 6 sla, 7 deadline, 8 operator0
    error BadTerms(uint8 code);
    error NotAuthorized();
    error BadKey();
    error BadStatus(uint8 status);
    error Underfunded(uint256 have, uint256 need);
    error TooEarly(uint256 at);
    error TooLate(uint256 at);
    error AlreadyRegistered();
    error BadSignature();
    error SignatureExpired();
    error ManifestMismatch();
    error ChargeTooHigh(uint256 max);

    // immutables / constants
    function USDC() external view returns (address);
    function SELLER() external view returns (address);
    function VAULT_IMPL() external view returns (address);
    function MIN_AMOUNT() external view returns (uint256);
    function MAX_AMOUNT() external view returns (uint256);
    function MAX_LIFETIME() external view returns (uint64);
    function RELEASE_GRACE() external view returns (uint64);

    // views
    function hashTerms(Terms calldata t) external view returns (bytes32);
    function escrowOf(bytes32 termsHash) external view returns (address);
    function payoutAt(Terms calldata t, uint256 ts) external pure returns (uint256);
    function order(bytes32 termsHash) external view returns (OrderView memory);
    function registryLength() external view returns (uint256);
    function refundableCount(uint256 maxScan) external view returns (uint256);

    // funding / registration (anyone)
    function fundWithAuthorization(
        Terms calldata t,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
    function register(Terms calldata t) external;

    // seller side (t.seller or t.operator)
    function release(Terms calldata t, bytes32 key, uint256 charge, bytes32 manifestHash) external;
    function deliver(Terms calldata t, bytes32 manifestHash) external;
    function cancel(Terms calldata t) external;

    // buyer side
    function decide(Terms calldata t, bool accept) external;
    function decideBySig(Terms calldata t, bool accept, uint256 sigDeadline, bytes calldata signature) external;

    // anyone
    function refund(Terms calldata t) external;
    function refundExpired(uint256 maxScan) external returns (uint256 refunded);
    function sweep(Terms calldata t, address token) external;
}

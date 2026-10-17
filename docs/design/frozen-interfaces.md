# Keyframe — Frozen interfaces v1 (SOURCE OF TRUTH)

This document wins over `architecture.md`, `product-render-demo.md` and `verification.md` on any conflict.
Everything here is frozen into the uploaded plugin bundle (portal upload lock: Sat 2026-10-17 20:00 EDT).
Anything NOT listed here (prices, catalog, templates, hosts, facilitator, keepers, copy) may evolve server-side.

Chain: Base mainnet `eip155:8453`. Token: Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals,
FiatTokenV2_2, EIP-712 domain name "USD Coin", version "2"). Amounts are atomic USDC as decimal strings in JSON.

---

## 1. Terms v1

```solidity
struct Terms {
  address buyer;        // payer; ALL refunds / change / late funds go here
  address seller;       // payout address; must equal factory SELLER to ever be paid
  address operator;     // studio hot key: may release/deliver/cancel; can never redirect funds
  address token;        // must equal factory USDC to register/pay out (refunds work for any token)
  uint256 amount;       // escrowed amount == x402 exact amount == max payout ("upto" ceiling)
  uint64  dueAt;        // SLA start: 0 = no decay; full payout if paid out at ts <= dueAt
  uint64  deadline;     // reviewWindow==0: last moment to release; >0: last moment to deliver
  uint32  reviewWindow; // 0 = Instant (hash-lock); >0 = Studio review seconds
  uint16  slaFloorBps;  // payout share at deadline (10000 = no decay)
  uint16  killFeeBps;   // seller share if buyer rejects during review (Studio)
  bytes32 keyHash;      // keccak256(K_chain)  (K_chain is 32 bytes)
  bytes32 specHash;     // sha256(JCS(spec))  — §6
  bytes32 contentHash;  // Instant render-before-pay: manifestHash (§5); Studio: 0x00…00
  bytes32 salt;         // keccak256(utf8(quote_id))
}
```

EIP-712 type string (exact):
```
Terms(address buyer,address seller,address operator,address token,uint256 amount,uint64 dueAt,uint64 deadline,uint32 reviewWindow,uint16 slaFloorBps,uint16 killFeeBps,bytes32 keyHash,bytes32 specHash,bytes32 contentHash,bytes32 salt)
```
Domain: `{ name: "Keyframe Escrow", version: "1", chainId: 8453, verifyingContract: <factory> }` (OZ `EIP712`, expose ERC-5267
`eip712Domain()`).
`termsHash = keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)` = viem `hashTypedData({domain, types:{Terms:[…]}, primaryType:"Terms", message:T})`.

Decision (Studio review) typed data, same domain:
```
Decision(bytes32 termsHash,bool accept,uint256 deadline)
```

JSON form of Terms (API ↔ plugin): all addresses EIP-55 checksummed strings; `amount` decimal string; `dueAt`, `deadline`,
`reviewWindow`, `slaFloorBps`, `killFeeBps` JSON integers; bytes32 as lowercase `0x` + 64 hex.

## 2. Escrow address derivation

- `VAULT_IMPL` = the ONLY contract created in the factory constructor ⇒ `VAULT_IMPL = getContractAddress({from: factory, nonce: 1})`.
- `E = Clones.predictDeterministicAddress(VAULT_IMPL, termsHash, factory)` (OpenZeppelin v5, canonical EIP-1167):
  `E = getCreate2Address({ from: factory, salt: termsHash, bytecodeHash: keccak256(0x3d602d80600a3d3981f3363d3d373d3d3d363d73 ‖ VAULT_IMPL ‖ 0x5af43d82803e903d91602b57fd5bf3) })`.
- The clone is deployed lazily by the first call that moves funds out of E, and is persistent. No SELFDESTRUCT, no transient storage.

## 3. Contracts (Solidity 0.8.30, cancun, OZ v5)

### KeyframeVault (implementation; clones delegatecall into it)
```solidity
address private immutable FACTORY = msg.sender;
function push(address token, address to, uint256 amount) external;  // only FACTORY; token==address(0) ⇒ ETH
// no receive()/fallback()
```

### KeyframeEscrowFactory
Constructor `(address usdc, address seller)`; immutables `USDC`, `SELLER`, `VAULT_IMPL`,
`MIN_AMOUNT = 100_000`, `MAX_AMOUNT = 50_000_000`, `MAX_LIFETIME = 30 days`, `RELEASE_GRACE = 3 days`.
Ownerless, no admin, no upgrade, never holds funds, no `receive()`.

```solidity
enum Status { None, Open, Delivered, Released, Refunded, Cancelled, Rejected }

struct OrderView {
  Status  status;
  address buyer;
  uint64  deadline;
  uint32  reviewWindow;
  uint64  openedAt;      // block.timestamp at registration
  uint64  deliveredAt;   // Studio
  uint64  finalAt;       // timestamp of terminal transition
  bool    accepted;      // Studio buyer accept
  bytes32 key;           // K_chain once released, else 0
  bytes32 manifestHash;  // set at release (Instant) or deliver (Studio)
  uint256 toSeller;
  uint256 toBuyer;
}

// views
function hashTerms(Terms calldata t) external view returns (bytes32);
function escrowOf(bytes32 termsHash) external view returns (address);
function payoutAt(Terms calldata t, uint256 ts) external pure returns (uint256);
function order(bytes32 termsHash) external view returns (OrderView memory);
function registryLength() external view returns (uint256);
function refundableCount(uint256 maxScan) external view returns (uint256);

// funding / registration (anyone)
function fundWithAuthorization(Terms calldata t, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external;
function register(Terms calldata t) external;

// seller side (msg.sender == t.seller || msg.sender == t.operator)
function release(Terms calldata t, bytes32 key, uint256 charge, bytes32 manifestHash) external;
function deliver(Terms calldata t, bytes32 manifestHash) external;   // Studio only (reviewWindow > 0)
function cancel(Terms calldata t) external;                          // void: everything to buyer

// buyer side
function decide(Terms calldata t, bool accept) external;             // msg.sender == t.buyer
function decideBySig(Terms calldata t, bool accept, uint256 sigDeadline, bytes calldata signature) external;

// anyone
function refund(Terms calldata t) external;
function refundExpired(uint256 maxScan) external returns (uint256 refunded);
function sweep(Terms calldata t, address token) external;

event Opened(bytes32 indexed termsHash, address indexed escrow, address indexed buyer, Terms terms);
event Delivered(bytes32 indexed termsHash, bytes32 manifestHash);
event Decided(bytes32 indexed termsHash, bool accepted, uint256 killFee);
event Released(bytes32 indexed termsHash, bytes32 key, bytes32 manifestHash, uint256 toSeller, uint256 toBuyer);
event Refunded(bytes32 indexed termsHash, uint256 toBuyer);
event Cancelled(bytes32 indexed termsHash, uint256 toBuyer);
event Swept(bytes32 indexed termsHash, address indexed token, uint256 toBuyer);

error BadTerms(uint8 code); // 1 token 2 amount 3 seller 4 buyer0 5 bps 6 sla 7 deadline 8 operator0
error NotAuthorized(); error BadKey(); error BadStatus(uint8 status); error Underfunded(uint256 have, uint256 need);
error TooEarly(uint256 at); error TooLate(uint256 at); error AlreadyRegistered(); error BadSignature();
error SignatureExpired(); error ManifestMismatch(); error ChargeTooHigh(uint256 max);
```

Validity `valid(T)` (register / fundWithAuthorization / release): `token == USDC`, `seller == SELLER`, `buyer != 0`,
`operator != 0`, `MIN_AMOUNT <= amount <= MAX_AMOUNT`, `block.timestamp < deadline <= block.timestamp + MAX_LIFETIME`
(checked at registration), `dueAt == 0 || dueAt < deadline`, `slaFloorBps <= 10000`, `killFeeBps <= 10000`.

`payoutAt(T, ts)`:
```
if (dueAt == 0 || ts <= dueAt) return amount;
floor = amount * slaFloorBps / 10000;
if (ts >= deadline) return floor;
return amount - (amount - floor) * (ts - dueAt) / (deadline - dueAt);
```

State machine (E = escrowOf(hashTerms(T)); "bal" = T.token balance of E; pay-outs always via the clone at E):

| From | Call | Guard | To | Money |
|---|---|---|---|---|
| None | `fundWithAuthorization` | valid(T); unregistered | Open | USDC `transferWithAuthorization(T.buyer → E, T.amount, …, signature)` (bytes overload) then register |
| None | `register` | valid(T); bal ≥ amount | Open | — |
| Open | `release` (rw == 0) | seller/operator; keccak256(key) == keyHash; now ≤ deadline; `contentHash == 0 ∨ manifestHash == contentHash`; bal ≥ amount; `charge ≤ payoutAt(T, now)` | Released | seller ← charge; buyer ← bal − charge |
| Open | `deliver` (rw > 0) | seller/operator; now ≤ deadline; bal ≥ amount | Delivered (deliveredAt = now) | — |
| Delivered | `decide/decideBySig(accept=true)` | buyer (or buyer sig, ECDSA first then ERC-1271); now < deliveredAt + rw | Delivered (accepted) | — |
| Delivered | `decide/decideBySig(accept=false)` | same; !accepted | Rejected | seller ← min(amount·killFeeBps/1e4, bal); buyer ← rest |
| Delivered | `release` (rw > 0) | seller/operator; key ok; manifestHash == stored; (accepted ∨ now ≥ deliveredAt + rw); now ≤ deliveredAt + rw + RELEASE_GRACE; `charge ≤ payoutAt(T, deliveredAt)` | Released | seller ← charge; buyer ← rest |
| None/Open/Delivered | `cancel` | seller/operator | Cancelled | buyer ← bal (no clone deploy if bal == 0) |
| None/Open | `refund` | now > deadline | Refunded | buyer ← bal |
| Delivered | `refund` | now > deliveredAt + rw + RELEASE_GRACE | Refunded | buyer ← bal |
| terminal | `sweep(T, T.token)` | — | same | buyer ← bal |
| any | `sweep(T, other token or address(0))` | — | same | buyer ← all of that asset |

`refundExpired(maxScan)`: iterate `registry[scanFrom … scanFrom+maxScan)`, refund eligible entries, advance `scanFrom` only across a
contiguous terminal prefix. `refundableCount(maxScan)` is the matching view (KeeperHub condition input).
All mutators `nonReentrant`; checks-effects-interactions. Unregistered T (status None) can still be refunded/cancelled/swept
(funds can always exit to `T.buyer`). Payout to a seller requires `seller == SELLER` and `token == USDC`.

Invariants (tests MUST encode): I1 tokens leaving any E go only to T.buyer or T.seller · I2 seller paid ≤ T.amount per T ·
I3 seller paid > 0 ⇒ (Released ∧ keccak(key) == keyHash ∧ before deadline/grace) ∨ (Rejected ∧ fee ≤ killFee) · I4 at most one terminal
state per T, terminal is absorbing (only sweep after) · I5 after terminal, residual/late funds reach only buyer · I6 factory and
VAULT_IMPL never hold tokens · I7 conservation across actors + escrows · I8 no function lets the caller choose a recipient ·
I9 no T with amount > MAX_AMOUNT can be registered or pay a seller · I10 a third party holding K cannot release (seller/operator only).

## 4. Keys

- `K_chain = HMAC-SHA256(KMASTER, utf8("kf/kchain/v1/" ‖ quote_id))` (32 bytes) — revealed on-chain in `release`.
- `K_buyer = HMAC-SHA256(KMASTER, utf8("kf/kbuyer/v1/" ‖ quote_id))` in **private** delivery, else 32 zero bytes (**public**).
- `keyHash = keccak256(K_chain)`. Spec carries `kBuyerHash = sha256(K_buyer)` (private) or `null` (public).
- KMASTER lives only in the API environment (secret). The render worker never holds keys.

## 5. KFC1 encrypted container (FROZEN)

- `K_file = HKDF-SHA256(IKM = K_chain ‖ K_buyer, salt = T.salt (32 bytes), info = utf8("keyframe/kfc1/file"), L = 32)`.
  **salt is T.salt, NOT termsHash** — termsHash depends on contentHash (= manifestHash), which depends on the ciphertext.
- Plaintext chunk size `1_048_560` bytes ⇒ each ciphertext chunk is exactly `1_048_576` bytes (last chunk shorter).
- Chunk i: AES-256-GCM, `nonce_i = 0x00000000 ‖ u64be(i)` (12 bytes), `AAD_i = utf8("KFC1") ‖ T.salt ‖ u64be(i) ‖ u64be(n)`.
- Manifest (canonicalized with JCS, §6):
  ```json
  {"v":1,"alg":"KFC1","salt":"0x…","chunkSize":1048560,"size":<plaintext bytes>,"chunks":<n>,
   "plaintextSha256":"0x…","ciphertext":["0x…sha256 of chunk 0", …],"plaintext":["0x…", …],
   "media":{"mime":"video/mp4","width":1080,"height":1920,"durationMs":6000,"fps":30}}
  ```
- `manifestHash = sha256(JCS(manifest))`. Instant: `T.contentHash = manifestHash`.
- Storage layout (public, immutable): `{FILES_BASE}/c/{manifestHash}/manifest.json`, `{FILES_BASE}/c/{manifestHash}/{i}.bin`.
  Optional IPFS mirror; the plugin checks hashes, never trusts locations.
- MP4s are encoded with `-movflags +faststart` so `moov` is in chunk 0.

## 6. Spec and canonicalization

JCS = RFC 8785 JSON Canonicalization Scheme. Spec objects contain only strings, booleans, null, integers (no floats), arrays, objects.
```json
{"v":1,"studio":"0x<seller>","tier":"instant|studio","format":"launch_sting|countdown|portfolio_pulse|kinetic_post|chart_moment|studio_sting|studio_spot|catalog",
 "style":"…","aspect":"9:16|1:1|16:9","durationS":6,"params":{…},"template":{"id":"…","version":"…","hash":"0x…"},
 "renderer":{"name":"hyperframes","version":"…"},"keyframe":{"stillSha256":"0x…","atMs":3400}|null,
 "delivery":"public|private","kBuyerHash":"0x…"|null,"dataSnapshotSha256":"0x…"|null}
```
`specHash = sha256(JCS(spec))`.

## 7. HTTP API v1 (plugin ↔ backend; responses may ADD fields, never remove/rename)

| Method & path | Purpose |
|---|---|
| `GET /v1/styles?tier&format` | catalog |
| `POST /v1/quotes` | create quote (body = `keyframe_quote` input minus plugin-only fields) |
| `GET /v1/quotes/{quote_id}` | quote (status `draft` → `final`; `expired`, `paid`, `cancelled`) |
| `ALL /v1/orders/{quote_id}` | **x402 resource**. Unpaid ⇒ 402 (byte-identical per quote, any method/headers). Paid ⇒ 200. 409 already paid / payer mismatch; 410 expired; 451 sanctioned; 503 at capacity (all "not charged") |
| `GET /v1/orders/{order_id}?token=` | order status (token = access_token for private detail) |
| `GET /v1/orders?buyer=0x…` | public list (ids + statuses) |
| `POST /v1/auth/siwe/challenge` `{address}` → `{message}`; `POST /v1/auth/siwe/verify` `{address,message,signature}` → `{orders:[…with access_token,k_buyer]}` | new-chat recovery |
| `POST /v1/reviews/{order_id}/challenge` `{access_token, decision}` → `{typed_data}`; `POST /v1/reviews/{order_id}/submit` `{access_token, decision, signature, sig_deadline}` → `{tx}` | Studio review |
| `GET /v1/stats`, `GET /llms.txt`, `GET /openapi.json`, `GET /health` | discovery & counter |

Quote object (fields the plugin relies on):
```json
{"v":1,"quote_id":"q_<22 base58>","status":"draft|final|paid|expired|cancelled","tier":"instant|studio","format":"…",
 "buyer":"0x…","price":{"atomic":"4000000","usdc":"4.00"},"eta_s":60,"quote_expires_at":<unix>,"deadline":<unix>,
 "factory":"0x…","vault_impl":"0x…","terms":{…Terms JSON…},"terms_hash":"0x…","escrow":"0x…",
 "spec":{…},"spec_hash":"0x…","preview":{"still_url":"…","still_sha256":"0x…","video_url":"…|null"},
 "content":{"manifest_url":"…|null","manifest_hash":"0x…|null"},"delivery":"public|private",
 "retry_after_ms":0,"disclosures":["…"]}
```
Paid 200 body: `{"v":1,"order_id":"o_<22 base58>","access_token":"<43 b64url>","quote_id":"…","terms_hash":"0x…","escrow":"0x…",
"amount":"…","deadline":<unix>,"funding_tx":"0x…","funding":"confirmed|pending","k_buyer":"0x…|null","status_url":"…","next":"keyframe_verify"}`

x402 402 (v2, default): header `PAYMENT-REQUIRED: base64(JSON)` with
`{"x402Version":2,"error":"Payment required","resource":{"url":"<PUBLIC_BASE>/v1/orders/<q>","description":"…","mimeType":"application/json"},
"accepts":[{"scheme":"exact","network":"eip155:8453","amount":"<atomic>","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","payTo":"<E>","maxTimeoutSeconds":300,"extra":{"name":"USD Coin","version":"2"}}]}`,
body `{}`. v1 fallback (`X402_WIRE=v1`): JSON body only, `network:"base"`, `maxAmountRequired`. Never both in one response.

## 8. Plugin tool surface (9 tools)

`keyframe_styles` (data) · `keyframe_quote` (data) · `keyframe_commission` (x402) · `keyframe_commission_direct` (evm) ·
`keyframe_status` (data) · `keyframe_verify` (data; `mode: derive|funding|delivery`; **derive is the offline conformance sample**) ·
`keyframe_refund` (evm; `action: refund|sweep|reject`) · `keyframe_review` (data) · `keyframe_orders` (data).
Exact zod schemas live in `plugin/src/schemas.ts` and are snapshotted to `plugin/tool-catalog.json` (CI diff gate).
Proposal tools return ONLY the starter's strict proposal schemas; human guidance goes in `content[].text`.

Plugin checks before ANY proposal: factory ∈ `KEYFRAME_FACTORIES` (status active), `T.seller ∈ KEYFRAME_SELLERS`,
`T.operator ∈ KEYFRAME_OPERATORS`, `T.token == USDC`, `amount <= KEYFRAME_MAX_AMOUNT <= 50 USDC`, recompute termsHash and E locally,
pre-fetch the live 402 and assert single version, scheme exact, Base, USDC, `payTo == E`, `amount == T.amount`.

## 9. Plugin env vars (names frozen; values editable after the lock; embedded defaults for offline conformance)

`KEYFRAME_API_BASE`, `KEYFRAME_FILES_BASE`, `KEYFRAME_FACTORIES` (JSON `[{"address","vaultImpl","status":"active|refund-only"}]`),
`KEYFRAME_SELLERS`, `KEYFRAME_OPERATORS`, `KEYFRAME_RPC_URLS` (comma), `KEYFRAME_IPFS_GATEWAY`, `KEYFRAME_MAX_AMOUNT`,
`KEYFRAME_PRIMARY_RAIL` (`x402|direct`), `KEYFRAME_7702_POLICY` (`x402-autoundelegate|direct-first`), `KEYFRAME_MAINTENANCE` (`0|1`).

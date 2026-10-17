<!-- Source: keyframe-design workflow (wf_54984e8c-060), system-architect agent, 2026-10-17. Reconciled decisions live in docs/design/frozen-interfaces.md, which WINS on any conflict. -->

# KEYFRAME: technical design (architect and smart-contract view), 2026-10-17

**Source key.** Each fact below is tagged with where I checked it.

- **[R]** `developer.paybox.sh/requirements.md`, fetched today.
- **[S]** Starter v1.0.2: `paybox.ts`, `plugin.ts`, `package.json`, `pnpm-workspace.yaml`, `scripts/{conformance,test,report,schema}.mjs`, `manifest.json`, and the `x402-request` / `base-transfer` examples.
- **[D]** `docs.paybox.sh/llms-full.txt`.
- **[X]** unpkg sources:
  - `@x402/hono@2.28.0` `dist/esm/index.mjs`
  - `@x402/core@2.28.0` (`x402Client-*.d.mts`, `chunk-FV2JN4FK.mjs`)
  - `@x402/evm@2.28.0` (`exact/server`, `exact/facilitator`, `chunk-DBLZWTJ6`, `chunk-P7ASDIFN`, `chunk-LQQ3M4DU`)
- **[B]** `docs.base.org/llms-full.txt`.
- **[OZ]** OpenZeppelin `Clones.sol` and Solady `LibClone.sol` (GitHub raw).
- **[L]** Live read-only GETs: `facilitator.payai.network/supported` and the 0xB10C OFAC ETH list.
- **[HF]** Local HyperFrames skill docs.
- **⚠ UNVERIFIED** marks anything not confirmed first-hand. The full list is in §8.

---

## 0. Decisions that drive everything

1. **What must be frozen in the bundle before Sat 8 pm EDT.** Tool names and schemas, the Terms v1 layout, the EIP-712 domain and type strings, the CREATE2/EIP-1167 derivation, event and function ABIs, the encryption format, and the spec canonicalization. Addresses, hosts and URLs are env vars, which stay editable after the lock [R]. The factory can be deployed and replaced after the lock as long as Terms v1 and the ABIs stay the same.
2. **Facts verified in the x402 source that shape the server:**
   - `PaymentOption.payTo: string | DynamicPayTo` and `price: Price | DynamicPrice` [X].
   - The v2 server emits **only** the `PAYMENT-REQUIRED` header. The body is `{}` or `unpaidResponseBody` [X].
   - `resource.url = routeConfig.resource || adapter.getUrl()` [X].
   - A v2 paid request matches by **`deepEqual` on the core requirement fields** (scheme, network, amount, asset, payTo, maxTimeoutSeconds), which is case-sensitive [X].
   - The exact-EVM verify step checks `to == payTo`, `value == amount` (exact), `validBefore ≥ now+6`, and simulates the transfer. It never checks payTo's code, so a codeless payTo works [X].
   - The exact-EVM settle step calls `transferWithAuthorization`, waits for the receipt, and checks the Transfer log [X].
   - The `@x402/hono` middleware runs verify → handler → (status ≥ 400 ⇒ cancel, no settle) → settle [X]. The handler therefore can't put the settlement tx in its body, and it rebuilds `resource.url` from the request.
   - **Decision:** use `x402HTTPResourceServer` from `@x402/core` directly, inside a thin custom Hono route (about 80 lines). This gives a canonical URL, business checks before settlement, settlement before the response (so the tx hash is in the body), and byte-identical idempotent replays. The open-source package also ships a stock-`@x402/hono` variant of about 20 lines (§3.8).
3. **Base mainnet RPC.** `https://mainnet.base.org` is Flashblocks-aware and returns receipts at Flashblock inclusion, about 200 ms [B]. The paid response can therefore confirm funding within about 1–1.5 s.
4. **Clone flavour.** Solady's `LibClone` uses a **non-canonical** proxy init code (`0x602c3d8160093d39f33d…`), while OpenZeppelin's `Clones` uses canonical EIP-1167 (`3d602d80600a3d3981f3363d3d373d3d3d363d73‖impl‖5af43d82803e903d91602b57fd5bf3`) [OZ]. **Use OZ Clones** so that Basescan labels E "Minimal Proxy" and the plugin's derivation is the textbook one.

---

## (a) Monorepo layout (pnpm 11.11.0, Node 24.21.0)

```
/Users/oluwademilade/Desktop/paybox/             # repo "keyframe"
├─ package.json  pnpm-workspace.yaml (packages: packages/*, apps/*, templates — NOT plugin/)
├─ .nvmrc(24.21.0)  biome.json  tsconfig.base.json  .github/workflows/{ci,keeper-cron,synthetic}.yml
├─ plugin/            STANDALONE pnpm root = starter v1.0.2, tooling byte-identical
│  ├─ package.json    starter + "viem":"2.51.3" (exact, per [R]); name "keyframe"; scripts unchanged (+ "unit")
│  ├─ pnpm-lock.yaml  pnpm-workspace.yaml(packages ["."], allowBuilds esbuild)  tsconfig.json  .gitignore
│  ├─ starter-version.json  scripts/{conformance,test,process,report,schema}.mjs   ← CI checks sha256 vs starter manifest.json
│  ├─ paybox-plugin.json  (sample = offline keyframe_verify derive, §d.5)
│  └─ src/ plugin.ts (registers 8 tools) · paybox.ts (starter, unchanged) · tools/*.ts (one per tool)
│        protocol/ (GENERATED copy of packages/protocol/src; header "do not edit"; CI diff gate)
│        net.ts (Budget-bounded fetch) · rpc.ts (JSON-RPC batch, 2-RPC cross-check) · crypto.ts (WebCrypto HKDF/AES-GCM)
│        mp4.ts (moov/mvhd/tkhd parser) · config.ts (env + embedded defaults) · catalog.fallback.json
├─ packages/
│  ├─ protocol/       @keyframe/protocol — Terms v1 zod + EIP-712 types, hashTerms, escrowOf, vaultImplOf, ABIs,
│  │                  Decision typed data, JCS canonicalize + specHash, manifest schema, KF-AES256GCM-HKDF-CHUNK-v1,
│  │                  test-vector loader. Deps: viem 2.51.3, zod 4.4.3 only. NodeNext-style ".js" imports.
│  └─ pod/            @keyframe/pod (MIT) — "pay-on-delivery for any x402 seller": escrowAccepts() for stock @x402/hono,
│                     PodFacilitator (fundWithAuthorization settle, idempotency, PayAI fallback), publishDelivery(),
│                     verifyDelivery(), keeper(); re-exports protocol.
├─ contracts/         Foundry: src/{KeyframeEscrowFactory,KeyframeVault}.sol, src/interfaces/, test/{unit,invariant,fork,halmos},
│                     test/vectors/terms-v1.json (written by forge, read by TS tests), script/Deploy.s.sol,
│                     deployments/8453.json, THREAT_MODEL.md. lib/: openzeppelin-contracts v5.x, forge-std (pinned submodules)
├─ apps/
│  ├─ api/            Hono on Node 24 (@hono/node-server): quote engine, x402 resource server + self-facilitator, relayer,
│  │                  order state machine, chain indexer/watcher, keeper cron, delivery (encrypt/upload/self-verify/release),
│  │                  OFAC screening, stats, llms.txt/openapi.json, internal worker API. Postgres. pino.
│  ├─ worker/         Render box (Docker: Chrome + ffmpeg + HyperFrames CLI): claims jobs over HTTPS from api, renders
│  │                  still/preview/master, PUTs to presigned private R2 URLs. Holds NO keys.
│  ├─ keeper/         Chain-only refund keeper + `npx @keyframe/refund <escrow|termsHash>` CLI (reads Opened logs/records).
│  └─ web/            Static site: landing, single-URL order form, live counter, client-side verify/decrypt page, docs.
├─ templates/         Human-designed HyperFrames compositions (launch-sting, pnl-card, price-chart, kinetic-tweet,
│                     countdown, heartbeat), each with variables schema, version = git tree hash, golden renders.
└─ docs/              architecture.md, x402-interop-log.md (raw day-1 probe captures), runbook.md, demo-script.md
```

**Why `plugin/` sits outside the workspace.** The starter's `pnpm-workspace.yaml` makes the plugin its own workspace root with its own frozen lockfile [S]. Pulling in shared code through workspace links would let esbuild resolve a second copy of viem and break reproducibility. Shared code is vendored by `pnpm sync:protocol` instead, with sorted file order and no timestamps. The workspace pins viem 2.51.3 and zod 4.4.3 through a pnpm catalog, so ABI encoding is identical across packages.

**Build determinism [S].**
- `pnpm test` builds twice and requires identical bytes. So: no `--define` with time, git or env values, and no build-time I/O beyond the sources.
- The JSON fallback catalog and fixtures are static.
- Import only `viem` utilities: `hashTypedData`, `getCreate2Address`, `getContractAddress`, `keccak256`, `encodeFunctionData`, `decodeEventLog`, `recoverTypedDataAddress`, `parseAbi`. No `createPublicClient` (`rpc.ts` is a hand-rolled bounded batch client).
- Module top level does only `registerTool` calls: no network and no side effects at discovery [R].

---

## (b) Escrow contracts

### b.1 Terms v1 (FROZEN) and hashing

```solidity
struct Terms {
  address buyer;        // payer; ALL refunds/change/late funds go here
  address seller;       // payout (studio PayBox wallet B); must == SELLER immutable to ever be paid
  address operator;     // studio hot key (relayer): may deliver/release/cancel, choose `charge`; can never redirect funds
  address token;        // Base USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
  uint256 amount;       // escrowed amount == x402 exact amount == max payout ("upto" ceiling)
  uint64  slaStart;     // 0 = no decay; else full payout if released/delivered at ts <= slaStart
  uint64  deadline;     // reviewWindow==0: last moment to release; >0: last moment to deliver
  uint32  reviewWindow; // 0 = Instant HTLC; >0 = Studio review mode (seconds)
  uint16  slaFloorBps;  // payout floor at deadline, bps of amount
  uint16  killFeeBps;   // seller share if buyer rejects in review
  bytes32 keyHash;      // keccak256(K_chain)
  bytes32 specHash;     // sha256(JCS(spec))
  bytes32 salt;         // keccak256(utf8(quote_id))
}
```

- **Type string:** `Terms(address buyer,address seller,address operator,address token,uint256 amount,uint64 slaStart,uint64 deadline,uint32 reviewWindow,uint16 slaFloorBps,uint16 killFeeBps,bytes32 keyHash,bytes32 specHash,bytes32 salt)`
- **Domain:** `{name:"Keyframe Escrow", version:"1", chainId:8453, verifyingContract:factory}` (OZ `EIP712`, ERC-5267 `eip712Domain()` exposed).
- **`termsHash`** is the full EIP-712 digest: `_hashTypedDataV4(structHash)`, which equals viem `hashTypedData`. It binds the chain and the factory, so the same E can never be valid on another chain.
- **Decision typed data:** `Decision(bytes32 termsHash,bool accept,uint256 deadline)`, same domain.

### b.2 Counterfactual address

- `VAULT_IMPL = address(new KeyframeVault())`. This MUST be the only CREATE in the factory constructor, so `VAULT_IMPL = getContractAddress({from: factory, nonce: 1})` (EIP-161).
- `E = Clones.predictDeterministicAddress(VAULT_IMPL, termsHash, factory)`, which is `getCreate2Address({from: factory, salt: termsHash, bytecodeHash: keccak256(0x3d602d80600a3d3981f3363d3d373d3d3d363d73 ‖ impl ‖ 0x5af43d82803e903d91602b57fd5bf3)})`.
- The plugin needs only `KEYFRAME_FACTORY` and prints all four inputs.
- The clone is deployed lazily (`code.length==0` ⇒ `cloneDeterministic`) by the first action that moves funds, and is **persistent**. No SELFDESTRUCT, no transient-storage runner.

```solidity
contract KeyframeVault {                       // implementation; clones delegatecall into it
  address private immutable FACTORY = msg.sender;  // immutables live in impl code → visible in clones
  error OnlyFactory();
  function push(address token, address to, uint256 amt) external {
    if (msg.sender != FACTORY) revert OnlyFactory();
    if (token == address(0)) Address.sendValue(payable(to), amt);   // ETH that arrived pre-deploy
    else SafeERC20.safeTransfer(IERC20(token), to, amt);
  }
  // no receive()/fallback(): ETH sent after deployment reverts
}
```

### b.3 Storage and state machine

```solidity
enum Status { Open, Delivered, Released, Refunded, Cancelled, Rejected }  // Open==0 (default, incl. unregistered)
struct Record {            // 2 slots
  address buyer; uint64 deadline; Status status; bool accepted;          // slot 0 (buyer==0 ⇒ unregistered)
  uint40 openedBlock; uint40 finalBlock; uint40 deliveredAt; uint32 reviewWindow; // slot 1 (blocks = O(1) log lookups)
}
mapping(bytes32 => Record) public records;  bytes32[] public registry;  uint256 public scanFrom;
```

| From | Call (who) | Guard | To | Money |
|---|---|---|---|---|
| Open | `fundWithAuthorization(T,…)` (anyone; our relayer) | valid(T), seller==SELLER, deadline∈(now, now+MAX_LIFETIME], unregistered | Open (registered) | buyer→E via USDC EIP-3009 (`from=T.buyer`, `value=T.amount`, `to=E` fixed by the signature) |
| Open | `open(T)` (anyone) | same, plus `bal(E) ≥ amount` | Open (registered) | none |
| Open | `release(T,K,charge,mh)` (seller/operator) | rw==0, keccak(K)==keyHash, now ≤ deadline, bal ≥ amount | **Released** | seller `min(charge, payoutAt(T,now))`; rest of bal → buyer |
| Open | `deliver(T,mh)` (seller/operator) | rw>0, now ≤ deadline, bal ≥ amount | Delivered (`deliveredAt=now`) | none |
| Delivered | `decide/decideBySig(T,true)` (buyer or buyer sig) | now < deliveredAt+rw | Delivered (`accepted`) | none |
| Delivered | `decide/decideBySig(T,false)` | now < deliveredAt+rw, !accepted | **Rejected** | seller `min(amount·killFeeBps/1e4, bal)`; rest → buyer |
| Delivered | `release(T,K,charge,mh)` (seller/operator) | keccak(K)==keyHash, (accepted ∨ now ≥ deliveredAt+rw), now ≤ deliveredAt+rw+RELEASE_GRACE | **Released** | seller `min(charge, payoutAt(T,deliveredAt))`; rest → buyer |
| Open/Delivered | `cancel(T)` (seller/operator) | — | **Cancelled** | all → buyer (no clone deploy if bal==0) |
| Open | `refund(T)` / `refundByHash(h)` / `refundExpired(n)` (anyone) | now > deadline | **Refunded** | all → buyer |
| Delivered | same | now > deliveredAt+rw+RELEASE_GRACE | **Refunded** | all → buyer |
| terminal | `sweep(T, T.token)` (anyone) | status terminal | same | all → buyer (late or duplicate funds) |
| any | `sweep(T, other or address(0))` (anyone) | — | same | all → buyer |

- **SLA decay:**
  ```
  payoutAt(T,ts) = (slaStart==0 || ts<=slaStart) ? amount
                 : ts>=deadline ? amount·floor/1e4
                 : amount − (amount − amount·floor/1e4)·(ts−slaStart)/(deadline−slaStart)
  ```
  It is monotone non-increasing.
- **"Upto" change:** the operator passes `charge` (the actual price). The change goes back to the buyer in the same tx.
- **Who may release.** Release is restricted to seller/operator. This removes any front-running of `charge`. The key is still published publicly by whoever releases.
- **Refunds and cancels work for any T** (even when seller ≠ SELLER or the token isn't USDC), so funds at any E can always leave toward `T.buyer`. Payout to a seller requires `seller==SELLER` and `token==USDC`.

### b.4 Interface (functions, events, errors)

```solidity
interface IKeyframeEscrowFactory {
  // immutables (ctor: usdc, seller, minAmount=100_000, maxAmount=50_000_000, maxLifetime=30 days, releaseGrace=3 days)
  function USDC() external view returns (address);       function SELLER() external view returns (address);
  function VAULT_IMPL() external view returns (address); function MIN_AMOUNT() external view returns (uint256);
  function MAX_AMOUNT() external view returns (uint256); function MAX_LIFETIME() external view returns (uint64);
  function RELEASE_GRACE() external view returns (uint64);
  // views
  function hashTerms(Terms calldata t) external view returns (bytes32);
  function escrowOf(bytes32 termsHash) external view returns (address);
  function payoutAt(Terms calldata t, uint256 ts) external pure returns (uint256);
  function registryLength() external view returns (uint256);
  function refundableCount(uint256 maxScan) external view returns (uint256);  // KeeperHub Condition input
  // funding / registration
  function fundWithAuthorization(Terms calldata t, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata sig) external;
  function open(Terms calldata t) external;
  // seller side
  function deliver(Terms calldata t, bytes32 manifestHash) external;
  function release(Terms calldata t, bytes32 key, uint256 charge, bytes32 manifestHash) external;
  function cancel(Terms calldata t) external;
  // buyer side
  function decide(Terms calldata t, bool accept) external;
  function decideBySig(Terms calldata t, bool accept, uint256 sigDeadline, bytes calldata sig) external;
  // anyone
  function refund(Terms calldata t) external;
  function refundByHash(bytes32 termsHash) external;              // registered orders only (uses Record)
  function refundExpired(uint256 maxScan) external returns (uint256 refunded); // bounded scan from scanFrom
  function sweep(Terms calldata t, address token) external;

  event Opened(bytes32 indexed termsHash, address indexed escrow, address indexed buyer, Terms terms);
  event Delivered(bytes32 indexed termsHash, bytes32 manifestHash);
  event Decided(bytes32 indexed termsHash, bool accepted, uint256 killFee);
  event Released(bytes32 indexed termsHash, bytes32 key, bytes32 manifestHash, uint256 toSeller, uint256 toBuyer);
  event Refunded(bytes32 indexed termsHash, uint256 toBuyer);
  event Cancelled(bytes32 indexed termsHash, uint256 toBuyer);
  event Swept(bytes32 indexed termsHash, address indexed token, uint256 toBuyer);

  error BadTerms(uint8 code); // 1 token 2 amount 3 seller 4 buyer0 5 bps 6 slaWindow 7 deadline 8 operator0
  error NotAuthorized(); error BadKey(); error BadStatus(Status s); error Underfunded(uint256 have, uint256 need);
  error TooEarly(uint256 at); error TooLate(uint256 at); error AlreadyRegistered(); error BadSignature(); error SignatureExpired();
}
```

- **`fundWithAuthorization`** is the contract-as-facilitator graft. It computes `E=escrowOf(hashTerms(t))` and calls USDC `transferWithAuthorization(t.buyer, E, t.amount, va, vb, nonce, v, r, s)` when the signature is 65 bytes, or the `bytes` overload otherwise. Both overloads are in the ABI x402 uses [X]. It then registers the order and emits `Opened` with the full T, so payment and terms publication happen in one atomic tx. A third party that front-runs the authorization only lands funds at E; then `open(T)` registers.
- **`decideBySig`** first tries `ECDSA.tryRecover`, then ERC-1271. Do not use OZ `SignatureChecker`'s code-length branch: 7702-delegated EOAs have code but still sign with ECDSA.
- **`refundExpired(maxScan)`.** Iterate `registry[scanFrom … scanFrom+maxScan)` and refund those whose refund condition holds. Advance `scanFrom` only across a contiguous terminal prefix. Bounded gas; KeeperHub calls `refundExpired(20)`.
- All mutators are `nonReentrant` (OZ storage-based guard) and follow checks-effects-interactions.

### b.5 Sanctions hook: decision

**No on-chain oracle call in the factory.**
- Screening happens off-chain at quote time and again in the paid handler before settlement, against the OFAC SDN ETH list [L] (lowercased, refreshed daily, last-good copy kept in Postgres, quoting fails closed if stale for more than 7 days). The Chainalysis free API or on-chain oracle can be added as an optional second layer via eth_call (⚠ address on Base unverified).
- Rationale:
  - A sanctioned payer is never settled.
  - Circle's USDC blacklist is the token-level on-chain backstop.
  - An oracle inside `refund` could only turn refunds into permanent freezes, and it would add a third-party admin to an ownerless escrow.
- The open-source factory exposes an optional `SANCTIONS_ORACLE` constructor variant for other sellers. Keyframe deploys with it disabled.

### b.6 Caps and validation

- Per-order bounds: `MIN_AMOUNT` 0.10 USDC (spam floor) and `MAX_AMOUNT` 50 USDC, enforced at register and release. An over-cap T can only be refunded.
- `deadline ≤ now+30d`; `bps ≤ 10_000`; `slaStart < deadline`.
- The factory never holds funds and has no `receive()`.

### b.7 Reentrancy and griefing

| Vector | Result |
|---|---|
| Malicious token in `sweep` re-enters | `nonReentrant`; sweep only ever pays `T.buyer`; status is untouched |
| Dust or duplicate deposits to E | Release pays ≤ cap to seller and the remainder to buyer; post-terminal funds are sweepable to buyer |
| Someone else settles the EIP-3009 authorization first | Funds still land at E (`to` is signed); our call reverts "authorization used"; server calls `open(T)` (§c.5) |
| Junk `open(T)` spam | Needs seller==SELLER, a funded E and ≥ 0.10 USDC, so the spammer funds their own refundable escrow; keeper scan is bounded |
| Unregistered T forged for a real E | Impossible: E = f(hash(T)) |
| Blacklisted buyer or seller (USDC) | Seller blacklisted: release reverts, buyer refunds after deadline. Buyer blacklisted: refund reverts and funds wait at E (documented; Circle-level) |
| USDC paused past the deadline | Release is impossible, refund after unpause (documented seller risk) |
| Relayer key stolen | Can cancel (refunds buyers) and drain gas; cannot redirect funds; cannot release without K (K derived from KMASTER, held only by the API) |
| Base 200 ms blocks (Denim) [B] | Logic uses `block.timestamp`; block numbers are only log-lookup hints |

### b.8 Verification plan

- **Foundry invariants.** Handler actors: buyer, seller, operator, attacker, keeper. Random T, warps, deposits (USDC, dust, duplicates, junk ERC-20, ETH pre-deploy) and call sequences. Ghost ledgers track every Transfer out of every E. Invariants:
  1. Every token leaving any E goes only to `T.buyer` or `T.seller`.
  2. `sellerPaid(T) ≤ T.amount`, and `> 0` ⇒ (Released ∧ revealed K matches keyHash) ∨ (Rejected ∧ fee ≤ killFee).
  3. The factory and VAULT_IMPL USDC balances are always 0.
  4. Terminal states are absorbing (only sweep runs afterwards), and at most one of {release, refund, cancel, reject} succeeds per T.
  5. After terminal + sweep, E's T.token balance is 0.
  6. `escrowOf(h)` equals the deployed clone address and the code equals the EIP-1167 runtime pointing at VAULT_IMPL.
  7. `scanFrom` only advances over terminal entries.
- **Halmos** (`check_*`, symbolic T/K/ts, mock EIP-3009 token):
  - `check_releaseNeedsPreimage`
  - `check_onlyPartiesReceive` (any 2-call sequence)
  - `check_payoutBoundsMonotone`
  - `check_noDoubleSettle`
  - `check_refundAfterDeadlineAlwaysSucceeds` (non-blacklisting token)
  - `check_reviewRejectFeeBound`
  - `check_escrowOfMatchesClone`
- **Base mainnet fork tests (real FiatTokenV2_2):**
  1. EIP-3009 via `fundWithAuthorization` (vm.sign).
  2. Front-run with a direct `transferWithAuthorization`, then `open`.
  3. On-time release and clone code check.
  4. SLA mid-decay payout.
  5. Refund by a random EOA.
  6. Cancel before funding, then late direct transfer, then sweep.
  7. Duplicate funding: price to seller, change to buyer.
  8. Upto `charge` < amount.
  9. Review: deliver → decideBySig reject (EOA and 1271 mock and 7702-delegated EOA via `vm.signDelegation`).
  10. Release-grace expiry refund.
  11. `refundExpired` bounded gas.
  12. Blacklisted buyer (prank USDC `blacklister()`) shows the documented stuck behavior.
  13. Gas snapshots.
  14. **Vector parity:** `test_vectors` writes `test/vectors/terms-v1.json` (T → termsHash, E, impl), and TS tests in protocol and plugin assert equality.
- **Deploy.**
  - Compiler: solc 0.8.30 (pinned), optimizer 10k, `evm_version=cancun`, no via-IR. Deterministic deployer `0x4e59b44847b379578588920ca78fbf26c0b4956c` with salt `keccak("keyframe.escrow.v1")`.
  - `forge script script/Deploy.s.sol --broadcast --verify` (Etherscan v2 key, chainid 8453), plus Sourcify.
  - Write `deployments/8453.json` with the addresses and the factory/impl runtime code hashes (these feed the plugin env `KEYFRAME_FACTORY_CODEHASH`).
  - Smoke-test a 0.10 USDC order between own wallets.
  - Publish verified source and THREAT_MODEL.md. No real orders until fork + invariant + Halmos are green.

---

## (c) x402 server (`apps/api`)

### c.1 Endpoints

| Endpoint | Behaviour |
|---|---|
| `GET /v1/catalog?tier&format` | Formats, params schemas, prices, ETA, sample/still URLs (≤ 32 KB, cacheable) |
| `POST /v1/quotes` | Body `{buyer, tier, format, params, aspect?, deadline_minutes?, private_delivery?, attest:{brand_rights:true, no_real_person_likeness:true}, notes?, client}`. Steps: zod per-template validation → content policy → OFAC screen of buyer → price → build spec + T → persist. Returns quote JSON (§d.3). p95 < 1.5 s. Rate-limited per IP and buyer |
| `GET /v1/quotes/{qid}` | Same JSON (re-fetched by the commission tools) |
| `POST /v1/quotes/{qid}/rail` | `{rail:"direct"}` puts E on the direct-transfer watcher (best effort) |
| `POST /v1/orders/{qid}` | **x402 resource** (c.2–c.5). Unpaid: 402. Expired: 410. Already paid: 409 `{order_id}` (no 402, prevents double pay) |
| `GET /v1/orders/{oid}` | Public status/timeline (no secrets); `?token=` adds private preview, k_buyer re-delivery, download |
| `GET /v1/orders?buyer=0x…` | Public list (ids + statuses) |
| `POST /v1/orders/{oid}/decision` | `{accept, sigDeadline, signature}`: verify sig == T.buyer, relay `decideBySig` |
| `GET /v1/orders/new?format=…&buyer=…&nonce=…&…` | **Single-URL order form for any x402 client.** The first request materializes a quote with `qid = q_ + base58(sha256(canonical URL))[:22]`; every later request is byte-identical |
| `GET /v1/stats` | Live counter from indexed factory events |
| `/llms.txt`, `/openapi.json` | Discovery |
| `/internal/*` (bearer) | Worker claims jobs and receives presigned PUTs |

### c.2 Deterministic 402 (probe, approval-time re-fetch, developer validation)

```ts
const http = new x402HTTPResourceServer(new x402ResourceServer(keyframeFacilitator), {
  "POST /v1/orders/:qid": {
    accepts: { scheme: "exact", network: "eip155:8453", maxTimeoutSeconds: 300,
      payTo: async (ctx) => (await quoteFromPath(ctx.path)).escrow,                       // EIP-55 checksummed E
      price: async (ctx) => ({ amount: (await quoteFromPath(ctx.path)).terms.amount,    // atomic string, never "$x"
                               asset: USDC, extra: { name: "USD Coin", version: "2" } }) },  // [X] default asset
    description: "Keyframe pay-on-delivery order", mimeType: "application/json",
    unpaidResponseBody: async (ctx) => ({ contentType: "application/json", body: { quote_id: qidOf(ctx.path) } }),
  }});
class CanonicalAdapter extends HonoAdapter { getUrl() { return PUBLIC_BASE_URL + this.c.req.path; } } // never trust proxy scheme/host
```

**Determinism checklist:**
- payTo, amount, asset and extra come only from the stored quote.
- `maxTimeoutSeconds` is constant; resource URL, description and mimeType are constant per quote.
- `error` is the constant "Payment required".
- No timestamps or random IDs anywhere in the 402.
- `Cache-Control` uses x402's no-store constant.
- One wire version per response: v2 header only (default) [X].
- The `quoteFromPath` in-process LRU cache is keyed by qid and immutable after creation.
- An hourly synthetic probe compares the raw 402 bytes against the stored golden copy.

`X402_WIRE=v1` switches to a v1 JSON body (`network:"base"`, `maxAmountRequired`) with no header, for the case where the live test demands it. `@x402/evm` registers v1 exact on the facilitator side [X].

### c.3 Paid path (verify, then business checks, then settle; target ≤ 1.5 s, hard 2 s)

```
POST /v1/orders/:qid  (PAYMENT-SIGNATURE | X-PAYMENT)
 1 quoteGuard: load quote (unpaid requests: 410 expired/cancelled, 409 paid; paid requests fall through)
 2 http.processHTTPRequest(ctx) → x402 verify (sig, to==E, value==amount, validBefore≥now+6, eth_call simulation) [X]
     tolerant-match shim: if accepted.payTo/asset equal ours case-insensitively, rewrite to our exact strings before matching
 3 business checks (no money has moved):
     from == T.buyer  else 409 payer_mismatch      | OFAC(from) clean  else 451
     render heartbeat < 60 s && queue < N  else 503 | deadline − now ≥ eta + 5 min  else 410
     CAS: UPDATE quotes SET state='settling', pay_nonce=$n, payer=$from WHERE id=$qid AND state='awaiting_payment'
       0 rows → same nonce & paid ⇒ return stored 200 body+headers byte-identically (replay); different nonce ⇒ 409
   any failure → cancellationDispatcher.cancel({reason:"handler_failed"}) and return 4xx ("you were not charged")
 4 http.processSettlement(...) → KeyframeFacilitator.settle (c.4); on failure → quote back to awaiting_payment, 402 + PAYMENT-RESPONSE
 5 create order, access_token = b64url(HMAC(ACCESS_SECRET, order_id)), k_buyer (private mode), enqueue render;
   store paid_response; return 200 + PAYMENT-RESPONSE
```

Paid 200 body (about 600 B):

```json
{"v":1,"order_id":"o_…","access_token":"…43…","quote_id":"q_…","terms_hash":"0x…","escrow":"0x…",
 "amount":"8000000","deadline":1792275300,"funding_tx":"0x…","funding":"confirmed|pending",
 "k_buyer":null,"status_url":"https://<api-host>/v1/orders/o_…","next":"keyframe_status"}
```

**Timing budget:**

| Step | Time |
|---|---|
| verify (2–3 RPC calls) | 0.2–0.5 s |
| checks + CAS | ~30 ms |
| broadcast | ~0.1 s |
| Flashblock receipt poll on mainnet.base.org [B] | 0.2–0.6 s, capped at a 1.2 s wait; then `funding:"pending"`, a background confirm, and `success:true` with the tx in PAYMENT-RESPONSE |

### c.4 Facilitator: self-facilitation first, PayAI fallback, never x402.org

`KeyframeFacilitator implements FacilitatorClient` [X]:
- `verify` delegates to a local `x402Facilitator` + `registerExactEvmScheme` with a **read-only** signer (publicClient; writes throw).
- `getSupported` is local (v2 exact eip155:8453, plus v1 when that wire is enabled).
- `settle`, in order:
  1. Idempotency row lookup by `(from, nonce)`.
  2. `authorizationState(from, nonce)`: if used, treat as settled. Find the Transfer to E via logs, `open(T)` if unregistered, return success.
  3. Relayer sends `factory.fundWithAuthorization(T, validAfter, validBefore, nonce, sig)` and checks the receipt's USDC `Transfer(from→E, amount)` like x402 does [X].
  4. If the relayer can't send (no gas, nonce stuck), fall back to `HTTPFacilitatorClient({url:"https://facilitator.payai.network"})`, which supports v2 exact on eip155:8453 per a live GET [L]. That path is a plain `transferWithAuthorization` to E, followed by a deferred `open(T)`.
  5. Map "authorization used" with E funded to success. Map insufficient balance or expiry to failure (no charge).
- Never return `settlement_pending`: core retries once on it [X]. Pending confirmation is tracked internally.
- **Relayer:** a single hot EOA (`operator`) with the viem nonceManager in a single API instance, an EIP-1559 fee bump after 30 s, a `chain_txs` journal, and an ETH balance alarm.

### c.5 Direct rail (7702-delegated wallets or x402 failure)

- The plugin proposes `USDC.transfer(E, amount)` [R].
- The watcher polls `eth_getLogs(Transfer, to ∈ {E of awaiting quotes})` every 3 s (topic OR-list).
- Once `balance(E) ≥ amount`: check the `from` sanctions screen, then `open(T)` → order funded.
- If `from ≠ T.buyer`, the plugin had warned. Refunds and change still go to `T.buyer`.
- Funds arriving after the quote expires or after the deadline trigger an immediate `cancel(T)`, which returns everything to the buyer.

### c.6 Keepers

1. **API cron (30 s):** for funded orders past the deadline or grace, call `refund(T)`; also reconcile stuck pending txs.
2. **KeeperHub workflow** (the builder's Ripcord pattern [local Ripcord `workflows/`]):
   - `Schedule */2` → `web3/read-contract refundableCount(50)` → `Condition > 0` → `web3/write-contract refundExpired(20)` on 8453.
   - Signed by KeeperHub's Turnkey wallet.
   - Needs no API or database.
3. **GitHub Actions cron (5 min)** running `apps/keeper` (chain-only).
4. **Buyer self-service:** `keyframe_refund`, plus the `npx @keyframe/refund` CLI.

### c.7 Other x402 clients

The same 402 is served to every client. Docs come from llms.txt and OpenAPI. The KeeperHub agentic wallet can serve as a second, non-PayBox interop client for tests.

### c.8 Open-source stock variant (the "about 20 lines")

```ts
export const escrowAccepts = (o: {factory: Address; resolve: (ctx: HTTPRequestContext) => Promise<Terms>}): PaymentOption => ({
  scheme: "exact", network: "eip155:8453", maxTimeoutSeconds: 300,
  payTo: async (c) => escrowOf(o.factory, await memo(c, o.resolve)),
  price: async (c) => ({ amount: (await memo(c, o.resolve)).amount.toString(), asset: USDC, extra: { name: "USD Coin", version: "2" } }),
});
// app.use(paymentMiddleware({"POST /orders/:id": {accepts: escrowAccepts({...})}}, server)) — works with ANY facilitator;
// publish terms afterwards with open(T) (onAfterSettle hook).
```

---

## (d) Plugin (starter v1.0.2, 8 tools)

### d.1 Hosts (5 of 16) and brokered headers

1. `<api-host>`: optional brokered `Authorization: Bearer <plugin-key>`, used for rate-limit tiering only. The x402 endpoint itself stays public because PayBox calls it without headers [R].
2. `<files-host>`: R2 custom domain.
3. `mainnet.base.org`: public, Flashblocks [B].
4. `base-rpc.publicnode.com`: second public RPC for cross-checks. Replace with Alchemy plus a brokered header only if header-auth is verified ⚠.
5. `ipfs.filebase.io` (or `dweb.link`): ciphertext fallback.

### d.2 Env vars (non-sensitive, editable after the lock, with embedded defaults for local conformance)

`KEYFRAME_API_BASE`, `KEYFRAME_FILES_BASE`, `KEYFRAME_FACTORY`, `KEYFRAME_FACTORY_CODEHASH` (optional pin), `KEYFRAME_SELLER` (plugin requires `T.seller==`), `KEYFRAME_OPERATORS` (comma list; plugin requires `T.operator∈`), `KEYFRAME_MAX_AMOUNT` (50000000), `KEYFRAME_RPC_URLS`, `KEYFRAME_IPFS_GATEWAY`.

Conformance strips the env down to HOME, NODE_ENV, NO_COLOR and PATH [S], so the defaults must work offline.

### d.3 Tools

All tools use `budget = new Budget(8_500)`. Each fetch gets `min(remaining − 300, perCallTimeout)` and `redirect:"error"`. Independent calls run in parallel, and a tool fails soft with `isError` and actionable text.

| # | Tool | Kind | Annotations (ro/destr/idem/open) | Calls and budget |
|---|---|---|---|---|
| 1 | `keyframe_catalog` | data | T/F/T/T | API GET 3.5 s; on failure, the embedded `catalog.fallback.json` with `source:"embedded"` |
| 2 | `keyframe_quote` | data | F/F/F/T | API POST 3.5 s → ∥ [402 probe 2.5 s, RPC batch ×2 RPCs 2.5 s] ≈ ≤ 6.5 s |
| 3 | `keyframe_commission` | **x402** | F/F/F/T | API GET 3 s → ∥ [probe, RPC] → `proposeX402` ≤ 6 s |
| 4 | `keyframe_commission_direct` | **evm** | F/F/F/T | Same checks → `proposeEvm(USDC.transfer(E, amount))` ≤ 6 s |
| 5 | `keyframe_status` | data | T/F/T/T | API GET ∥ RPC (`records(h)`, `balanceOf(E)`, `getCode(E)`) ≤ 3.5 s |
| 6 | `keyframe_verify` | data | T/F/T/T | derive: offline. funding: ≤ 5.5 s. delivery: ≤ 8.5 s hard stop with adaptive chunk sampling |
| 7 | `keyframe_refund` | **evm** | F/F/F/T | RPC `records` + log fetch ≤ 5.5 s → `refundByHash`/`refund(T)`/`sweep`/`decide(T,false)` |
| 8 | `keyframe_review` | data | F/T/F/T | API GET (+ POST decision) ≤ 6.5 s |

**Shared zod pieces:**

```ts
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/), Bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Atomic = z.string().regex(/^(0|[1-9][0-9]{0,77})$/), Unix = z.number().int().min(0).max(2 ** 40);
const QuoteId = z.string().regex(/^q_[1-9A-HJ-NP-Za-km-z]{22}$/), OrderId = z.string().regex(/^o_[1-9A-HJ-NP-Za-km-z]{22}$/);
const TermsZ = z.object({ buyer: Address, seller: Address, operator: Address, token: Address, amount: Atomic,
  slaStart: Unix, deadline: Unix, reviewWindow: z.number().int().min(0).max(4294967295),
  slaFloorBps: z.number().int().min(0).max(10000), killFeeBps: z.number().int().min(0).max(10000),
  keyHash: Bytes32, specHash: Bytes32, salt: Bytes32 }).strict();
const Check = z.object({ id: z.string(), status: z.enum(["pass","fail","skip"]), detail: z.string().max(400) }).strict();
```

**Tool 1, `keyframe_catalog`.**
- Input `{tier?: "instant"|"studio", format?: string≤64}`.
- Output `{source, studio:{seller, operators[], factory}, formats:[{id, tier, title, description, durationsSec[], aspects[], priceUsdc, etaSeconds, deadlineMinutes, params:[{id, type:"string"|"color"|"number"|"enum"|"boolean"|"series", label, required, maxLength?, options?}], sampleUrl, stillUrl}], policy:{maxOrderUsdc, rules[]}}`.

**Tool 2, `keyframe_quote`.**
- Input `{buyer: Address, tier, format, params: z.record(z.string().max(64), z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.union([z.number(), z.string().max(64)])).max(256)])), aspect?: "9:16"|"1:1"|"16:9", deadline_minutes?: int 5–4320, private_delivery?: boolean, attest_brand_rights: z.literal(true), attest_no_real_person_likeness: z.literal(true), notes?: string≤2000}`.
- Behaviour:
  1. Validate T: token==USDC, seller==env, operator∈env, amount≤cap, `salt==keccak(qid)`.
  2. `specHash == sha256(JCS(spec))`.
  3. Compute termsHash, impl and E locally.
  4. Probe the 402 (parse the v2 header or v1 body) and assert `payTo==E`, `amount==T.amount`, asset==USDC, network eip155:8453, scheme exact, single version.
  5. RPC: `getCode(buyer)` (0xef0100 prefix means 7702), ETH and USDC balances, `getCode(E)` (empty) and `balanceOf(E)`.
- Rail decision:

  | Buyer state | Rail |
  |---|---|
  | Plain EOA | x402 |
  | 7702-delegated, has ETH | direct |
  | 7702-delegated, no ETH | x402, with a note about auto-undelegate; if refused, fund about $0.05 of ETH |
  | USDC shortfall | `fund_first`, with the exact shortfall and a core `get_buy_link` hint |
- Output `{quote_id, expires_at, terms: TermsZ, terms_hash, escrow, derivation:{factory, vault_impl, init_code_hash, salt, chain_id, formula}, spec, price:{amount_usdc, sla, change_policy}, deadline_iso, eta_seconds, still_url|null, checks: Check[], wallet:{delegated_7702, delegate|null, eth_wei, usdc, shortfall}, rail:{recommended, reason}, disclosures: string[], next:{tool|null, args:{quote_id}, note}}`.

**Tool 3, `keyframe_commission`.**
- Input `{quote_id}`.
- Re-runs every quote check, then returns `{...proposeX402({chain:"eip155:8453", url:`${API}/v1/orders/${qid}`, method:"POST", body:{quote_id:qid}, maxAmount:T.amount, expiresAt:min(now+240s, quote.expires_at−60s)}), content:[{type:"text", text:"Approve 8.00 USDC to escrow 0xE5c…9aB1 (no code yet = CREATE2(factory, termsHash 0x9ab…)). The payee in PayBox's window must match. Refunds to you if the key isn't published by 18:20 UTC. Pass wallet_id for 0xU…."}]}`.
- **outputSchema = starter `x402OutputSchema`** (strict, proposal key only) [S].

**Tool 4, `keyframe_commission_direct`.** Same as tool 3, but returns `proposeEvm({chain:"eip155:8453", to:USDC, value:"0", data:encode(transfer(E, amount))})` with `evmOutputSchema`. It also best-effort POSTs `/rail` and warns if ETH < 2e13 wei.

**Tool 5, `keyframe_status`.**
- Input `{order_id?, quote_id?, buyer?, access_token?: /^[A-Za-z0-9_-]{43}$/, onchain?: boolean=true}`. Use a flat object (MCP needs a root `type:"object"`) and validate "exactly one id" at runtime.
- Output `{order?:{id, status, progress?, timeline[], escrow, terms_hash, amount, deadline_iso, funding_tx?, release_tx?, refund_tx?, still_url?, preview_url?, download_url?, manifest_hash?}, onchain?:{status, escrow_code:"none"|"eip1167", escrow_balance, opened_block?, final_block?}, consistent: boolean, orders?: [...]≤20, poll_after_seconds, next}`.

**Tool 6, `keyframe_verify`.**
- Input `{mode:"derive"|"funding"|"delivery", terms?: TermsZ, terms_hash?, escrow?, quote_id?, order_id?, k_buyer?: Bytes32, spec?: object, max_chunks?: int 1–4}`.
- Terms are resolved in this order: argument, then the on-chain `Opened` event at `records(h).openedBlock` (hash re-checked), then the API (labelled `source:"api"`).
- **derive:** offline hash, E, impl and initCodeHash, plus Terms sanity.
- **funding:** adds `getCode(E)` ∈ {empty, EIP-1167 → impl}, `balanceOf(E) ≥ amount` on both RPCs, Opened T == T, USDC Transfer buyer→E in the same block, record status, and an optional factory code-hash pin.
- **delivery:** adds:
  - the `Released` log at `finalBlock`: K, keccak(K)==keyHash, toSeller ≤ amount and toBuyer;
  - `manifest.json` with sha256 == manifestHash;
  - chunk 0 and the last chunk (plus random chunks while budget > 1.5 s), each sha256-checked and AES-GCM-decrypted, with plaintext chunk hashes checked;
  - an MP4 `moov` check (faststart) of duration, width and height against `spec.output`.
- Output `{mode, terms_hash, escrow, derivation, checks: Check[], verdict:"verified"|"partial"|"failed", chunks_verified, chunks_total, summary}`.

**Tool 7, `keyframe_refund`.**
- Input `{action:"refund"|"sweep"|"reject", terms?, terms_hash?, escrow?, token?: Address}`.
- Pre-checks the refund or reject window over RPC. If not yet allowed, it returns `isError` with "refundable at 18:20:00Z; the studio can still deliver".
- Output `evmOutputSchema`.

**Tool 8, `keyframe_review`.**
- Input `{order_id, access_token, decision:"accept"|"reject", signature?: hex≤1KB, sig_deadline?: Unix}`.
- Stage 1 returns EIP-712 `Decision` typedData, the preview URL, and "call core `request_wallet_sign` `{op:'typedData'}`" (the plugin can't request signatures [R]).
- Stage 2 checks `recoverTypedDataAddress == T.buyer`, POSTs `/decision`, and returns the relay tx. The fallback is `keyframe_refund {action:"reject"}`.
- Output `{stage:"sign"|"submitted", typed_data?, tx?, status, note}`.

Tool descriptions must tell the agent four things:
- the order of calls: catalog → quote → commission (with `wallet_id`) → poll `get_request` → status/verify with `order_id` + `access_token` from the paid response;
- amounts are atomic USDC;
- never re-run commission to poll;
- buyer and seller are disclosed own wallets in demos.

### d.4 Proposal-output rule

Proposal tools return **only** the starter's strict schema (`structuredContent` = proposal key). Human-readable context goes in `content[].text`. Whether extra structured keys alongside the proposal are allowed is unverified ⚠.

### d.5 `paybox-plugin.json` (offline, deterministic)

```json
{ "tool": "keyframe_verify",
  "arguments": { "mode": "derive", "terms": {
    "buyer": "0x1111111111111111111111111111111111111111", "seller": "0x2222222222222222222222222222222222222222",
    "operator": "0x3333333333333333333333333333333333333333", "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "amount": "8000000", "slaStart": 0, "deadline": 1798761600, "reviewWindow": 0, "slaFloorBps": 10000, "killFeeBps": 0,
    "keyHash": "0x4b2bd1e1a2c7a3b0d7c4f2b8e9a6d5c4b3a2918f7e6d5c4b3a2918f7e6d5c4b3",
    "specHash": "0x9e1c7d3a5b2f4e6c8a0b1d3f5e7c9a2b4d6f8e0a1c3e5b7d9f2a4c6e8b0d1f3a",
    "salt": "0x6a1f0c2e4b7d9a3c5e8f1b2d4a6c8e0f3b5d7a9c1e2f4b6d8a0c3e5f7b9d1a2c" } } }
```

### d.6 Hero flow (Claude.ai connector)

1. `list_credentials`
2. `keyframe_quote`
3. `get_buy_link`, only if there's a shortfall
4. `use_plugin keyframe_commission` (+`wallet_id`): one passkey tap
5. Poll `get_request`; the output carries the paid body
6. `keyframe_status`
7. `keyframe_verify delivery`

---

## (e) Data model, keys, encryption, storage

### e.1 Database choice: Postgres (Railway or Neon)

- A conditional UPDATE gives exactly-once compare-and-set.
- `FOR UPDATE SKIP LOCKED` gives a job queue, so there is no Redis.
- JSONB holds spec and terms; there is a durable audit log.
- D1 was rejected (Node API, HTTP latency); Redis is unnecessary.

Tables (abridged DDL):
- `quotes(id pk, created_at, expires_at, buyer, tier, format, template_id, template_version, renderer_digest, params jsonb, spec jsonb, spec_hash, terms jsonb, terms_hash unique, escrow unique, amount numeric, deadline, private bool, kmaster_ver int, state, pay_nonce, payer, rail, screening jsonb, source)`
- `payments(id, quote_id, rail, auth_from, auth_nonce, valid_before, facilitator, settle_tx, status, error, unique(auth_from, auth_nonce))`
- `orders(id pk, quote_id unique, status, funding_tx, funded_block, paid_response jsonb, render_job, manifest_hash, ipfs_cids text[], deliver_tx, release_tx, refund_tx, cancel_tx, to_seller, to_buyer, ts…)`
- `chain_txs(id, kind, order_id, hash, nonce, status, gas_used, submitted_at, confirmed_at, error)`
- `jobs(id, order_id, kind, state, attempts, locked_until, payload, result)`
- `artifacts(order_id, kind, sha256, size, r2_key, cid)`
- `events(append-only)`
- `sanctions_lists(version, fetched_at, sha256, count)`
- `kv(indexer_block, …)`
- `synthetic_runs`

### e.2 Keys

- `K_chain = HMAC-SHA256(KMASTER_v, "kf/kchain/v1/" ‖ qid)`; `K_buyer = HMAC(KMASTER_v, "kf/kbuyer/v1/" ‖ qid)` (private mode) or 0³².
- This is deterministic (the single-URL form needs it), nothing is stored, and the key is rotatable through `kmaster_ver`.
- `keyHash = keccak256(K_chain)`.
- KMASTER, the relayer key and ACCESS_SECRET live only in the API's environment. The worker holds no keys.

### e.3 Encryption: KF-AES256GCM-HKDF-CHUNK-v1 (FROZEN)

- `K_file = HKDF-SHA256(IKM = K_chain‖K_buyer, salt = termsHash, info = "keyframe/file/v1", L = 32)`.
- Plaintext chunk size is 1,048,560 bytes, so each ciphertext chunk is exactly 1 MiB and IPFS raw-leaf CIDs equal multihash(sha256).
- `nonce_i = 0x00000000‖u64be(i)`; `AAD_i = "KF1"‖termsHash‖u64be(i)‖u64be(n)`. The total count binds the order of chunks and prevents truncation.
- Manifest (JCS), with `manifestHash = sha256(JCS(manifest))` committed by `deliver`/`release`:
  ```
  {v, alg, termsHash, chunkSize, size, chunks, plaintextSha256,
   ciphertext:[sha256…], plaintext:[sha256…], cids:[…],
   media:{mime, width, height, durationMs, fps}}
  ```
- **Split-key private delivery:** `K_chain` goes on-chain (payment), `K_buyer` only in the paid x402 response and in token-gated re-delivery. Public mode sets `K_buyer` to zero.

### e.4 Storage

- **R2** (custom domain, zero egress, immutable cache):
  - `s/{qid}.png` still
  - `p/{oid}.mp4` watermarked 540p preview
  - `c/{termsHash}/manifest.json` and `c/{termsHash}/{i}.bin`
  - `d/{oid}.mp4` decrypted copy (public orders, after release)
  - Masters go to a separate **private** bucket.
- **IPFS via Filebase:** S3-compatible pinning on a different provider. This is what makes "even if our server vanished" true: T is on-chain, refund is permissionless, K is on-chain, and the ciphertext is pinned on a third party.
- **Optional Arweave via Turbo** for Studio masters.
- The plugin checks hashes, not locations.

### e.5 Render and delivery pipeline

- The worker renders with `hyperframes render --docker --strict-variables --variables …`. `--docker` is documented as byte-identical [HF], so Instant deliverables are **reproducible from the spec** ⚠ to be confirmed across hosts.
- Encoding uses `-movflags +faststart` so `moov` lands in chunk 0. Root duration is fixed per template file and nothing is fetched at render time [HF]. The hero still comes from `snapshot` [HF] and is reported asynchronously after the quote; the spec already pins template version, renderer digest and params.
- The API then encrypts, uploads to R2 and Filebase, and **self-verifies**: it fetches back from the public URLs, decrypts, and checks the sha256 and the mp4 header against the spec.
- Instant: `release`. Studio: `deliver`, then the review window, then `release`.
- Three render failures trigger an automatic `cancel`, which refunds the buyer immediately.

---

## (f) Threat model and failure modes

| # | Threat | Impact | Mitigation | Residual |
|---|---|---|---|---|
| 1 | API swaps payTo or seller (compromise or bug) | Funds to an attacker | Plugin asserts seller/operator against env, recomputes E, pre-probes payTo==E; text tells the user to match the payee in PayBox's window; verify detects E unfunded | PayBox only checks asset and amount [R], so payTo can change at approval time: inherent, disclosed |
| 2 | Contract bug | Funds stuck forever (no admin) | 50 USDC cap, about 300 lines of OZ primitives, invariants, Halmos, fork tests, verified source, review before listing | Unaudited (disclosed) |
| 3 | Relayer key theft | Grief by cancel; gas drain | Cannot redirect; K not on the key host's disk; alarms | Seller loses sales |
| 4 | KMASTER leak | Early release before delivery | Release only from a self-verified pipeline; KMASTER only in the API env; rotation | Buyer harm if both leak |
| 5 | Seller publishes a bogus key | Paid, no file | AES-GCM fails or manifest mismatch → plugin "FAILED", public on-chain evidence; Studio review and kill fee | Guarantees delivery, not quality (stated) |
| 6 | Wrong wallet pays | Refund goes to a different own wallet | x402: `from≠buyer` → 409, no settle; direct: warning | Direct-rail user error |
| 7 | Double payment | Over-charge | CAS exactly-once (409, no settle); excess or late funds → buyer | None |
| 8 | Prompt injection via API strings | Agent misled | Plugin length-caps and quotes untrusted text; never builds instructions from API text | Low |
| 9 | Content abuse | Legal | Per-template zod, blocklist plus optional Haiku moderation, no likeness inputs in Instant, brand-rights attestation, designer can cancel | Studio relies on human judgment |
| 10 | Sanctioned payer | Compliance | OFAC at quote and before settle; USDC blacklist backstop | Small list-lag window |
| 11 | Ciphertext unavailable | Can't decrypt | R2 + IPFS (+ Arweave); release only after public self-verify | Pin-provider risk |
| 12 | 402 drift between probe and paid request | Payment rejected | Golden-byte probes; tolerant case shim | — |

**Top 10 failure modes:**

| # | Failure | Detection | Automatic response | Buyer outcome |
|---|---|---|---|---|
| 1 | PayBox rejects per-order payTo or the wire version | Day-1 probes, interop log | `X402_WIRE` toggle; direct rail | Not charged |
| 2 | Paid retry times out | Interop log, latency metrics | 1.2 s receipt cap, idempotent replay | Charged once |
| 3 | Plugin call goes over 10 s | Budget helper | Partial results, adaptive chunks | Clear retry text |
| 4 | Relayer out of gas or nonce stuck | Balance and age alarms | Fee bump; PayAI settles; keepers independent | Order proceeds |
| 5 | Render box cold or dead | 60 s heartbeat | Capacity gate refuses before settle; ≥ 3 fails → cancel | Not charged, or instant refund |
| 6 | API keeper down | KeeperHub, GH cron, synthetic alerts | `refundExpired` and CLI | Zero-tap refund |
| 7 | 7702-delegated wallet | `getCode` prefix check | Rail selection | One tap on either rail |
| 8 | Storage or upload fails | Self-verify | Retry, then cancel | Refund |
| 9 | Contract issue found | Monitoring, review | Stop quoting (flag), cancel open orders, deploy v2, update env | Refund |
| 10 | Quote expires mid-approval | 410 | Plugin asks for a re-quote | Not charged |

---

## 7. Sequencing

**Before the lock (critical path):**
1. `packages/protocol` frozen, plus Solidity `TermsLib` and vector parity.
2. The plugin's 8 tools with final schemas, `pnpm test` green, and the starter checksum gate.
3. Minimal live API: catalog, quotes, the 402 plus the paid path (provisional factory env), and status.
4. Upload → hosted checks → Test console (every tool) → Validate transaction (x402 + both EVM proposals) → accept T&C → Submit.
5. If time allows: deploy and verify the factory today. Its address is env-only, but **take no real money before deploy, fork tests and invariants.**

**After the lock:**
1. Day-1 live probes at 0.10, 8 and 50 USDC from Claude.ai.
2. Worker and templates.
3. Delivery pipeline.
4. Keepers (API cron, KeeperHub, GH cron).
5. Halmos, then a deeper invariant campaign.
6. Web, stats and the synthetic order.
7. Demo film and X thread.

## 8. Unverified (each closed by a day-1 probe or test)

1. PayBox's plugin-x402 path accepting a per-order, codeless payTo end to end.
2. Whether the probe sends a body.
3. Which wire version PayBox prefers, and whether it rejects mixed 402s.
4. Whether PayBox echoes `accepted` case-preserving.
5. The paid-retry timeout and size limit, and whether `get_request` exposes PAYMENT-RESPONSE.
6. The proposal amount limit (50 USDC?).
7. Auto-undelegate being enabled on Base.
8. The FiatTokenV2_2 `bytes`-signature overload on Base (covered by fork test).
9. Alchemy header-key auth.
10. The Chainalysis oracle address on Base.
11. HyperFrames byte-identical renders across hosts.
12. Whether Claude.ai renders links or images coming from `use_plugin`.
13. Extra structuredContent keys next to proposals.
14. Filebase CID behaviour.
15. Whether the PayAI keyless free tier holds at our volume.

### Critical Files for Implementation
- /Users/oluwademilade/Desktop/paybox/packages/protocol/src/terms.ts
- /Users/oluwademilade/Desktop/paybox/contracts/src/KeyframeEscrowFactory.sol
- /Users/oluwademilade/Desktop/paybox/plugin/src/plugin.ts
- /Users/oluwademilade/Desktop/paybox/apps/api/src/x402/paidRoute.ts
- /Users/oluwademilade/Desktop/paybox/apps/api/src/x402/facilitator.ts

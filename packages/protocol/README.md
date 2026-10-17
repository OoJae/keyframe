# @keyframe/protocol

The frozen Keyframe protocol v1 in TypeScript: Terms and EIP-712, CREATE2 escrow derivation, ABIs, JCS, keys,
the KFC1 container, x402 402 parsing/emission, 7702 detection and the MP4 header check.
`docs/design/frozen-interfaces.md` is the specification. When this package and that document disagree, the
document is right and this package has a bug.

- Runtime deps: `viem@2.51.3` and `zod@4.4.3` only, pinned through the workspace catalog.
- Web platform only (WebCrypto, `TextEncoder`, `atob`/`btoa`, `DataView`), with no `node:*` and no `Buffer`. The
  same source runs in Node 24, Cloudflare Workers and the PayBox plugin sandbox. Two checks enforce this:
  `tsconfig.src.json` typechecks `src/` without Node types, and `test/portability.test.ts` scans the source.
- Consumers import the TS source (`exports["."] = ./src/index.ts`) and there is no build step. Imports use
  NodeNext-style `.js` specifiers. Only erasable TS syntax is allowed (`Status` is a const object, not an `enum`).
- `plugin/` gets a vendored copy instead of a workspace link (see "Vendoring").

## API (everything exported from `src/index.ts`; `test/constants.test.ts` pins the list)

| Area | Exports |
|---|---|
| constants | `CHAIN_ID` 8453, `CAIP2`, `USDC`, `USDC_DECIMALS`, `MIN_AMOUNT` 100000n, `MAX_AMOUNT` 50000000n, `EIP712_NAME`, `EIP712_VERSION`, `TERMS_TYPES`, `DECISION_TYPES`, `CLONE_PREFIX`, `CLONE_SUFFIX`, `KFC1_CHUNK_PLAINTEXT`, `Status` |
| types/schemas | `Terms`, `TermsJson`, `TermsJsonSchema`, `SpecSchema`, `QuoteSchema` (loose), `PaidResponseSchema` (loose), `ManifestSchema` |
| terms | `termsFromJson`, `termsToJson`, `domainOf`, `hashTerms`, `vaultImplOf`, `escrowOf`, `payoutAt`, `decisionTypedData` |
| abis | `keyframeFactoryAbi`, `keyframeVaultAbi`, `erc20Abi` (balanceOf, transfer, `transferWithAuthorization(..., bytes)`, authorizationState, Transfer event) |
| jcs | `jcs`, `sha256Hex`, `specHash` |
| keys | `deriveKChain`, `deriveKBuyer`, `keyHashOf` |
| kfc1 | `deriveFileKey`, `encryptKfc1`, `decryptKfc1Chunk`, `verifyManifest` |
| x402 | `parsePaymentRequired`, `normalizeAccept`, `buildPaymentRequiredV2`, `buildPaymentRequiredV1` |
| misc | `detect7702`, `parseMp4Header`, `newQuoteId`, `newOrderId`, `saltOf` |

```ts
import { escrowOf, hashTerms, parsePaymentRequired, normalizeAccept, termsFromJson } from "@keyframe/protocol";

const T = termsFromJson(quote.terms);                // strict: checksummed addresses, lowercase bytes32
const E = escrowOf(hashTerms(T, factory), factory);  // pass vaultImpl explicitly if it comes from an allowlist
const pr = parsePaymentRequired({ status: res.status, headers: res.headers, bodyText: await res.text() });
const a = pr.accepts.map(normalizeAccept);           // then require exactly one exact / eip155:8453 / USDC / payTo==E
```

## Behaviour that matters to callers

- **Strict vs loose schemas.** Terms JSON, spec and manifest are strict: unknown keys are rejected because these
  objects are hashed. Quote and paid-response are loose, since the API may add fields (§7). Addresses must be exactly
  EIP-55 (`getAddress(s) === s`), and bytes32 values must be lowercase. The quote's `preview.still_url` and
  `still_sha256` also accept `null`, so a draft quote can arrive before its still has rendered. That widens what
  the parser accepts and changes nothing on the wire.
- **`hashTerms`** is viem `hashTypedData` over `TERMS_TYPES`. Tests check it against an independent `abi.encode`
  construction (fuzzed), and `cast` gives the same digest. `escrowOf` and `vaultImplOf` were checked on a real EVM
  (local anvil): a clone deployed through the CREATE2 deployer and a contract's first CREATE.
- **`payoutAt`** uses exact bigint math, which matches Solidity's `mulDiv`. It throws `RangeError` in the cases
  where the contract would revert (`slaFloorBps > 10000` inside the decay window).
- **`jcs`** follows RFC 8785 restricted to the spec profile. Floats, NaN/Infinity, unsafe integers, bigint, lone
  surrogates, cycles, sparse arrays and non-plain objects throw. Members whose value is `undefined` are omitted,
  the same way `JSON.stringify` omits them, so an object hashes identically before and after a JSON round trip.
- **KFC1** (§5): `K_file = HKDF(K_chain ‖ K_buyer, salt = T.salt, "keyframe/kfc1/file")`. The nonce is
  `0^4 ‖ u64be(i)` and the AAD is `"KFC1" ‖ salt ‖ u64be(i) ‖ u64be(n)`. `decryptKfc1Chunk` fails closed on
  tampering, reordering, a wrong `n` or truncation, and it also enforces chunk lengths. **Nonces are counters, so
  one (K_chain, K_buyer, salt) triple must never encrypt two different plaintexts.** A re-render that changes the
  bytes needs a new quote. An empty plaintext is rejected. `verifyManifest` never throws.
- **x402.** v2 is read only from the base64 `PAYMENT-REQUIRED` header, and v1 only from a JSON body with
  `x402Version: 1`. The parser rejects a response that mixes the two, a v2 accept that carries `maxAmountRequired`,
  a v1 accept that carries `amount`, conflicting duplicate headers, non-standard base64 and invalid UTF-8. It does
  **not** judge scheme, network, asset, payTo or amount. `normalizeAccept` passes those through so the caller can
  name exactly what was wrong. Addresses also come through verbatim, so compare them with `isAddressEqual`. The
  only error type thrown is `X402ParseError` (`name`, `code`), which is fuzzed with fast-check. The builders emit
  §7 byte for byte: v2 has the header, body `{}` and `Cache-Control: no-store`, and v1 has a JSON body with
  `network: "base"`. They interoperate with `@x402/core@2.28.0`'s header codec.
- **`detect7702`**: no code means `plain`. Exactly `0xef0100 ‖ 20 bytes` means `delegated`. Any other code,
  including a malformed designator, means `contract`. Malformed hex throws.
- **`parseMp4Header`** reads `moov/mvhd` and the `vide` track's `tkhd` from the leading bytes. It returns `null`
  (meaning "unverifiable") when moov is truncated or not in the given bytes (no faststart), when the duration is
  unknown, or when there is no video track. It never throws. `durationMs` is rounded to the nearest millisecond.
- **Keys**: KMASTER must be at least 32 bytes. Public delivery uses `K_buyer = 0x00…00`, which the caller passes in.

## Commands

```sh
pnpm -F @keyframe/protocol typecheck   # tsc (src+test with Node types) && tsc -p tsconfig.src.json (src, no Node types)
pnpm -F @keyframe/protocol test        # vitest: RFC 8785, KFC1, x402 fuzz, 7702, mp4, EVM (anvil if on PATH), vectors, sync
pnpm -F @keyframe/protocol vectors     # regenerate test/vectors/terms-v1.output.json
pnpm -F @keyframe/protocol fixtures:mp4  # regenerate test/fixtures/*.m4v with ffmpeg (deterministic, bitexact)
```

The anvil test and the fresh-ffmpeg test skip themselves when those tools are not installed. Everything else
runs offline.

## Parity vectors

`test/vectors/terms-v1.output.json` is computed from `docs/design/vectors/terms-v1.input.json`. It holds
`{termsHash, vaultImpl, escrow}` for each terms entry and `payoutAt` for each sample (as a decimal string). For the
KFC1 vector it holds `manifestHash`, the per-chunk ciphertext hashes and the full manifest, plus `fileKey` from an
independent `node:crypto` HKDF. The input does not pin manifest `media`, so the frozen §5 example values are used
and recorded. Two buyer/factory addresses in the input are not valid EIP-55. Case never affects the encoding, so
the generator normalises them, while `termsFromJson` itself stays strict. `contracts/` writes its own output from
the same input, and the integration step diffs the two. A plain `vitest` run fails if the committed file is stale.

## Vendoring into the plugin

`plugin/` is its own pnpm root with a frozen lockfile (starter v1.0.2), so it takes a copy:

```sh
pnpm sync:protocol         # packages/protocol/src/**/*.ts -> plugin/src/protocol/ (header, sorted, no timestamps)
pnpm sync:protocol:check   # CI gate: exit 1 if plugin/src/protocol differs (exit 2 on usage/IO errors)
node scripts/sync-protocol.mjs --target <dir> [--check]
```

The script only deletes files that carry its own header. The plugin also needs `"viem": "2.51.3"` in its
`package.json`, and it already has `zod@4.4.3`. The vendored copy typechecks under the plugin's exact `tsconfig.json`
and bundles deterministically with the plugin's esbuild 0.28.2, for both node and browser platforms.

License: MIT.

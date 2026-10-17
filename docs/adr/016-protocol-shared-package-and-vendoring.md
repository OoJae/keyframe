# ADR-016: One TypeScript protocol package, vendored into the plugin

- Status: accepted
- Date: 2026-10-17
- Area: `packages/protocol`, `scripts/sync-protocol.mjs`, root workspace
- Numbering: 001–015 are reserved for the topics listed in `docs/design/verification.md`, so this ADR takes 016.

## Context

Four codebases have to agree, byte for byte, on what `frozen-interfaces.md` §1–§7 freezes: the plugin (bundled and
frozen at upload), the API (Workers/Node), the render/delivery path and the keepers. Those surfaces are Terms and
EIP-712, the CREATE2 derivation, ABIs, JCS, keys, KFC1 and the x402 wire. Any drift breaks things. A different
`termsHash` or `E` means a refund address nobody checked, and a different manifest hash means a release the plugin
cannot verify. The plugin is its own pnpm root with a frozen lockfile (starter v1.0.2), so it cannot take a
workspace link without risking a second viem copy and a non-reproducible bundle.

## Decision

1. **A single source of truth.** `@keyframe/protocol` lives in `packages/protocol/src` and has two runtime
   dependencies, viem 2.51.3 and zod 4.4.3, both pinned through the workspace catalog. Its public surface is an
   explicit export list, which a test pins. Consumers import the TS source; there is no build step.
2. **Web platform only.** It uses WebCrypto, `TextEncoder`, `atob`/`btoa` and `DataView`, with no `node:*`, no
   `Buffer` and only erasable TS syntax. Two gates enforce this: a second `tsc` pass without Node types, and a
   source scan. The same files therefore run in Node 24, Workers and the plugin sandbox.
3. **Vendoring, not linking.** `scripts/sync-protocol.mjs` copies `src/**/*.ts` into `plugin/src/protocol/`. It
   walks files in sorted order, adds a fixed `GENERATED` header, writes LF line endings and no timestamps, and it
   only deletes files that carry its own header. `--check` is the CI drift gate.
4. **Strict where hashed, loose where served.** The objects that get hashed (Terms JSON, spec, KFC1 manifest) use
   strict zod schemas: exact EIP-55 addresses, lowercase bytes32, no unknown keys. Backend responses (quote, paid
   body) use loose schemas, because §7 lets the API add fields.
5. **JCS integers-only.** RFC 8785 is applied to the §6 profile. Anything that could serialize two ways (floats,
   unsafe integers, lone surrogates, non-plain objects) throws instead of being coerced. Members set to `undefined`
   are dropped as `JSON.stringify` drops them, so hashing before and after a JSON round trip agrees.
6. **The x402 parser surfaces values and rejects ambiguity.** It mirrors `@x402/core@2.28.0`: v2 comes only from
   the base64 `PAYMENT-REQUIRED` header, and v1 only from a body with `x402Version: 1`. A response that mixes the
   two is rejected. So is a requirement that carries the other version's amount field. Without that rule, a server
   could show `amount` to PayBox and `maxAmountRequired` to our checks. Scheme, network, asset, payTo and amount
   are passed through unjudged, so the plugin can refuse with a precise reason. The only error type thrown is
   `X402ParseError`, which is fuzzed.
7. **The KFC1 rule that follows from counter nonces.** One (K_chain, K_buyer, salt) triple encrypts exactly one
   plaintext. Since `salt = keccak256(quote_id)`, a re-render that changes the bytes needs a new quote. Empty
   plaintexts are rejected, so every container has at least one authenticated chunk.

## Consequences

- Parity is testable. `test/vectors/terms-v1.output.json` is generated from the shared input, and `contracts/`
  produces its own output independently. The derivations are also checked against an independent `abi.encode`,
  against `cast`, and on a local anvil EVM.
- Changing the protocol takes a source edit, `pnpm sync:protocol` and a plugin rebuild. The CI `--check` gate
  catches a forgotten sync. After the upload lock, only backend-side consumers can pick up changes.
- The plugin must add `viem@2.51.3` as an exact dependency.
- `QuoteSchema` accepts `null` for `preview.still_url` and `still_sha256` (a draft quote whose still is not
  rendered yet). This widens what the parser accepts, not the wire format.

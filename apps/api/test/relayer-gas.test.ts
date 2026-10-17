// The relayer's gas limit always leaves a fully funded payout push (docs/deploy/factory-v1.md): estimate + 20%, and
// never less than estimate + 150k, so the deployed factory's best-effort push cannot be starved by our own sends.

import { type Hex, parseTransaction } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { gasLimitFor, RelayerCore, type StoredTx } from "../src/relayer/core.js";

describe("relayer gas limit", () => {
  it("adds a flat push reserve to small estimates and 20% to large ones", () => {
    expect(gasLimitFor(50_000n)).toBe(200_000n);
    expect(gasLimitFor(218_278n)).toBe(368_278n);
    expect(gasLimitFor(750_000n)).toBe(900_000n);
    expect(gasLimitFor(2_000_000n)).toBe(2_400_000n);
  });

  it("signs the broadcast transaction with that limit", async () => {
    const sent: Hex[] = [];
    const client = {
      estimateGas: async () => 205_250n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      getTransactionCount: async () => 0,
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        sent.push(serializedTransaction);
        return "0x";
      },
      getBalance: async () => 10n ** 18n,
    };
    const store = new Map<string, unknown>();
    const core = new RelayerCore({
      account: privateKeyToAccount(generatePrivateKey()),
      client: client as never,
      factory: "0x00000000000000000000000000000000000f4c70",
      chainId: 8453,
      store: {
        getNonce: async () => store.get("nonce") as number | undefined,
        putNonce: async (n) => void store.set("nonce", n),
        putTx: async (h, t) => void store.set(`tx:${h}`, t),
        getTx: async (h) => store.get(`tx:${h}`) as StoredTx | undefined,
        deleteTx: async (h) => void store.delete(`tx:${h}`),
      },
    });
    expect((await core.send({ kind: "release", ref: "o", data: "0x1234", waitMs: 0 })).state).toBe("pending");
    expect(sent).toHaveLength(1);
    expect(parseTransaction(sent[0] as Hex).gas).toBe(355_250n);
  });
});

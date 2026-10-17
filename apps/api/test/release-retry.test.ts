// Right after payment the RPC can be a block behind the funding tx. The post-payment advance retries an Instant
// release a few times (RELEASE_RETRY_MS apart) instead of leaving the key to the next keeper tick.

import { Status } from "@keyframe/protocol";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { Harness } from "./support/harness.js";

/** The stub chain answers None for the first `n` reads of a funded order, like a node one block behind. */
function lagReads(h: Harness, termsHash: string, n: number) {
  const real = h.chain.orderOf.bind(h.chain);
  let left = n;
  h.chain.orderOf = async (f: Address, th: Hex) => {
    const v = await real(f, th);
    if (th.toLowerCase() === termsHash.toLowerCase() && v.status === Status.Open && left > 0) {
      left--;
      return h.factory.view(`0x${"00".repeat(32)}`);
    }
    return v;
  };
  return () => left;
}

describe("post-payment release retry", () => {
  it("publishes the key in the payment's own background work when the first reads lag", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    const left = lagReads(h, q.terms_hash, 2);
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(res.status).toBe(200);
    await h.drain();
    expect(left()).toBe(0);
    expect(h.relayer.sends.filter((r) => r.kind === "release")).toHaveLength(1);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Released);
  });

  it("gives up after a few attempts and leaves the order to the keeper", async () => {
    const h = new Harness();
    const q = await h.finalQuote();
    lagReads(h, q.terms_hash, 100);
    const res = await h.pay(q.quote_id, await h.paymentHeaders(q.quote_id));
    expect(res.status).toBe(200);
    await h.drain();
    expect(h.relayer.sends.filter((r) => r.kind === "release")).toHaveLength(0);
    expect(h.factory.view(q.terms_hash).status).toBe(Status.Open);
  });
});

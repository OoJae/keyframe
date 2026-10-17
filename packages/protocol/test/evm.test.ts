// Derivations checked against a real EVM (local anvil, no fork, no network): CREATE2 clone address via the
// standard deterministic-deployment proxy, and the CREATE-at-nonce-1 address of a contract's first child.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { type Address, concat, createPublicClient, type Hex, http, keccak256, toBytes } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLONE_PREFIX, CLONE_SUFFIX, escrowOf, vaultImplOf } from "../src/index.js";

const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
const PORT = 18_545 + (process.pid % 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

let anvil: ChildProcess | undefined;
const client = createPublicClient({ transport: http(RPC), pollingInterval: 50 });

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

async function send(
  from: Address,
  to: Address | null,
  data: Hex,
): Promise<{ contractAddress?: Address | null | undefined }> {
  const hash = await rpc<Hex>("eth_sendTransaction", [{ from, ...(to ? { to } : {}), data, gas: "0x1e8480" }]);
  const receipt = await client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  return receipt;
}

describe.skipIf(!hasAnvil)("derivations on a local EVM (anvil)", () => {
  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        await client.getChainId();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("anvil did not start");
  });
  afterAll(() => {
    anvil?.kill();
  });

  it("escrowOf predicts the EIP-1167 clone CREATE2 address and runtime code", async () => {
    const [from] = await rpc<Address[]>("eth_accounts", []);
    const impl: Address = "0x1234567890AbcdEF1234567890aBcdef12345678";
    const termsHash = keccak256(toBytes("keyframe-test-terms"));
    const initCode = concat([CLONE_PREFIX, impl, CLONE_SUFFIX]);
    await send(from as Address, CREATE2_DEPLOYER, concat([termsHash, initCode]));
    const predicted = escrowOf(termsHash, CREATE2_DEPLOYER, impl);
    const code = await client.getCode({ address: predicted });
    expect(code).toBe(`0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`);
  });

  it("vaultImplOf predicts the first CREATE of a contract (nonce 1)", async () => {
    const [from] = await rpc<Address[]>("eth_accounts", []);
    // child init: MSTORE8(0, 0); RETURN(0, 1)  => runtime code 0x00
    const child = "600060005360016000f3";
    // parent init: PUSH10 child; MSTORE(0); CREATE(value 0, offset 22, size 10); POP; STOP
    const parentInit: Hex = `0x69${child}600052600a60166000f05000`;
    const deployed = await send(from as Address, null, parentInit);
    const factory = deployed.contractAddress as Address;
    expect(await client.getCode({ address: vaultImplOf(factory) })).toBe("0x00");
  });
});

// Strict EIP-4361 (Sign-In with Ethereum) check for the message Keyframe's API asks the buyer to sign. The message
// must sign in to Keyframe's own API host, for the given address, on Base, and expire soon; a backend cannot
// use this flow to obtain a login signature for some other site. Line-exact: unknown lines are rejected.

import { type Address, isAddress, isAddressEqual } from "viem";
import { CHAIN_ID } from "../protocol/index.js";
import { ToolError } from "./result.js";

export const SIWE_MAX_LIFETIME_S = 15 * 60;
const CLOCK_SKEW_S = 10 * 60;

export type Siwe = {
  domain: string;
  address: Address;
  uri: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
};

const refuse = (why: string): never => {
  throw new ToolError(
    `Refusing to ask you to sign: the sign-in message is not a Keyframe sign-in (${why}). Nothing was signed.`,
  );
};

function time(value: string | undefined, what: string): number {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value))
    return refuse(`bad ${what}`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return refuse(`bad ${what}`);
  return Math.floor(ms / 1000);
}

export function checkSiwe(
  message: string,
  expected: { apiBase: string; address: Address; now: number; forSubmit: boolean },
): Siwe {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control/bidi characters are exactly what is refused
  if (message.length > 2048 || /[\r\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(message))
    return refuse("unexpected characters");
  const host = new URL(expected.apiBase).host;
  const lines = message.split("\n");
  let i = 0;
  const header = /^(?:https:\/\/)?([a-z0-9.-]+(?::\d{1,5})?) wants you to sign in with your Ethereum account:$/.exec(
    lines[i++] ?? "",
  );
  if (!header || header[1] !== host) return refuse(`it signs in to ${header?.[1] ?? "an unknown site"}, not ${host}`);
  const address = lines[i++] ?? "";
  if (!isAddress(address, { strict: false }) || !isAddressEqual(address as Address, expected.address))
    return refuse("wrong address");
  if (lines[i++] !== "") return refuse("malformed");
  if (lines[i] !== undefined && !lines[i]?.startsWith("URI: ")) {
    const statement = lines[i++] ?? "";
    if (statement.length > 200) return refuse("statement too long");
    if (lines[i++] !== "") return refuse("malformed statement");
  }
  const field = (name: string, optional = false): string | undefined => {
    const line = lines[i];
    if (line?.startsWith(`${name}: `)) {
      i++;
      return line.slice(name.length + 2);
    }
    if (!optional) refuse(`missing ${name}`);
    return undefined;
  };
  const uri = field("URI") as string;
  let uriOk = false;
  try {
    const u = new URL(uri);
    uriOk = u.protocol === "https:" && u.host === host && !u.username && !u.password;
  } catch {
    uriOk = false;
  }
  if (!uriOk) return refuse("URI is not Keyframe's API");
  if (field("Version") !== "1") return refuse("unsupported version");
  if (Number(field("Chain ID")) !== CHAIN_ID) return refuse("not Base");
  const nonce = field("Nonce") as string;
  if (!/^[A-Za-z0-9]{8,64}$/.test(nonce)) return refuse("bad nonce");
  const issuedAt = time(field("Issued At"), "Issued At");
  const expiresAt = time(field("Expiration Time"), "Expiration Time");
  field("Not Before", true);
  field("Request ID", true);
  if (i !== lines.length) return refuse("unexpected extra lines");
  const now = expected.now;
  if (Math.abs(issuedAt - now) > CLOCK_SKEW_S && !expected.forSubmit) return refuse("issued at an unexpected time");
  if (expiresAt - issuedAt > SIWE_MAX_LIFETIME_S) return refuse("it stays valid too long");
  if (expiresAt <= now) {
    throw new ToolError(
      "The sign-in message has expired; call keyframe_orders again with just the address. Nothing was signed.",
    );
  }
  return { domain: host, address: expected.address, uri, nonce, issuedAt, expiresAt };
}

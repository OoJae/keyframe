// Plain-English order states (product vocabulary): the escrow address is a "sealed envelope" that opens only two
// ways. SEALED = paid into escrow; KEY PUBLISHED = delivered and paid out; RETURNED = refunded to the buyer.

import { Status } from "../protocol/index.js";
import { usdc } from "./text.js";

export const ENVELOPES = ["NOT SEALED", "SEALED", "IN REVIEW", "KEY PUBLISHED", "RETURNED", "UNKNOWN"] as const;
export type Envelope = (typeof ENVELOPES)[number];

export function envelopeOf(
  status: number | undefined,
  balance: bigint | undefined,
  amount: bigint | undefined,
): { envelope: Envelope; meaning: string } {
  switch (status) {
    case Status.Released:
      return { envelope: "KEY PUBLISHED", meaning: "the studio published the key to the file on Base and was paid" };
    case Status.Refunded:
      return { envelope: "RETURNED", meaning: "the deadline passed and the escrowed USDC went back to the buyer" };
    case Status.Cancelled:
      return {
        envelope: "RETURNED",
        meaning: "the studio voided the order and the escrowed USDC went back to the buyer",
      };
    case Status.Rejected:
      return {
        envelope: "RETURNED",
        meaning:
          "the buyer rejected the delivery in review; the agreed kill fee (if any) went to the designer, the rest back to the buyer",
      };
    case Status.Delivered:
      return {
        envelope: "IN REVIEW",
        meaning: "the Studio delivery is in its review window; the key is not published yet",
      };
    case Status.Open:
      return { envelope: "SEALED", meaning: "the USDC is in escrow and the order is registered on Base" };
    case Status.None:
      if (balance !== undefined && amount !== undefined && balance >= amount && amount > 0n) {
        return {
          envelope: "SEALED",
          meaning: "the USDC is at the escrow address; on-chain registration of the deal is pending",
        };
      }
      if (balance !== undefined && balance > 0n && amount !== undefined) {
        return {
          envelope: "NOT SEALED",
          meaning: `the escrow address holds ${usdc(balance)} of ${usdc(amount)} USDC; it is not fully paid`,
        };
      }
      return { envelope: "NOT SEALED", meaning: "nothing has been paid into the escrow address yet" };
    default:
      return { envelope: "UNKNOWN", meaning: "the on-chain state could not be read" };
  }
}

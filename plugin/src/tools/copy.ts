// Tool titles and descriptions (product-render-demo.md §A5). Titles are numbered to sequence the agent.
// Descriptions are factual documentation: PayBox treats them as untrusted labels. Frozen at upload; snapshotted
// in tool-catalog.json. Wording rules: plain English, never "PayBox-verified", "audited" or "AI video generator".

export const COPY = {
  keyframe_styles: {
    title: "Keyframe · browse formats and prices (free)",
    description:
      "Lists what Keyframe Studio makes and what it costs: formats (launch sting, countdown, portfolio card, kinetic post, price-chart moment, and human Studio commissions), styles, aspect ratios, durations, prices in USDC on Base, typical delivery time, current queue and sample video links. Every template is designed by hand by Keyframe's designer; agents only fill typed fields. Free; moves no money. If the user already said what they want, go straight to keyframe_quote.",
  },
  keyframe_quote: {
    title: "Keyframe · 1. quote an order (free)",
    description:
      "Prices an order and prepares its pay-on-delivery escrow. Fill only the typed fields; omit optional fields rather than inventing names, colors or numbers the user did not give. buyer is the address of the PayBox wallet that will pay (list_credentials → metadata.address). For portfolio_pulse, first call get_portfolio for that address and pass its result unchanged as params.portfolio. Returns price, delivery time, deadline, a watermarked preview of the key frame, the escrow address (derived from the deal terms and re-checked by this plugin) and the payment route for this wallet. Moves no money. Show the user the price, deadline, preview link and escrow address. Next: the tool named in next.tool. If quote_status is draft (preview pending), call keyframe_status with quote_id after retry_after_ms. Amounts are atomic USDC (1000000 = 1.00 USDC).",
  },
  keyframe_commission: {
    title: "Keyframe · 2. pay into escrow (1 approval)",
    description:
      "Creates the payment for a quote as one PayBox approval: an x402 payment of the quoted USDC on Base, gasless for the payer. The money goes to the order's escrow address, never to Keyframe directly. It can pay the studio only if the studio publishes the key to the buyer's file before the deadline; otherwise it can only return to the buyer, automatically. Before proposing, this plugin re-derives the escrow address and checks that the live payment request pays exactly that address and amount. Input: quote_id (valid 5 minutes). Use the wallet_id of the quote's buyer wallet. PayBox shows the payee and amount for approval. After approval, poll get_request until it finishes; never call this tool twice for one quote. Then call keyframe_verify with the paid response.",
  },
  keyframe_commission_direct: {
    title: "Keyframe · 2b. pay by direct transfer (1 approval, needs ETH gas)",
    description:
      "Payment route for wallets that cannot pay by x402 (for example EIP-7702-delegated wallets). Use only when keyframe_quote returns route.kind = 'direct'. Proposes one Base transaction: USDC.transfer(escrow address, exact price). PayBox's window shows the USDC contract as 'to'; the escrow address and amount are inside the data. Needs a little ETH on Base for gas. Use the wallet_id of the quote's buyer wallet. Poll get_request to success, then call keyframe_verify with mode funding, quote_id and tx_hash.",
  },
  keyframe_status: {
    title: "Keyframe · 3. check an order (free)",
    description:
      "Order progress: preview ready, sealed (paid into escrow), rendering (percent and time left), key published (delivered and paid), returned (refunded) or void. Accepts quote_id (this also finalizes a quote whose preview was pending) or order_id (+ access_token for private orders). Waits up to wait_s seconds (max 6) for a change. Free; moves no money. While rendering, call again after poll_after_s. When the state is KEY PUBLISHED or RETURNED, call keyframe_verify.",
  },
  keyframe_verify: {
    title: "Keyframe · 4. verify delivery independently (free)",
    description:
      "Proves an order's state from Base and public storage instead of trusting Keyframe's server. It recomputes the escrow address from the terms and checks the funding transfer and the escrow's balance and code on two Base RPCs. After delivery it reads the key from the escrow factory's on-chain record, downloads the encrypted file, decrypts it here, and checks its fingerprint, length and resolution against the terms. mode derive works offline (escrow math only); funding checks the payment; delivery checks the key and the file. Accepts the paid response from get_request, or quote_id/order_id (+ tx_hash for direct payments), or the terms themselves. Free; moves no money. Report each check to the user.",
  },
  keyframe_refund: {
    title: "Keyframe · return funds after deadline (fallback)",
    description:
      "Fallback only. Refunds are automatic: after the deadline, Keyframe's keepers (or anyone) return the escrowed USDC to the buyer. If keyframe_status still shows funds in escrow after the deadline, this proposes the same public refund call from the buyer's wallet (one approval, needs a little ETH on Base). The money can only go to the buyer. action sweep returns late or extra funds after an order has settled; action reject is the buyer's own Studio-review rejection. Refuses with the exact time when an action is not allowed yet.",
  },
  keyframe_review: {
    title: "Keyframe · Studio review: accept, changes or reject",
    description:
      "For Studio orders whose watermarked preview is ready. decision: accept (pay the designer now), changes (one revision) or reject (refund to the buyer, minus the kill fee in the deal, if any). The first call returns an EIP-712 message. Confirm with the user, sign it with request_wallet_sign (no gas; moves no money by itself), then call again with the signature and sig_deadline. This plugin only passes on messages for Keyframe's own escrow contract. Doing nothing until the review window ends counts as accept.",
  },
  keyframe_orders: {
    title: "Keyframe · find my orders (free)",
    description:
      "Lists a buyer's Keyframe orders with fresh access links, for use in a new chat. The first call returns a sign-in message (EIP-4361) for request_wallet_sign; call again with the message and the signature. This plugin checks that the message signs in to Keyframe only. Free; moves no money.",
  },
} as const;

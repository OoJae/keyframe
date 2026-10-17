import type { Config } from "../config.js";

// Human pages on the API origin and the additive `links` entries that point at them. URLs never carry secrets:
// a private order's access token and k_buyer travel only in the URL fragment, added by the buyer's own agent.

/** Fixed link kinds the plugin prints with its own labels (additive `links: [{kind, url}]` fields). */
export type LinkKind = "watch" | "download" | "receipt" | "review" | "preview" | "samples" | "order";
export interface Link {
  kind: LinkKind;
  url: string;
}

/** Watch & download page (deterministic per order, so paid-body replays stay byte-identical). */
export const watchUrl = (cfg: Config, orderId: string) => `${cfg.publicBaseUrl}/w/${orderId}`;
/** Watermarked preview page of a quote. */
export const previewPageUrl = (cfg: Config, quoteId: string) => `${cfg.publicBaseUrl}/q/${quoteId}`;

/** `watch_url` and `links` for an order record, once the key is published (the file can be opened). */
export function orderLinks(cfg: Config, o: { id: string; status: string }): { watch_url?: string; links?: Link[] } {
  if (o.status !== "key_published") return {};
  const url = watchUrl(cfg, o.id);
  return { watch_url: url, links: [{ kind: "watch", url }] };
}

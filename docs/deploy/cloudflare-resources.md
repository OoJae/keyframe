# Cloudflare resources (created 2026-10-17, account "Captainjoe550@gmail.com's Account")

Non-secret identifiers. Secrets live only in Cloudflare (wrangler secret) and the gitignored `.env`.

| Resource | Name | Id |
|---|---|---|
| Worker (spike) | keyframe-spike | https://keyframe-spike.keyframe-spike-server.workers.dev |
| KV (spike) | SPIKE_KV | cf92204a268b409db53d0ed116757b4e |
| D1 (api) | keyframe | e025cc17-93dd-40d8-9bb7-7e4a251a1cb0 |
| KV (api) | KEYFRAME_KV | 8e2b0d9a8a2f469f8ee9d2fd5af7193d |
| R2 (api) | keyframe-files | — |

workers.dev subdomain: `keyframe-spike-server.workers.dev` (so the API will be `keyframe-api.keyframe-spike-server.workers.dev`
unless a custom domain is attached). Pre-existing account resources NOT owned by Keyframe (never touch): R2 bucket `curb-archive`.

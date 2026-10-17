# Tonight: what changed, and what only you can do

**Upload lock: 00:00 UTC = 1:00 am your time (8 pm EDT).** After it the plugin file is frozen; the API, worker, env vars
and hosts can still change.

## What changed today (all tested)

- **First real mainnet order:** placed from Claude.ai, sealed, key published, verified 16/16 by the plugin.
  [evidence/LIVE.md](evidence/LIVE.md).
- **Full system test:** 49/49 on a Base fork with real USDC, on all of today's code.
- **Plugin bundle (needs your upload):** `plugin/dist/plugin.mjs`, sha256
  `ead285eb2c22d3caf448dc3cff5378088f1e0034331707e351b0e056dcfa63a2`.
  - Tool text now prints Keyframe's own links: watch & download, motion preview, review preview, samples.
  - Tool descriptions use the words people search for (video, animation, logo intro, MP4).
  - Adds a Solana-USDC funding hint.
  - 276 tests and starter conformance pass. Tool schemas are unchanged.
- **API (needs your OK to deploy):**
  - **New pages:**
    - `/w/<order>` decrypts the video in the browser with the key from Base, plays it, offers a download and shows a receipt;
    - `/q/<quote>` is a motion preview page;
    - `/` is a front page.
  - **Playback and links:** `/files` supports byte ranges (iPhone playback). The paid body and order records carry `watch_url`.
  - **Studio offline:** quotes fail fast with a clear message, and nothing is charged.
  - **Honest catalog:**
    - formats that can't be bought yet are no longer advertised;
    - disclosures cover public delivery and silent clips;
    - palette presets that aren't designed yet get a clear 422.
  - **Names:** ENS and brand-domain names like `ripcord.eth` or `pump.fun` are no longer refused.
  - **Faster key:** the key is published about 3 s after payment, down from up to a minute.
  - **Relayer gas floor:** see below.
  - 211 tests pass.
- **Render worker (already live on this Mac):**
  - countdowns show the buyer's own timezone;
  - a new `studio` command (see below);
  - it now runs under a restart-on-crash loop;
  - the Mac is kept awake for 7 days.
- **Contracts:** the factory source is now verified on Sourcify. The deployed factory differs from `main` in one
  gas-safety constant. It's harmless with the new relayer gas floor; [deploy/factory-v1.md](deploy/factory-v1.md)
  explains it.

## What only you can do, in order

1. **Say "deploy"** in this chat. I'll run `scripts/deploy-mainnet.sh api` (same secrets, no migration). Then I'll
   check `/health`, the watch page for the live order, the plugin's verify, and an iPhone-style byte-range request.
2. **Upload the new plugin file** in the portal: "Upload new version" → `plugin/dist/plugin.mjs` → check that the sha256
   matches the one above → Run checks → Test console (`keyframe_styles`, then `keyframe_verify` with the sample) →
   **Submit Project** again. Aim for 11 pm your time, not 12:59.
3. **Blurb (optional, ≤280 characters).** Two options; both only claim what's live:
   - (266) Hire a motion designer from chat, pay only on delivery. Your clip renders before you pay; one PayBox tap
     seals your USDC in an escrow on Base. The studio is paid only by publishing your file's key on time; otherwise
     the money comes back to you. Live on Base mainnet.
   - (248) Hire a motion designer from chat: countdowns now, hand-made Studio pieces on request. The video renders
     before you pay; one PayBox tap seals your USDC on Base, and the studio is paid only by unlocking your file on
     time, or the money returns to you.
4. **Your craft:**
   - **Templates:** the `launch_sting` design, `templates/_kit/MOTION.md`, and palette presets in
     `templates/_kit/palettes.json`. This is backend-only, so it's fine after the lock. When a design is ready, remove
     it from `FORMATS_DISABLED` in `apps/api/wrangler.toml` and redeploy.
   - **The film:** 75–90 s in your own voice, posted on X. Shot list below.
5. **Decisions:**
   - Licences: MIT for `contracts/`, `plugin/` and `packages/`; templates all rights reserved?
   - Publish the repo on GitHub? `README.md` is drafted and only claims what's live.
   - Write `HUMAN.md` in your own words: what you designed and decided, and what the AI built.

## Studio commissions (if someone buys one)

I'm watching the inbox and will notify you. Deliver from `apps/worker`:

```bash
node --env-file=.env src/cli.ts studio inbox                       # brief, spec, deadline
node --env-file=.env src/cli.ts studio check master.mp4 --aspect 9:16 --duration 10
node --env-file=.env src/cli.ts studio deliver o_… master.mp4      # watermarked review preview + sealed master
node --env-file=.env src/cli.ts studio cancel o_… --yes            # can't make it: full refund
```

## Film shot list (75–90 s)

| Time | Shot |
|---|---|
| 0:00 | Cold open: your countdown playing on the watch page. "An AI agent paid for this video, and the studio got paid only when its key landed on Base." |
| 0:06 | Claude.ai: type the one-line request. |
| 0:14 | The quote card with its motion preview; open the preview page. |
| 0:24 | The PayBox window: the payee is the escrow address, 1.00 USDC. One passkey tap. |
| 0:32 | Basescan: an address with no code holding 1 USDC, then the release transaction carrying the key. |
| 0:42 | The watch page: "Opened in this browser with the key from Base". Play it, then Download. |
| 0:52 | The safety net: if the studio misses the deadline, the money goes home by itself. Show the refund evidence. |
| 1:02 | Your design process for the templates (timelapse). |
| 1:12 | End card: "Keyframe: pay on delivery for the agent economy. Live on Base." Show the factory address and the tx links. |

Disclosure line for the post: "The buyer and studio wallets are both mine; real USDC, Base mainnet."

# Keyframe demo film

78 s, 1920×1080, 30 fps, with the builder's own voiceover (retimed to it). Built in HyperFrames from real footage of the live product:
- the Claude.ai quote (a fresh chat, 2026-10-17);
- the PayBox card from the first mainnet order;
- Basescan: the funding transaction, the release transaction and its event log;
- the watch page decrypting the paid file;
- the paid countdown itself, decrypted with its published key.

Captions are burned in, because X autoplays muted.

Render (from this folder; HyperFrames 0.8.140, the builder's pinned install):

```bash
HF=/Users/oluwademilade/Desktop/ignix/video/hyperframes/node_modules/.bin/hyperframes
HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_NO_UPDATE_CHECK=1 $HF render . --fps 30 --quality looks --video-frame-format png -o renders/keyframe-final-silent.mp4
ffmpeg -i renders/keyframe-final-silent.mp4 -c copy -movflags +faststart renders/keyframe-demo.mp4
```

Voiceover: the builder's recording (`assets/vo/raw.m4a`, not committed) is cleaned and normalised to -16 LUFS with
`ffmpeg -i assets/vo/raw.m4a -af "highpass=f=80,afftdn=nf=-28,acompressor=threshold=-21dB:ratio=2.5:attack=8:release=120:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=9" -ar 48000 -ac 2 assets/vo/vo.wav`.
It sits at 0.5 s in the timeline. Scene windows and reveals come from its word timings (`assets/vo/transcript.json`,
from `hyperframes transcribe`), with each reveal landing about 0.15 s before its word.

## Scenes

| Time | Scene |
|---|---|
| 0:00 | Cold open: the paid video plays. "An AI agent just bought this video. The studio got paid only when it was delivered." |
| 0:07 | Title: Keyframe. Hire a motion designer from chat. Pay only on delivery. |
| 0:11 | The problem: agents can pay, but paying up front is a leap of faith (no refunds, no escrow, no proof of delivery). |
| 0:19 | 01 Ask: the Claude.ai request and quote, with the watermarked preview. |
| 0:31 | 02 One tap: the PayBox "Payment sent" card, then Basescan showing buyer → escrow, 1 USDC. |
| 0:41 | 03 Your file: the key and fingerprint in the release log, then the watch page opening the file with four checks. |
| 0:56 | Proof: the agent's own `keyframe_verify`, 16/16. |
| 1:03 | Safety net: escrow → studio (only with the key) or → back to you (keeper refunds automatically). |
| 1:11 | What you can order today: Countdown, Studio commissions, any x402 client. |
| 1:19 | End card: links, the disclosure line, and "MoonPay Hackathons · Chapter 1". |

## Optional voiceover (your own voice, about 150 words)

Record over the cut; each line starts on its scene.

1. (0:00) "An AI agent just bought this video, and the studio only got paid when it was delivered."
2. (0:07) "This is Keyframe. Hire a motion designer from chat, and pay only on delivery."
3. (0:11) "Agents can pay now. But paying a stranger up front is a leap of faith. There's no refund, no escrow, no proof."
4. (0:19) "So you ask in plain words. Keyframe renders the clip first, so you watch a preview and get an exact price."
5. (0:31) "One passkey tap, and your USDC goes to an escrow address computed from the deal. Nobody owns it."
6. (0:41) "The studio only gets paid by publishing the key to your file on Base. Your browser reads that key and opens the file."
7. (0:56) "And your agent checks it again, by itself. Sixteen out of sixteen."
8. (1:03) "If the studio is late, the money comes home by itself."
9. (1:11) "Countdowns, hand-made Studio pieces, and any x402 client."
10. (1:19) "Keyframe. Pay on delivery, live on Base."

## X post

Main post (278 characters; attach `keyframe-demo.mp4`):

> I built Keyframe for the MoonPay PayBox hackathon: hire a motion designer from chat, and pay only on delivery.
>
> Your agent shows you the clip first. One gasless USDC tap seals it in an escrow on Base, and the studio gets paid only by publishing your file's key. Live on mainnet.

Reply 1 (links count as 23 characters each):

> Try it, or check every step yourself:
> • watch page (opens with the key from Base): keyframe-api.keyframe-spike-server.workers.dev/w/o_YF8xCvJy3fusQUQzaJCMjG
> • code: github.com/OoJae/keyframe
> • release tx: basescan.org/tx/0x9c1fbc5eb3a8d4ecc27096600f6cabbb3e2114f6bcebfd24806163e88f1e82e0

Reply 2:

> Real USDC on Base mainnet; the buyer and studio wallets in the demo are both mine. Contracts are unaudited, so orders are capped at 50 USDC.

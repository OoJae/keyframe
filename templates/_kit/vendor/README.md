# Vendored GSAP

Copied byte for byte from npm `gsap@3.15.0` (`dist/`). These are the same files the builder vendored for the
Covenant film (`ignix/video/hyperframes/assets/vendor/`), and the hashes match. Templates load them with
`<script src="kit/vendor/gsap.min.js">`. Nothing is loaded from a CDN, because HyperFrames renders must not
fetch over the network.

| File | sha256 |
|---|---|
| `gsap.min.js` | `92bb9a96476f983d212a2bc4f54c889039c1696dd4461d40a736860938570fbb` |
| `CustomEase.min.js` | `466e426a5c60c21c94b15a30a3dffacac9bb39ce8f4e07d071d7d4bb1be43390` |

The worker test suite (`apps/worker/test/kit.test.ts`) checks these hashes against the pinned
`gsap@3.15.0` in `apps/worker/node_modules`. To upgrade GSAP, bump the version in `apps/worker/package.json`,
copy both files from `node_modules/gsap/dist/`, update this table, and expect every template hash to change.

License: GreenSock "Standard 'no charge' license" (https://gsap.com/standard-license), as stated in each file's header.

# syntax=docker/dockerfile:1
# Keyframe render worker: Node 24 + ffmpeg + the pinned HyperFrames CLI + its pinned chrome-headless-shell.
# Build from the repository root (the image needs templates/ too):
#   docker build --platform linux/amd64 -f apps/worker/Dockerfile -t keyframe-worker .
# linux/amd64 only: chrome-for-testing publishes no linux-arm64 headless shell, and `hyperframes browser ensure`
# would fall back to Debian's unpinned chromium there (HyperFrames issue #2039). On an Apple-silicon Mac, run the
# worker natively instead (README: "Builder's Mac").

# node:24.21.0-bookworm-slim, linux/amd64 (pinned by digest).
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

ARG TARGETARCH
RUN if [ "${TARGETARCH:-amd64}" != "amd64" ]; then \
      echo "keyframe-worker: linux/amd64 only (got ${TARGETARCH}); see the Dockerfile header" >&2; exit 1; fi

# ffmpeg; chrome-headless-shell's shared libraries (the list HyperFrames' own Dockerfile.render uses); unzip for the
# browser download; fonts only as a fallback (templates ship their own); tini as PID 1 for signal forwarding.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates unzip tini ffmpeg \
      libgbm1 libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 libxdamage1 libxrandr2 libcups2 libasound2 \
      libpangocairo-1.0-0 libxshmfence1 libgtk-3-0 libxkbcommon0 \
      fonts-dejavu-core fontconfig \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HYPERFRAMES_NO_TELEMETRY=1 \
    HYPERFRAMES_NO_UPDATE_CHECK=1 \
    HYPERFRAMES_SKIP_SKILLS=1 \
    HYPERFRAMES_NO_AUTO_INSTALL=1 \
    DO_NOT_TRACK=1 \
    TZ=UTC \
    TEMPLATES_DIR=/app/templates \
    WORK_DIR=/work \
    HEALTH_HOST=0.0.0.0 \
    HEALTH_PORT=8790

RUN mkdir -p /app/apps/worker /work && chown -R node:node /app /work
USER node
WORKDIR /app/apps/worker

# Exact dependency tree from the lockfile; no lifecycle scripts (nothing in the tree needs one to run).
COPY --chown=node:node apps/worker/package.json apps/worker/package-lock.json apps/worker/.npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The browser HyperFrames pins (chrome-headless-shell 152.0.7977.30 for hyperframes 0.8.140) into ~/.cache.
RUN node node_modules/hyperframes/bin/hyperframes.mjs browser ensure

COPY --chown=node:node apps/worker/src ./src
COPY --chown=node:node templates /app/templates

# Build gate: node, ffmpeg encoders, browser, every template.json and its hash.
RUN node src/cli.ts preflight > /dev/null

VOLUME ["/work"]
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8790/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "src/cli.ts"]
CMD ["serve"]

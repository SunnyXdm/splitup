FROM node:24 AS webbuild
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

# Full image so better-sqlite3 can compile if no prebuild matches.
FROM node:24 AS serverdeps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci

# OpenAI Codex CLI for receipt scanning (pinned). Install the JS launcher with
# --omit=optional plus only this architecture's platform package, then drop
# the parts `codex exec` doesn't use: the voice-mode runtime (~75 MB) and the
# code-mode host (~71 MB). What's left is the ~276 MB codex binary + rg/bwrap.
FROM node:24-slim AS codex
ARG CODEX_VERSION=0.160.1
ARG TARGETARCH
RUN set -eu; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in amd64) p=x64 ;; arm64) p=arm64 ;; *) echo "unsupported arch: $arch" >&2; exit 1 ;; esac; \
    npm install -g --omit=optional --no-fund --no-audit \
      "@openai/codex@${CODEX_VERSION}" \
      "@openai/codex-linux-${p}@npm:@openai/codex@${CODEX_VERSION}-linux-${p}"; \
    vendor=$(echo /usr/local/lib/node_modules/@openai/codex-linux-${p}/vendor/*-linux-musl); \
    rm -rf "$vendor/codex-resources/voice" "$vendor/bin/codex-code-mode-host"; \
    test -x "$vendor/bin/codex"; \
    npm cache clean --force

FROM node:24-slim
ENV NODE_ENV=production
# ca-certificates: the codex binary verifies TLS against the system store.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=codex /usr/local/lib/node_modules/@openai /usr/local/lib/node_modules/@openai
RUN ln -s ../lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex \
    && mkdir -p -m 700 /codex
# Holds auth.json from `codex login`; mount a volume here to keep it.
ENV CODEX_HOME=/codex
WORKDIR /app/server
COPY --from=serverdeps /app/server/node_modules ./node_modules
COPY server/ .
COPY --from=webbuild /app/web/dist /app/web/dist
EXPOSE 8790
# node is PID 1 directly (no npm/npx wrapper) so SIGTERM reaches the app.
CMD ["node", "--import", "tsx", "src/index.ts"]

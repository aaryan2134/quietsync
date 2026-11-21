FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock .bun-version tsconfig.json ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/relay/package.json packages/relay/package.json
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4.4-alpine
WORKDIR /app
ARG QUIETSYNC_VERSION=dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/aaryan2134/quietsync" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="QuietSync Relay" \
      org.opencontainers.image.description="Relay for end-to-end encrypted QuietSync traffic and offline queues" \
      org.opencontainers.image.version="$QUIETSYNC_VERSION" \
      org.opencontainers.image.revision="$VCS_REF"
COPY --from=build /app/packages/cli/dist/quietsync.mjs /app/packages/cli/dist/relay.mjs /app/
COPY --from=build /app/LICENSE /app/NOTICE /app/LEGAL.md /app/plugins/claude-code/dist/THIRD_PARTY_NOTICES.md /app/
ENV HOST=0.0.0.0 PORT=8787 QUIETSYNC_RELAY_DB=/data/relay.sqlite
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
EXPOSE 8787
USER bun
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["bun", "/app/quietsync.mjs", "relay"]

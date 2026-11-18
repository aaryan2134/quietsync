FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run build

FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY --from=build /app/packages/cli/dist/quietsync.mjs /app/packages/cli/dist/relay.mjs /app/
COPY --from=build /app/LICENSE /app/NOTICE /app/LEGAL.md /app/plugins/claude-code/dist/THIRD_PARTY_NOTICES.md /app/
ENV HOST=0.0.0.0 PORT=8787 QUIETSYNC_RELAY_DB=/data/relay.sqlite
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
EXPOSE 8787
USER bun
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["bun", "/app/quietsync.mjs", "relay"]

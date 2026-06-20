# 构建 Next.js 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# Runtime image: starts the Next.js app. Optional AI provider keys stay server-side via /api/ai-proxy.
FROM node:22-bookworm-slim

WORKDIR /app
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY --from=web-build /app/web/public /app/web/public
COPY --from=web-build /app/web/.next/standalone /app/web
COPY --from=web-build /app/web/.next/static /app/web/.next/static
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV IMAGE_WORKER_DATA_DIR=/app/data
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && mkdir -p /app/data && rm -rf /var/lib/apt/lists/*

EXPOSE 3000
CMD ["sh", "-c", "cd /app/web && PORT=3000 node server.js"]

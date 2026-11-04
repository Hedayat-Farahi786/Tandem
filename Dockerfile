# Tandem, the hosted web app. One container: the sign-in front, every workspace's engine and its
# runner. Data lives in /data (mount a volume). See docs/DEPLOYMENT.md.
#
#   docker build -t tandem .
#   docker run -p 8080:8080 -v tandem-data:/data --env-file tandem.env tandem

# ---------------------------------------------------------------- build
FROM node:22.21.1-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /src
# Dependencies first, so source changes don't refetch them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY spikes/package.json spikes/
RUN pnpm install --frozen-lockfile --filter "@tandem/server..." --filter "@tandem/web..."
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm exec tsc -b apps/server && pnpm --filter @tandem/web build
# Only what runs: production dependencies of the server and its packages.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --filter "@tandem/server..."

# ---------------------------------------------------------------- run
FROM node:22.21.1-bookworm-slim
# git for the repositories; the JavaScript package managers that builds of customer repos use.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /app
COPY --from=build /src/package.json /src/pnpm-workspace.yaml ./
COPY --from=build /src/node_modules node_modules
# The built packages and the server, each with its own production dependencies.
COPY --from=build /src/packages packages
COPY --from=build /src/apps/server apps/server
COPY --from=build /src/apps/web/dist apps/web/dist
COPY docs/legal docs/legal

RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production \
    TANDEM_MODE=hosted \
    TANDEM_HOME=/data \
    TANDEM_PORT=8080 \
    TANDEM_LISTEN_HOST=0.0.0.0
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TANDEM_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/cli.js", "start", "--no-open"]

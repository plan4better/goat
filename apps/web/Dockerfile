FROM node:22-alpine AS base

FROM base AS builder
RUN apk add --no-cache libc6-compat
RUN apk update

# Set working directory
WORKDIR /app
RUN npm install -g turbo@2.10.7
COPY . .
RUN turbo prune @p4b/web --docker


# Add lockfile and package.json's of isolated subworkspace
FROM base AS installer
RUN apk add --no-cache libc6-compat
RUN apk update
WORKDIR /app

# First install the dependencies (as they change less often)
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN npm install -g corepack@latest
RUN corepack enable
RUN pnpm install --frozen-lockfile

# Build the project
COPY --from=builder /app/out/full/ .

ARG NEXT_PUBLIC_APP_URL=APP_NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_MAPBOX_TOKEN=APP_NEXT_PUBLIC_MAPBOX_TOKEN
ARG NEXT_PUBLIC_GEOAPI_URL=APP_NEXT_PUBLIC_GEOAPI_URL
ARG NEXT_PUBLIC_PROCESSES_URL=APP_NEXT_PUBLIC_PROCESSES_URL
ARG NEXT_PUBLIC_API_URL=APP_NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_CATALOG_URL=APP_NEXT_PUBLIC_CATALOG_URL
ARG NEXT_PUBLIC_APP_ENVIRONMENT=APP_NEXT_PUBLIC_APP_ENVIRONMENT
ARG NEXT_PUBLIC_KEYCLOAK_ISSUER=APP_NEXT_PUBLIC_KEYCLOAK_ISSUER
ARG NEXT_PUBLIC_KEYCLOAK_CLIENT_ID=APP_NEXT_PUBLIC_KEYCLOAK_CLIENT_ID
ARG NEXT_PUBLIC_AUTH=APP_NEXT_PUBLIC_AUTH
ARG NEXT_PUBLIC_WEBSITE_URL=APP_NEXT_PUBLIC_WEBSITE_URL
ARG NEXT_PUBLIC_STATUS_FEED_URL=APP_NEXT_PUBLIC_STATUS_FEED_URL

# The runner stage copies only the standalone server, the static files and
# public/. Next's compilation cache and turbo's copy of the build outputs
# would stay in this layer, which is exported to the build cache on every
# build, so they are removed in the same step.
RUN pnpm exec turbo run build --filter=@p4b/web \
    && rm -rf apps/web/.next/cache .turbo


FROM base AS runner
RUN apk add bash

WORKDIR /app
# Don't run production as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
USER nextjs

COPY --from=installer /app/apps/web/next.config.js .
COPY --from=installer /app/apps/web/package.json .

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=installer --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=installer --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=installer --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

ENV HOSTNAME=0.0.0.0

COPY ./apps/web/entrypoint.sh /app/apps/web/entrypoint.sh
ENTRYPOINT ["/app/apps/web/entrypoint.sh"]
CMD ["node", "apps/web/server.js"]


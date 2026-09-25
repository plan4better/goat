FROM node:22-alpine AS base

# Only storybook and the workspace packages it builds from, with their
# lockfile entries, so a change elsewhere in the monorepo leaves the install
# and build below cached.
FROM base AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
RUN npm install -g turbo@2.10.7
COPY . .
RUN turbo prune @p4b/storybook --docker

FROM base AS installer
RUN apk add --no-cache libc6-compat
WORKDIR /app
# corepack picks the pnpm release named in package.json's packageManager
RUN npm install -g corepack@latest && corepack enable

# First install the dependencies (as they change less often)
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

# Build the project
COPY --from=builder /app/out/full/ .
# Only storybook-static/ goes into the image. The build's caches would stay
# in this layer, which is exported to the build cache on every build, so they
# are removed in the same step.
RUN pnpm exec turbo run build --filter=@p4b/storybook \
    && rm -rf apps/storybook/node_modules/.cache .turbo

# production stage
FROM nginx:stable-alpine AS production-stage
# mkdir called storybook in /usr/share/nginx/html
RUN mkdir /usr/share/nginx/html/storybook
COPY --from=installer /app/apps/storybook/storybook-static /usr/share/nginx/html/storybook
COPY --from=installer /app/apps/storybook/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

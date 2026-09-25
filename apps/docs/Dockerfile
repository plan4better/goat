FROM node:22-alpine AS base

# Only docs' own package and the lockfile entries it uses, so a change
# elsewhere in the monorepo leaves the install and build below cached.
FROM base AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
RUN npm install -g turbo@2.10.7
COPY . .
RUN turbo prune @p4b/docs --docker

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
WORKDIR /app/apps/docs
RUN pnpm run build

# production stage
FROM nginx:stable-alpine AS production-stage
# mkdir called docs in /usr/share/nginx/html
RUN mkdir /usr/share/nginx/html/docs
COPY --from=installer /app/apps/docs/build /usr/share/nginx/html/docs
COPY --from=installer /app/apps/docs/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

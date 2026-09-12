const withBundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig = {
  output: "standalone",
  env: {
    // Client-bundle vars derived from their single source of truth. An
    // explicitly set NEXT_PUBLIC_* value always wins — Docker builds set them
    // to placeholders that entrypoint.sh substitutes at container start.
    NEXT_PUBLIC_AUTH: process.env.NEXT_PUBLIC_AUTH ?? process.env.AUTH ?? "",
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? "",
    NEXT_PUBLIC_KEYCLOAK_ISSUER:
      process.env.NEXT_PUBLIC_KEYCLOAK_ISSUER ??
      (process.env.KEYCLOAK_SERVER_URL && process.env.REALM_NAME
        ? `${process.env.KEYCLOAK_SERVER_URL}/realms/${process.env.REALM_NAME}`
        : ""),
    NEXT_PUBLIC_KEYCLOAK_CLIENT_ID:
      process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID ?? process.env.KEYCLOAK_CLIENT_ID ?? "",
    NEXT_PUBLIC_APP_ENVIRONMENT:
      process.env.NEXT_PUBLIC_APP_ENVIRONMENT ?? process.env.ENVIRONMENT ?? "",
  },
  reactStrictMode: true,
  transpilePackages: ["@p4b/ui", "@p4b/tsconfig"],
  // The pwa-icon routes use sharp, whose libvips shared library is loaded by
  // the dynamic linker (not require()), so output file tracing misses it and
  // the standalone build 500s with ERR_DLOPEN_FAILED. Globs resolve from this
  // directory; node_modules lives at the monorepo root.
  outputFileTracingIncludes: {
    "/api/pwa-icon/**": ["../../node_modules/.pnpm/@img+sharp-libvips-*/**/*"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "assets.plan4better.de" },
      { protocol: "https", hostname: "source.unsplash.com" },
    ],
  },
};

module.exports = withBundleAnalyzer(nextConfig);

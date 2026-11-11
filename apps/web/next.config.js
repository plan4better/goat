const withBundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true",
});

/** `next/image` hosts besides the defaults: the static product asset host
 * when `NEXT_PUBLIC_ASSETS_URL` is an absolute URL at build time. The
 * default root-relative `/assets` is served by this app and needs none. */
const imageRemotePatterns = () => {
  const patterns = [
    { protocol: "https", hostname: "assets.plan4better.de" },
    { protocol: "https", hostname: "source.unsplash.com" },
  ];
  const assetsUrl = (process.env.NEXT_PUBLIC_ASSETS_URL ?? "").trim();
  if (!/^https?:\/\//i.test(assetsUrl)) return patterns;
  try {
    const { protocol, hostname, port } = new URL(assetsUrl);
    if (!patterns.some((p) => p.hostname === hostname)) {
      patterns.push({ protocol: protocol.replace(/:$/, ""), hostname, ...(port ? { port } : {}) });
    }
  } catch {
    // Not a parseable URL: only the defaults apply.
  }
  return patterns;
};

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
  // Hostnames besides localhost that may load the dev server's own resources
  // (HMR, /_next/*), e.g. when it is opened over a VPN name. Comma-separated.
  allowedDevOrigins: (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
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
    remotePatterns: imageRemotePatterns(),
  },
  // A typed /settings lands on the profile, as a 307 before rendering and
  // before the proxy runs. A page.tsx with redirect() under settings/loading.tsx
  // would stream a 200 page that reloads the whole app (Settings load, L1).
  async redirects() {
    return [{ source: "/settings", destination: "/settings/profile", permanent: false }];
  },
};

module.exports = withBundleAnalyzer(nextConfig);

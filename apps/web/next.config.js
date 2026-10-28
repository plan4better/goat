const fs = require("node:fs");
const path = require("node:path");
const { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } = require("next/constants");

const withBundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true",
});

/** MapLibre's worker, copied into public/vendor/maplibre where
 * lib/utils/map/maplibre.ts points setWorkerUrl. MapLibre builds the worker
 * URL at runtime, so Next.js does not bundle it. Copied here rather than in a
 * package script so that every way of starting a dev server or a build has it. */
const copyMaplibreWorker = () => {
  const target = path.join(__dirname, "public", "vendor", "maplibre");
  fs.mkdirSync(target, { recursive: true });
  for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-worker.mjs.map"]) {
    fs.copyFileSync(require.resolve(`maplibre-gl/dist/${file}`), path.join(target, file));
  }
};

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
};

module.exports = (phase) => {
  if (phase === PHASE_DEVELOPMENT_SERVER || phase === PHASE_PRODUCTION_BUILD) {
    copyMaplibreWorker();
  }
  return withBundleAnalyzer(nextConfig);
};

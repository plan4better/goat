// Copies DuckDB-WASM's worker and WebAssembly module into public/, so the
// app serves them itself (GOAT is self-hosted; no CDN) and the bundler never
// has to understand either. The version is part of the path, so a release can
// cache them for good and an upgrade never meets a stale copy.
//
// Run before `next dev` and `next build` (see package.json).
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// package.json is not among the package's exports; the wasm file is, and its
// package.json sits one level up.
const dist = dirname(require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm"));
const { version } = JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8"));

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(webRoot, "public", "vendor", "duckdb", version);
mkdirSync(target, { recursive: true });

// The single-threaded "eh" build: the threaded one needs cross-origin
// isolation, which would break the map's cross-origin tiles.
for (const file of ["duckdb-eh.wasm", "duckdb-browser-eh.worker.js"]) {
  copyFileSync(join(dist, file), join(target, file));
}
console.log(`DuckDB-WASM ${version} → public/vendor/duckdb/${version}`);

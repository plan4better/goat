import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import fs from "fs";
import type { ServerResponse } from "http";
import path from "path";
import { type Plugin, defineConfig } from "vitest/config";

// The style lab: GOAT Styles drawn on a real MapLibre map in headless
// Chromium. `pnpm lab` runs it, `pnpm lab:show` opens the browser to look at
// the cases, `pnpm lab:update` rewrites the screenshot baselines.

const GLYPH_ROUTE = "/lab-glyphs/";
const GLYPH_DIR = path.resolve(__dirname, "lib/style/__tests__/lab/glyphs");
const FIXTURE_ROUTE = "/lab/";
const FIXTURE_DIR = path.resolve(__dirname, "lib/style/__tests__/lab/fixtures");
// The app's API in the lab (NEXT_PUBLIC_API_URL): uploaded icons, which the
// app loads from core's public route by id, answer with the fixture icon.
const API_ROUTE = "/lab-api";
const UPLOAD_ROUTE = `${API_ROUTE}/api/v2/asset/`;
const UPLOAD_FILE = path.join(FIXTURE_DIR, "icon.svg");
// Raster tiles: /lab-raster/{name}/{z}/{x}/{y}, with or without `.webp` and with any query, answers
// fixtures/raster/{name}.webp at every tile address, so the lab's raster sources (image tiles of colored cells, value
// tiles) draw the same tile everywhere.
const RASTER_ROUTE = "/lab-raster/";
const RASTER_DIR = path.join(FIXTURE_DIR, "raster");
// H3 layers: /lab-h3/{z}/{x}/{y}.pbf answers as geoapi answers a layer's tiles, from fixtures/h3/{request}/{z}/{x}/{y}.pbf.
// The request is the hexagons the query asks for (h3-{resolution}-{value}[-{field}]), or the points themselves
// without one. A request the fixtures do not hold is a 400, which MapLibre reports as a map error (it stays silent on a
// 404 tile); an address without a stored tile is empty (204), as geoapi answers a tile without features.
const H3_ROUTE = "/lab-h3/";
const H3_DIR = path.join(FIXTURE_DIR, "h3");
// Closes the connection without an answer: a request that gets no response.
const HANG_UP_ROUTE = "/lab-hang-up";

// lib/utils/map/maplibre.ts points MapLibre at this worker URL, which a dev
// server or a build fills by copying the worker into public/. The lab serves
// it from the installed package instead, so it needs neither.
const WORKER_ROUTE = "/vendor/maplibre/maplibre-gl-worker.mjs";
const WORKER_FILE = path.resolve(__dirname, "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs");

// Answers a path below the route it is mounted at with the file of that path
// under `dir`, and 404 for anything outside it or missing.
function serveDir(dir: string, contentType: (file: string) => string) {
  return (req: { url?: string }, res: ServerResponse, next: (err?: unknown) => void) => {
    const relative = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
    const file = path.resolve(dir, relative);
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", contentType(file));
    fs.createReadStream(file).on("error", next).pipe(res);
  };
}

// Serves MapLibre's worker, the local glyph ranges at
// /lab-glyphs/{fontstack}/{range}.pbf, the lab's fixtures at /lab/, raster
// tiles at /lab-raster/, H3 layers' tiles at /lab-h3/ and uploaded icons at the lab's API, so the lab's maps draw text and icons
// without reaching another server; and a route that answers nothing, for the
// scene's request checks.
function labFiles(): Plugin {
  return {
    name: "lab-files",
    configureServer(server) {
      server.middlewares.use(WORKER_ROUTE, (_req, res, next) => {
        res.setHeader("Content-Type", "text/javascript");
        fs.createReadStream(WORKER_FILE).on("error", next).pipe(res);
      });
      server.middlewares.use(
        GLYPH_ROUTE,
        serveDir(GLYPH_DIR, () => "application/x-protobuf")
      );
      server.middlewares.use(
        FIXTURE_ROUTE,
        serveDir(FIXTURE_DIR, (file) =>
          file.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream"
        )
      );
      server.middlewares.use(RASTER_ROUTE, (req, res, next) => {
        const name = /^\/([a-z0-9-]+)\/\d+\/\d+\/\d+(?:\.webp)?(\?|$)/.exec(req.url ?? "")?.[1];
        const file = name && path.join(RASTER_DIR, `${name}.webp`);
        if (!file || !fs.existsSync(file)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "image/webp");
        fs.createReadStream(file).on("error", next).pipe(res);
      });
      server.middlewares.use(H3_ROUTE, (req, res, next) => {
        const url = new URL(req.url ?? "", "http://lab");
        const address = /^\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url.pathname);
        const query = url.searchParams;
        const h3 = query.get("h3");
        const request = h3
          ? ["h3", h3, query.get("h3_value"), query.get("h3_field")].filter((part) => part !== null).join("-")
          : "points";
        const dir = path.join(H3_DIR, request);
        if (!address || !/^[a-z0-9_-]+$/i.test(request) || !fs.existsSync(dir)) {
          res.statusCode = 400;
          res.end();
          return;
        }
        const file = path.join(dir, address[1], address[2], `${address[3]}.pbf`);
        if (!fs.existsSync(file)) {
          res.statusCode = 204;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/x-protobuf");
        fs.createReadStream(file).on("error", next).pipe(res);
      });
      server.middlewares.use(UPLOAD_ROUTE, (req, res, next) => {
        if (!/^\/[A-Za-z0-9-]+\/file(\?|$)/.test(req.url ?? "")) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "image/svg+xml");
        fs.createReadStream(UPLOAD_FILE).on("error", next).pipe(res);
      });
      server.middlewares.use(HANG_UP_ROUTE, (req) => req.socket.destroy());
    },
  };
}

// The gallery's paths, absolute, where they are set: AUTO_COLORS_GALLERY (the page written) and
// AUTO_COLORS_GALLERY_GROUNDS (a folder with light.png, dark.png and satellite.png). Both are read and written through
// the browser's file commands, which reach files inside the repository's folder only.
function galleryPaths(): Record<string, string> {
  const out: Record<string, string> = {};
  // Asked for by hand only: no build or cached task reads them.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const { AUTO_COLORS_GALLERY: page, AUTO_COLORS_GALLERY_GROUNDS: grounds } = process.env;
  if (page) out.AUTO_COLORS_GALLERY = path.resolve(page);
  if (grounds) out.AUTO_COLORS_GALLERY_GROUNDS = path.resolve(grounds);
  return out;
}

export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [react(), labFiles()] as any,
  publicDir: "public",
  // The app reads its settings from process.env, which a browser has not: in
  // the lab only the API is set (uploaded icons, served above); every other
  // setting is unset, so no URL points at another server. The gallery of
  // automatic colors (auto-colors-gallery.lab.test.tsx) gets its output file
  // and its folder of ground pictures when they are asked for.
  define: { "process.env": JSON.stringify({ NEXT_PUBLIC_API_URL: API_ROUTE, ...galleryPaths() }) },
  // Bundled before the first test file loads; finding them during the run
  // would reload the page under a running test.
  optimizeDeps: {
    include: [
      "maplibre-gl",
      "react",
      "react-dom",
      "react-dom/client",
      "vitest-browser-react",
      // The legend a scene draws beside its map.
      "@mui/material",
      "@mui/material/styles",
      "@mui/material/CssBaseline",
      "@mui/material/GlobalStyles",
      "@mui/material/locale",
      "@mui/utils",
      "i18next",
      "react-i18next",
    ],
  },
  test: {
    // Every lab test, wherever it lives: vitest.config.ts leaves all of them out of the jsdom run.
    include: ["**/*.lab.test.tsx"],
    exclude: ["**/node_modules/**", ".next/**"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: {
          args: [
            // SwiftShader draws WebGL on the CPU: the same pixels with or
            // without a GPU, and on any Linux machine.
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            // No host but the lab's own server resolves, so a request that
            // leaves the machine fails.
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
          ],
        },
      }),
      instances: [{ browser: "chromium" }],
      viewport: { width: 1000, height: 700 },
      // Baselines in __screenshots__/ next to the test, made by `lab:update`. A pixel counts as changed when its
      // color moves past pixelmatch's threshold, low enough that one step of a class palette counts; antialiased
      // edge pixels are not counted, and a scene matches with a handful of changed pixels left over from
      // antialiasing that the edge detection misses.
      expect: {
        toMatchScreenshot: {
          comparatorName: "pixelmatch",
          comparatorOptions: { threshold: 0.02, includeAA: false, allowedMismatchedPixels: 8 },
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});

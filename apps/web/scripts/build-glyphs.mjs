#!/usr/bin/env node
// Builds GOAT's own label fonts: the Noto Sans weights and italics the basemaps' glyph servers do not serve, as
// MapLibre glyph ranges (PBF, signed distance fields) in public/glyphs/<dir>/<start>-<end>.pbf, the license beside
// them (public/glyphs/OFL.txt), and the ranges each stack has (lib/utils/map/glyphRanges.json), which
// lib/utils/map/glyphs.ts routes requests by.
//
// The fonts are Noto Sans v2.015 (SIL Open Font License 1.1), unhinted TTF, as published to notofonts.github.io at a
// pinned commit and checked against their SHA-256. The ranges are drawn by node-fontnik, the tool the public glyph
// servers' Noto Sans was built with (same size, buffer and metrics), fetched into a temporary directory for this run
// only: no dependency of the app. A range without any glyph of the font is left out, and so are SERVER_RANGES, so the
// map asks its own glyph server for them (glyphs.ts).
//
//   node scripts/build-glyphs.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const out = join(web, "public/glyphs");
const manifest = join(web, "lib/utils/map/glyphRanges.json");

const FONTNIK = "fontnik@0.7.7";
const FONTS_URL =
  "https://raw.githubusercontent.com/notofonts/notofonts.github.io/28b15b4b43b7bed62b5cf6e6b0b5ff5846270535/fonts/NotoSans/unhinted/ttf";
const LICENSE = {
  url: "https://raw.githubusercontent.com/notofonts/latin-greek-cyrillic/NotoSans-v2.015/OFL.txt",
  sha256: "cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a",
};

/** The stacks, as a style names them, with their directory and font file. */
const STACKS = [
  {
    stack: "Noto Sans Light",
    dir: "noto-sans-light",
    file: "NotoSans-Light.ttf",
    sha256: "8897d5cba2567d06d437b1de90b65d37ea4c4b40db6b8979ea26d8789ce6e030",
  },
  {
    stack: "Noto Sans Light Italic",
    dir: "noto-sans-light-italic",
    file: "NotoSans-LightItalic.ttf",
    sha256: "ad3012e341f196abf83dc2c680a0ee70917f505135b8662b37d5ed5c020a0a8c",
  },
  {
    stack: "Noto Sans Medium",
    dir: "noto-sans-medium",
    file: "NotoSans-Medium.ttf",
    sha256: "220e74546aee1b9a17cd50025dd917a064d0224e653f562287446c2328e4160b",
  },
  {
    stack: "Noto Sans Medium Italic",
    dir: "noto-sans-medium-italic",
    file: "NotoSans-MediumItalic.ttf",
    sha256: "52e3470eace3028fd4a979f71ba4ffbb97b743934e28618174d92afaeafc7436",
  },
  {
    stack: "Noto Sans Bold Italic",
    dir: "noto-sans-bold-italic",
    file: "NotoSans-BoldItalic.ttf",
    sha256: "3d367743f371f28671d2764e911a53d7c20ec9b6aa8791d059e7090389fc52a5",
  },
];

/** Ranges left to the glyph servers although Noto Sans has a few glyphs in them: they hold scripts Noto Sans lacks
 * and the servers' stacks have (Armenian and Hebrew; Georgian; Georgian Mtavruli; Hebrew and Armenian presentation
 * forms; Arabic presentation forms B), which a range file of Noto Sans alone would leave blank. Their Noto Sans letters
 * (Cyrillic Supplement and Extended, Latin ligatures, combining half marks) then draw in the stand-in stack's weight. */
const SERVER_RANGES = [1280, 4096, 7168, 11520, 64256, 65024];

/** Letters every stack must draw: Latin, Vietnamese, Greek, Greek Extended, Cyrillic. */
const REQUIRED = "AzÄßŁđệỹΩάἄЖщӁ";

async function download(url, sha256) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== sha256) throw new Error(`${url}: SHA-256 ${actual}, expected ${sha256}`);
  return data;
}

const call = (fn, arg) =>
  new Promise((ok, fail) => fn(arg, (error, result) => (error ? fail(error) : ok(result))));

const work = mkdtempSync(join(tmpdir(), "goat-glyphs-"));
try {
  execFileSync("npm", ["install", "--prefix", work, "--no-save", "--no-audit", "--no-fund", FONTNIK], {
    stdio: "inherit",
  });
  const fontnik = createRequire(join(work, "package.json"))("fontnik");

  rmSync(out, { recursive: true, force: true });
  const ranges = {};
  let bytes = 0;
  for (const { stack, dir, file, sha256 } of STACKS) {
    const font = await download(`${FONTS_URL}/${file}`, sha256);
    const [face] = await call(fontnik.load, font);
    const points = new Set(face.points);
    const missing = [...REQUIRED].filter((letter) => !points.has(letter.codePointAt(0)));
    if (missing.length) throw new Error(`${file} lacks ${missing.join(" ")}`);

    const starts = [...new Set(face.points.filter((p) => p <= 0xffff).map((p) => p - (p % 256)))]
      .filter((start) => !SERVER_RANGES.includes(start))
      .sort((a, b) => a - b);
    mkdirSync(join(out, dir), { recursive: true });
    for (const start of starts) {
      const end = start + 255;
      const pbf = await call(fontnik.range, { font, start, end });
      writeFileSync(join(out, dir, `${start}-${end}.pbf`), pbf);
      bytes += pbf.length;
    }
    ranges[stack] = starts;
    console.log(`${stack}: ${starts.length} ranges`);
  }

  const license = await download(LICENSE.url, LICENSE.sha256);
  writeFileSync(
    join(out, "OFL.txt"),
    `GOAT's own label fonts: glyph ranges of Noto Sans Light, Light Italic, Medium, Medium Italic and Bold Italic in
MapLibre's glyph format (PBF, signed distance fields), built from the Noto Sans v2.015 font files by
apps/web/scripts/build-glyphs.mjs. The fonts' license:

${license}`
  );
  writeFileSync(manifest, `${JSON.stringify(ranges, null, 2)}\n`);
  execFileSync("pnpm", ["exec", "prettier", "--write", manifest], { cwd: web, stdio: "inherit" });
  console.log(`${(bytes / 1024 / 1024).toFixed(2)} MB of glyph ranges in ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

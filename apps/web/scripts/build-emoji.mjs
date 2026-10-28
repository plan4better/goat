#!/usr/bin/env node
// Builds GOAT Style's emoji library (`emoji:<code>`) from an unpacked emoji-datasource-google package
// (`npm pack emoji-datasource-google@16.0.0`): the catalogue goatlib checks icon references against and the picker
// lists (packages/python/goatlib/src/goatlib/style/data/emoji.json), one 64 px WebP per emoji the map draws
// (public/assets/icons/emoji), and the picker's sheets (sheets/): one per group, the emoji in catalogue order, and one
// per skin tone, the toned emoji in catalogue order; SHEET_COLUMNS cells of SHEET_CELL px a row, as the picker reads
// them (EmojiPane). An emoji with skin tones lists its five toned codes under `tones` (light to dark; for two people,
// both in the same tone), as the picker's tone choice applies them. The "Component" group is left out.
//
//   node scripts/build-emoji.mjs <path to the package directory>
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const catalogue = resolve(web, "../../packages/python/goatlib/src/goatlib/style/data/emoji.json");
const images = join(web, "public/assets/icons/emoji");

const GROUPS = {
  "Smileys & Emotion": "smileys_emotion",
  "People & Body": "people_body",
  "Animals & Nature": "animals_nature",
  "Food & Drink": "food_drink",
  "Travel & Places": "travel_places",
  Activities: "activities",
  Objects: "objects",
  Symbols: "symbols",
  Flags: "flags",
};

const pkg = process.argv[2];
if (!pkg) {
  console.error("usage: node scripts/build-emoji.mjs <emoji-datasource-google package directory>");
  process.exit(1);
}

const data = JSON.parse(readFileSync(join(pkg, "emoji.json"), "utf8"))
  .filter((e) => e.has_img_google && GROUPS[e.category])
  .sort((a, b) => a.sort_order - b.sort_order);

export const SHEET_COLUMNS = 16;
export const SHEET_CELL = 40;

// The folder's README stays; the images are rebuilt.
mkdirSync(join(images, "sheets"), { recursive: true });
for (const file of readdirSync(images)) if (file.endsWith(".webp")) rmSync(join(images, file));
for (const file of readdirSync(join(images, "sheets"))) rmSync(join(images, "sheets", file));
const TONES = ["1F3FB", "1F3FC", "1F3FD", "1F3FE", "1F3FF"];

/** Writes the WebP of an emoji image and returns its code. */
async function write(image) {
  const code = image.replace(/\.png$/, "");
  const png = readFileSync(join(pkg, "img/google/64", image));
  writeFileSync(
    join(images, `${code}.webp`),
    await sharp(png).webp({ quality: 90, alphaQuality: 100 }).toBuffer()
  );
  return code;
}

/** The toned variants, one per tone, or undefined when the emoji has none (or Google draws only some). */
async function tones(e) {
  const variations = e.skin_variations;
  if (!variations) return undefined;
  const found = TONES.map((t) => variations[t] ?? variations[`${t}-${t}`]);
  if (found.some((v) => !v?.has_img_google)) return undefined;
  return Promise.all(found.map((v) => write(v.image)));
}

const entries = [];
for (const e of data) {
  const code = await write(e.image);
  const toned = await tones(e);
  entries.push({
    code,
    name: (e.name || e.short_name).toLowerCase(),
    group: GROUPS[e.category],
    keywords: [...new Set(e.short_names.map((k) => k.replace(/_/g, " ")))],
    ...(toned ? { tones: toned } : {}),
  });
}
writeFileSync(catalogue, `[\n${entries.map((e) => JSON.stringify(e)).join(",\n")}\n]\n`);

/** One sheet of `codes`, in rows of SHEET_COLUMNS. */
async function sheet(name, codes) {
  const rows = Math.ceil(codes.length / SHEET_COLUMNS);
  const cells = await Promise.all(
    codes.map(async (code, i) => ({
      input: await sharp(readFileSync(join(pkg, "img/google/64", `${code}.png`)))
        .resize(SHEET_CELL, SHEET_CELL)
        .png()
        .toBuffer(),
      left: (i % SHEET_COLUMNS) * SHEET_CELL,
      top: Math.floor(i / SHEET_COLUMNS) * SHEET_CELL,
    }))
  );
  const canvas = sharp({
    create: {
      width: SHEET_COLUMNS * SHEET_CELL,
      height: rows * SHEET_CELL,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
  writeFileSync(
    join(images, "sheets", `${name}.webp`),
    await canvas.composite(cells).webp({ quality: 80, alphaQuality: 100 }).toBuffer()
  );
}

for (const group of Object.values(GROUPS))
  await sheet(
    group,
    entries.filter((e) => e.group === group).map((e) => e.code)
  );
const toned = entries.filter((e) => e.tones);
for (let t = 0; t < TONES.length; t++)
  await sheet(
    `tone-${t + 1}`,
    toned.map((e) => e.tones[t])
  );
console.log(`${entries.length} emoji`);

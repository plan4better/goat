// @vitest-environment node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Every static asset the code references is shipped in `public/assets`, so a
 * default install serves all of them itself. The file must exist under the
 * same path it is requested at: `/assets/<path>` -> `public/assets/<path>`.
 */

const WEB_ROOT = path.resolve(__dirname, "../..");
const PUBLIC_ASSETS = path.join(WEB_ROOT, "public/assets");
const SOURCE_DIRS = ["app", "components", "hooks", "lib"];

/** Artwork the web app serves for other services: core and Keycloak email
 * images (fetched by mail clients), core's default thumbnails and avatars,
 * and goatlib's default point marker. */
const SERVED_FOR_OTHER_SERVICES = [
  "icons/maki/foundation-marker.svg",
  "img/goat_new_dataset_thumbnail.png",
  "img/no-user-thumb.jpg",
  "img/no-org-thumb.jpg",
  "img/goat_new_project_artwork.png",
  "img/email/account_trial_started.png",
  "img/email/organization_invited.png",
  "img/email/organization_suspended.png",
  "img/email/subscription_about_to_end.png",
  "img/email/user_removed_from_organization.png",
  "img/email/reset_password.png",
  "img/email/verify_email.png",
];

const exists = (assetPath: string) => existsSync(path.join(PUBLIC_ASSETS, assetPath));

/** `/assets/x/y.svg` -> `x/y.svg`. */
const underAssets = (url: string): string => {
  expect(url.startsWith("/assets/"), `${url} is not under /assets`).toBe(true);
  return url.slice("/assets/".length);
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "__tests__") return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });

/** Literal asset paths in the source: `${ASSETS_URL}/img/x.png` and
 * `"/assets/img/x.png"`. Paths built from a variable (`${icon}.svg`) are
 * covered by the constants they come from. */
const literalAssetPaths = (): Map<string, string> => {
  const found = new Map<string, string>();
  const patterns = [
    /\$\{ASSETS_URL\}\/([A-Za-z0-9_./-]+\.[a-z0-9]+)(?=[`"'])/g,
    /["'`]\/assets\/([A-Za-z0-9_./-]+\.[a-z0-9]+)["'`]/g,
  ];
  for (const file of SOURCE_DIRS.flatMap((dir) => sourceFiles(path.join(WEB_ROOT, dir)))) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        found.set(match[1], path.relative(WEB_ROOT, file));
      }
    }
  }
  return found;
};

describe("static assets shipped in public/assets", () => {
  beforeAll(() => {
    vi.stubEnv("NEXT_PUBLIC_ASSETS_URL", "");
    vi.resetModules();
  });

  it("has every marker icon of the gallery, and the no-icon icon", async () => {
    const { MAKI_ICON_TYPES, MAKI_ICONS_BASE_URL, NO_ICON_ICON } = await import("@/lib/constants/icons");
    const base = underAssets(MAKI_ICONS_BASE_URL);
    const icons = [...MAKI_ICON_TYPES.flatMap((type) => type.icons), NO_ICON_ICON];
    expect(icons.length).toBeGreaterThan(100);
    const missing = icons.filter((icon) => !exists(`${base}/${icon}.svg`));
    expect(missing).toEqual([]);
  });

  it("has the geofence of every toolbox mask layer", async () => {
    const { GEOFENCE_LAYERS_PATH } = await import("@/lib/constants");
    const { toolboxMaskLayerNames } = await import("@/lib/validations/tools");
    const base = underAssets(GEOFENCE_LAYERS_PATH);
    const missing = Object.values(toolboxMaskLayerNames).filter((name) => !exists(`${base}/${name}.geojson`));
    expect(missing).toEqual([]);
  });

  it("has every basemap style served from the asset base", async () => {
    const { BASEMAPS } = await import("@/lib/constants/basemaps");
    const local = BASEMAPS.flatMap((b) => [b.url, b.thumbnail]).filter(
      (url): url is string => typeof url === "string" && url.startsWith("/assets/")
    );
    expect(local.length).toBeGreaterThan(0);
    expect(local.map(underAssets).filter((p) => !exists(p))).toEqual([]);
  });

  it("has the org avatar and the social preview images", async () => {
    const { ORG_DEFAULT_AVATAR } = await import("@/lib/constants");
    const { getLocalizedMetadata } = await import("@/lib/metadata");
    expect(exists(underAssets(ORG_DEFAULT_AVATAR))).toBe(true);
    for (const lng of ["en", "de"]) {
      const images = getLocalizedMetadata(lng, {}, { openGraphUrl: "https://goat.test/" }).openGraph?.images;
      const url = new URL((images as { url: string }[])[0].url);
      expect(url.origin).toBe("https://goat.test");
      expect(exists(underAssets(url.pathname))).toBe(true);
    }
  });

  it("has every asset path written out in the web source", () => {
    const paths = literalAssetPaths();
    expect(paths.size).toBeGreaterThan(0);
    const missing = [...paths].filter(([p]) => !exists(p)).map(([p, file]) => `${p} (${file})`);
    expect(missing).toEqual([]);
  });

  it("has the artwork served for the other services", () => {
    expect(SERVED_FOR_OTHER_SERVICES.filter((p) => !exists(p))).toEqual([]);
  });

  it("keeps every copied file under 1 MB", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
    const tooBig = walk(PUBLIC_ASSETS).filter((file) => statSync(file).size > 1024 * 1024);
    expect(tooBig.map((file) => path.relative(PUBLIC_ASSETS, file))).toEqual([]);
  });
});

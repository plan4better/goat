import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { CAPABILITIES, defaultRange } from "@/lib/style/generated/capabilities";
import { ICON_GROUPS, ICON_NAMES, PALETTES } from "@/lib/style/generated/catalog";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { PROPERTY_KINDS } from "@/lib/style/generated/properties";

const WEB = resolve(__dirname, "../../..");

type Generated = { files: Record<string, string>; formatted: Record<string, boolean> };

/** The generator's output and whether prettier leaves each file as generated, from a plain Node process: formatting
 * with the repository's prettier config inside the vmForks pool CI runs vitest in fails to load prettier's ES module
 * entry from its CommonJS one. */
const generateInNode = (): Generated => {
  const script = pathToFileURL(resolve(WEB, "scripts/generate-style-sources.mjs")).href;
  const program = `
    import { check, resolveConfig } from "prettier";
    import { resolve } from "node:path";
    const { generate } = await import(${JSON.stringify(script)});
    const files = await generate();
    const formatted = {};
    for (const [path, content] of Object.entries(files)) {
      const filepath = resolve(${JSON.stringify(WEB)}, path);
      formatted[path] = await check(content, { ...(await resolveConfig(filepath)), filepath });
    }
    process.stdout.write(JSON.stringify({ files, formatted }));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: WEB,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    })
  ) as Generated;
};

describe("generated GOAT Style sources", () => {
  it("are current", () => {
    const { files } = generateInNode();
    expect(Object.keys(files).sort()).toEqual([
      "lib/style/generated/capabilities.ts",
      "lib/style/generated/catalog.ts",
      "lib/style/generated/defaults.ts",
      "lib/style/generated/emoji.ts",
      "lib/style/generated/properties.ts",
      "lib/style/generated/types.ts",
      "public/assets/icons/maki/symbols.json",
    ]);
    for (const [path, content] of Object.entries(files)) {
      expect(readFileSync(resolve(WEB, path), "utf8"), path).toBe(content);
    }
  });

  it("are formatted like the rest of the repository, so prettier leaves them as generated", () => {
    for (const [path, unchanged] of Object.entries(generateInNode().formatted)) {
      expect(unchanged, path).toBe(true);
    }
  });

  it("have an SVG for every catalogue icon", () => {
    const missing = ICON_NAMES.filter(
      (name) => !existsSync(resolve(WEB, `public/assets/icons/maki/${name}.svg`))
    );
    expect(missing).toEqual([]);
  });

  it("carry goatlib's palettes, property kinds and defaults", () => {
    expect(PALETTES["colorbrewer:OrRd"].variants?.[5]).toEqual([
      "#fef0d9",
      "#fdcc8a",
      "#fc8d59",
      "#e34a33",
      "#b30000",
    ]);
    expect(PROPERTY_KINDS["outline.width"]).toBe("number");
    expect(PROPERTY_KINDS["label.halo.color"]).toBe("color");
    expect(PROPERTY_KINDS["line.dash"]).toBe("choice");
    expect(DEFAULTS["fill.color"]).toBe("#2bb381");
  });

  it("say which value forms each property takes", () => {
    expect(CAPABILITIES["fill.color"]).toEqual({
      kind: "color",
      zoom: "blend",
      attribute: "color",
      perFeature: true,
    });
    expect(CAPABILITIES["line.dash"]).toEqual({
      kind: "choice",
      zoom: "step",
      attribute: null,
      perFeature: true,
    });
    expect(CAPABILITIES["arrows.spacing"].perFeature).toBe(false);
    expect(CAPABILITIES["label.placement"].zoom).toBeNull();
    expect(CAPABILITIES["heatmap.radius"]).toEqual({
      kind: "number",
      zoom: "blend",
      attribute: null,
      perFeature: false,
    });
    expect(CAPABILITIES.opacity).toEqual({
      kind: "number",
      zoom: "blend",
      attribute: null,
      perFeature: false,
    });
    // The same kinds as PROPERTY_KINDS, except numbers without a mapping by attribute (zoom-only, or switching at
    // stops like a pattern's spacing), which the compiler treats as choices.
    const steppedNumbers = new Set(["fill.pattern_spacing", "fill.pattern_width"]);
    for (const [key, kind] of Object.entries(PROPERTY_KINDS)) {
      const capability = CAPABILITIES[key];
      expect(capability, key).toBeDefined();
      const number = kind === "choice" && (capability.zoom === "blend" || steppedNumbers.has(key));
      expect(capability.kind, key).toBe(number ? "number" : kind);
    }
    expect(CAPABILITIES["arrows.spacing"].kind).toBe("number");
    expect(CAPABILITIES["fill.pattern_spacing"]).toEqual({
      kind: "number",
      zoom: "step",
      attribute: null,
      perFeature: true,
    });
  });

  it("carry goatlib's default ranges and icon groups", () => {
    expect(defaultRange("marker.size")).toEqual([4, 24]);
    expect(defaultRange("outline.width")).toEqual([0.5, 6]);
    expect(ICON_GROUPS.flatMap((g) => g.icons).sort()).toEqual([...ICON_NAMES].sort());
    // The places come first; the marker shapes and pins close the list.
    expect(ICON_GROUPS[0]).toMatchObject({
      id: "urban_infrastructure",
      labelKey: "icon_category_urban_infrastructure",
    });
    expect(ICON_GROUPS.at(-1)).toMatchObject({ id: "shapes_pins", labelKey: "icon_category_shapes_pins" });
  });
});

describe("limits the panel shares with the format", () => {
  it("MAX_CLASS_COUNT is the schema's maximum count", async () => {
    const { MAX_CLASS_COUNT } = await import("@/lib/style/editor/classify");
    const schema = readFileSync(
      resolve(
        __dirname,
        "../../../../../packages/python/goatlib/src/goatlib/style/data/goat-style.schema.json"
      ),
      "utf8"
    );
    const maxima = [...schema.matchAll(/"count": \{[^}]*?"maximum": (\d+)/g)].map((m) => Number(m[1]));
    expect(maxima.length).toBeGreaterThan(0);
    expect(new Set(maxima)).toEqual(new Set([MAX_CLASS_COUNT]));
  });
});

describe("raster keys", () => {
  it("raster render defaults and the raster opacity capability are generated", () => {
    expect(DEFAULTS["terrain.direction"]).toBe(315);
    expect(DEFAULTS["continuous.palette"]).toBe("goat:elevation");
    expect(CAPABILITIES["raster.opacity"]).toEqual({
      kind: "number",
      zoom: "blend",
      attribute: null,
      perFeature: false,
    });
  });
});

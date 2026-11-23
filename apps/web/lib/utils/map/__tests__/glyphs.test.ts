import { describe, expect, it } from "vitest";

import { FONT_STACKS } from "@/lib/style/compile/constants";
import { GLYPHS_PATH, OWN_FONT_STACKS, OWN_GLYPH_RANGES, ownGlyphsRequest } from "@/lib/utils/map/glyphs";

const OFM = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const BASEMAP_DE = "https://sgx.geodatenzentrum.de/gdz_basemapde_vektor/fonts/{fontstack}/{range}.pbf";
const KEYED = "https://api.maptiler.com/fonts/{fontstack}/{range}.pbf?key=abc";

/** The URL MapLibre asks for: the style's glyphs template with the stack as it is (spaces and all) and the range. */
const glyphUrl = (template: string, stack: string, range: string) =>
  template.replace("{fontstack}", stack).replace("{range}", range);

const own = (dir: string, range: string) => `${location.origin}${GLYPHS_PATH}/${dir}/${range}.pbf`;

describe("own label fonts", () => {
  it("are the weights and italics the glyph servers lack, each in its own directory", () => {
    expect(Object.keys(OWN_FONT_STACKS).sort()).toEqual([
      "Noto Sans Bold Italic",
      "Noto Sans Light",
      "Noto Sans Light Italic",
      "Noto Sans Medium",
      "Noto Sans Medium Italic",
    ]);
    expect(OWN_FONT_STACKS["Noto Sans Medium Italic"].dir).toBe("noto-sans-medium-italic");
  });

  it("have glyph ranges for Latin (with Vietnamese), Greek and Cyrillic", () => {
    for (const stack of Object.keys(OWN_FONT_STACKS)) {
      // Basic Latin, Latin Extended-A, combining marks and Greek, Cyrillic, Latin Extended Additional (Vietnamese),
      // Greek Extended.
      expect(OWN_GLYPH_RANGES[stack], stack).toEqual(expect.arrayContaining([0, 256, 768, 1024, 7680, 7936]));
    }
  });
});

describe("ownGlyphsRequest", () => {
  it("serves an own stack from the app, whatever glyph server the map's style names", () => {
    expect(ownGlyphsRequest(glyphUrl(OFM, "Noto Sans Medium", "0-255"), "Glyphs")).toEqual({
      url: own("noto-sans-medium", "0-255"),
    });
    expect(ownGlyphsRequest(glyphUrl(BASEMAP_DE, "Noto Sans Light Italic", "1024-1279"), "Glyphs")).toEqual({
      url: own("noto-sans-light-italic", "1024-1279"),
    });
    // A server's query (its key) stays with that server.
    expect(ownGlyphsRequest(glyphUrl(KEYED, "Noto Sans Bold Italic", "7680-7935"), "Glyphs")).toEqual({
      url: own("noto-sans-bold-italic", "7680-7935"),
    });
  });

  it("reads a stack the template already encoded", () => {
    expect(ownGlyphsRequest(glyphUrl(OFM, "Noto%20Sans%20Light", "256-511"), "Glyphs")).toEqual({
      url: own("noto-sans-light", "256-511"),
    });
  });

  it("asks the map's glyph server for a range the own files lack, in the upright stack it serves", () => {
    // Arabic: Noto Sans has none; the basemaps' servers draw it in their Regular and Bold stacks.
    expect(OWN_GLYPH_RANGES["Noto Sans Medium"]).not.toContain(1536);
    expect(ownGlyphsRequest(glyphUrl(OFM, "Noto Sans Medium", "1536-1791"), "Glyphs")).toEqual({
      url: glyphUrl(OFM, "Noto%20Sans%20Regular", "1536-1791"),
    });
    expect(ownGlyphsRequest(glyphUrl(KEYED, "Noto Sans Bold Italic", "1536-1791"), "Glyphs")).toEqual({
      url: glyphUrl(KEYED, "Noto%20Sans%20Bold", "1536-1791"),
    });
  });

  it("asks the server for a range Noto Sans shares with a script it lacks, so those letters draw", () => {
    // Cyrillic Supplement with Armenian and Hebrew; Georgian.
    for (const range of ["1280-1535", "4096-4351"]) {
      expect(OWN_GLYPH_RANGES["Noto Sans Light"]).not.toContain(Number(range.split("-")[0]));
      expect(ownGlyphsRequest(glyphUrl(OFM, "Noto Sans Light", range), "Glyphs")).toEqual({
        url: glyphUrl(OFM, "Noto%20Sans%20Regular", range),
      });
    }
  });

  it("leaves the servers' own stacks, combined stacks and unknown stacks to the server", () => {
    for (const stack of [
      "Noto Sans Regular",
      "Noto Sans Bold",
      "Noto Sans Italic",
      "Noto Sans Medium,Noto Sans Regular",
      "Open Sans Semibold",
    ]) {
      expect(ownGlyphsRequest(glyphUrl(OFM, stack, "0-255"), "Glyphs"), stack).toBeUndefined();
    }
  });

  it("leaves every request but glyphs alone", () => {
    const url = glyphUrl(OFM, "Noto Sans Medium", "0-255");
    for (const type of ["Tile", "Source", "Style", "SpriteJSON", "Unknown"]) {
      expect(ownGlyphsRequest(url, type), type).toBeUndefined();
    }
  });

  it("leaves a glyph URL it cannot read alone", () => {
    expect(ownGlyphsRequest("https://glyphs.example/Noto Sans Medium.pbf", "Glyphs")).toBeUndefined();
    expect(ownGlyphsRequest(glyphUrl(OFM, "Noto%E0Sans", "0-255"), "Glyphs")).toBeUndefined();
  });
});

describe("the compiler's font stacks", () => {
  it("are the servers' three and the own five, so every stack a label names loads", () => {
    const compiled = Object.values(FONT_STACKS).flatMap((stacks) => [...stacks.normal, ...stacks.italic]);
    expect(compiled.filter((stack) => !(stack in OWN_FONT_STACKS)).sort()).toEqual([
      "Noto Sans Bold",
      "Noto Sans Italic",
      "Noto Sans Regular",
    ]);
    for (const stack of Object.keys(OWN_FONT_STACKS)) expect(compiled, stack).toContain(stack);
  });
});

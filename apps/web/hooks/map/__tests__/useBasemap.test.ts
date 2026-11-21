import { describe, expect, it } from "vitest";

import {
  resolveActiveBasemap,
  synthesizeMapStyle,
} from "@/hooks/map/MapHooks";
import { BASEMAPS, GLYPHS_URL } from "@/lib/constants/basemaps";

const customVector = {
  source: "custom" as const,
  type: "vector" as const,
  value: "00000000-0000-0000-0000-000000000001",
  id: "00000000-0000-0000-0000-000000000001",
  name: "Custom Vector",
  description: null,
  thumbnail_url: null,
  url: "https://example.com/style.json",
  created_at: "2026-04-30T00:00:00Z",
  updated_at: "2026-04-30T00:00:00Z",
};

const customRaster = {
  source: "custom" as const,
  type: "raster" as const,
  value: "00000000-0000-0000-0000-000000000002",
  id: "00000000-0000-0000-0000-000000000002",
  name: "Custom Raster",
  description: null,
  thumbnail_url: null,
  url: "https://example.com/{z}/{x}/{y}.png",
  attribution: "© Example",
  created_at: "2026-04-30T00:00:00Z",
  updated_at: "2026-04-30T00:00:00Z",
};

const customSolid = {
  source: "custom" as const,
  type: "solid" as const,
  value: "00000000-0000-0000-0000-000000000003",
  id: "00000000-0000-0000-0000-000000000003",
  name: "Custom Solid",
  description: null,
  thumbnail_url: null,
  color: "#ff8800",
  created_at: "2026-04-30T00:00:00Z",
  updated_at: "2026-04-30T00:00:00Z",
};

describe("resolveActiveBasemap", () => {
  it("resolves a built-in by value", () => {
    const result = resolveActiveBasemap("streets", BASEMAPS, []);
    expect(result.value).toBe("streets");
    expect(result.source).toBe("builtin");
  });

  it("resolves a custom by id", () => {
    const result = resolveActiveBasemap(customVector.id, BASEMAPS, [
      {
        type: "vector",
        id: customVector.id,
        name: customVector.name,
        description: null,
        thumbnail_url: null,
        url: customVector.url,
        created_at: customVector.created_at,
        updated_at: customVector.updated_at,
      },
    ]);
    expect(result.value).toBe(customVector.id);
    expect(result.source).toBe("custom");
    expect(result.type).toBe("vector");
  });

  it("falls back to DEFAULT_BASEMAP when value is missing", () => {
    const result = resolveActiveBasemap(null, BASEMAPS, []);
    expect(result.value).toBe("light");
    expect(result.source).toBe("builtin");
  });

  it("falls back to DEFAULT_BASEMAP when value points to a deleted custom", () => {
    const result = resolveActiveBasemap(
      "deadbeef-0000-0000-0000-000000000000",
      BASEMAPS,
      []
    );
    expect(result.value).toBe("light");
  });

  it("preserves the legacy URL-as-basemap path for backward compatibility", () => {
    const result = resolveActiveBasemap(
      "https://example.com/legacy.json",
      BASEMAPS,
      []
    );
    expect(result.value).toBe("custom");
    if (result.source === "builtin") expect(result.url).toBe("https://example.com/legacy.json");
  });
});

describe("synthesizeMapStyle", () => {
  it("returns the URL string for vector basemaps", () => {
    expect(synthesizeMapStyle(customVector)).toBe(
      "https://example.com/style.json"
    );
  });

  it("returns a raster style spec for raster basemaps", () => {
    const style = synthesizeMapStyle(customRaster);
    expect(typeof style).toBe("object");
    expect(style).toMatchObject({
      version: 8,
      sources: {
        "raster-source": {
          type: "raster",
          tiles: ["https://example.com/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© Example",
        },
      },
      layers: [{ id: "raster-layer", type: "raster", source: "raster-source" }],
    });
  });

  it("gives the styles it builds glyphs, so labels draw in the label font", () => {
    expect(synthesizeMapStyle(customRaster)).toMatchObject({ glyphs: GLYPHS_URL });
    expect(synthesizeMapStyle(customSolid)).toMatchObject({ glyphs: GLYPHS_URL });
  });

  it("returns a background-only style spec for solid basemaps", () => {
    const style = synthesizeMapStyle(customSolid);
    expect(typeof style).toBe("object");
    expect(style).toMatchObject({
      version: 8,
      sources: {},
      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#ff8800" },
        },
      ],
    });
  });
});

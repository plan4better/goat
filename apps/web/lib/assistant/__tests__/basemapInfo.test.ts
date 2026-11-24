import { describe, expect, it } from "vitest";

import { basemapInfo, offeredBasemaps } from "@/lib/assistant/basemapInfo";

import type { Basemap, BuiltInBasemap } from "@/types/map/common";

const builtIn = (value: string, title: string): BuiltInBasemap => ({
  source: "builtin",
  type: "vector",
  value,
  url: `https://tiles.example.org/styles/${value}`,
  title,
  subtitle: "",
  thumbnail: "",
});

const STAMP = { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
const RASTER_ID = "6d3c2a1e-0f4b-4c5d-8e9f-0a1b2c3d4e5f";
const SOLID_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const VECTOR_ID = "9f8e7d6c-5b4a-4392-8171-6f5e4d3c2b1a";

const raster = {
  id: RASTER_ID,
  name: "Luftbild 2024",
  type: "raster",
  url: "https://tiles.example.org/{z}/{x}/{y}.png",
  ...STAMP,
  source: "custom",
  value: RASTER_ID,
} as Basemap;
const solid = (color: string) =>
  ({
    id: SOLID_ID,
    name: "Fläche",
    type: "solid",
    color,
    ...STAMP,
    source: "custom",
    value: SOLID_ID,
  }) as Basemap;
const vector = (backgroundColor?: string) => {
  const basemap = {
    id: VECTOR_ID,
    name: "Eigener Stil",
    type: "vector",
    url: "https://tiles.example.org/style.json",
    ...STAMP,
    source: "custom",
    value: VECTOR_ID,
    backgroundColor,
  };
  return basemap as Basemap;
};

describe("basemapInfo", () => {
  it("gives a built-in basemap its id, title and tone", () => {
    expect(basemapInfo(builtIn("dark", "Dark"), "light")).toEqual({
      id: "dark",
      name: "Dark",
      tone: "dark",
      imagery: false,
    });
    expect(basemapInfo(builtIn("light", "Light"), "dark")).toEqual({
      id: "light",
      name: "Light",
      tone: "light",
      imagery: false,
    });
  });

  it("marks imagery and calls its tone dark in either app theme", () => {
    for (const theme of ["light", "dark"] as const) {
      expect(basemapInfo(builtIn("satellite", "Satellite"), theme)).toEqual({
        id: "satellite",
        name: "Satellite",
        tone: "dark",
        imagery: true,
      });
      expect(basemapInfo(raster, theme)).toEqual({
        id: RASTER_ID,
        name: "Luftbild 2024",
        tone: "dark",
        imagery: true,
      });
    }
  });

  it("reads the tone of a solid and a custom vector basemap from its colour", () => {
    expect(basemapInfo(solid("#202020"), "light")).toMatchObject({
      id: SOLID_ID,
      tone: "dark",
      imagery: false,
    });
    expect(basemapInfo(solid("#f0f0f0"), "dark")).toMatchObject({ tone: "light", imagery: false });
    expect(basemapInfo(vector("#111111"), "light")).toMatchObject({
      id: VECTOR_ID,
      name: "Eigener Stil",
      tone: "dark",
      imagery: false,
    });
    expect(basemapInfo(vector(), "dark")).toMatchObject({ tone: "light", imagery: false });
  });

  it("cuts a long name to 80 characters without splitting a character", () => {
    // A character outside the Basic Multilingual Plane is two UTF-16 units; the server counts it as one.
    const name = `${"a".repeat(79)}\u{1F5FA} rest`;
    const info = basemapInfo({ ...(vector() as object), name } as Basemap, "light");
    expect(info.name).toBe(`${"a".repeat(79)}\u{1F5FA}`);
  });
});

describe("offeredBasemaps", () => {
  it("offers built-in and custom basemaps, at most thirty", () => {
    const builtIns = [builtIn("streets", "High Fidelity"), builtIn("dark", "Dark")];
    expect(offeredBasemaps(builtIns, [raster, solid("#202020")], "light")).toEqual([
      { id: "streets", name: "High Fidelity", tone: "light", imagery: false },
      { id: "dark", name: "Dark", tone: "dark", imagery: false },
      { id: RASTER_ID, name: "Luftbild 2024", tone: "dark", imagery: true },
      { id: SOLID_ID, name: "Fläche", tone: "dark", imagery: false },
    ]);
    const many = Array.from({ length: 40 }, (_, i) => builtIn(`b${i}`, `Basemap ${i}`));
    const offered = offeredBasemaps(many.slice(0, 10), many.slice(10), "light");
    expect(offered).toHaveLength(30);
    expect(offered[0].id).toBe("b0");
    expect(offered[29].id).toBe("b29");
  });

  it("leaves out a basemap the server would refuse: an id over 64 characters or an empty name", () => {
    const longId = "x".repeat(65);
    const builtIns = [
      builtIn(longId, "Too long"),
      builtIn("unnamed", ""),
      builtIn("blank", "   "),
      builtIn("x".repeat(64), "Just fits"),
    ];
    const many = Array.from({ length: 30 }, (_, i) => builtIn(`b${i}`, `Basemap ${i}`));
    const offered = offeredBasemaps(builtIns, many, "light");
    // The refused ones take no place: thirty valid entries remain.
    expect(offered).toHaveLength(30);
    expect(offered.map((b) => b.id)).not.toContain(longId);
    expect(offered.map((b) => b.id)).not.toContain("unnamed");
    expect(offered.map((b) => b.id)).not.toContain("blank");
    expect(offered[0]).toMatchObject({ id: "x".repeat(64), name: "Just fits" });
  });
});

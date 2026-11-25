import { describe, expect, it } from "vitest";

import { customBasemapSchema } from "@/lib/validations/project";

const baseFields = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "My basemap",
  description: null,
  thumbnail_url: null,
  created_at: "2026-04-30T00:00:00Z",
  updated_at: "2026-04-30T00:00:00Z",
};

describe("customBasemapSchema", () => {
  it("accepts a valid vector basemap", () => {
    const parsed = customBasemapSchema.parse({
      ...baseFields,
      type: "vector",
      url: "https://example.com/style.json",
    });
    expect(parsed.type).toBe("vector");
  });

  it("rejects an invalid vector URL", () => {
    expect(() =>
      customBasemapSchema.parse({
        ...baseFields,
        type: "vector",
        url: "not-a-url",
      })
    ).toThrow();
  });

  it("accepts a raster basemap with placeholders", () => {
    const parsed = customBasemapSchema.parse({
      ...baseFields,
      type: "raster",
      url: "https://example.com/{z}/{x}/{y}.png",
      attribution: "© Example",
    });
    expect(parsed.type).toBe("raster");
  });

  it("accepts a raster basemap with TMS rows or subdomains", () => {
    for (const url of [
      "https://tiles.example.org/{z}/{x}/{-y}.png",
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      "https://{switch:a,b}.tiles.example.org/{z}/{x}/{-y}.png",
    ])
      expect(customBasemapSchema.parse({ ...baseFields, type: "raster", url })).toMatchObject({ url });
  });

  it("rejects a raster basemap whose subdomain list is more than host labels", () => {
    for (const url of [
      "https://{switch:a,evil.example/x?}.tiles.example.org/{z}/{x}/{y}.png",
      "https://{switch:}.tiles.example.org/{z}/{x}/{y}.png",
    ])
      expect(customBasemapSchema.safeParse({ ...baseFields, type: "raster", url }).success).toBe(false);
  });

  it("rejects raster URLs missing placeholders", () => {
    expect(() =>
      customBasemapSchema.parse({
        ...baseFields,
        type: "raster",
        url: "https://example.com/{z}/{x}.png",
      })
    ).toThrow();
  });

  it("accepts a solid color in #rrggbb form", () => {
    const parsed = customBasemapSchema.parse({
      ...baseFields,
      type: "solid",
      color: "#ff8800",
    });
    expect(parsed.type).toBe("solid");
  });

  it("accepts a solid color in #rrggbbaa form", () => {
    const parsed = customBasemapSchema.parse({
      ...baseFields,
      type: "solid",
      color: "#ff8800cc",
    });
    expect(parsed.type).toBe("solid");
  });

  it("rejects an invalid color", () => {
    expect(() =>
      customBasemapSchema.parse({
        ...baseFields,
        type: "solid",
        color: "orange",
      })
    ).toThrow();
  });

  it("rejects an unknown type", () => {
    expect(() =>
      customBasemapSchema.parse({
        ...baseFields,
        type: "wmts",
        url: "https://example.com",
      })
    ).toThrow();
  });

  it("rejects raster URL with non-http scheme", () => {
    expect(() =>
      customBasemapSchema.parse({
        ...baseFields,
        type: "raster",
        url: "ftp://example.com/{z}/{x}/{y}.png",
      })
    ).toThrow();
  });

  it("rejects raster URL missing scheme", () => {
    expect(() =>
      customBasemapSchema.parse({
        ...baseFields,
        type: "raster",
        url: "/{z}/{x}/{y}.png",
      })
    ).toThrow();
  });

  it("rejects non-ISO created_at strings", () => {
    expect(() =>
      customBasemapSchema.parse({
        ...baseFields,
        created_at: "yesterday",
        type: "vector",
        url: "https://example.com/style.json",
      })
    ).toThrow();
  });
});

describe("customBasemapSchema layer_config", () => {
  it("accepts a vector basemap with layer_config", () => {
    const parsed = customBasemapSchema.parse({
      ...baseFields,
      type: "vector",
      url: "https://example.com/style.json",
      layer_config: {
        road_label: { visible: true, relation: "above", target: "12" },
        water: { visible: false, relation: "below", target: "all" },
      },
    });
    expect(parsed.type).toBe("vector");
    if (parsed.type === "vector") {
      expect(parsed.layer_config?.road_label.relation).toBe("above");
      expect(parsed.layer_config?.road_label.target).toBe("12");
      expect(parsed.layer_config?.water.visible).toBe(false);
    }
  });

  it("applies defaults to a partial layer_config entry", () => {
    const parsed = customBasemapSchema.parse({
      ...baseFields,
      type: "vector",
      url: "https://example.com/style.json",
      layer_config: { road_label: {} },
    });
    if (parsed.type === "vector") {
      expect(parsed.layer_config?.road_label).toEqual({
        visible: true,
        relation: "below",
        target: "all",
      });
    }
  });

  it("rejects an invalid relation", () => {
    expect(() =>
      customBasemapSchema.parse({
        ...baseFields,
        type: "vector",
        url: "https://example.com/style.json",
        layer_config: { road_label: { relation: "sideways" } },
      })
    ).toThrow();
  });

  it("accepts a vector basemap without layer_config (optional)", () => {
    const parsed = customBasemapSchema.parse({
      ...baseFields,
      type: "vector",
      url: "https://example.com/style.json",
    });
    if (parsed.type === "vector") {
      expect(parsed.layer_config).toBeUndefined();
    }
  });
});

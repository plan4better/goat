import { describe, expect, it } from "vitest";

import { formatFeatureProperties } from "../formatFeatureProperties";

describe("formatFeatureProperties", () => {
  const layerFields = [
    { name: "area_m2", type: "number", kind: "area" },
    { name: "status", type: "string", kind: "string" },
  ] as const;

  it("formats area fields from m² to ha", () => {
    const { byColumn } = formatFeatureProperties({
      properties: { area_m2: 50000, status: "aktiv" },
      layerFields: layerFields as never,
      lang: "en",
    });
    expect(byColumn["area_m2"]).toMatch(/5([.,]\d+)?\s?ha/);
    expect(byColumn["status"]).toBe("aktiv");
  });

  it("applies fieldDecorators prefix/suffix", () => {
    const { byColumn } = formatFeatureProperties({
      properties: { count: 5 },
      layerFields: [{ name: "count", type: "number", kind: "number" }] as never,
      fieldDecorators: { count: { prefix: "≈ ", suffix: " items" } },
      lang: "en",
    });
    expect(byColumn["count"]).toBe("≈ 5 items");
  });

  it("returns label-keyed output when fieldLabels provided", () => {
    const { formatted } = formatFeatureProperties({
      properties: { status: "aktiv" },
      layerFields: [{ name: "status", type: "string", kind: "string" }] as never,
      fieldLabels: { status: "State" },
      lang: "en",
    });
    expect(formatted["State"]).toBe("aktiv");
    expect(formatted["status"]).toBeUndefined();
  });

  it("formats a field that brings its own number format in the reader's language; a field-list format wins", () => {
    // A raster cell's values: numbers as the reader writes them (Intl's default, at most three decimals).
    const cell = [
      { name: "value", type: "number", format: "none" },
      { name: "band_1", type: "number", format: "none" },
    ] as const;
    const de = formatFeatureProperties({
      properties: { value: 65.93717, band_1: 144 },
      layerFields: [...cell],
      lang: "de",
    });
    expect(de.byColumn).toEqual({ value: "65,937", band_1: "144" });
    const en = formatFeatureProperties({
      properties: { value: 65.93717 },
      layerFields: [...cell],
      lang: "en",
    });
    expect(en.byColumn.value).toBe("65.937");
    const decorated = formatFeatureProperties({
      properties: { value: 65.93717 },
      layerFields: [...cell],
      fieldDecorators: { value: { format: "decimal_2" } },
      lang: "de",
    });
    expect(decorated.byColumn.value).toBe("65,94");
  });

  it("returns empty string for null / undefined values", () => {
    const { byColumn } = formatFeatureProperties({
      properties: { status: null as never },
      layerFields: [{ name: "status", type: "string", kind: "string" }] as never,
      lang: "en",
    });
    expect(byColumn["status"]).toBe("");
  });
});

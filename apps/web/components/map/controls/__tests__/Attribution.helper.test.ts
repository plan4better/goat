import { describe, expect, it } from "vitest";

import { DEFAULT_ATTRIBUTIONS, buildAttributionParts, sanitizeAttributionHtml } from "../Attribution";

describe("buildAttributionParts", () => {
  it("puts custom attribution in madeWith and sources in dataSources", () => {
    const parts = buildAttributionParts(
      ['<a href="x">Made with GOAT</a>'],
      null,
      ["© MapTiler © OpenStreetMap contributors"],
    );
    expect(parts.madeWith).toEqual(['<a href="x">Made with GOAT</a>']);
    expect(parts.dataSources).toEqual(["© MapTiler © OpenStreetMap contributors"]);
  });

  it("includes extraAttribution in dataSources and trims/drops empties", () => {
    const parts = buildAttributionParts("GOAT", "  ", ["  ", "OSM"]);
    expect(parts.madeWith).toEqual(["GOAT"]);
    expect(parts.dataSources).toEqual(["OSM"]);
  });

  it("substring-dedupes dataSources keeping the longer superstring", () => {
    const parts = buildAttributionParts("GOAT", null, ["© OSM", "© OSM contributors"]);
    expect(parts.dataSources).toEqual(["© OSM contributors"]);
  });

  it("default attributions no longer include MapLibre", () => {
    expect(DEFAULT_ATTRIBUTIONS.join(" ")).toContain("Made with GOAT");
    expect(DEFAULT_ATTRIBUTIONS.join(" ").toLowerCase()).not.toContain("maplibre");
  });
});

describe("sanitizeAttributionHtml", () => {
  it("keeps links and inline formatting", () => {
    const html = '<a href="https://openstreetmap.org" target="_blank">© <b>OSM</b></a><br>';
    expect(sanitizeAttributionHtml(html)).toBe(html);
  });

  it("drops scripts, event handlers and javascript: links", () => {
    const out = sanitizeAttributionHtml(
      '<img src=x onerror="alert(1)"><a href="javascript:alert(1)" onclick="alert(2)">x</a><script>alert(3)</script>'
    );
    expect(out).toBe("<a>x</a>");
  });
});

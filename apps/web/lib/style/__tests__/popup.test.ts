import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import { fromPopupConfig, popupConfigOf, toPopupConfig } from "@/lib/style/popup";

import { specExamples } from "./fixtures";

const example = (line: number) => specExamples().find((e) => e.line === line)!.doc.popup;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("toPopupConfig", () => {
  it("maps the facilities popup (spec 7.4) onto today's popup configuration", () => {
    const config = toPopupConfig(example(1537), {
      name: "string",
      visitors: "integer",
      type: "string",
      photo_url: "string",
    });
    expect(config).not.toBeNull();
    expect(config!.trigger).toBe("click_and_hover");
    expect(config!.blocks.map((b) => b.type)).toEqual([
      "badge",
      "fieldList",
      "image",
      "text",
      "divider",
      "button",
    ]);
    const fields = config!.blocks[1];
    if (fields.type !== "fieldList") throw new Error("field list expected");
    expect(fields.layout).toBe("list");
    expect(fields.collapse_after).toBe(5);
    expect(fields.attributes).toEqual([
      { name: "name", label: "Name", type: "string" },
      {
        name: "visitors",
        label: "Visitors",
        type: "number",
        format_config: { abbreviate: true, always_show_sign: false },
        suffix: " a year",
      },
    ]);
    const badge = config!.blocks[0];
    if (badge.type !== "badge") throw new Error("badge expected");
    expect(badge.palette).toEqual({ library: "#3969ac", pool: "#11a5c9" });
    expect(config!.blocks.every((b) => UUID.test(b.id))).toBe(true);
  });

  it("gives every block a stable id derived from its own", () => {
    const a = toPopupConfig(example(1537));
    const b = toPopupConfig(example(1537));
    expect(a!.blocks.map((x) => x.id)).toEqual(b!.blocks.map((x) => x.id));
    expect(new Set(a!.blocks.map((x) => x.id)).size).toBe(a!.blocks.length);
  });

  it("takes attribute types from the dataset and number options from the format", () => {
    const config = toPopupConfig(example(1403), { name: "string", vehicles: "integer", year: "integer" });
    const fields = config!.blocks[0];
    if (fields.type !== "fieldList") throw new Error("field list expected");
    expect(fields.attributes).toEqual([
      { name: "name", type: "string" },
      {
        name: "vehicles",
        label: "Vehicles per day",
        type: "number",
        format_config: { decimals: 0, thousands_separator: true },
      },
      { name: "year", type: "number", format_config: { thousands_separator: false } },
    ]);
  });

  it("an absent popup opens on click with all fields; false or disabled is none", () => {
    const config = toPopupConfig(undefined);
    expect(config).toMatchObject({
      enabled: true,
      trigger: "click",
      mode: "simple",
      layout: "popup",
      header: "standard",
    });
    expect(config!.blocks).toMatchObject([{ type: "fieldList", attributes: [] }]);
    expect(toPopupConfig(false)).toBeNull();
    expect(toPopupConfig(example(566))).toBeNull();
  });

  it("keeps html popups and their sizes", () => {
    expect(toPopupConfig(example(1569))).toMatchObject({ mode: "html", width: 300, max_height: 360 });
  });

  it("drops a block today's popup cannot draw instead of failing", () => {
    const config = toPopupConfig({
      blocks: [
        { id: "b", type: "badge" },
        { id: "t", type: "text", html: "Hi" },
      ],
    });
    expect(config?.blocks.map((b) => b.type)).toEqual(["text"]);
  });

  it("leaves raster popups to the raster service", () => {
    expect(toPopupConfig(example(2071))).toBeNull();
  });
});

describe("fromPopupConfig", () => {
  const popups = specExamples()
    .map((e) => e.doc.popup)
    .filter(
      (p): p is Record<string, unknown> =>
        typeof p === "object" && p !== null && !("bands" in p) && p.enabled !== false
    );

  it("fromPopupConfig inverts toPopupConfig on every spec popup example", () => {
    expect(popups.length).toBeGreaterThan(0);
    for (const popup of popups) expect(fromPopupConfig(toPopupConfig(popup)!, popup)).toEqual(popup);
    expect(fromPopupConfig(toPopupConfig(undefined)!, undefined)).toEqual({});
  });

  it("a new block keeps its UUID as id", () => {
    const original = { blocks: [{ id: "facts", type: "field_list", attributes: [{ field: "name" }] }] };
    const config = toPopupConfig(original)!;
    const uuid = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
    const next = {
      ...config,
      blocks: [...config.blocks, { id: uuid, type: "divider" as const, thickness: 2, color: "#e0e0e0" }],
    };
    const popup = fromPopupConfig(next, original) as { blocks: Array<Record<string, unknown>> };
    expect(popup.blocks.map((b) => b.id)).toEqual(["facts", uuid]);
    expect(toPopupConfig(popup)!.blocks[1].id).toBe(uuid);
  });

  it("HTML mode keeps the html", () => {
    const config = toPopupConfig({})!;
    const html = "<p>{{ name }}</p>";
    expect(fromPopupConfig({ ...config, mode: "html", html }, {})).toEqual({ mode: "html", html });
  });

  it("a disabled popup is false", () => {
    expect(fromPopupConfig({ ...toPopupConfig({})!, enabled: false }, {})).toBe(false);
  });
});

describe("popupConfigOf", () => {
  it("a style without a popup clicks open the default one; popup false and no style show none", () => {
    const plain = { version: 1, kind: "vector" } as LayerStyle;
    expect(popupConfigOf(plain)?.trigger).toBe("click");
    expect(popupConfigOf(plain)).toBe(popupConfigOf(plain));
    expect(popupConfigOf({ ...plain, popup: false } as LayerStyle)).toBeUndefined();
    expect(popupConfigOf(null)).toBeUndefined();
    const hover = { ...plain, popup: { trigger: "hover", blocks: [] } } as LayerStyle;
    expect(popupConfigOf(hover)?.trigger).toBe("hover");
  });
});

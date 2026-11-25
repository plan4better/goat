import { act, screen } from "@testing-library/react";
import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";

import { shade } from "@/lib/style/colors";
import { labelHaloSummary } from "@/lib/style/editor/labels";
import type { LayerStyle } from "@/lib/style/generated/types";

import { PropertyRow } from "@/components/map/panels/styleEditor/editors/PropertyRow";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { renderPanel } from "./renderPanel";

// In the scope of a class of a classification other than the one that sets the fill, a derived color's swatch shows
// what those features draw: the shades of the classes that set the fill, not the layer's own shade.

vi.mock("react-toastify", () => ({ toast: Object.assign(() => 0, { info: () => 0, dismiss: () => 0 }) }));

const FILLS = { classify: 0, colors: ["#11a579", "#e68310"] };
const style = (symbol: object) =>
  ({
    version: "1.0.0",
    kind: "vector",
    symbol: { fill: { color: "#7f3c8d" }, ...symbol },
    classify: [
      {
        field: "k",
        method: "categories",
        classes: FILLS.colors.map((color, i) => ({ values: [String(i)], fill: { color } })),
      },
      {
        field: "t",
        method: "categories",
        target: "outline.width",
        classes: [{ values: ["a"], outline: { width: 2 } }],
      },
    ],
  }) as unknown as LayerStyle;
const SCOPE = { classify: 1, key: 0 };
const CLASSES = `linear-gradient(90deg, ${FILLS.colors.map((c) => shade(c)).join(", ")})`;

/** The CSS background of a swatch element, as its style rule writes it. */
function backgroundOf(el: Element): string {
  const css = [...document.querySelectorAll("style")].map((s) => s.textContent).join("");
  const own = [...el.classList].filter((c) => c.startsWith("css-"));
  for (const name of own) {
    const rule = new RegExp(`\\.${name}\\{[^}]*?background:([^;}]*)`).exec(css);
    if (rule) return rule[1];
  }
  return "";
}

describe("a derived color's swatch in a class's scope", () => {
  it("in the part's group row shows the classes that set the followed color", () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <SymbolSection />
      </PopoverProvider>,
      { document: style({ outline: { color: "auto", width: 1 } }), data: { geometry: "polygon" } }
    );
    act(() => store.setScope(SCOPE));
    const row = screen.getAllByText("style_editor.part_outline")[0].parentElement as HTMLElement;
    expect(backgroundOf(row.querySelector("button > div")!)).toBe(CLASSES);
  });

  it("in a row by zoom shows no layer's shade where the classes draw several", () => {
    const { store, container } = renderPanel(
      <PopoverProvider>
        <PropertyRow
          row={{ type: "color", key: "color", label: "style_editor.color" }}
          base="symbol.outline"
        />
      </PopoverProvider>,
      {
        document: style({
          outline: {
            color: {
              zoom: [
                [8, "auto"],
                [16, "#000000"],
              ],
            },
            width: 1,
          },
        }),
        data: { geometry: "polygon" },
      }
    );
    act(() => store.setScope(SCOPE));
    const backgrounds = [...container.querySelectorAll("[class*='css-']")].map(backgroundOf).filter(Boolean);
    expect(backgrounds.join(" ")).not.toContain(shade("#7f3c8d"));
    // In the scope of a class that sets the fill: that class's shade at the Auto stop, then the stop's own color.
    act(() => store.setScope({ classify: 0, key: 0 }));
    const own = [...container.querySelectorAll("[class*='css-']")].map(backgroundOf);
    expect(own).toContain(`linear-gradient(90deg, ${shade(FILLS.colors[0])}, #000000)`);
  });

  it("in the Halo row of a label shows what the class's features draw", () => {
    const doc = style({ label: { text: "{t}", color: "#3a3541", halo: { color: "auto" } } });
    const t = ((key: string) => key) as unknown as TFunction;
    const ctx = {
      fields: [],
      mapZoom: 12,
      geometry: "polygon" as const,
      language: "en",
      tone: "dark" as const,
    };
    const { swatch } = labelHaloSummary(doc, "symbol.label", SCOPE, t, ctx);
    // A halo against a set text looks at the text alone: the same for every feature.
    expect(new Set(swatch.match(/#[0-9a-f]{6}/g))).toEqual(new Set(["#ffffff"]));
    // The pair's halo is a shade of each feature's fill: the classes', in scope as for all features.
    const pair = style({ label: { text: "{t}", color: "auto", halo: { color: "auto" } } });
    expect(labelHaloSummary(pair, "symbol.label", SCOPE, t, ctx).swatch).toBe(
      labelHaloSummary(pair, "symbol.label", null, t, ctx).swatch
    );
  });
});

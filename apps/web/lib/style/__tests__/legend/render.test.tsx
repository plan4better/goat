// The drawn legend against its data: one swatch per entry, real words in both languages, and entries that differ
// in the style look different on screen, except where `NOT_DRAWN` says the legend does not draw a property yet.
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type LegendSection, type Swatch, buildLegend } from "@/lib/style/legend";

import { StyleLegend } from "@/components/map/legend/StyleLegend";

import { drawnSizes } from "./assess";
import { type LegendCase, legendCases } from "./cases";
import { language } from "./i18n";
import { NOT_DRAWN } from "./known";

vi.mock("react-i18next", async () => (await import("./i18n")).reactI18nextMock);

const cases = legendCases();
const each = cases.map((c) => [c.id, c] as const);

const legendOf = (c: LegendCase) =>
  buildLegend(c.style, { geometry: c.geometry, zoom: c.zoom, serviceLegendUrl: c.serviceLegendUrl });

/** The swatches a legend holds, in the order the component draws them, by section; `sized` for a block about size
 * (classes by size, the samples of a size by attribute). */
const swatchesOf = (sections: LegendSection[]): Array<{ swatches: Swatch[]; sized: boolean }> =>
  sections.flatMap((s) =>
    s.kind === "entries"
      ? [{ swatches: s.entries.map((e) => e.swatch), sized: s.sized === true }]
      : s.kind === "sizes"
        ? [{ swatches: s.samples.map((x) => x.swatch), sized: true }]
        : []
  );

/** The width and height a drawn swatch takes. */
const boxOf = (el: Element): [number, number] => {
  const style = (el as HTMLElement).style;
  return [
    Number(el.getAttribute("width") ?? Number.parseFloat(style.width)),
    Number(el.getAttribute("height") ?? Number.parseFloat(style.height)),
  ];
};

/** A drawn swatch without what React numbers per element. */
const drawn = (el: Element) => el.outerHTML.replace(/\sid="[^"]*"/g, "").replace(/url\(#[^)]*\)/g, "url(#)");

/** The `part.key` paths two swatches differ in. */
function differences(a: Swatch, b: Swatch): string[] {
  const out: string[] = [];
  for (const part of ["fill", "outline", "line", "casing", "marker"] as const) {
    const [pa, pb] = [a[part], b[part]];
    if (!pa !== !pb) out.push(part);
    for (const key of new Set([...Object.keys(pa ?? {}), ...Object.keys(pb ?? {})]))
      if (pa && pb && JSON.stringify(pa[key]) !== JSON.stringify(pb[key])) out.push(`${part}.${key}`);
  }
  return out;
}

const SIZE_KEYS = new Set(["marker.size", "line.width", "outline.width"]);

afterEach(() => {
  language.current = "en";
});

describe("the drawn legend", () => {
  it.each(each)("%s: one swatch per entry, each entry with its text", (_id, c) => {
    const legend = legendOf(c);
    if (!legend) return;
    const { container } = render(<StyleLegend legend={legend} layerName="Layer name" locale="en" />);
    const swatches = swatchesOf(legend.sections).flatMap((g) => g.swatches);
    const drawnSwatches = [...container.querySelectorAll('[aria-hidden="true"]')];
    expect(drawnSwatches).toHaveLength(swatches.length);
    legend.sections.forEach((section) => {
      if (section.kind !== "entries" || section.id === "base") return;
      // Every entry of a classification or a rule says what it stands for.
      section.entries.forEach((entry) => {
        const row = drawnSwatches[swatches.indexOf(entry.swatch)].parentElement!;
        expect(row.textContent?.trim(), `${section.id}/${entry.id}`).not.toBe("");
      });
    });
  });

  it.each(["en", "de"])("in %s no text is a raw key or a broken number", (lang) => {
    language.current = lang;
    for (const c of cases) {
      const legend = legendOf(c);
      if (!legend) continue;
      const { container, unmount } = render(
        <StyleLegend legend={legend} layerName="Layer name" locale={lang} />
      );
      expect(container.textContent, c.id).not.toMatch(/style_editor\.|NaN|undefined|Infinity/);
      unmount();
    }
  });

  it("a heatmap reads low to high, clusters and H3 cells say what they are", () => {
    const texts = [1666, 1702, 1736].map((line) => {
      const { container, unmount } = render(
        <StyleLegend legend={legendOf(cases.find((c) => c.id === `spec-${line}`)!)!} locale="en" />
      );
      const text = container.textContent ?? "";
      unmount();
      return text;
    });
    expect(texts[0]).toMatch(/Low.*High/);
    expect(texts[1]).toMatch(/Clusters/);
    expect(texts[2]).toMatch(/Sum of pupils/);
  });

  it.each(each)("%s: one swatch column for all entries, 14 px high outside a block about size", (_id, c) => {
    const legend = legendOf(c);
    if (!legend) return;
    const { container } = render(<StyleLegend legend={legend} layerName="Layer name" locale="en" />);
    const drawnSwatches = [...container.querySelectorAll('[aria-hidden="true"]')];
    // Every entry's swatch has the same width, so the texts of all blocks start at the same place: 20 px, or what
    // the legend's widest block of sizes needs.
    const widths = new Set<number>();
    let at = 0;
    for (const section of legend.sections) {
      if (section.kind === "sizes") at += section.samples.length;
      if (section.kind !== "entries") continue;
      section.entries.forEach((_, i) => {
        const [width, height] = boxOf(drawnSwatches[at + i]);
        widths.add(width);
        if (!section.sized) expect(height).toBe(14);
      });
      at += section.entries.length;
    }
    expect([...widths].length).toBeLessThanOrEqual(1);
    if (!legend.sections.some((s) => s.kind === "entries" && s.sized))
      for (const w of widths) expect(w).toBe(20);
  });

  it("a block about size draws its classes in the ratio they have, the largest at most 28 px", () => {
    const style = {
      version: 1,
      kind: "vector",
      symbol: { marker: { shape: "circle", color: "#3366cc", size: 8 } },
      classify: [
        {
          id: "size",
          field: "amount",
          method: "manual",
          target: "marker.size",
          classes: [
            { to: 10, marker: { size: 10 } },
            { from: 10, to: 20, marker: { size: 20 } },
            { from: 20, marker: { size: 80 } },
          ],
        },
      ],
    };
    const legend = buildLegend(style, { geometry: "point", zoom: 12 })!;
    const { container } = render(<StyleLegend legend={legend} locale="en" />);
    const sides = [...container.querySelectorAll("[data-marker-shape]")].map((el) =>
      Number.parseFloat((el as HTMLElement).style.width)
    );
    expect(sides[2]).toBe(28);
    expect(sides[1] / sides[0]).toBeCloseTo(2);
    expect(sides[2] / sides[1]).toBeCloseTo(4);
    // The swatches share one width, so the texts line up.
    const widths = [...container.querySelectorAll('[aria-hidden="true"]')].map((el) => boxOf(el)[0]);
    expect(new Set(widths).size).toBe(1);
  });

  it("a size by zoom is the same at every zoom, a color by zoom follows the map", () => {
    const style = {
      version: 1,
      kind: "vector",
      symbol: {
        marker: {
          shape: "circle",
          color: {
            zoom: [
              [8, "#fee8c8"],
              [16, "#e34a33"],
            ],
          },
          size: {
            zoom: [
              [8, 4],
              [16, 12],
            ],
          },
        },
      },
    };
    const at = (zoom: number) => buildLegend(style, { geometry: "point", zoom })!.sections[0];
    const marker = (zoom: number) => {
      const section = at(zoom);
      return section.kind === "entries" ? section.entries[0].swatch.marker! : {};
    };
    expect(marker(8).size).toBe(marker(16).size);
    expect(marker(8).size).toBe(8);
    expect(marker(8).color).not.toBe(marker(16).color);
  });

  it("yes and no fields read Yes and No in the viewer's language", () => {
    const c = cases.find(
      (x) => x.values?.data === "boolean" && x.values.names === "no" && x.values.render === "features"
    )!;
    const texts = ["en", "de"].map((lang) => {
      language.current = lang;
      const { container, unmount } = render(<StyleLegend legend={legendOf(c)!} locale={lang} />);
      const text = container.textContent ?? "";
      unmount();
      return text;
    });
    expect(texts[0]).toMatch(/Yes|No/);
    expect(texts[0]).not.toMatch(/true|false/);
    expect(texts[1]).toMatch(/Ja|Nein/);
  });

  it("a name cut off by the row shows in full in a tooltip", () => {
    const c = cases.find(
      (x) => x.values?.data === "long_text" && x.values.names === "no" && x.values.render === "features"
    )!;
    const { container } = render(<StyleLegend legend={legendOf(c)!} locale="en" />);
    const titles = [...container.querySelectorAll("[title]")].map((el) => el.getAttribute("title") ?? "");
    expect(titles.some((title) => title.length > 100)).toBe(true);
  });

  it("a block that sets the outline alone draws a ring, not a filled swatch", () => {
    const legend = buildLegend(
      {
        version: 1,
        kind: "vector",
        symbol: { fill: { color: "#3366cc" }, outline: { color: "#555555", width: 1 } },
        classify: [
          {
            id: "o",
            field: "rate",
            method: "manual",
            target: "outline.color",
            classes: [
              { to: 10, outline: { color: "#111111" } },
              { from: 10, outline: { color: "#999999" } },
            ],
          },
        ],
      },
      { geometry: "polygon", zoom: 12 }
    )!;
    const { container } = render(<StyleLegend legend={legend} locale="en" />);
    const rects = [...container.querySelectorAll("svg[aria-hidden] rect")];
    expect(rects.map((r) => r.getAttribute("fill"))).toEqual(["none", "none"]);
    expect(rects.map((r) => r.getAttribute("stroke"))).toEqual(["#111111", "#999999"]);
    expect(Number(rects[0].getAttribute("stroke-width"))).toBeGreaterThanOrEqual(2);
  });

  it("classes of the height draw a bar per class and write its height", () => {
    const c = cases.find((x) => x.values?.target === "height" && x.values.method === "manual")!;
    const legend = legendOf(c)!;
    const { container } = render(<StyleLegend legend={legend} locale="en" />);
    const block = legend.sections.find((s) => s.kind === "entries" && s.bars);
    const bars = [...container.querySelectorAll("[data-height-bar]")];
    expect(block && block.kind === "entries" && bars.length).toBe(
      block && block.kind === "entries" ? block.entries.length : -1
    );
    // Bars of different heights differ, and each row names its height in metres.
    expect(new Set(bars.map((b) => b.outerHTML)).size).toBeGreaterThan(1);
    for (const bar of bars) expect(bar.parentElement!.textContent).toMatch(/· \d+ m$/);
  });

  it("writes ranges with the language's words and separators", () => {
    // The spec's own example of classes by quantile (5.2).
    const c = cases.find((x) => x.id === "spec-935")!;
    const texts = ["en", "de"].map((lang) => {
      language.current = lang;
      const { container, unmount } = render(<StyleLegend legend={legendOf(c)!} locale={lang} />);
      const text = container.textContent ?? "";
      unmount();
      return text;
    });
    expect(texts[0]).toMatch(/2,800 to 3,600/);
    expect(texts[1]).toMatch(/2\.800 bis 3\.600/);
  });

  it.each(each)("%s: entries that differ in the style differ on screen", (_id, c) => {
    const legend = legendOf(c);
    if (!legend) return;
    const { container } = render(<StyleLegend legend={legend} layerName="Layer name" locale="en" />);
    const drawnSwatches = [...container.querySelectorAll('[aria-hidden="true"]')].map(drawn);
    let at = 0;
    for (const { swatches: group, sized } of swatchesOf(legend.sections)) {
      const sizesDrawn = drawnSizes(group, sized);
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++) {
          const keys = differences(group[i], group[j]);
          if (!keys.length) continue;
          // What is left once the properties the legend does not draw (known.ts), and sizes the legend holds to
          // the same size on purpose (one box outside a block about size), are set aside.
          const sameSize = sizesDrawn[i] === sizesDrawn[j];
          const visible = keys.filter(
            (key) => !NOT_DRAWN.some((n) => n.keys.includes(key)) && !(SIZE_KEYS.has(key) && sameSize)
          );
          const label = `${c.id} entries ${i} and ${j} differ in ${keys.join(", ")}`;
          if (visible.length) expect(drawnSwatches[at + i], label).not.toBe(drawnSwatches[at + j]);
          else
            expect(drawnSwatches[at + i], `${label}: drawn now, remove from NOT_DRAWN`).toBe(
              drawnSwatches[at + j]
            );
        }
      at += group.length;
    }
  });
});

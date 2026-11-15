// What a reviewer should know about a case's legend: where its reading is open, or where it cannot say what the
// map draws. The gallery prints these beside each legend; they are opinions to decide on, not checks.
import type { Legend, LegendSection, Swatch } from "@/lib/style/legend";

import type { LegendCase } from "./cases";

export interface Remark {
  /** `change`: the legend misleads or hides something; `question`: a choice to make; `fine`: reads well. */
  kind: "change" | "question" | "fine";
  /** One key per kind of remark, so the gallery can count each once. */
  topic: string;
  text: string;
}

/** The size the style gives a swatch's symbol: a marker's size, a line's width, an area's outline width. */
const modelSize = (swatch: Swatch): number => {
  const part = { point: swatch.marker, line: swatch.line, polygon: swatch.outline }[swatch.geometry];
  const key = swatch.geometry === "point" ? "size" : "width";
  return typeof part?.[key] === "number"
    ? (part[key] as number)
    : { point: 8, line: 2, polygon: 1 }[swatch.geometry];
};

/** The sizes the legend draws a block's swatches at. Outside a block about size every swatch sits in one fixed box
 * (a plain circle its own size up to 14 px, other markers 14 px, lines up to 8 px, outlines up to 3 px). A block
 * about size draws its entries in the ratio they have to each other, the largest no bigger than 28, 12 or 6 px. */
export function drawnSizes(swatches: Swatch[], sized: boolean): number[] {
  const model = swatches.map(modelSize);
  if (!swatches.length) return [];
  const geometry = swatches[0].geometry;
  if (!sized)
    return swatches.map((swatch, i) => {
      if (geometry === "line") return Math.min(model[i], 8);
      if (geometry === "polygon") return Math.min(model[i], 3);
      const marker = swatch.marker ?? {};
      const plain =
        (marker.shape === "circle" || marker.shape === undefined) && typeof marker.icon !== "string";
      return plain ? Math.min(Math.max(model[i], 4), 14) : 14;
    });
  const cap = { point: 28, line: 12, polygon: 6 }[geometry];
  const largest = Math.max(...model);
  const scale = largest > cap ? cap / largest : 1;
  return model.map((m) => Math.min(Math.max(m * scale, geometry === "point" ? 3 : 0.5), cap));
}

/** Whether swatches of different sizes in the style end up drawn at the same size. */
function sizesCollapse(swatches: Swatch[], sized: boolean): boolean {
  return new Set(swatches.map(modelSize)).size > new Set(drawnSizes(swatches, sized)).size;
}

const entries = (legend: Legend | null) =>
  (legend?.sections ?? []).filter(
    (s): s is Extract<LegendSection, { kind: "entries" }> => s.kind === "entries"
  );

export function assess(c: LegendCase, legend: Legend | null): Remark[] {
  const out: Remark[] = [];
  const add = (kind: Remark["kind"], topic: string, text: string) => out.push({ kind, topic, text });
  const sections = legend?.sections ?? [];
  // Only blocks about size draw sizes; the others hold every swatch to one box on purpose.
  const sizedBlocks = [
    ...entries(legend).flatMap((x) => (x.sized ? [x.entries.map((e) => e.swatch)] : [])),
    ...sections.flatMap((x) => (x.kind === "sizes" ? [x.samples.map((y) => y.swatch)] : [])),
  ];
  if (sizedBlocks.some((block) => sizesCollapse(block, true)))
    add(
      "question",
      "size_floor",
      "Sizes are drawn in the ratio the classes have, the largest at most 28 px. Where that ratio would make the smallest thinner than can be seen, it is held at a minimum, so two very small classes can look alike."
    );
  if (c.values?.data === "field_missing")
    add(
      "question",
      "field_missing",
      "The field is missing from the data. The legend cannot know: it lists the classes the style holds, or nothing where the server computes them. The layer list is the place to flag such a layer."
    );
  if (c.values?.data === "all_equal" && entries(legend).some((s) => s.entries.length === 1))
    add("fine", "all_equal", "One value in the data: one entry that reads the value.");
  if (c.values?.method === "categories_many")
    add(
      "fine",
      "many",
      "More than 12 categories: the list is long but complete, in list order, then Other, then No data where the data has such features."
    );
  return out;
}

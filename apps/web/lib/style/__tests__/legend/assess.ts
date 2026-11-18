// The sizes the legend draws its swatches at, worked out from the style: what the render test expects the legend
// component to draw.
import type { Swatch } from "@/lib/style/legend";

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

// The dataset's default style as the panel compares and resets against it: the style core keeps for the dataset (a
// project layer's first style is a copy of it), else, for a dataset without one, the built-in default a fresh style
// gets. A raster has no built-in default. Undefined while it loads, or when it cannot be read.
import { useDatasetStyle } from "@/lib/api/map";
import type { Geometry } from "@/lib/style/compile/types";
import { defaultStyle } from "@/lib/style/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";

export function useDatasetReference(
  datasetId: string | undefined,
  geometry: Geometry | undefined,
  kind: LayerStyle["kind"] | undefined
): LayerStyle | undefined {
  const { style, error } = useDatasetStyle(datasetId);
  if (style) return style.document as LayerStyle;
  const none = (error as { status?: number } | undefined)?.status === 404;
  return none && kind === "vector" ? defaultStyle(geometry) : undefined;
}

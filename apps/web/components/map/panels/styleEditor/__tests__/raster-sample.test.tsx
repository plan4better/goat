import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { rasterInfoOf } from "@/lib/style/raster/metadata";
import { StyleSaver } from "@/lib/style/save";

import {
  EMPTY_DATA,
  StyleEditorProvider,
  useRasterSample,
} from "@/components/map/panels/styleEditor/context";

const band = (index: number, p2: number | null, p98: number | null) => ({
  index,
  min: p2,
  max: p98,
  mean: null,
  std: null,
  p2,
  p98,
  histogram: { counts: [], edges: [] },
  values: null,
  approximate: true,
});

describe("useRasterSample", () => {
  it("reads the band's values from the raster service's statistics; a band without values is null", async () => {
    const document = { version: 1, kind: "raster", render: { type: "image" } } as LayerStyle;
    const store = new EditorStore({
      saver: new StyleSaver({
        transport: {
          save: async () => ({ ok: true, document, revision: 2, issues: [] }),
          load: async () => ({ document, revision: 1 }),
        },
        document,
        revision: 1,
      }),
    });
    const info = rasterInfoOf({
      width: 1,
      height: 1,
      bounds: [0, 0, 1, 1],
      count: 2,
      dtype: "float32",
      nodata: null,
      bits: [32, 32],
      color_table: null,
      names: ["a", "b"],
      scales: [1, 1],
      offsets: [0, 0],
      bands: [band(1, 2, 8), band(2, null, null)],
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StyleEditorProvider
        store={store}
        data={{ ...EMPTY_DATA, raster: { dataset: "d1", info } }}
        mapZoom={9}>
        {children}
      </StyleEditorProvider>
    );
    const { result } = renderHook(() => useRasterSample(), { wrapper });
    expect(await result.current(1)).toEqual({ min: 2, max: 8, values: [] });
    expect(await result.current(2)).toBeNull();
  });
});

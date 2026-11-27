import { ThemeProvider, createTheme } from "@mui/material";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { makeStore } from "@/lib/store";
import type { LayerStyle } from "@/lib/style/generated/types";

import type { MapLayer } from "@/hooks/map/useMapLayers";

import { ProjectLayerTree } from "@/components/map/panels/layer/ProjectLayerTree";

import { i18n } from "../../styleEditor/__tests__/renderPanel";

// The rows the tree hands its view, each with the icon it shows beside the layer's name.
vi.mock("@/components/map/panels/layer/DraggableTreeView", () => ({
  DraggableTreeView: ({ items }: { items: Array<{ id: string; icon?: ReactNode }> }) => (
    <div>
      {items.map((item) => (
        <div key={item.id} data-testid={`row-${item.id}`}>
          {item.icon}
        </div>
      ))}
    </div>
  ),
}));
vi.mock("react-map-gl/maplibre", () => ({ useMap: () => ({}) }));
// Answers that keep their identity between renders, as the hooks' cached answers do.
const { profile, noVersions } = vi.hoisted(() => ({
  profile: { userProfile: { id: "u1" } },
  noVersions: { versions: {} },
}));
vi.mock("@/lib/api/users", async (original) => ({
  ...(await original<object>()),
  useUserProfile: () => profile,
}));
vi.mock("@/lib/api/catalog", async (original) => ({
  ...(await original<object>()),
  useCatalogItemVersions: () => noVersions,
  useCatalogDatasetVersions: () => noVersions,
}));
vi.mock("@/hooks/map/useBundleMemberGates", () => ({ useBundleMemberGates: () => undefined }));

const POLYGON = {
  version: "1.0.0",
  kind: "vector",
  symbol: { fill: { color: "#78c679", opacity: 0.8 }, outline: false },
} as LayerStyle;
const LINE = { version: "1.0.0", kind: "vector", symbol: { line: { color: "#ff0000" } } } as LayerStyle;
const RASTER = { version: "1.0.0", kind: "raster" } as unknown as LayerStyle;

const layer = (id: number, type: string, geometry: string | null, document: LayerStyle | null) =>
  ({
    id,
    layer_id: `dataset-${id}`,
    name: `Layer ${id}`,
    type,
    feature_layer_geometry_type: geometry,
    order: id,
    entry: { type: "layer", id },
    style: document
      ? { id: `s${id}`, name: "Default", position: 0, revision: 1, document, issues: [], stale: false }
      : null,
    otherStyles: [],
  }) as unknown as MapLayer;

const NO_GROUPS: never[] = [];

/** The table icon as the tree drew it inline. */
function tableIconMarkup() {
  const theme = createTheme();
  return render(
    <ThemeProvider theme={theme}>
      <Icon iconName={ICON_NAME.TABLE} style={{ fontSize: "1rem", color: theme.palette.action.active }} />
    </ThemeProvider>
  ).container.innerHTML;
}

function renderTree(layers: MapLayer[], groups: never[] = NO_GROUPS) {
  return render(
    <Provider store={makeStore()}>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider theme={createTheme()}>
          <ProjectLayerTree
            projectId="p1"
            projectLayers={layers}
            projectLayerGroups={groups}
            viewMode="view"
            hideActions
          />
        </ThemeProvider>
      </I18nextProvider>
    </Provider>
  );
}

describe("the layer tree's icons", () => {
  it("a polygon layer shows its area swatch, a line layer its line swatch", () => {
    const { getByTestId } = renderTree([
      layer(1, "feature", "polygon", POLYGON),
      layer(2, "feature", "line", LINE),
    ]);
    const area = getByTestId("row-layer-1").querySelector("svg rect:not([data-checker-under])");
    expect(area?.getAttribute("fill")).toBe("#78c679");
    expect(area?.getAttribute("fill-opacity")).toBe("0.8");
    expect(area?.getAttribute("stroke")).toBe("none");
    const line = getByTestId("row-layer-2").querySelector("svg");
    expect(line?.querySelector("rect")).toBeNull();
    expect(line?.innerHTML).toContain("#ff0000");
  });

  it("a raster layer shows the raster icon, styled or not; a table the table icon", () => {
    const { getByTestId } = renderTree([
      layer(3, "raster", null, RASTER),
      layer(4, "raster", null, null),
      layer(5, "table", null, null),
    ]);
    expect(getByTestId("row-layer-3").querySelector("[data-testid=raster-layer-icon]")).not.toBeNull();
    expect(getByTestId("row-layer-4").querySelector("[data-testid=raster-layer-icon]")).not.toBeNull();
    expect(getByTestId("row-layer-5").innerHTML).toBe(tableIconMarkup());
  });

  it("a bundle's Tables row shows the table icon", () => {
    const group = { id: 10, name: "Bundle", parent_id: null, order: 0, visible: true, bundle_id: "b1" };
    const inBundle = (l: MapLayer) => ({ ...l, layer_project_group_id: 10 }) as unknown as MapLayer;
    const { getByTestId } = renderTree(
      [inBundle(layer(7, "feature", "polygon", POLYGON)), inBundle(layer(8, "table", null, null))],
      [group] as never[]
    );
    expect(getByTestId("row-tables-10").innerHTML).toBe(tableIconMarkup());
  });

  it("a styled layer without a known geometry shows an area swatch", () => {
    const { getByTestId } = renderTree([layer(6, "feature", null, POLYGON)]);
    expect(getByTestId("row-layer-6").querySelector("svg rect")).not.toBeNull();
  });
});

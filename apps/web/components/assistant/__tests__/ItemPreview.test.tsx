/**
 * A catalog card's preview: a map for a dataset with geometry, its first rows
 * for a table (stops as coordinate columns, a timetable), and for a bundle its
 * first member that has a map.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResultItem } from "@/lib/assistant/items";

import { DockActionsContext } from "@/components/assistant/DockActions";
import { dockActions } from "@/components/assistant/__tests__/helpers";
import ItemPreview from "@/components/assistant/messages/ItemPreview";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

let resolved: { item?: unknown; members: unknown[]; isLoading: boolean };
let previewRows: unknown[];
vi.mock("@/lib/api/catalog", () => ({
  useCatalogResolve: () => resolved,
  useCatalogPreview: () => ({ preview: { features: previewRows }, isLoading: false }),
}));
vi.mock("@/components/dashboard/catalog/CatalogFootprintMap", () => ({
  default: ({ item }: { item: { id: string } }) => <div data-testid="map">{item.id}</div>,
}));
vi.mock("@/components/dashboard/catalog/CatalogFeatureTable", () => ({
  default: ({ features, rows }: { features: unknown[]; rows: number }) => (
    <div data-testid="rows">{`${features.length} rows, ${rows} shown`}</div>
  ),
}));

const card: ResultItem = { kind: "catalog", id: "c1", title: "Haltestellen MVV" } as ResultItem;
const withMap = { id: "stops", geometry: { type: "Point", coordinates: [11.5, 48.1] }, properties: {} };
const table = { id: "trips", geometry: null, properties: { "table:columns": [] } };

const renderPreview = () =>
  render(
    <DockActionsContext.Provider value={dockActions()}>
      <ItemPreview item={card} />
    </DockActionsContext.Provider>
  );

describe("catalog card preview", () => {
  beforeEach(() => {
    previewRows = [{ type: "Feature", geometry: null, properties: { stop_name: "Marienplatz" } }];
  });

  it("draws a map for a dataset with geometry", () => {
    resolved = { item: withMap, members: [], isLoading: false };
    renderPreview();
    expect(screen.getByTestId("map").textContent).toBe("stops");
    expect(screen.queryByText("catalog_no_geometry")).toBeNull();
  });

  it("shows a table's first rows instead of an empty map", () => {
    resolved = { item: table, members: [], isLoading: false };
    renderPreview();
    expect(screen.getByTestId("rows").textContent).toBe("1 rows, 5 shown");
    expect(screen.queryByTestId("map")).toBeNull();
  });

  it("says so when a table has no rows to preview", () => {
    resolved = { item: table, members: [], isLoading: false };
    previewRows = [];
    renderPreview();
    expect(screen.getByText("assistant_item_no_rows")).toBeTruthy();
  });

  it("previews a bundle's first member with a map, past its tables", () => {
    resolved = { members: [table, withMap], isLoading: false };
    renderPreview();
    expect(screen.getByTestId("map").textContent).toBe("stops");
  });

  it("shows a bundle of tables as rows", () => {
    resolved = { members: [table, { ...table, id: "stop_times" }], isLoading: false };
    renderPreview();
    expect(screen.getByTestId("rows")).toBeTruthy();
  });
});

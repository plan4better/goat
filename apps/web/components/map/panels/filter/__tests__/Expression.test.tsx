import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { type Expression as ExpressionType, FilterType } from "@/lib/validations/filter";

import Expression from "@/components/map/panels/filter/Expression";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
}));

vi.mock("react-map-gl/maplibre", () => ({
  useMap: () => ({ map: undefined }),
}));

vi.mock("@/i18n/utils", () => ({
  useDayjsLocale: () => "en",
}));

vi.mock("@/hooks/map/CommonHooks", () => ({
  default: () => ({ layerFields: [] }),
}));

vi.mock("@/hooks/map/FilteringHooks", () => ({
  default: () => ({ logicalExpressionTypes: [] }),
}));

vi.mock("@/hooks/map/LayerPanelHooks", () => ({
  useActiveLayer: () => ({ activeLayer: undefined }),
}));

type DraftCase = {
  regions: { as_box: boolean }[];
  config: { nodes: { data: { type: string; filter?: { expressions?: ExpressionType[] } } }[] };
};

const FIXTURE = path.join(__dirname, "../../../../../../assistant/tests/fixtures/workflow_drafts.json");
const { cases } = JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: DraftCase[] };

/** The area the assistant set for a region too large for its boundary. */
const boxedArea = (): ExpressionType => {
  const boxed = cases.find((c) => c.regions.some((region) => region.as_box));
  const row = boxed?.config.nodes
    .flatMap((node) => (node.data.type === "dataset" ? (node.data.filter?.expressions ?? []) : []))
    .find((expression) => expression.type === FilterType.Spatial);
  if (!row) throw new Error("the fixture holds no area stored as its bounding box");
  return row;
};

const renderRow = (expression: ExpressionType) =>
  render(<Expression expression={expression} onDelete={vi.fn()} onUpdate={vi.fn()} layerId="layer-1" />);

describe("a filter row with an area", () => {
  it("selects the boundary the assistant set and names its region", async () => {
    renderRow(boxedArea());

    await expect(screen.getByRole("combobox", { name: "select_spatial_intersection" })).toHaveTextContent(
      "boundary"
    );
    await expect(screen.getByText("Bayern (bounding box)")).toBeInTheDocument();
    expect(screen.getAllByText("boundary")).toHaveLength(1);
  });

  it("renders a value that is not a geometry, with nothing selected", async () => {
    renderRow({ ...boxedArea(), value: "not json" });

    await expect(screen.getByRole("combobox", { name: "select_spatial_intersection" })).toHaveTextContent(
      "select_spatial_intersection"
    );
  });
});

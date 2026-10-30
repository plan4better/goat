import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LayerInformationSchema } from "@/lib/validations/widget";

import { LayerInformationWidget } from "@/components/builder/widgets/information/Layers";

/**
 * The Layers widget lists layers and groups as a tree. A group set to a switcher
 * type keeps its place and row in the tree, with the switcher in place of its
 * layers; everything else stays as it was.
 */

const updateTree = vi.fn().mockResolvedValue(undefined);

const layer = (id: number, name: string, order: number, group: number | null, visibility = true) => ({
  id,
  name,
  order,
  layer_project_group_id: group,
  type: "feature",
  properties: { visibility },
});

const layers = [
  layer(1, "Bäume", 0, null),
  layer(2, "2015", 1, 7, false),
  layer(3, "2018", 2, 7, true),
  layer(4, "Radwege", 3, 8),
];
const groups = [
  { id: 7, name: "Versiegelung", order: 0, parent_id: null },
  { id: 8, name: "Verkehr", order: 1, parent_id: null },
];

vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => undefined,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/builder/widgets/information/useWidgetLayerTree", () => ({
  useWidgetLayerTree: () => ({ projectId: "p", layers, layerGroups: groups, updateTree }),
}));
// The tree itself is tested elsewhere: list what it was given, and render the group content
vi.mock("@/components/map/panels/layer/ProjectLayerTree", () => ({
  ProjectLayerTree: ({
    projectLayers,
    projectLayerGroups,
    groupContent,
  }: {
    projectLayers: { name: string }[];
    projectLayerGroups: { id: number; name: string }[];
    groupContent?: Record<number, React.ReactNode>;
  }) => (
    <div>
      <div data-testid="tree">
        {projectLayerGroups.map((g) => `group:${g.name}`).join(",")}|
        {projectLayers.map((l) => l.name).join(",")}
      </div>
      {projectLayerGroups.map(
        (g) =>
          groupContent?.[g.id] && (
            <div key={g.id} data-testid={`content-${g.id}`}>
              {groupContent[g.id]}
            </div>
          )
      )}
    </div>
  ),
}));

const widget = (setup: object = {}, options: object = {}) =>
  render(
    <LayerInformationWidget
      widgetId="w"
      config={{ type: "layers", setup, options } as unknown as LayerInformationSchema}
      projectLayers={[]}
      projectLayerGroups={[]}
    />
  );

beforeEach(() => updateTree.mockClear());

describe("LayerInformationWidget", () => {
  it("lists every layer and group in the tree when no group is a switcher", () => {
    widget();

    expect(screen.getByTestId("tree")).toHaveTextContent(
      "group:Versiegelung,group:Verkehr|Bäume,2015,2018,Radwege"
    );
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("keeps a switcher group in its place in the tree, with the switcher as its content", () => {
    widget({ group_switchers: { 7: { layout: "chips", show_play: false } } });

    expect(screen.getByTestId("tree")).toHaveTextContent(
      "group:Versiegelung,group:Verkehr|Bäume,2015,2018,Radwege"
    );
    expect(screen.queryByTestId("content-8")).not.toBeInTheDocument();
    const radios = within(screen.getByTestId("content-7")).getAllByRole("radio");
    expect(radios.map((c) => c.textContent)).toEqual(["2015", "2018"]);
  });

  it("leaves excluded layers out of the switcher as well", () => {
    widget({ group_switchers: { 7: { layout: "chips", show_play: false } } }, { excluded_layers: [2] });

    expect(screen.getAllByRole("radio").map((c) => c.textContent)).toEqual(["2018"]);
  });
});

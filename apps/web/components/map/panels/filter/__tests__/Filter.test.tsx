// The layer panel's Filter tab: a hint while it is empty, the quiet "Add expression" under the expressions with the
// app's menu of kinds (a table has one kind and adds it at once), and a foot with "Clear filter" and the one primary
// action, "Save as new layer".
import { ThemeProvider, createTheme } from "@mui/material";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTheCQLBasedOnExpression } from "@/lib/transformers/filter";
import { FilterType } from "@/lib/validations/filter";
import type { ProjectLayer } from "@/lib/validations/project";

import FilterPanel from "@/components/map/panels/filter/Filter";

const FIELDS = [{ name: "kind", type: "string" }];
const mocks = vi.hoisted(() => ({
  updateProjectLayer: vi.fn(async () => undefined),
  execute: vi.fn(async () => ({ jobID: "job-1" })),
  layers: [] as unknown[],
}));

// One `t` for every render, as react-i18next's: the tab's memos depend on it.
const t = (key: string) => key.replace(/^common:/, "");
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));
vi.mock("react-toastify", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/projects", () => ({ updateProjectLayer: mocks.updateProjectLayer }));
vi.mock("@/hooks/map/CommonHooks", () => ({ default: () => ({ layerFields: FIELDS }) }));
vi.mock("@/hooks/map/LayerPanelHooks", () => ({
  useFilteredProjectLayers: () => ({ layers: mocks.layers, mutate: vi.fn(async () => undefined) }),
}));
vi.mock("@/hooks/map/useOgcProcesses", () => ({ useProcessExecution: () => ({ execute: mocks.execute }) }));
vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: (select: (state: unknown) => unknown) => select({ jobs: { runningJobIds: [] } }),
}));
// An expression's own fields are Expression's tests; here it is its kind.
vi.mock("@/components/map/panels/filter/Expression", () => ({
  default: ({ expression }: { expression: { type: string } }) => (
    <div data-testid="expression">{expression.type}</div>
  ),
}));

const layer = (overrides: Partial<ProjectLayer> = {}) =>
  ({
    id: 7,
    layer_id: "dataset-7",
    name: "Forests",
    type: "feature",
    query: null,
    ...overrides,
  }) as ProjectLayer;

const filtered = () =>
  layer({
    query: {
      cql: createTheCQLBasedOnExpression(
        [{ id: "e1", type: FilterType.Logical, attribute: "kind", expression: "is", value: "oak" }],
        FIELDS as never,
        "and"
      ),
    },
  } as Partial<ProjectLayer>);

function renderTab(activeLayer: ProjectLayer) {
  mocks.layers = [activeLayer];
  return render(
    <ThemeProvider theme={createTheme()}>
      <FilterPanel activeLayer={activeLayer} projectId="p1" />
    </ThemeProvider>
  );
}

beforeEach(() => {
  mocks.updateProjectLayer.mockClear();
  mocks.execute.mockClear();
});

describe("the Filter tab", () => {
  it("says what a filter does while there is none, in the panels' hint style", () => {
    renderTab(layer());
    const hint = screen.getByText("filter_layer_message");
    expect(hint.className).toMatch(/MuiTypography-caption/);
    expect(getComputedStyle(hint).fontStyle).not.toBe("italic");
    // Nothing to clear or save yet.
    expect(screen.queryByRole("button", { name: "clear_filter" })).toBeNull();
    expect(screen.queryByRole("button", { name: "save_as_new_layer" })).toBeNull();
  });

  it("adds an expression of the kind picked in the app's menu, under the button", async () => {
    renderTab(layer());
    const add = screen.getByRole("button", { name: "add_expression" });
    // The quiet add button (AddButton), not a filled pill.
    expect(add.className).toMatch(/MuiButton-text/);
    await userEvent.click(add);
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    ).toEqual(["logical_expression", "spatial_expression"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "spatial_expression" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByTestId("expression").textContent).toBe(FilterType.Spatial);
  });

  it("adds a table's one kind at once, with no menu", async () => {
    renderTab(layer({ type: "table" } as Partial<ProjectLayer>));
    await userEvent.click(screen.getByRole("button", { name: "add_expression" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByTestId("expression").textContent).toBe(FilterType.Logical);
  });

  it("clears the filter from a text button in the foot", async () => {
    renderTab(filtered());
    expect(screen.getAllByTestId("expression")).toHaveLength(1);
    const clear = screen.getByRole("button", { name: "clear_filter" });
    expect(clear.className).toMatch(/MuiButton-text/);
    expect(clear.className).not.toMatch(/Error/);
    await userEvent.click(clear);
    expect(mocks.updateProjectLayer).toHaveBeenCalledWith("p1", 7, { query: null });
  });

  it("saves the filtered layer as a new one from the foot's primary button", async () => {
    renderTab(filtered());
    const save = screen.getByRole("button", { name: "save_as_new_layer" });
    expect(save.className).toMatch(/MuiButton-contained/);
    // Beside "Clear filter", in one foot.
    expect(save.parentElement).toBe(screen.getByRole("button", { name: "clear_filter" }).parentElement);
    await userEvent.click(save);
    expect(mocks.execute).toHaveBeenCalledWith(
      "layer_create_filtered",
      expect.objectContaining({ source_layer_id: "dataset-7", project_id: "p1" })
    );
  });
});

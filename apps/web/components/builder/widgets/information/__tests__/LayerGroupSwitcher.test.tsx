import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GroupSwitcherType } from "@/lib/validations/widget";

import {
  LayerGroupSwitcher,
  PLAY_INTERVAL_MS,
} from "@/components/builder/widgets/information/LayerGroupSwitcher";

/**
 * A layer group shown one layer at a time: picking one turns it
 * on and its siblings off, through the same tree update the layers widget uses.
 */

const dispatch = vi.fn();
const updateTree = vi.fn().mockResolvedValue(undefined);
let layers: object[] = [];

vi.mock("@/hooks/store/ContextHooks", () => ({ useAppDispatch: () => dispatch }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/builder/widgets/information/useWidgetLayerTree", () => ({
  useWidgetLayerTree: () => ({ projectId: "p", layers, layerGroups: [], updateTree }),
}));

const layer = (id: number, name: string, order: number, visibility: boolean, group = 7) => ({
  id,
  name,
  order,
  layer_project_group_id: group,
  type: "feature",
  properties: { visibility },
});

const GROUP = 7;

const renderSwitcher = (
  options: Partial<GroupSwitcherType> = {},
  extra: { excludedLayers?: number[]; legendHiddenLayers?: number[]; viewOnly?: boolean } = {}
) => render(<Switcher options={options} extra={extra} />);

const Switcher = ({
  options,
  extra,
}: {
  options: Partial<GroupSwitcherType>;
  extra: { excludedLayers?: number[]; legendHiddenLayers?: number[]; viewOnly?: boolean };
}) => (
  <LayerGroupSwitcher
    groupId={GROUP}
    config={{ layout: "chips", show_play: false, ...options }}
    excludedLayers={extra.excludedLayers ?? []}
    legendHiddenLayers={extra.legendHiddenLayers ?? []}
    simpleLegendLayers={[]}
    viewOnly={extra.viewOnly}
  />
);

const visibilityIn = (call: number) =>
  Object.fromEntries(
    updateTree.mock.calls[call][0].items.map((i: { id: number; properties: { visibility: boolean } }) => [
      i.id,
      i.properties.visibility,
    ])
  );

beforeEach(() => {
  dispatch.mockClear();
  updateTree.mockClear();
  layers = [
    layer(3, "2021", 2, false),
    layer(1, "2015", 0, false),
    layer(2, "2018", 1, true),
    layer(9, "Stadtgrenze", 0, true, 8),
  ];
});
afterEach(() => vi.useRealTimers());

describe("LayerGroupSwitcher", () => {
  it("shows the group's layers in order, the visible one picked", () => {
    renderSwitcher();

    const chips = screen.getAllByRole("radio");
    expect(chips.map((c) => c.textContent)).toEqual(["2015", "2018", "2021"]);
    expect(chips.map((c) => c.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  });

  it("turns the picked layer on and only its group siblings off", () => {
    renderSwitcher();

    fireEvent.click(screen.getByRole("radio", { name: "2021" }));

    expect(updateTree).toHaveBeenCalledTimes(1);
    expect(visibilityIn(0)).toEqual({ 1: false, 2: false, 3: true });
    const events = dispatch.mock.calls.map(([a]) => a.payload);
    expect(events).toEqual([
      expect.objectContaining({ type: "visibility_changed", sourceId: 2, value: false }),
      expect.objectContaining({ type: "visibility_changed", sourceId: 3, value: true }),
    ]);
  });

  it("does nothing when the current layer is picked again", () => {
    renderSwitcher();

    fireEvent.click(screen.getByRole("radio", { name: "2018" }));
    expect(updateTree).not.toHaveBeenCalled();
  });

  it("leaves out layers the Layers widget excludes, and renders nothing for an empty group", () => {
    const { container } = renderSwitcher({}, { excludedLayers: [3] });
    expect(screen.getAllByRole("radio").map((c) => c.textContent)).toEqual(["2015", "2018"]);

    const empty = render(<Switcher options={{}} extra={{ excludedLayers: [1, 2, 3] }} />);
    expect(empty.container).toBeEmptyDOMElement();
    expect(container).not.toBeEmptyDOMElement();
  });

  it("leaves one layer on when the project was saved with several", () => {
    layers = [layer(1, "a", 0, true), layer(2, "b", 1, true), layer(3, "c", 2, false)];
    renderSwitcher({}, { viewOnly: true });

    expect(updateTree).toHaveBeenCalledTimes(1);
    expect(visibilityIn(0)).toEqual({ 1: true, 2: false, 3: false });
  });

  it("turns the last layer on in the public view when none is on", () => {
    layers = [layer(1, "a", 0, false), layer(2, "b", 1, false), layer(3, "c", 2, false)];
    renderSwitcher({}, { viewOnly: true });

    expect(visibilityIn(0)).toEqual({ 1: false, 2: false, 3: true });
  });

  it("leaves the saved visibility alone in the editor", () => {
    layers = [layer(1, "a", 0, true), layer(2, "b", 1, true), layer(3, "c", 2, false)];
    renderSwitcher();

    expect(updateTree).not.toHaveBeenCalled();
  });

  it("does not offer tables or locked layers", () => {
    layers = [
      layer(1, "2015", 0, true),
      { ...layer(2, "Tabelle", 1, false), type: "table" },
      { ...layer(3, "Gesperrt", 2, false), locked: true },
    ];
    renderSwitcher();

    expect(screen.getAllByRole("radio").map((c) => c.textContent)).toEqual(["2015"]);
  });

  it("shows the legend of the layer on the map, unless it is hidden from the legend", () => {
    const { unmount } = renderSwitcher();
    // once on the chip, once in the legend
    expect(screen.getAllByText("2018")).toHaveLength(2);
    unmount();

    renderSwitcher({}, { legendHiddenLayers: [2] });
    expect(screen.getAllByText("2018")).toHaveLength(1);
  });

  it("plays through the layers and wraps around", async () => {
    vi.useFakeTimers();
    layers = [layer(1, "a", 0, false), layer(2, "b", 1, false), layer(3, "c", 2, true)];
    renderSwitcher({ show_play: true });

    fireEvent.click(screen.getByRole("button", { name: "play" }));
    await act(async () => {
      vi.advanceTimersByTime(PLAY_INTERVAL_MS);
    });

    expect(visibilityIn(0)).toEqual({ 1: true, 2: false, 3: false });
  });

  it("only shows each play step in the editor, and saves the layer it stops on once", async () => {
    vi.useFakeTimers();
    layers = [layer(1, "a", 0, false), layer(2, "b", 1, false), layer(3, "c", 2, true)];
    renderSwitcher({ show_play: true });

    fireEvent.click(screen.getByRole("button", { name: "play" }));
    await act(async () => {
      vi.advanceTimersByTime(PLAY_INTERVAL_MS);
    });
    expect(updateTree).toHaveBeenCalledTimes(1);
    expect(updateTree.mock.calls[0][1]).toEqual({ persist: false });

    fireEvent.click(screen.getByRole("button", { name: "pause" }));
    expect(updateTree).toHaveBeenCalledTimes(2);
    expect(updateTree.mock.calls[1][1]).toEqual({ persist: true });
  });

  it("saves nothing more when playing stops in the public view", async () => {
    vi.useFakeTimers();
    layers = [layer(1, "a", 0, false), layer(2, "b", 1, false), layer(3, "c", 2, true)];
    renderSwitcher({ show_play: true }, { viewOnly: true });

    fireEvent.click(screen.getByRole("button", { name: "play" }));
    await act(async () => {
      vi.advanceTimersByTime(PLAY_INTERVAL_MS);
    });
    fireEvent.click(screen.getByRole("button", { name: "pause" }));

    expect(updateTree).toHaveBeenCalledTimes(1);
  });

  it("stops playing when the play button is switched off", async () => {
    vi.useFakeTimers();
    layers = [layer(1, "a", 0, false), layer(2, "b", 1, false), layer(3, "c", 2, true)];
    const { rerender } = renderSwitcher({ show_play: true });
    fireEvent.click(screen.getByRole("button", { name: "play" }));

    rerender(<Switcher options={{ show_play: false }} extra={{}} />);
    await act(async () => {
      vi.advanceTimersByTime(PLAY_INTERVAL_MS * 3);
    });

    expect(updateTree).not.toHaveBeenCalled();
  });

  it("renders a slider with one mark per layer", () => {
    renderSwitcher({ layout: "slider" });

    expect(screen.getByRole("slider")).toBeInTheDocument();
    ["2015", "2018", "2021"].forEach((label) => expect(screen.getAllByText(label).length).toBeGreaterThan(0));
  });

  it("shows the slider's layer on change and saves it when the change is committed", () => {
    renderSwitcher({ layout: "slider" });

    // A keyboard step is a change and its commit at once; a drag commits only when let go
    fireEvent.change(screen.getByRole("slider"), { target: { value: 2 } });

    expect(updateTree.mock.calls.map((call) => call[1])).toEqual([{ persist: false }, { persist: true }]);
    expect(visibilityIn(1)).toEqual({ 1: false, 2: false, 3: true });
  });

  it("renders a dropdown that shows the visible layer and picks another", () => {
    renderSwitcher({ layout: "dropdown" });

    const select = screen.getByRole("combobox");
    expect(select).toHaveTextContent("2018");
    fireEvent.mouseDown(select);
    fireEvent.click(screen.getByRole("option", { name: "2021" }));

    expect(visibilityIn(0)).toEqual({ 1: false, 2: false, 3: true });
  });
});

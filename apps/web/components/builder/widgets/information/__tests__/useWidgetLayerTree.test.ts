import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWidgetLayerTree } from "@/components/builder/widgets/information/useWidgetLayerTree";

/**
 * In the editor a widget's tree update is shown at once and saved; with
 * `persist: false` it is only shown, so quick steps (play, slider drags) do not
 * each write the project.
 */

const updateProjectLayerTree = vi.fn().mockResolvedValue(undefined);
const mutateLayers = vi.fn();
const mutateGroups = vi.fn();

const layers = [
  { id: 1, order: 4, layer_project_group_id: 7, properties: { visibility: true } },
  { id: 2, order: 5, layer_project_group_id: 7, properties: { visibility: false } },
];

vi.mock("next/navigation", () => ({ useParams: () => ({ projectId: "p" }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-toastify", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => [],
}));
vi.mock("@/hooks/map/LayerPanelHooks", () => ({
  useFilteredProjectLayers: () => ({ mutate: mutateLayers }),
}));
vi.mock("@/lib/api/projects", () => ({
  updateProjectLayerTree: (...args: unknown[]) => updateProjectLayerTree(...args),
  useProjectLayers: () => ({ layers }),
  useProjectLayerGroups: () => ({ layerGroups: [], mutate: mutateGroups }),
}));

const payload = {
  items: [
    { id: 1, type: "layer" as const, order: 0, parent_id: null, properties: { visibility: false } },
    { id: 2, type: "layer" as const, order: 1, parent_id: null, properties: { visibility: true } },
  ],
};

beforeEach(() => {
  updateProjectLayerTree.mockClear();
  mutateLayers.mockClear();
});

describe("useWidgetLayerTree", () => {
  it("shows and saves an update, keeping the saved order and group", async () => {
    const { result } = renderHook(() => useWidgetLayerTree(false));

    await act(() => result.current.updateTree(payload));

    expect(mutateLayers).toHaveBeenCalledTimes(1);
    expect(updateProjectLayerTree).toHaveBeenCalledWith("p", {
      items: [
        expect.objectContaining({ id: 1, order: 4, parent_id: 7 }),
        expect.objectContaining({ id: 2, order: 5, parent_id: 7 }),
      ],
    });
  });

  it("only shows an update with persist: false", async () => {
    const { result } = renderHook(() => useWidgetLayerTree(false));

    await act(() => result.current.updateTree(payload, { persist: false }));

    expect(mutateLayers).toHaveBeenCalledTimes(1);
    expect(
      mutateLayers.mock.calls[0][0].map(
        (l: { properties: { visibility: boolean } }) => l.properties.visibility
      )
    ).toEqual([false, true]);
    expect(updateProjectLayerTree).not.toHaveBeenCalled();
  });
});

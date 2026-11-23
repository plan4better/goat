import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWidgetLayerTree } from "@/components/builder/widgets/information/useWidgetLayerTree";

/**
 * In the editor a widget's visibility change is shown at once and written as
 * map state; with `persist: false` it is only shown, so quick steps (play,
 * slider drags) do not each write the project.
 */

const onLayerStateChange = vi.fn().mockResolvedValue(undefined);
const previewLayerState = vi.fn().mockResolvedValue(undefined);

vi.mock("next/navigation", () => ({ useParams: () => ({ projectId: "p" }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-toastify", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/hooks/store/ContextHooks", () => ({ useAppSelector: () => [] }));
vi.mock("@/hooks/map/useMapLayers", () => ({
  useMapLayers: () => ({ layers: [], map: undefined }),
  withMapGroups: (groups: unknown[]) => groups,
}));
vi.mock("@/hooks/map/useLayerTreeState", () => ({
  useLayerTreeState: () => ({ onLayerStateChange, previewLayerState }),
}));
vi.mock("@/lib/api/projects", () => ({
  useProjectLayerGroups: () => ({ layerGroups: [] }),
}));

const changes = [
  { id: 1, visible: false },
  { id: 2, visible: true },
];

beforeEach(() => {
  onLayerStateChange.mockClear();
  previewLayerState.mockClear();
});

describe("useWidgetLayerTree", () => {
  it("shows and writes a change", async () => {
    const { result } = renderHook(() => useWidgetLayerTree(false));

    await act(() => result.current.setVisibility(changes));

    expect(previewLayerState.mock.calls).toEqual([
      [1, { visible: false }],
      [2, { visible: true }],
    ]);
    expect(onLayerStateChange.mock.calls).toEqual([
      [1, { visible: false }],
      [2, { visible: true }],
    ]);
  });

  it("only shows a change with persist: false", async () => {
    const { result } = renderHook(() => useWidgetLayerTree(false));

    await act(() => result.current.setVisibility(changes, { persist: false }));

    expect(previewLayerState).toHaveBeenCalledTimes(2);
    expect(onLayerStateChange).not.toHaveBeenCalled();
  });
});

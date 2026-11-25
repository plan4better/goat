import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("swr", () => ({ mutate: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/api/catalog", () => ({
  useCatalogAggregations: () => ({ aggregations: [], isLoading: false }),
  useCatalogDatasetPages: () => ({
    datasets: [],
    total: 0,
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    loadMore: vi.fn(),
    mutate: vi.fn(),
  }),
}));
vi.mock("@/lib/api/favorites", () => ({
  useFavoriteStars: () => ({ starred: {}, toggleStar: vi.fn() }),
}));

const addCatalogLayersToProject = vi.fn();
vi.mock("@/lib/api/projects", () => ({
  addCatalogLayersToProject: (...args: unknown[]) => addCatalogLayersToProject(...args),
  projectLayersKey: (id: string) => `project-layers-${id}`,
  // useShareNotice's dependency — no space/share fields in this flow's fixtures,
  // so it never produces a notice here.
  useProject: () => ({ project: undefined, isLoading: false }),
}));
vi.mock("@/lib/api/teams", () => ({ useTeams: () => ({ teams: [], isLoading: false }) }));

import { useCatalogFlow } from "@/hooks/addLayer/useCatalogFlow";

const PROJECT = "project-1";
const DATASET = "2b83c9a3-1026-4edb-ac7f-77bc2ddcb4cc";

describe("useCatalogFlow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("closes the dialog on click, without waiting for the server", async () => {
    // The add is a promote, an enqueue and a project-layers refetch — none of
    // which the user has anything to do with. Materialization is asynchronous
    // anyway, so the layer arrives in the tree as "preparing" either way;
    // holding the dialog open only makes the click feel slow.
    let settle: (value: unknown) => void = () => undefined;
    addCatalogLayersToProject.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const onDone = vi.fn();
    const { result } = renderHook(() => useCatalogFlow({ projectId: PROJECT, onDone }));

    act(() => result.current.catalog.selection.toggle(DATASET));
    act(() => result.current.action.run());

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(addCatalogLayersToProject).toHaveBeenCalledWith(PROJECT, [DATASET]);

    // Still in flight — the dialog is already gone.
    act(() => settle([{ id: 1 }]));
    await waitFor(() => expect(result.current.catalog.selection.ids).toEqual([]));
  });

  it("reports the server's refusal, not a generic error", async () => {
    const { toast } = await import("react-toastify");
    const refusal = "120 layers is more than the 100 a single request may add.";
    addCatalogLayersToProject.mockRejectedValue(new Error(refusal));
    const onDone = vi.fn();
    const { result } = renderHook(() => useCatalogFlow({ projectId: PROJECT, onDone }));

    act(() => result.current.catalog.selection.toggle(DATASET));
    act(() => result.current.action.run());

    expect(onDone).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(refusal));
  });

  it("does nothing without a project or a selection", () => {
    const onDone = vi.fn();
    const { result } = renderHook(() => useCatalogFlow({ projectId: PROJECT, onDone }));

    act(() => result.current.action.run());

    expect(addCatalogLayersToProject).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});

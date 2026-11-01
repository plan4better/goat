import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { toast } from "react-toastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeMap } from "@/lib/assistant/__tests__/fakeMap";
import { getActiveSurface, getDockState, hasProposalUndo, resetAssistantStore } from "@/lib/assistant/store";
import type { Proposal } from "@/lib/assistant/types";
import type { MapMode } from "@/lib/store/map/slice";

import { useProjectAssistantSurface } from "@/hooks/assistant/useProjectAssistantSurface";

import { DockActionsContext } from "@/components/assistant/DockActions";
import { dockActions } from "@/components/assistant/__tests__/helpers";
import ProposalCard from "@/components/assistant/messages/ProposalCard";

const WORKFLOW = "0b3c6f0e-6a1d-4b8f-9a77-1d2f3e4a5b6c";

const redux = vi.hoisted(() => ({ activeLayerId: 4 as number | null, dispatch: vi.fn() }));
const navigate = vi.hoisted(() => ({ zoomToProjectLayer: vi.fn(async () => undefined) }));

vi.mock("@/hooks/store/ContextHooks", () => ({
  useAppSelector: (select: (state: unknown) => unknown) =>
    select({ layers: { activeLayerId: redux.activeLayerId }, workflow: { selectedWorkflowId: WORKFLOW } }),
  useAppDispatch: () => redux.dispatch,
}));
vi.mock("@/lib/utils/map/navigate", () => navigate);
vi.mock("react-toastify", () => ({ toast: { error: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const project = { id: "p1", name: "Radnetz", folder_id: "f1" };
const view: Proposal = {
  version: 1,
  kind: "map.view",
  surface: "project.map",
  target: { project_id: "p1", name: "Radnetz" },
  title: "Innenstadt",
  rows: [],
  payload: { project_id: "p1", camera: null, bbox: [13.1, 52.3, 13.8, 52.7], layer_project_id: null },
};

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  redux.activeLayerId = 4;
});

describe("useProjectAssistantSurface", () => {
  it("publishes the project, the selected layer and the map view in Map mode, and applies map views", () => {
    const map = fakeMap({ lng: 13.4, lat: 52.5, zoom: 11 });
    renderHook(() =>
      useProjectAssistantSurface({ project, mapRef: { current: map }, mapMode: "data", isEditor: true })
    );
    const surface = getActiveSurface();
    expect(surface).toMatchObject({
      surface: "project.map",
      project: { id: "p1", name: "Radnetz" },
      uploadTo: { projectId: "p1", folderId: "f1" },
    });
    expect(surface?.getContext()).toMatchObject({
      surface: "project.map",
      project_id: "p1",
      selected_layer_project_id: 4,
      viewport: { center: [13.4, 52.5], zoom: 11 },
    });
    surface?.apply?.(view);
    expect(map.fitBounds).toHaveBeenCalled();
  });

  it("zooms a result card's layer: selects it and fits the map to it, in Map mode only", async () => {
    const map = fakeMap({ lng: 13.4, lat: 52.5, zoom: 11 });
    const layer = { id: 77, layer_id: "d1", name: "Radwege" };
    const { rerender } = renderHook(
      ({ mapMode }: { mapMode: MapMode }) =>
        useProjectAssistantSurface({
          project,
          mapRef: { current: map },
          mapMode,
          isEditor: true,
          layers: [layer] as never,
        }),
      { initialProps: { mapMode: "data" as MapMode } }
    );
    await getActiveSurface()?.zoomToLayer?.(77);
    expect(redux.dispatch).toHaveBeenCalledWith(expect.objectContaining({ payload: [77] }));
    expect(navigate.zoomToProjectLayer).toHaveBeenCalledWith(map, layer);
    // A fit the user did not ask for leaves the selection as it is.
    redux.dispatch.mockClear();
    navigate.zoomToProjectLayer.mockClear();
    await getActiveSurface()?.zoomToLayer?.(77, { select: false });
    expect(redux.dispatch).not.toHaveBeenCalled();
    expect(navigate.zoomToProjectLayer).toHaveBeenCalledWith(map, layer);
    rerender({ mapMode: "workflows" });
    expect(getActiveSurface()?.zoomToLayer).toBeUndefined();
  });

  it("re-labels per mode and offers no Apply outside Map mode", () => {
    const { rerender } = renderHook(
      ({ mapMode }: { mapMode: MapMode }) =>
        useProjectAssistantSurface({ project, mapRef: { current: null }, mapMode, isEditor: false }),
      { initialProps: { mapMode: "data" as MapMode } }
    );
    rerender({ mapMode: "workflows" });
    expect(getActiveSurface()?.getContext()).toEqual({
      surface: "project.workflows",
      project_id: "p1",
      workflow_id: WORKFLOW,
    });
    expect(getActiveSurface()?.apply).toBeUndefined();
    expect(getActiveSurface()?.uploadTo).toBeUndefined();
    rerender({ mapMode: "reports" });
    expect(getActiveSurface()?.getContext()).toEqual({ surface: "project.layouts", project_id: "p1" });
    rerender({ mapMode: "builder" });
    expect(getActiveSurface()?.getContext()).toEqual({ surface: "project.dashboard", project_id: "p1" });
  });

  it("registers nothing while the project loads", () => {
    renderHook(() =>
      useProjectAssistantSurface({
        project: undefined,
        mapRef: { current: null },
        mapMode: "data",
        isEditor: true,
      })
    );
    expect(getActiveSurface()).toBeNull();
  });

  it("does not re-register when the map pans or a view is applied, but reads the live viewport", () => {
    let center = { lng: 13.4, lat: 52.5 };
    const map = { ...fakeMap({ lng: 13.4, lat: 52.5, zoom: 11 }), getCenter: () => center };
    const { rerender } = renderHook(() =>
      useProjectAssistantSurface({ project, mapRef: { current: map }, mapMode: "data", isEditor: true })
    );
    const first = getActiveSurface();
    center = { lng: 11.5, lat: 48.1 };
    rerender();
    expect(getActiveSurface()).toBe(first);
    expect(getActiveSurface()?.getContext()).toMatchObject({ viewport: { center: [11.5, 48.1] } });

    getActiveSurface()?.apply?.(view);
    rerender();
    expect(getActiveSurface()).toBe(first);

    // A different selected layer is part of the context chips and does re-register.
    redux.activeLayerId = 7;
    rerender();
    expect(getActiveSurface()).not.toBe(first);
    expect(getActiveSurface()?.getContext()).toMatchObject({ selected_layer_project_id: 7 });
  });

  it("throws from apply while the map is not ready, so the card reports a failure", async () => {
    const actions = dockActions();
    renderHook(() =>
      useProjectAssistantSurface({ project, mapRef: { current: null }, mapMode: "data", isEditor: true })
    );
    expect(() => getActiveSurface()?.apply?.(view)).toThrow();
    render(
      <DockActionsContext.Provider value={actions}>
        <ProposalCard
          proposal={view}
          partId="m2:1"
          conversationId="c1"
          conversationProjectId="p1"
          readOnly={false}
          isLatest
        />
      </DockActionsContext.Provider>
    );
    fireEvent.click(screen.getByText("assistant_proposal_apply_map"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("assistant_proposal_apply_failed"));
    expect(screen.queryByText("assistant_proposal_applied")).toBeNull();
  });

  it("keeps Undo through an apply, hides it outside Map mode and drops it on unmount", async () => {
    const map = fakeMap({ lng: 11.5, lat: 48.1, zoom: 9 });
    const actions = dockActions();
    function Harness({ mapMode }: { mapMode: MapMode }) {
      useProjectAssistantSurface({ project, mapRef: { current: map }, mapMode, isEditor: true });
      return (
        <DockActionsContext.Provider value={actions}>
          <ProposalCard
            proposal={view}
            partId="m1:1"
            conversationId="c1"
            conversationProjectId="p1"
            readOnly={false}
            isLatest
          />
        </DockActionsContext.Provider>
      );
    }
    const { rerender, unmount } = render(<Harness mapMode="data" />);
    const before = getActiveSurface();
    fireEvent.click(screen.getByText("assistant_proposal_apply_map"));
    await screen.findByText("assistant_proposal_applied");
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    expect(getActiveSurface()).toBe(before);
    expect(screen.getByText("undo")).toBeTruthy();

    // Workflows mode keeps the owner and its undoers, but cannot apply a map view: no Undo.
    rerender(<Harness mapMode="workflows" />);
    expect(hasProposalUndo("m1:1")).toBe(true);
    expect(screen.queryByText("undo")).toBeNull();

    rerender(<Harness mapMode="data" />);
    fireEvent.click(screen.getByText("undo"));
    expect(map.flyTo).toHaveBeenLastCalledWith({ center: [11.5, 48.1], zoom: 9, bearing: 0, pitch: 0 });

    act(() => {
      getActiveSurface()?.apply?.(view);
    });
    unmount();
    expect(hasProposalUndo("m1:1")).toBe(false);
  });

  it("tells the dock when its project failed to load or its mode has no surface, so the dock stops waiting", () => {
    const failed = renderHook(() =>
      useProjectAssistantSurface({
        projectId: "p1",
        project: undefined,
        failed: true,
        mapRef: { current: null },
        mapMode: "data",
        isEditor: false,
      })
    );
    expect(getDockState().noSurfaceProject).toBe("p1");
    failed.unmount();
    expect(getDockState().noSurfaceProject).toBeNull();
    // A client navigation from a public map can leave the public mode behind.
    const publicMode = renderHook(() =>
      useProjectAssistantSurface({ project, mapRef: { current: null }, mapMode: "public", isEditor: false })
    );
    expect(getActiveSurface()).toBeNull();
    expect(getDockState().noSurfaceProject).toBe("p1");
    publicMode.unmount();
    // Still loading, or registered: the dock waits for (or has) the surface.
    renderHook(() =>
      useProjectAssistantSurface({
        projectId: "p1",
        project: undefined,
        mapRef: { current: null },
        mapMode: "data",
        isEditor: false,
      })
    );
    expect(getDockState().noSurfaceProject).toBeNull();
  });
});

import { act, render, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getActiveSurface,
  getActiveSurfaceOwner,
  hasProposalUndo,
  resetAssistantStore,
  setProposalUndo,
} from "@/lib/assistant/store";
import {
  PROJECT_SURFACE_WAIT_MS,
  assistantRouteAllowed,
  canApply,
  pageOrigin,
  routeProjectId,
  surfaceForMapMode,
  useAssistantSurface,
  useProjectSurfaceWait,
  waitingForProjectSurface,
} from "@/lib/assistant/surface";
import type { AssistantSurfaceAdapter, Proposal } from "@/lib/assistant/types";

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
});

function CatalogPage({ q }: { q: string }) {
  useAssistantSurface({ surface: "catalog", getContext: () => ({ surface: "catalog", q }) });
  return null;
}

function KeyedPage({ contextKey }: { contextKey: string }) {
  useAssistantSurface({ surface: "catalog", contextKey, getContext: () => ({ surface: "catalog" }) });
  return null;
}

function ProjectPage({ mode }: { mode: "data" | "workflows" }) {
  const surface = surfaceForMapMode(mode);
  useAssistantSurface(
    surface
      ? { surface, project: { id: "p1", name: "Radnetz" }, getContext: () => ({ surface: "none" }) }
      : null
  );
  return null;
}

const mapProposal = (projectId: string): Proposal => ({
  version: 1,
  kind: "map.view",
  surface: "project.map",
  target: { project_id: projectId, name: "Radnetz" },
  title: "Berlin",
  rows: [],
  payload: { project_id: projectId, camera: null, bbox: [13, 52, 14, 53], layer_project_id: null },
});

describe("useAssistantSurface", () => {
  it("registers while mounted and reads the context lazily", () => {
    const { rerender, unmount } = render(<CatalogPage q="a" />);
    const registered = getActiveSurface();
    expect(registered?.getContext()).toEqual({ surface: "catalog", q: "a" });
    rerender(<CatalogPage q="b" />);
    // Same registration: getContext reads the latest render.
    expect(getActiveSurface()).toBe(registered);
    expect(getActiveSurface()?.getContext()).toEqual({ surface: "catalog", q: "b" });
    unmount();
    expect(getActiveSurface()).toBeNull();
  });

  it("registers again when the mode changes, so the chips re-label", () => {
    const { rerender } = render(<ProjectPage mode="data" />);
    expect(getActiveSurface()?.surface).toBe("project.map");
    rerender(<ProjectPage mode="workflows" />);
    expect(getActiveSurface()).toMatchObject({
      surface: "project.workflows",
      project: { id: "p1", name: "Radnetz" },
    });
  });
});

describe("useAssistantSurface owner", () => {
  it("keeps the undo when the page re-registers and drops it on unmount", () => {
    const { rerender, unmount } = render(<KeyedPage contextKey="k1" />);
    const owner = getActiveSurfaceOwner();
    expect(owner).not.toBeNull();
    setProposalUndo("m1:1", () => undefined, owner as symbol);
    const registered = getActiveSurface();

    // A changed contextKey registers a new adapter for the same mount.
    rerender(<KeyedPage contextKey="k2" />);
    expect(getActiveSurface()).not.toBe(registered);
    expect(getActiveSurfaceOwner()).toBe(owner);
    expect(hasProposalUndo("m1:1")).toBe(true);

    unmount();
    expect(hasProposalUndo("m1:1")).toBe(false);
  });

  it("does not drop the undo of another mount", () => {
    const first = render(<CatalogPage q="a" />);
    const owner = getActiveSurfaceOwner() as symbol;
    setProposalUndo("m1:1", () => undefined, owner);
    const second = render(<ProjectPage mode="data" />);
    expect(getActiveSurfaceOwner()).not.toBe(owner);
    second.unmount();
    expect(hasProposalUndo("m1:1")).toBe(true);
    first.unmount();
    expect(hasProposalUndo("m1:1")).toBe(false);
  });
});

describe("useAssistantSurface owner liveness", () => {
  it("ignores an undo recorded after the page unmounted", () => {
    const { unmount } = render(<CatalogPage q="a" />);
    const owner = getActiveSurfaceOwner() as symbol;
    unmount();
    setProposalUndo("m1:1", () => undefined, owner);
    expect(hasProposalUndo("m1:1")).toBe(false);
  });

  it("keeps the owner live through the StrictMode double effect and ends clean", () => {
    const { unmount } = render(
      <StrictMode>
        <CatalogPage q="a" />
      </StrictMode>
    );
    const owner = getActiveSurfaceOwner() as symbol;
    setProposalUndo("m1:1", () => undefined, owner);
    expect(hasProposalUndo("m1:1")).toBe(true);
    unmount();
    expect(hasProposalUndo("m1:1")).toBe(false);
    setProposalUndo("m1:2", () => undefined, owner);
    expect(hasProposalUndo("m1:2")).toBe(false);
  });
});

describe("surface helpers", () => {
  it("applies a proposal only on its own surface and target", () => {
    const map: AssistantSurfaceAdapter = {
      surface: "project.map",
      project: { id: "p1", name: "Radnetz" },
      getContext: () => ({ surface: "project.map", project_id: "p1" }),
      apply: () => undefined,
    };
    expect(canApply(mapProposal("p1"), map)).toBe(true);
    expect(canApply(mapProposal("p2"), map)).toBe(false);
    expect(canApply(mapProposal("p1"), { ...map, apply: undefined })).toBe(false);
    expect(canApply(mapProposal("p1"), { ...map, surface: "project.workflows" })).toBe(false);
    expect(canApply(mapProposal("p1"), null)).toBe(false);
  });

  it("maps project modes to surfaces", () => {
    expect(surfaceForMapMode("data")).toBe("project.map");
    expect(surfaceForMapMode("workflows")).toBe("project.workflows");
    expect(surfaceForMapMode("reports")).toBe("project.layouts");
    expect(surfaceForMapMode("builder")).toBe("project.dashboard");
    expect(surfaceForMapMode("public")).toBeNull();
  });

  it("shows the dock on app pages only", () => {
    for (const path of [
      "/home",
      "/catalog",
      "/catalog/abc",
      "/content",
      "/settings/organization/ai",
      "/map/p1",
    ]) {
      expect(assistantRouteAllowed(path)).toBe(true);
    }
    for (const path of ["/map/public/p1", "/print/x", "/auth/login", "/onboarding", "/thumbnail/x", null]) {
      expect(assistantRouteAllowed(path)).toBe(false);
    }
    expect(pageOrigin("/home")).toBe("home");
    expect(pageOrigin("/settings/organization")).toBe("settings");
    expect(pageOrigin("/somewhere")).toBe("none");
  });

  it("waits on a project page until that project's surface registered", () => {
    expect(routeProjectId("/map/p1")).toBe("p1");
    expect(routeProjectId("/map/p1/")).toBe("p1");
    expect(routeProjectId("/map/public/p1")).toBeNull();
    expect(routeProjectId("/home")).toBeNull();
    expect(routeProjectId(null)).toBeNull();
    // A malformed escape in the URL names no project; it does not throw.
    expect(routeProjectId("/map/%E0%A4%A")).toBeNull();
    expect(waitingForProjectSurface("/map/%E0%A4%A", null)).toBe(false);
    const project = (id: string): AssistantSurfaceAdapter => ({
      surface: "project.map",
      project: { id, name: id },
      getContext: () => ({ surface: "project.map", project_id: id }),
    });
    // The project is still loading: nothing registered yet.
    expect(waitingForProjectSurface("/map/p1", null)).toBe(true);
    // Coming from another project: its surface is still the active one for a moment.
    expect(waitingForProjectSurface("/map/p1", project("p0"))).toBe(true);
    expect(waitingForProjectSurface("/map/p1", project("p1"))).toBe(false);
    expect(waitingForProjectSurface("/home", null)).toBe(false);
    expect(
      waitingForProjectSurface("/catalog", { surface: "catalog", getContext: () => ({ surface: "catalog" }) })
    ).toBe(false);
  });
});

describe("useProjectSurfaceWait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits again for a project whose earlier wait ran out after the route moved on", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ path }) => useProjectSurfaceWait(path, null), {
      initialProps: { path: "/map/p1" },
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(PROJECT_SURFACE_WAIT_MS);
    });
    expect(result.current).toBe(false);
    rerender({ path: "/map/p2" });
    expect(result.current).toBe(true);
    // Back to the first project before the second wait ended: a fresh wait, not the old timeout.
    rerender({ path: "/map/p1" });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(PROJECT_SURFACE_WAIT_MS);
    });
    expect(result.current).toBe(false);
  });
});

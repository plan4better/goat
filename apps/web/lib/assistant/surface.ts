import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  type SurfaceOwner,
  createSurfaceOwner,
  markOwnerLive,
  registerSurface,
  releaseOwner,
  useDockState,
} from "@/lib/assistant/store";
import type { AssistantSurfaceAdapter, AssistantSurfaceId, Proposal } from "@/lib/assistant/types";
import type { MapMode } from "@/lib/store/map/slice";

export { MODE_LABEL_KEYS } from "@/lib/assistant/chips";

/**
 * Register the page with the dock while it is mounted (spec §6.3). The page's
 * callbacks are read through a ref, so a page passes fresh closures every render
 * without re-registering; it registers again when the surface, the project, the
 * upload target or `contextKey` change (the chips re-label then).
 *
 * Each mount has one owner token, kept across those re-registrations. Undo
 * functions recorded for it (`setProposalUndo(partId, undo, owner)`, with the
 * owner from `getActiveSurfaceOwner()` or this hook's return value) are
 * dropped when the page unmounts, not when it registers again.
 */
export function useAssistantSurface(adapter: AssistantSurfaceAdapter | null): SurfaceOwner {
  const ownerRef = useRef<SurfaceOwner | null>(null);
  if (!ownerRef.current) ownerRef.current = createSurfaceOwner();
  const owner = ownerRef.current;
  const latest = useRef(adapter);
  useLayoutEffect(() => {
    latest.current = adapter;
  });
  const surface = adapter?.surface;
  const projectId = adapter?.project?.id;
  const projectName = adapter?.project?.name;
  const uploadProject = adapter?.uploadTo?.projectId;
  const uploadFolder = adapter?.uploadTo?.folderId;
  const contextKey = adapter?.contextKey;
  const hasApply = !!adapter?.apply;
  const hasPreview = !!adapter?.preview;
  const hasClear = !!adapter?.clearPreview;
  const hasZoom = !!adapter?.zoomToLayer;
  // StrictMode runs this effect, its cleanup and the effect again: the owner is live while mounted.
  useEffect(() => {
    markOwnerLive(owner);
    return () => releaseOwner(owner);
  }, [owner]);
  useEffect(() => {
    if (!surface) return;
    return registerSurface(
      {
        surface,
        contextKey,
        project: projectId ? { id: projectId, name: projectName ?? "" } : undefined,
        uploadTo:
          uploadProject || uploadFolder ? { projectId: uploadProject, folderId: uploadFolder } : undefined,
        getContext: () => latest.current?.getContext() ?? { surface: "none" },
        apply: hasApply ? (proposal) => latest.current?.apply?.(proposal) : undefined,
        preview: hasPreview ? (proposal) => latest.current?.preview?.(proposal) : undefined,
        clearPreview: hasClear ? () => latest.current?.clearPreview?.() : undefined,
        zoomToLayer: hasZoom
          ? (layerProjectId, options) => latest.current?.zoomToLayer?.(layerProjectId, options)
          : undefined,
      },
      owner
    );
  }, [
    owner,
    surface,
    contextKey,
    projectId,
    projectName,
    uploadProject,
    uploadFolder,
    hasApply,
    hasPreview,
    hasClear,
    hasZoom,
  ]);
  return owner;
}

/** Whether this page's adapter can apply the proposal (its surface and target). */
export function canApply(proposal: Proposal, adapter: AssistantSurfaceAdapter | null): boolean {
  if (!adapter?.apply || proposal.surface !== adapter.surface) return false;
  if (proposal.target && proposal.target.project_id !== adapter.project?.id) return false;
  return true;
}

const MAP_MODE_SURFACES: Partial<Record<MapMode, Exclude<AssistantSurfaceId, "none" | "catalog">>> = {
  data: "project.map",
  workflows: "project.workflows",
  reports: "project.layouts",
  builder: "project.dashboard",
};

export const surfaceForMapMode = (mode: MapMode) => MAP_MODE_SURFACES[mode] ?? null;

const DOCK_ROUTES = ["/home", "/catalog", "/content", "/datasets", "/projects", "/settings"];
/** A project page (`/map/<id>`), not a public one. */
const PROJECT_ROUTE = /^\/map\/(?!public(?:\/|$))([^/]+)/;

/** App pages get the dock; print, thumbnail, auth, onboarding and public pages do not. */
export function assistantRouteAllowed(pathname: string | null): boolean {
  if (!pathname) return false;
  if (PROJECT_ROUTE.test(pathname)) return true;
  return DOCK_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/** The project of a project page, from its URL; null on any other page. */
export function routeProjectId(pathname: string | null): string | null {
  const match = pathname ? PROJECT_ROUTE.exec(pathname) : null;
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A malformed escape names no project.
    return null;
  }
}

/**
 * A project page whose project has not registered its surface yet (it is
 * still loading, or the previous project's page is still the active one).
 * The dock waits then: it cannot tell yet which project the user is in.
 */
export function waitingForProjectSurface(
  pathname: string | null,
  surface: AssistantSurfaceAdapter | null
): boolean {
  const projectId = routeProjectId(pathname);
  return projectId !== null && surface?.project?.id !== projectId;
}

const PAGE_ORIGINS = ["home", "catalog", "content", "datasets", "projects", "settings"];

/** `origin_surface` of a conversation started on a page without an adapter. */
export function pageOrigin(pathname: string | null): string {
  const first = pathname?.split("/")[1] ?? "";
  return PAGE_ORIGINS.includes(first) ? first : "none";
}

/** How long the dock waits for a project page's surface before it goes on without page context. */
export const PROJECT_SURFACE_WAIT_MS = 4000;

/**
 * `waitingForProjectSurface`, bounded: the wait ends after
 * PROJECT_SURFACE_WAIT_MS, or at once when the page reports that its project
 * registers no surface. The dock then behaves as on a page without context.
 */
export function useProjectSurfaceWait(
  pathname: string | null,
  surface: AssistantSurfaceAdapter | null
): boolean {
  const { noSurfaceProject } = useDockState();
  const projectId = routeProjectId(pathname);
  const pending = waitingForProjectSurface(pathname, surface) && noSurfaceProject !== projectId;
  const [expiredFor, setExpiredFor] = useState<string | null>(null);
  const [routeProject, setRouteProject] = useState(projectId);
  if (routeProject !== projectId) {
    // Another project: a wait that ran out for an earlier one does not count when the user comes back to it.
    setRouteProject(projectId);
    setExpiredFor(null);
  }
  useEffect(() => {
    if (!pending || !projectId) return;
    const timer = window.setTimeout(() => setExpiredFor(projectId), PROJECT_SURFACE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [pending, projectId]);
  return pending && expiredFor !== projectId;
}

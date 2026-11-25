// The dock's way into the open map page. The dock sits outside the page's tree, and what follows a change made
// elsewhere lives inside it (the style editor stores, the scene store, the map request's cache, the map's camera),
// so the page registers a bridge here while it is mounted, as it registers its surface adapter.
import {
  type MapChange,
  type ViewTarget,
  mapChangeOfUndo,
  mapEdit,
  mergedMapChange,
} from "@/lib/assistant/mapEdits";
import { type StyleChange, styleEdit } from "@/lib/assistant/styleEdits";
import type { AssistantMessage, UndoFn } from "@/lib/assistant/types";
import { undoneByStep } from "@/lib/assistant/undoReply";

/** What the open map page does for the dock. */
export interface MapBridge {
  projectId: string;
  isEditor: boolean;
  /**
   * Brings the map and an open style editor in step with styles changed elsewhere; resolves once they are.
   * Changes of another project are dropped.
   */
  followStyles: (changes: StyleChange[]) => Promise<void>;
  /**
   * Sends the page's pending style and scene saves now; resolves once they are stored, or after `timeoutMs` (3 s by
   * default). Never rejects.
   */
  settle: (timeoutMs?: number) => Promise<void>;
  /**
   * Reads again what a map change touched (layer rows, groups, the project's basemap, the map document) and
   * hands a changed scene to the scene store; resolves once that is done. A change of another project is
   * dropped, and a viewer's page reads nothing again.
   */
  followMap: (change: MapChange) => Promise<void>;
  /**
   * Shows a view on the map: the camera, 2D or 3D, the projection. Nothing of it is stored by this call. Answers
   * the way back to the view before, or nothing when no view was shown (the map is not ready, or the page is
   * not in Map mode).
   */
  applyView: (target: ViewTarget) => UndoFn | void;
}

let bridge: MapBridge | null = null;

/** The newest registration wins; the returned function removes it, and removing an older one changes nothing. */
export function registerMapBridge(next: MapBridge): () => void {
  bridge = next;
  return () => {
    if (bridge === next) bridge = null;
  };
}

/** The open map page's bridge; with a project, only when the page shows that project. Null when none does. */
export function getMapBridge(projectId?: string): MapBridge | null {
  if (!bridge || (projectId !== undefined && bridge.projectId !== projectId)) return null;
  return bridge;
}

/**
 * Hands style changes to the map page that shows their project; the changes of a project no page shows are
 * dropped (its page reads the stored styles when it opens). A follow that fails is logged, never thrown.
 */
export function followStyleChanges(changes: StyleChange[]): void {
  const byProject = new Map<string, StyleChange[]>();
  for (const change of changes) {
    byProject.set(change.projectId, [...(byProject.get(change.projectId) ?? []), change]);
  }
  byProject.forEach((group, projectId) => {
    void getMapBridge(projectId)
      ?.followStyles(group)
      .catch((error: unknown) => console.error("Following the assistant's style changes failed", error));
  });
}

/**
 * Hands a map change to the map page that shows its project; the change of a project no page shows is dropped
 * (its page reads the stored map when it opens). A follow that fails is logged, never thrown.
 */
export function followMapChange(change: MapChange): void {
  void getMapBridge(change.projectId)
    ?.followMap(change)
    .catch((error: unknown) => console.error("Following the assistant's map change failed", error));
}

/** The `style_update`, `map_update` and `undo_changes` steps this tab handed to the page as they came in, by tool call. */
const followedCalls = new Set<string>();

/** A step was handed to the page as it came in. */
export const markFollowed = (toolCallId: string): void => void followedCalls.add(toolCallId);

/** Tests: forget the steps handed over, as a fresh tab would. */
export const resetFollowedCalls = (): void => followedCalls.clear();

/** A re-read of a project's map request, which carries the layers' active styles and their lists. */
const restyled = (projectId: string): MapChange => ({
  projectId,
  layers: false,
  state: true,
  groups: false,
  basemap: false,
  scene: false,
});

/**
 * What the newest answer of `messages` changed in steps this tab did not hand to the page as they came in (no chat
 * view followed it while it ran: the dock was closed, or it ran in another tab), as one change per project for the
 * page to read again. A changed style is a re-read of the map request: no style is read on its own. A typed undo is
 * what went back of the map and the maps of the styles it restored. `map: false` leaves the map steps out, for a
 * caller that follows them itself; no follow reads a typed undo's map again, so it stays in. Each step counts once
 * per tab.
 */
export function missedEdits(messages: AssistantMessage[], { map = true } = {}): MapChange[] {
  const answer = messages.findLast((message) => message.role === "assistant");
  const changes = new Map<string, MapChange>();
  for (const part of answer?.parts ?? []) {
    if (part.type !== "dynamic-tool" || followedCalls.has(part.toolCallId)) continue;
    const style = styleEdit(part);
    const undone = undoneByStep(part);
    const found: MapChange[] = style
      ? [restyled(style.projectId)]
      : undone
        ? [
            ...(undone.map ? [mapChangeOfUndo(undone.map)] : []),
            ...undone.styles.map((restored) => restyled(restored.projectId)),
          ]
        : map
          ? [mapEdit(part)?.change].filter((change): change is MapChange => !!change)
          : [];
    if (!found.length) continue;
    followedCalls.add(part.toolCallId);
    for (const change of found) {
      const known = changes.get(change.projectId);
      changes.set(change.projectId, known ? mergedMapChange(known, change) : change);
    }
  }
  return [...changes.values()];
}

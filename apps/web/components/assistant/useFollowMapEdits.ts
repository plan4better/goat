"use client";

import { useEffect, useRef } from "react";

import { getMapBridge, markFollowed } from "@/lib/assistant/mapBridge";
import { type MapChange, mapEdits, mergedMapChange, viewUndoKey } from "@/lib/assistant/mapEdits";
import {
  getActiveSurface,
  getActiveSurfaceOwner,
  markProposal,
  setProposalUndo,
} from "@/lib/assistant/store";
import type { AssistantMessage, UndoFn } from "@/lib/assistant/types";

import { useDockActions } from "@/components/assistant/DockActions";

/**
 * The map changes this tab handed to the page already, by answer and step: a
 * chat mounts again when the dock expands or reconnects, and a running answer
 * then replays from its start.
 */
const followed = new Set<string>();
/**
 * The steps whose view this tab applied, by tool call: a replayed answer comes
 * under another message id, and its view must not move the map a second time.
 */
const applied = new Set<string>();

/** Tests: forget the changes handed over and the views applied, as a fresh tab would. */
export function resetFollowedMapEdits(): void {
  followed.clear();
  applied.clear();
}

/**
 * Follows the `map_update` steps of the conversation's answers.
 *
 * What a step changed on the server is handed to the page once
 * (`followMapChange`), also for the conversation as the chat mounted with it,
 * since an answer may have ended while the dock was closed: reading again is
 * harmless. Steps that come in together are handed over as one change per
 * project, so a conversation opened with many of them is one read.
 *
 * A view a step asks for is applied only as the step comes in: never for the
 * conversation as the chat mounted with it, once per tool call, and only when
 * the map page of its project is open at that moment. The way back the page
 * answers is kept like an applied proposal's undo, one per page. A view the
 * page could not show is logged and moves nothing.
 */
export function useFollowMapEdits(messages: AssistantMessage[], initialMessages: AssistantMessage[]): void {
  const actions = useDockActions();
  // The views this chat has weighed: those it mounted with, and each one that came in since.
  const weighed = useRef<Set<string> | null>(null);
  if (weighed.current === null) {
    weighed.current = new Set(mapEdits(initialMessages).map((edit) => edit.toolCallId));
  }
  useEffect(() => {
    const changes = new Map<string, MapChange>();
    // The chat's messages start as the initial ones: each change counts once.
    for (const edit of mapEdits([...initialMessages, ...messages])) {
      if (edit.change && !followed.has(edit.key)) {
        followed.add(edit.key);
        markFollowed(edit.toolCallId);
        const known = changes.get(edit.projectId);
        changes.set(edit.projectId, known ? mergedMapChange(known, edit.change) : edit.change);
      }
      if (!edit.view || !weighed.current || weighed.current.has(edit.toolCallId)) continue;
      weighed.current.add(edit.toolCallId);
      const bridge = getMapBridge(edit.projectId);
      if (!bridge || applied.has(edit.toolCallId)) continue;
      let undo: UndoFn | void;
      try {
        undo = bridge.applyView(edit.view);
      } catch (error) {
        // A view the map refuses (a camera outside the world) moves nothing; the rest is still followed.
        console.error("Showing the assistant's view failed", error);
        continue;
      }
      // The page showed nothing (its map is not drawn): the call is not applied.
      if (!undo) continue;
      applied.add(edit.toolCallId);
      // The way back moves that page's map: it is kept for the page's mount, and replaces an older one.
      const owner = getActiveSurface()?.project?.id === edit.projectId ? getActiveSurfaceOwner() : null;
      if (!owner) continue;
      setProposalUndo(viewUndoKey(edit.toolCallId), undo, owner);
      markProposal(viewUndoKey(edit.toolCallId), "applied");
    }
    changes.forEach((change) => actions.followMapChange(change));
  }, [messages, initialMessages, actions]);
}

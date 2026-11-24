"use client";

import { useEffect, useRef } from "react";

import { markFollowed } from "@/lib/assistant/mapBridge";
import type { AssistantMessage } from "@/lib/assistant/types";
import { followUndone, typedUndoEdits } from "@/lib/assistant/undoReply";

import { useDockActions } from "@/components/assistant/DockActions";

/**
 * The typed undos this tab handed to the page already, by tool call: a chat
 * mounts again when the dock expands or reconnects, and a running answer then
 * replays from its start under another message id.
 */
const followed = new Set<string>();

/** Tests: forget the undos handed over, as a fresh tab would. */
export function resetFollowedTypedUndos(): void {
  followed.clear();
}

/**
 * Has the page follow what a typed undo wrote back (`undo_changes`), once
 * per call; a repeated call's result wrote nothing more.
 *
 * An undo that comes in is followed through the code that follows the Undo
 * button's reply (`followUndone`): the map, the layer tree, the style panel
 * and an open workflow editor show the state the Undo restored. It is marked
 * as followed (`markFollowed`), so the catch-up of a run that ended reads it
 * no second time.
 *
 * The undos of the conversation as the chat mounted with it (it may have
 * ended while no chat followed it) are caught up as the other follows do:
 * the map and the styles of the newest answer through the map page's re-read
 * of missed steps (`missedEdits`, which `useFollowStyleEdits` and the run
 * watcher run), and the workflows of every answer here, since an open editor
 * ignores a revision it holds already.
 */
export function useFollowTypedUndo(messages: AssistantMessage[], initialMessages: AssistantMessage[]): void {
  const actions = useDockActions();
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) {
    seen.current = new Set(typedUndoEdits(initialMessages).map((edit) => edit.key));
  }
  useEffect(() => {
    const fresh = typedUndoEdits(initialMessages).filter((edit) => {
      if (followed.has(edit.toolCallId)) return false;
      followed.add(edit.toolCallId);
      return true;
    });
    const workflows = fresh.flatMap((edit) => edit.restored.workflows);
    if (workflows.length) actions.followWorkflowChanges(workflows);
  }, [initialMessages, actions]);
  useEffect(() => {
    for (const edit of typedUndoEdits(messages)) {
      if (seen.current?.has(edit.key) || followed.has(edit.toolCallId)) continue;
      followed.add(edit.toolCallId);
      markFollowed(edit.toolCallId);
      followUndone(edit.restored, actions);
    }
  }, [messages, actions]);
}

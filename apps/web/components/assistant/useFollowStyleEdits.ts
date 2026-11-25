"use client";

import { useEffect, useRef } from "react";

import { markFollowed, missedEdits } from "@/lib/assistant/mapBridge";
import { styleEdits } from "@/lib/assistant/styleEdits";
import type { AssistantMessage } from "@/lib/assistant/types";

import { useDockActions } from "@/components/assistant/DockActions";

/**
 * The style edits this tab handed to the page already, by answer and step: a
 * chat mounts again when the dock expands or reconnects, and a running answer
 * then replays from its start.
 */
const followed = new Set<string>();

/** Tests: forget the edits handed over, as a fresh tab would. */
export function resetFollowedStyleEdits(): void {
  followed.clear();
}

/**
 * Hands each style edit of the answers that come in to the page once
 * (`followStyleChanges`): the map draws the changed style, and an open style
 * editor takes it as one step of its undo. A running answer that replays
 * after a remount comes under another message id, so its edits are followed;
 * the map page ignores a revision it holds already.
 *
 * The edits of the conversation as the chat mounted with it are not handed
 * over one by one. Only when its newest answer has edits this tab did not
 * follow as they came in (the answer ran while no chat followed it) does the
 * page read its map once (`missedEdits`), which carries the active styles.
 */
export function useFollowStyleEdits(messages: AssistantMessage[], initialMessages: AssistantMessage[]): void {
  const actions = useDockActions();
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) {
    seen.current = new Set(styleEdits(initialMessages).map((edit) => edit.key));
  }
  useEffect(() => {
    // The map steps are the map follow's: it reads what they touched itself.
    missedEdits(initialMessages, { map: false }).forEach((change) => actions.followMapChange(change));
  }, [initialMessages, actions]);
  useEffect(() => {
    const known = seen.current;
    const fresh = styleEdits(messages).filter((edit) => {
      if (known?.has(edit.key) || followed.has(edit.key)) return false;
      followed.add(edit.key);
      markFollowed(edit.toolCallId);
      return true;
    });
    if (fresh.length === 0) return;
    actions.followStyleChanges(fresh.map(({ key: _key, toolCallId: _call, ...change }) => change));
  }, [messages, actions]);
}

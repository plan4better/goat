"use client";

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { announceRunEnd, lastAnswer, runEndOf } from "@/lib/assistant/announce";
import { type Translate, plainTranslate } from "@/lib/assistant/chips";
import { refreshConversationLists } from "@/lib/assistant/conversations";
import { AssistantApiError } from "@/lib/assistant/errors";
import { getDockState, removePendingRun, useDockState } from "@/lib/assistant/store";
import { fetchConversation } from "@/lib/assistant/transport";

export const WATCH_INTERVAL_MS = 4000;
const GIVE_UP_MS = 30 * 60 * 1000;

/**
 * Runs this tab started whose chat view is gone (the dock was closed, another
 * conversation opened): the run goes on server side, so this asks for its end
 * and announces it. Mounted only while the assistant is available.
 */
export default function RunWatcher() {
  const { t } = useTranslation("common");
  // React escapes text itself; the toast takes a plain string, so i18next must not escape twice.
  const translate = useRef<Translate>(plainTranslate(t));
  useEffect(() => {
    translate.current = plainTranslate(t);
  });
  const dock = useDockState();
  const watched = dock.pending
    .filter((run) => !(dock.open && dock.conversationId === run.conversationId))
    .map((run) => run.conversationId)
    .join(",");

  useEffect(() => {
    if (!watched) return;
    let stopped = false;
    let running = false;
    const tick = async () => {
      // A slow request must not let the next tick fetch the same conversation again.
      if (running) return;
      running = true;
      try {
        for (const run of getDockState().pending) {
          const state = getDockState();
          if (stopped) return;
          if (state.open && state.conversationId === run.conversationId) continue;
          if (Date.now() - run.since > GIVE_UP_MS) {
            removePendingRun(run.conversationId);
            // The history may still mark it as running.
            void refreshConversationLists();
            continue;
          }
          try {
            const detail = await fetchConversation(run.conversationId);
            if (stopped || detail.activeRunId) continue;
            removePendingRun(run.conversationId);
            // No chat view ended this run, so the history still marks it as running.
            void refreshConversationLists();
            const answer = lastAnswer(detail.messages);
            // The answer known at send time is not this run's: the send was refused or never arrived.
            if (answer && answer.id !== (run.knownAnswerId ?? null)) {
              await announceRunEnd(
                {
                  conversationId: run.conversationId,
                  messageId: answer.id,
                  title: detail.conversation.title || run.title || translate.current("assistant_untitled"),
                  status: runEndOf(answer),
                },
                translate.current
              );
            }
          } catch (error) {
            // Deleted, or no longer this user's to read: it will not answer differently later.
            if (error instanceof AssistantApiError && (error.status === 403 || error.status === 404)) {
              removePendingRun(run.conversationId);
              void refreshConversationLists();
            }
            // Any other failed poll (network, a restart) is retried on the next tick; the give-up time bounds it.
          }
        }
      } finally {
        running = false;
      }
    };
    const id = window.setInterval(() => void tick(), WATCH_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [watched]);

  return null;
}

import { toast } from "react-toastify";

import type { Translate } from "@/lib/assistant/chips";
import { getDockState, openConversation } from "@/lib/assistant/store";
import type { AssistantMessage, RunStatusData } from "@/lib/assistant/types";
import { claimJobAnnouncement } from "@/lib/utils/jobAnnouncement";

export interface RunEnd {
  conversationId: string;
  /** The answer's message id: the same in every tab, so the claim is shared. */
  messageId: string;
  title: string;
  status: "succeeded" | RunStatusData["status"];
}

/** How long a background tab waits before claiming, so a visible tab claims first. */
export const HIDDEN_TAB_DELAY_MS = 1500;

/** The newest assistant message: the answer a run end announces. */
export function lastAnswer(messages: AssistantMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") return messages[index];
  }
  return undefined;
}

export function runEndOf(message: AssistantMessage): RunEnd["status"] {
  for (const part of message.parts) {
    if (part.type === "data-run-status") return part.data.status;
  }
  return "succeeded";
}

/** The conversation is on screen in this tab: the user saw the answer arrive. */
export function isShowing(conversationId: string): boolean {
  const dock = getDockState();
  const visible = typeof document === "undefined" || document.visibilityState === "visible";
  return dock.enabled && dock.open && dock.conversationId === conversationId && visible;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A toast when an answer finishes while the user is elsewhere, in one tab
 * only. Every tab that saw the end claims it through the job-announcement
 * lock; the tab that shows the conversation claims without a toast, so no
 * other tab toasts either. A stopped answer is not announced. The title is
 * user or model text: it only ever reaches the toast as a plain string, and
 * the caller's `t` must not escape it.
 */
export async function announceRunEnd(end: RunEnd, t: Translate): Promise<void> {
  if (
    !isShowing(end.conversationId) &&
    typeof document !== "undefined" &&
    document.visibilityState !== "visible"
  ) {
    await pause(HIDDEN_TAB_DELAY_MS);
  }
  const claimed = await claimJobAnnouncement(`assistant:${end.messageId}`);
  if (!claimed || end.status === "cancelled" || isShowing(end.conversationId)) return;
  const open = () => openConversation(end.conversationId);
  if (end.status === "succeeded") {
    toast.info(t("assistant_toast_answer_ready", { title: end.title }), { onClick: open });
  } else {
    toast.warning(t("assistant_toast_answer_failed", { title: end.title }), { onClick: open });
  }
}

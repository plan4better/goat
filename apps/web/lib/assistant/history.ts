import { type Locale, format, isSameDay, parseISO } from "date-fns";

import type { Translate } from "@/lib/assistant/chips";
import { MODE_LABEL_KEYS } from "@/lib/assistant/surface";
import type { ConversationSummary } from "@/lib/assistant/types";

/** Existing labels of the pages a conversation can start on. */
const PAGE_LABEL_KEYS: Record<string, string> = {
  catalog: "catalog",
  home: "home",
  content: "content",
  settings: "settings",
  datasets: "datasets",
  projects: "projects",
};

/** The length the server cuts a conversation's first message to, for the history. */
const FIRST_MESSAGE_CHARS = 200;

/**
 * The title of a conversation just sent, until the server has stored its first
 * message: that message on one line, cut as the server cuts it. Null for no text.
 */
export function provisionalTitle(text: string | undefined): string | null {
  const line = text?.replace(/\s+/g, " ").trim();
  if (!line) return null;
  const chars = Array.from(line);
  return chars.length > FIRST_MESSAGE_CHARS ? `${chars.slice(0, FIRST_MESSAGE_CHARS - 1).join("")}…` : line;
}

export const conversationTitle = (
  conversation: Pick<ConversationSummary, "title" | "first_message"> | undefined,
  t: Translate
): string => conversation?.title || conversation?.first_message || t("assistant_untitled");

/** "Berlin cycling study · Map", "Catalog" (spec §10). */
export function originLabel(conversation: ConversationSummary, t: Translate): string {
  if (conversation.project_id) {
    if (!conversation.project_access) return t("assistant_origin_project_unavailable");
    const mode = MODE_LABEL_KEYS[conversation.origin_surface];
    const name = conversation.project_name ?? "";
    return mode ? `${name} · ${t(mode)}` : name;
  }
  const page = PAGE_LABEL_KEYS[conversation.origin_surface];
  return page ? t(page) : t("assistant_origin_other");
}

export function groupByDay(
  list: ConversationSummary[],
  now: Date = new Date()
): { today: ConversationSummary[]; earlier: ConversationSummary[] } {
  const today: ConversationSummary[] = [];
  const earlier: ConversationSummary[] = [];
  for (const conversation of list) {
    (isSameDay(parseISO(conversation.updated_at), now) ? today : earlier).push(conversation);
  }
  return { today, earlier };
}

/** A history row's time: the hour today, else the day ("30 Oct", in German "30. Okt."). */
export function historyDate(updatedAt: string, locale: Locale, now: Date = new Date()): string {
  const date = parseISO(updatedAt);
  if (isSameDay(date, now)) return format(date, "HH:mm");
  return format(date, locale.code?.startsWith("de") ? "d. MMM" : "d MMM", { locale });
}

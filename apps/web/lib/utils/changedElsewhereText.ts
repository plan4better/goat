import type { Translate } from "@/lib/assistant/chips";
import { relativeTime } from "@/lib/assistant/messageTimes";
import type { SaveConflict } from "@/lib/utils/revisionedSaver";

/** The documents an editor saves on a revision; each has its own texts. */
export type ConflictDocument = "workflow" | "report_layout" | "dashboard";

/** Who changed a document and when, as core names them. */
type Change = Pick<SaveConflict, "updatedAt" | "updatedBy">;

const personName = (change: Change): string | null => {
  const { firstname, lastname } = change.updatedBy ?? {};
  const name = [firstname, lastname].filter(Boolean).join(" ").trim();
  return name || null;
};

/**
 * "This workflow was changed elsewhere (by Ada Lovelace, 2 minutes ago)." The
 * name is left out when nobody is recorded, the brackets when the time is
 * unknown too.
 */
export function changedElsewhereText(
  t: Translate,
  document: ConflictDocument,
  conflict: SaveConflict,
  language: string,
  now: number
): string {
  return changedText(t, `${document}_changed_elsewhere`, conflict, language, now);
}

/**
 * The text `key` names, with who changed the document and when in brackets
 * (`<key>_by`, `<key>_at`), as far as they are known.
 */
export function changedText(
  t: Translate,
  key: string,
  change: Change,
  language: string,
  now: number
): string {
  const time = change.updatedAt ? Date.parse(change.updatedAt) : Number.NaN;
  if (Number.isNaN(time)) return t(key);
  // "Just now" and "Yesterday" start a sentence elsewhere; here they sit inside one.
  const relative = relativeTime(time, now, t, language);
  const when = relative.charAt(0).toLowerCase() + relative.slice(1);
  const name = personName(change);
  return name ? t(`${key}_by`, { name, time: when }) : t(`${key}_at`, { time: when });
}

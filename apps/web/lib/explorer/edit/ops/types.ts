/**
 * What an operation makes of a draft: the change's rows, ready for the
 * session, and the facts the Apply bar words; or why it cannot be made.
 * Operations never word anything themselves: the panel and the Apply bar do,
 * in the user's language.
 */
import type { EditChange } from "@/lib/explorer/edit/types";

/** A change as an operation builds it; the words are added by the caller. */
export type ChangeRows = Pick<EditChange, "kind" | "touches" | "sql" | "gtfs" | "shapes" | "dropped">;

/** A finding about a draft, by its notice code (03-validation-spec): an
 * error refuses the edit, a notice lets it be. Both are said once, as a
 * toast, not kept beside the edit; an error on a form field is said on it. */
export interface Check {
  code: string;
  severity: "error" | "notice";
  params?: Record<string, string | number>;
  /** The form field it is about, where the form shows it there. */
  field?: string;
}

export type Built<F> =
  | { ok: true; rows: ChangeRows; facts: F; checks: Check[] }
  | { ok: false; refused: Check; facts: F | null; checks: Check[] };

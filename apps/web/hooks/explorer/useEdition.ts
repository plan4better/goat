/**
 * The edition of a database's editing session: moved on by every apply,
 * undo and redo, so what reads the tables reads them again.
 */
import { useSyncExternalStore } from "react";

import type { SqlRunner } from "@/lib/explorer/db/types";
import { sessionOf } from "@/lib/explorer/edit/session";

const none = () => () => undefined;
const zero = () => 0;

export function useEdition(db: SqlRunner | undefined): number {
  const session = db ? sessionOf(db) : null;
  return useSyncExternalStore(session?.subscribe ?? none, session?.getEdition ?? zero, zero);
}

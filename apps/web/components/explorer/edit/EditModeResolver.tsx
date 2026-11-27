/**
 * While a line mode ("Edit stops", "Edit path") is on: the line it edits, read from the
 * snapshot for the map (modeStore) — the pattern shown, the variant picked
 * else the direction's main one — read again after each change applied or
 * undone, as the line it draws may have changed with it.
 */
import { useEffect } from "react";

import { patternLine } from "@/lib/explorer/derive/path";
import { shownPattern } from "@/lib/explorer/directionChoice";
import { modeStore } from "@/lib/explorer/edit/modeStore";

import { useEdition } from "@/hooks/explorer/useEdition";
import { lineScope } from "@/hooks/explorer/useLineStopEdits";
import { useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";

export function EditModeResolver() {
  const { db } = useExplorer();
  const mode = useAppSelector((s) => s.explorer.edit.mode);
  const drawing = useAppSelector((s) => s.explorer.drawing);
  const choice = useAppSelector((s) => s.explorer.pattern);
  // Moved on by every apply, undo and redo.
  const edition = useEdition(db);

  useEffect(() => {
    // Until the line is read again, the map has none: a direction left, or
    // a line changed, is never edited where it was.
    modeStore.set(null);
    if (!mode || !db || !drawing) return;
    const scope = lineScope(mode.route_idx, drawing, choice);
    const pattern = shownPattern(choice, drawing.directions);
    if (!scope || pattern === null) return;
    let current = true;
    patternLine(db, pattern)
      .then((line) => current && modeStore.set(line ? { line, scope } : null))
      .catch(() => current && modeStore.set(null));
    return () => {
      current = false;
    };
  }, [mode, db, drawing, choice, edition]);

  useEffect(() => () => modeStore.set(null), []);
  return null;
}

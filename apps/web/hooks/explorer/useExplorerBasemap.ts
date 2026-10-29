/**
 * The Explorer's basemap. On a project nobody has chosen a basemap for, the
 * Explorer shows the Light or Dark basemap to match GOAT's theme. For this
 * session and this view only: it is never saved to the project, which others
 * share, and the project's own basemap is back when the Explorer closes. A
 * basemap the user picks, in the Explorer or out of it, is saved as ever and
 * shown from then on, High Fidelity included.
 *
 * "Nobody has chosen" is read from the project as core sends it: core leaves
 * an unset basemap out, and only the project schema then fills in its default
 * (High Fidelity), which would make it look chosen.
 *
 * Its map layers read the basemap from the store to draw for it
 * (lib/explorer/mapPalette), so the store holds one here whatever the theme.
 */
import { useTheme } from "@mui/material";
import { useEffect } from "react";

import { clearActiveBasemap, setActiveBasemap } from "@/lib/store/map/slice";

import type { BuiltInBasemap } from "@/types/map/common";

import { resolveActiveBasemap } from "@/hooks/map/MapHooks";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

export function useExplorerBasemap(
  /** The project as core sends it, before the schema: its `basemap` absent or
   * null if never chosen. */
  project: { id?: string; basemap?: string | null } | undefined
) {
  const dispatch = useAppDispatch();
  const active = useAppSelector((s) => s.explorer.active);
  const builtIns = useAppSelector((s) => s.map.basemaps) as BuiltInBasemap[];
  const mode = useTheme().palette.mode;
  const projectId = project?.id;
  const unchosen = !!project && (project.basemap === null || project.basemap === undefined);
  useEffect(() => {
    if (!active || !unchosen || !projectId) return;
    const basemap = resolveActiveBasemap(mode === "dark" ? "dark" : "light", builtIns, []);
    dispatch(setActiveBasemap({ basemap, projectId }));
    // On leaving — the Explorer closed, the user picked a basemap (saved, and
    // set by the map page), or the page gone — the session's choice is
    // dropped. React runs this before the map page sets a picked one.
    return () => {
      dispatch(clearActiveBasemap());
    };
  }, [active, unchosen, projectId, mode, builtIns, dispatch]);
}

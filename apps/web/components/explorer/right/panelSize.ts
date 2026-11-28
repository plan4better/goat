/**
 * How much of the map's right edge the Explorer's right panel takes: the
 * layout makes room for it, the map keeps clear of it. Apart from the panel
 * itself, so the map's layers can read it without loading the panel.
 */
import { rightPanelOpen } from "@/lib/store/explorer/slice";

import { useAppSelector } from "@/hooks/store/ContextHooks";

/** The panel's width (02-panel-behaviour-spec). */
export const EXPLORER_RIGHT_PANEL_WIDTH = 340;

/** The width the panel takes; 0 when closed. */
export function useRightPanelWidth(): number {
  return useAppSelector((s) => (rightPanelOpen(s.explorer) ? EXPLORER_RIGHT_PANEL_WIDTH : 0));
}

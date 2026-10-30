/**
 * The Explorer's left panel (board 3): one panel headed by a tab bar —
 * Layers | Explorer. It neither closes nor collapses; the Explorer is left
 * by the × on its tab or the bundle's menu. On the Explorer tab the
 * operating cost stands below it in a card of its own
 * (docs/pt-network-editor/docs/02-panel-behaviour-spec.md).
 */
import { Box, Stack, Tab, Tabs, Tooltip } from "@mui/material";
import { type ReactNode, memo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { type ExplorerLeftTab, closeExplorer, setExplorerLeftTab } from "@/lib/store/explorer/slice";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { FloatingPanel } from "@/components/common/FloatingPanel";
import { CostSection } from "@/components/explorer/CostSection";
import { useExplorer } from "@/components/explorer/ExplorerContext";
import { ExplorerLoadingCard, ExplorerLoadingLine } from "@/components/explorer/ExplorerLoading";
import { ExplorerSettingsDialog } from "@/components/explorer/ExplorerSettingsDialog";
import { ExplorerTab } from "@/components/explorer/ExplorerTab";
import { EXPLORER_RIGHT_PANEL_WIDTH } from "@/components/explorer/right/panelSize";

/** The left panel's width while the Explorer is open: the right panel's, so
 * the two sides match and the route summary has room. It holds for the
 * whole session — opening a route never resizes it — and the data view's
 * own width comes back on exit (DataProjectLayout). */
export const EXPLORER_PANEL_WIDTH = EXPLORER_RIGHT_PANEL_WIDTH;

export function ExplorerLeftPanel({ layersTab }: { layersTab: ReactNode }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const tab = useAppSelector((s) => s.explorer.leftTab);
  const { db } = useExplorer();

  // One panel: the tab bar is its header, the active tab fills the rest. Both
  // tabs stay mounted, so switching is a tab change, never a reload — the
  // route search and scroll position survive a look at the layers.
  return (
    // The full map height on both tabs, so switching does not resize it: on
    // the Explorer tab the panel gives up the cost card's height and a gap,
    // 8 px, as the bottom bar keeps from the panel.
    <Stack spacing={2} sx={{ height: "100%", width: EXPLORER_PANEL_WIDTH, pointerEvents: "none" }}>
      <FloatingPanel
        width={EXPLORER_PANEL_WIDTH}
        maxHeight="100%"
        minHeight={0}
        sx={{ flex: 1, minHeight: 0 }}>
        {/* Flush with the panel: plain tabs under its own corners, the active
          one underlined, rather than a control set inside it. */}
        <Tabs
          value={tab}
          variant="fullWidth"
          onChange={(_e, value: ExplorerLeftTab) => dispatch(setExplorerLeftTab(value))}
          sx={{ minHeight: 44, flexShrink: 0, borderBottom: 1, borderColor: "divider" }}>
          <Tab
            value="layers"
            iconPosition="start"
            icon={<Icon iconName={ICON_NAME.LAYERS} style={{ fontSize: 14 }} />}
            label={t("layers")}
            // Half the row each, whatever their padding: a tab's padding counts
            // toward its share where they only grow.
            sx={{ minHeight: 44, textTransform: "none", gap: 0.5, flex: "0 0 50%", maxWidth: "50%" }}
          />
          <Tab
            value="explorer"
            iconPosition="start"
            icon={<Icon iconName={ICON_NAME.BUS} style={{ fontSize: 14 }} />}
            label={
              <>
                {t("explorer")}
                {/* The way out, at the tab's far edge, centred on its height: a
                  control inside the tab, so its own click does not select it. */}
                <Tooltip title={t("explorer_exit")}>
                  <Box
                    component="span"
                    role="button"
                    tabIndex={0}
                    aria-label={t("explorer_exit")}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch(closeExplorer());
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        dispatch(closeExplorer());
                      }
                    }}
                    sx={{
                      position: "absolute",
                      right: 10,
                      top: "50%",
                      transform: "translateY(-50%)",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 24,
                      height: 24,
                      borderRadius: "50%",
                      // Grey whether or not the tab is selected: a control,
                      // not part of the tab's name.
                      color: "text.secondary",
                      "&:hover": { bgcolor: "action.hover" },
                      // A hairline between the tab's name and its close.
                      "&::before": {
                        content: '""',
                        position: "absolute",
                        left: -6,
                        top: "50%",
                        width: "1px",
                        height: 16,
                        mt: "-8px",
                        bgcolor: "divider",
                      },
                    }}>
                    <Icon iconName={ICON_NAME.XCLOSE} style={{ fontSize: 13 }} htmlColor="inherit" />
                  </Box>
                </Tooltip>
              </>
            }
            // Icon and name centred between the tab's left padding and the
            // divider before the close (40px from its right edge).
            sx={{
              minHeight: 44,
              textTransform: "none",
              gap: 0.5,
              flex: "0 0 50%",
              maxWidth: "50%",
              pl: "16px",
              pr: "40px",
            }}
          />
        </Tabs>
        <Box
          sx={{
            display: tab === "layers" ? "flex" : "none",
            flexDirection: "column",
            minHeight: 0,
            overflow: "auto",
          }}>
          <WhileShown shown={tab === "layers"}>{layersTab}</WhileShown>
        </Box>
        <Stack
          sx={{ display: tab === "explorer" ? "flex" : "none", flex: 1, minHeight: 0, position: "relative" }}>
          <ExplorerContent ready={!!db} />
        </Stack>
      </FloatingPanel>
      {tab === "explorer" && db && (
        <FloatingPanel width={EXPLORER_PANEL_WIDTH} minHeight={0} sx={{ flexShrink: 0 }}>
          <CostSection />
        </FloatingPanel>
      )}
    </Stack>
  );
}

/** The Explorer tab's content. Apart, and memoised, so the map layout
 * re-rendering around it — the right panel opening or folding changes its
 * widths — does not re-render the route list or the route summary with it. */
const ExplorerContent = memo(function ExplorerContent({ ready }: { ready: boolean }) {
  return (
    <>
      <ExplorerLoadingLine />
      {ready ? (
        <>
          <Box sx={{ flex: 1, minHeight: 0 }}>
            <ExplorerTab />
          </Box>
          <ExplorerSettingsDialog />
        </>
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <ExplorerLoadingCard />
        </Box>
      )}
    </>
  );
});

/** Holds a hidden tab as it was: the layout hands down a new layer tree with
 * every render of its own, and a tab out of view need not draw it again.
 * Shown, it takes the latest. */
const WhileShown = memo(
  function WhileShown({ children }: { shown: boolean; children: ReactNode }) {
    return <>{children}</>;
  },
  (_prev, next) => !next.shown
);

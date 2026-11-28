/**
 * The edit bar (board 17): one fixed bar at the top of the map, right of
 * GOAT's round map buttons, for a user who may write the bundle. It holds
 * only what works without a selection — Select, the tools that create (Stop,
 * Line), Snap, Undo/Redo and the change count — and never changes with
 * the selection. Under its tools, on the same surface, a second row
 * (EditBarRow): what can be done to the selection, or a line mode's
 * direction and Done; what the pointer does is said under the bar
 * (ToolHint).
 *
 * Under a narrow map the tools show as icons only, their names and keys in
 * the tooltips. The count opens the change list.
 */
import { Box, ButtonBase, Stack, Tooltip, Typography, alpha } from "@mui/material";
import type { ReactNode } from "react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import {
  type ExplorerEditTool,
  setChangeListOpen,
  setEditSnap,
  setEditTool,
} from "@/lib/store/explorer/slice";
import { isApplePlatform } from "@/lib/utils/platform";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { ICON_GAP } from "@/components/explorer/SectionHeader";
import { StopMarker } from "@/components/explorer/StopMarker";
import { ChangeList } from "@/components/explorer/edit/ChangeList";
import { EditBarRow } from "@/components/explorer/edit/EditBarRow";

/** The bar's height (GOAT's round map buttons'), and what sits inside it:
 * every control the same height, inset the same from the bar's edge. */
const BAR_H = 40;
const ITEM_H = 32;
const INSET = (BAR_H - ITEM_H) / 2;
/** Labels and icons as the Explorer's other controls have them (the bottom
 * bar's speed, date and Chart | List): 12 px, bold, in GOAT's grey. */
const LABEL_SIZE = 12;
const LABEL_WEIGHT = 700;
const ICON_SIZE = 12;

/** The tools, each marked as the Explorer marks what it makes: a stop as
 * the map draws one (StopMarker), a line by the Lines section's icon. */
const TOOLS: { tool: ExplorerEditTool; mark: ReactNode; key: string }[] = [
  {
    tool: "select",
    mark: <Icon iconName={ICON_NAME.ARROW_POINTER} style={{ fontSize: 12 }} htmlColor="inherit" />,
    key: "V",
  },
  // In the button's colour, as the other tools' icons: green when chosen.
  { tool: "stop", mark: <StopMarker size={11} fill="currentColor" />, key: "S" },
  // A new line (its code keeps GTFS's "route").
  {
    tool: "route",
    mark: <Icon iconName={ICON_NAME.ROUTE} style={{ fontSize: 12 }} htmlColor="inherit" />,
    key: "L",
  },
];

function Divider() {
  return <Box aria-hidden sx={{ width: "1px", height: 18, bgcolor: "divider", flexShrink: 0, mx: "8px" }} />;
}

/** A control of the bar: an icon, and a label unless compact. Chosen, a
 * pale fill in the primary colour; a tool not built yet stays legible, in
 * the secondary text colour, its tooltip saying it is coming. */
function BarButton({
  label,
  hint,
  mark,
  active = false,
  disabled = false,
  compact,
  tight = false,
  onClick,
  children,
}: {
  label: string;
  hint: string;
  mark: ReactNode;
  active?: boolean;
  disabled?: boolean;
  compact: boolean;
  /** Less room either side (Stop, Route, Snap; Select keeps its own). */
  tight?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <Tooltip title={hint}>
      {/* A span, so a disabled button still shows why. */}
      <Box component="span" sx={{ display: "inline-flex" }}>
        <ButtonBase
          aria-pressed={active}
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          sx={{
            height: ITEM_H,
            // Room either side, so a chosen tool's fill is not tight round
            // its name. In pixels: the theme's spacing unit is 4 px.
            px: tight ? "10px" : compact ? "10px" : "14px",
            gap: ICON_GAP,
            borderRadius: `${ITEM_H / 2}px`,
            color: active ? "primary.main" : "text.secondary",
            bgcolor: (theme) => (active ? alpha(theme.palette.primary.main, 0.1) : "transparent"),
            transition: "background-color 120ms",
            "&:hover": {
              bgcolor: (theme) =>
                active ? alpha(theme.palette.primary.main, 0.14) : theme.palette.action.hover,
            },
            "&.Mui-disabled": { color: "text.secondary" },
          }}>
          <Box sx={{ display: "flex", alignItems: "center", width: 12, justifyContent: "center" }}>
            {mark}
          </Box>
          {!compact && (
            <Typography color="inherit" sx={{ fontSize: LABEL_SIZE, fontWeight: LABEL_WEIGHT }}>
              {label}
            </Typography>
          )}
          {children}
        </ButtonBase>
      </Box>
    </Tooltip>
  );
}

/** The snap switch: small, as a toggle inside a toolbar is. */
function Toggle({ on }: { on: boolean }) {
  return (
    <Box
      aria-hidden
      sx={{
        position: "relative",
        width: 26,
        height: 16,
        borderRadius: "8px",
        flexShrink: 0,
        bgcolor: on ? "primary.main" : "action.disabled",
        transition: "background-color 120ms",
      }}>
      <Box
        sx={{
          position: "absolute",
          top: 2,
          left: on ? 12 : 2,
          width: 12,
          height: 12,
          borderRadius: "50%",
          bgcolor: "background.paper",
          boxShadow: "0 1px 2px rgba(0, 0, 0, 0.25)",
          transition: "left 120ms",
        }}
      />
    </Box>
  );
}

/** Undo or redo: an icon alone. */
function HistoryButton({
  label,
  hint,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  icon: ICON_NAME;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip title={hint}>
      <Box component="span" sx={{ display: "inline-flex" }}>
        <ButtonBase
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          sx={{
            width: ITEM_H,
            height: ITEM_H,
            borderRadius: "50%",
            color: "text.secondary",
            "&:hover": { bgcolor: "action.hover" },
            "&.Mui-disabled": { color: "text.disabled" },
          }}>
          <Icon iconName={icon} style={{ fontSize: ICON_SIZE }} htmlColor="inherit" />
        </ButtonBase>
      </Box>
    </Tooltip>
  );
}

export function EditBar({
  compact,
  undo,
  redo,
}: {
  compact: boolean;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const edit = useAppSelector((s) => s.explorer.edit);
  const count = edit.changes.length;
  const pill = useRef<HTMLButtonElement | null>(null);
  const apple = typeof navigator !== "undefined" && isApplePlatform(navigator);
  const undoKey = apple ? "⌘Z" : t("explorer_ctrl_key", { key: "Z" });
  const redoKey = apple ? "⇧⌘Z" : t("explorer_ctrl_key", { key: "Y" });

  return (
    // The Explorer's floating surface, as the bottom bar's and the panels'
    // (FloatingPanel): the tools, and under them the second row, if any.
    <Box
      sx={{
        width: "fit-content",
        borderRadius: `${BAR_H / 2}px`,
        overflow: "hidden",
        bgcolor: (theme) => alpha(theme.palette.background.paper, 0.9),
        backdropFilter: "blur(10px)",
        boxShadow: "rgba(0, 0, 0, 0.2) 0px 0px 10px",
        pointerEvents: "all",
      }}>
      <Stack
        direction="row"
        alignItems="center"
        role="toolbar"
        aria-label={t("explorer_edit_tools")}
        sx={{
          height: BAR_H,
          px: `${INSET}px`,
          // A little air between neighbouring controls.
          columnGap: "4px",
        }}>
        {TOOLS.map(({ tool, mark, key }, i) => {
          const label = t(`explorer_tool_${tool}`);
          return (
            <Box key={tool} sx={{ display: "flex", alignItems: "center", columnGap: "4px" }}>
              <BarButton
                label={label}
                hint={`${label} · ${key}`}
                mark={mark}
                active={edit.tool === tool}
                compact={compact}
                tight={tool !== "select"}
                onClick={() => dispatch(setEditTool(tool))}
              />
              {/* Select apart from the tools that create. */}
              {i === 0 && <Divider />}
            </Box>
          );
        })}
        <Divider />
        <BarButton
          label={t("explorer_snap")}
          hint={t("explorer_snap_hint")}
          mark={<Icon iconName={ICON_NAME.MAGNET} style={{ fontSize: ICON_SIZE }} htmlColor="inherit" />}
          compact={compact}
          tight
          onClick={() => dispatch(setEditSnap(!edit.snap))}>
          <Toggle on={edit.snap} />
        </BarButton>
        <Divider />
        <HistoryButton
          label={t("undo")}
          hint={`${t("undo")} · ${undoKey}`}
          icon={ICON_NAME.UNDO}
          disabled={!count}
          onClick={() => void undo()}
        />
        <HistoryButton
          label={t("redo")}
          hint={`${t("redo")} · ${redoKey}`}
          icon={ICON_NAME.REDO}
          disabled={!edit.redo.length}
          onClick={() => void redo()}
        />
        {/* The count: dark once something changed, a quiet grey before. */}
        <ButtonBase
          ref={pill}
          aria-haspopup="dialog"
          aria-expanded={edit.listOpen}
          onClick={() => dispatch(setChangeListOpen(!edit.listOpen))}
          sx={{
            height: ITEM_H,
            // As roomy as the tools: 14 px before the text, 12 after the chevron.
            ml: "4px",
            pl: "14px",
            pr: "12px",
            gap: ICON_GAP,
            borderRadius: `${ITEM_H / 2}px`,
            bgcolor: count ? "text.primary" : "action.hover",
            color: count ? "background.paper" : "text.secondary",
            "&:hover": { bgcolor: count ? "text.primary" : "action.selected" },
          }}>
          <Typography color="inherit" noWrap sx={{ fontSize: LABEL_SIZE, fontWeight: LABEL_WEIGHT }}>
            {count ? t("explorer_edits", { count }) : t("explorer_edits_none")}
          </Typography>
          <Icon iconName={ICON_NAME.CHEVRON_DOWN} style={{ fontSize: 9 }} htmlColor="inherit" />
        </ButtonBase>
        <ChangeList anchor={pill.current} undo={undo} />
      </Stack>
      <EditBarRow compact={compact} />
    </Box>
  );
}

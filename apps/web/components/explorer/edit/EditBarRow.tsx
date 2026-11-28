/**
 * The edit bar's second row (decided 26 Nov 2026), under its tools, on the
 * same surface: in "Edit stops" or "Edit path", the mode, the direction it
 * edits (the strip's picker) and Done; else, with Select and something
 * selected, what is selected and what can be done to it
 * (useSelectionActions), as a right click on it offers. None while an edit is
 * being made: its Apply bar has the say.
 *
 * Under a narrow map the actions show as icons only, their names in the
 * tooltips.
 */
import { Box, ButtonBase, Stack, Tooltip, Typography } from "@mui/material";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { setEditMode } from "@/lib/store/explorer/slice";

import { useRouteTrips, useRoutes } from "@/hooks/explorer/useExplorerData";
import { useSelectionActions } from "@/hooks/explorer/useSelectionActions";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { DirectionPicker, tripsByPattern } from "@/components/explorer/DirectionPicker";
import { useExplorer } from "@/components/explorer/ExplorerContext";
import { RouteBadge } from "@/components/explorer/RouteBadge";
import { ICON_GAP } from "@/components/explorer/SectionHeader";

/** The row's controls, as the first row's: 32 high, in a 40 px row. */
const ROW_H = 40;
const ITEM_H = 32;
const LABEL = { fontSize: 12, fontWeight: 700 } as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      role="toolbar"
      aria-label={label}
      sx={{ height: ROW_H, pl: "14px", pr: "4px", columnGap: "4px", borderTop: 1, borderColor: "divider" }}>
      {children}
    </Stack>
  );
}

function Separator() {
  return <Box aria-hidden sx={{ width: "1px", height: 18, bgcolor: "divider", flexShrink: 0, mx: "8px" }} />;
}

export function EditBarRow({ compact }: { compact: boolean }) {
  const mode = useAppSelector((s) => s.explorer.edit.mode);
  const tool = useAppSelector((s) => s.explorer.edit.tool);
  const drafting = useAppSelector((s) => !!s.explorer.edit.draft);
  if (mode) return <ModeRow compact={compact} route_idx={mode.route_idx} kind={mode.kind} />;
  if (tool !== "select" || drafting) return null;
  return <SelectionRow compact={compact} />;
}

/** A line mode: its name, the direction it edits, Done. */
function ModeRow({
  compact,
  route_idx,
  kind,
}: {
  compact: boolean;
  route_idx: number;
  kind: "stops" | "path";
}) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { db } = useExplorer();
  const date = useAppSelector((s) => s.explorer.date);
  const route = useRoutes(db).data?.find((r) => r.route_idx === route_idx);
  const trips = useRouteTrips(db, route, date).data;
  const dayTrips = useMemo(() => (trips ? tripsByPattern(trips.runs) : null), [trips]);
  const name = t(kind === "stops" ? "explorer_action_edit_stops" : "explorer_action_edit_path");
  return (
    <Row label={name}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={ICON_GAP}
        sx={{ color: "primary.main", flexShrink: 0 }}>
        <Icon
          iconName={kind === "stops" ? ICON_NAME.CIRCLE_DOT : ICON_NAME.ROUTE}
          style={{ fontSize: 12 }}
          htmlColor="inherit"
        />
        {!compact && (
          <Typography color="inherit" noWrap sx={LABEL}>
            {name}
          </Typography>
        )}
      </Stack>
      <Separator />
      {route && trips && (
        <DirectionPicker
          route={route}
          directions={trips.directions}
          dayTrips={dayTrips}
          compact={compact}
          below
        />
      )}
      <Box sx={{ flex: 1 }} />
      <ButtonBase
        onClick={() => dispatch(setEditMode(null))}
        sx={{
          height: ITEM_H,
          px: "14px",
          ml: "8px",
          borderRadius: `${ITEM_H / 2}px`,
          bgcolor: "primary.main",
          color: "primary.contrastText",
          flexShrink: 0,
          "&:hover": { bgcolor: "primary.dark" },
        }}>
        <Typography color="inherit" sx={LABEL}>
          {t("done")}
        </Typography>
      </ButtonBase>
    </Row>
  );
}

/** What is selected, and its actions. */
function SelectionRow({ compact }: { compact: boolean }) {
  const { t } = useTranslation("common");
  const selection = useSelectionActions();
  if (!selection) return null;
  return (
    <Row label={t("explorer_selection_actions", { name: selection.name })}>
      {/* A line by its badge, as everywhere else; a stop or trip by name. */}
      {selection.route ? (
        <RouteBadge route={selection.route} small />
      ) : (
        <Typography noWrap sx={{ ...LABEL, maxWidth: 180, flexShrink: 1, minWidth: 0 }}>
          {selection.name}
        </Typography>
      )}
      <Separator />
      {selection.actions.map((a) => (
        <Tooltip key={a.id} title={compact ? a.label : ""}>
          <ButtonBase
            onClick={a.run}
            aria-label={a.label}
            sx={{
              height: ITEM_H,
              px: "10px",
              gap: ICON_GAP,
              flexShrink: 0,
              borderRadius: `${ITEM_H / 2}px`,
              color: "text.secondary",
              "&:hover": { bgcolor: "action.hover", color: "text.primary" },
            }}>
            <Icon iconName={a.icon} style={{ fontSize: 12 }} htmlColor="inherit" />
            {!compact && (
              <Typography color="inherit" noWrap sx={LABEL}>
                {a.label}
              </Typography>
            )}
          </ButtonBase>
        </Tooltip>
      ))}
      {selection.hint && !compact && (
        <Typography noWrap color="text.secondary" sx={{ fontSize: 12, mx: "8px" }}>
          {selection.hint}
        </Typography>
      )}
    </Row>
  );
}

/**
 * A line's own GTFS fields (routes.txt), as a stop's (board 26): edited in
 * its Properties dialog (LinePropertiesDialog), in the Explorer's settings
 * rows, each change a draft the Apply bar applies; a
 * problem said on its field once it was touched. Its ID shown, not edited:
 * trips and other tables name it.
 */
import { ButtonBase, MenuItem, Paper, Stack, TextField, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { type ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import {
  type RouteField,
  type RouteValues,
  routeFieldProblems,
  sameRouteValues,
} from "@/lib/explorer/edit/ops/routes";
import { modeOf } from "@/lib/explorer/modes";
import { setEditDraft } from "@/lib/store/explorer/slice";
import { rgbToHex } from "@/lib/utils/helpers";

import { useDraftEditShown } from "@/hooks/explorer/useDraftEdit";
import { useAgencies, useRouteRecord } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { ArrowPopper } from "@/components/ArrowPoper";
import { useExplorer } from "@/components/explorer/ExplorerContext";
import { ICON_GAP } from "@/components/explorer/SectionHeader";
import { FIELD_SX, OPTION_SX, POPUP_SX, Row } from "@/components/explorer/edit/StopDetails";
import { modeIcon } from "@/components/explorer/modeIcon";
import SingleColorSelector from "@/components/map/panels/style/color/SingleColorSelector";

/** The basic route types, in the order riders meet them most. */
const ROUTE_TYPES = [3, 11, 0, 1, 2, 12, 4, 5, 6, 7];

/** A line's own fields as a form (the line's dialog), each change a draft
 * the Apply bar applies. */
export function RouteDetails({ route_idx }: { route_idx: number }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { db } = useExplorer();
  const query = useRouteRecord(db, route_idx);
  const agencies = useAgencies(db).data ?? [];
  const draft = useAppSelector((s) => s.explorer.edit.draft);
  const edit = useDraftEditShown();
  // A problem is said on its field once it was left or changed.
  const [touched, setTouched] = useState<Set<RouteField>>(() => new Set());
  const record = query.data;
  if (query.error)
    return (
      <Typography variant="body2" color="error" sx={{ mt: 2 }}>
        {query.error}
      </Typography>
    );
  if (!record) return null;

  const { route_idx: _i, route_id, ...saved } = record;
  const values = draft?.kind === "route-details" && draft.route_idx === route_idx ? draft.values : saved;
  // Back where it was: nothing to apply.
  const set = (f: RouteField, next: Partial<RouteValues>) => {
    setTouched((s) => (s.has(f) ? s : new Set(s).add(f)));
    const v = { ...values, ...next };
    dispatch(
      setEditDraft(sameRouteValues(v, saved) ? null : { kind: "route-details", route_idx, values: v })
    );
  };
  const problems = routeFieldProblems(values);
  const refused =
    edit?.draft.kind === "route-details" && edit.built && !edit.built.ok ? edit.built.refused : null;
  const error = (f: RouteField) => {
    const code = touched.has(f)
      ? (problems[f] ?? (refused?.field === f ? refused.code : undefined))
      : undefined;
    return code ? t(`explorer_field_${code}`) : undefined;
  };
  const text = (f: "short_name" | "long_name" | "description", label: string) => (
    <Row label={label}>
      <TextField
        size="small"
        fullWidth
        value={values[f]}
        error={!!error(f)}
        helperText={error(f)}
        onBlur={() => setTouched((s) => new Set(s).add(f))}
        onChange={(e) => set(f, { [f]: e.target.value })}
        inputProps={{ "aria-label": label }}
        sx={FIELD_SX}
      />
    </Row>
  );
  const color = (f: "color" | "text_color", label: string) => (
    <Row label={label}>
      <ColourField
        value={values[f]}
        label={label}
        error={error(f)}
        onBlur={() => setTouched((s) => new Set(s).add(f))}
        onChange={(v) => set(f, { [f]: v })}
      />
    </Row>
  );
  const select = <V extends string | number>(
    label: string,
    value: V,
    options: { value: V; label: string; icon?: ICON_NAME }[],
    onChange: (v: string) => void
  ) => {
    return (
      <Row label={label}>
        <TextField
          select
          size="small"
          fullWidth
          value={value}
          onChange={(e) => onChange(e.target.value)}
          SelectProps={{
            SelectDisplayProps: { "aria-label": label },
            MenuProps: { PaperProps: { sx: POPUP_SX } },
          }}
          sx={FIELD_SX}>
          {options.map((o) => (
            <MenuItem key={String(o.value)} value={o.value} sx={OPTION_SX}>
              <Stack direction="row" alignItems="center" spacing={ICON_GAP} sx={{ minWidth: 0 }}>
                {o.icon && <Icon iconName={o.icon} style={{ fontSize: 12 }} htmlColor="inherit" />}
                <Typography noWrap sx={{ fontSize: "0.8125rem" }}>
                  {o.label}
                </Typography>
              </Stack>
            </MenuItem>
          ))}
        </TextField>
      </Row>
    );
  };
  const typeLabel = (k: number) =>
    k in BASIC_LABELS ? t(`explorer_mode_${modeOf(k)}`) : `${t(`explorer_mode_${modeOf(k)}`)} (${k})`;

  // No section title: the dialog names it. Its fields in three groups set
  // apart by more room than the rows of a group: its names, what runs it,
  // its colours; its ID, which is not edited, last and quiet.
  return (
    <Stack spacing="28px">
      <Stack spacing="16px">
        {text("short_name", t("explorer_line_field_short_name"))}
        {text("long_name", t("explorer_line_field_long_name"))}
        {text("description", t("explorer_line_field_description"))}
      </Stack>
      <Stack spacing="16px">
        {select(
          t("explorer_line_field_mode"),
          values.route_type,
          [...ROUTE_TYPES, ...(ROUTE_TYPES.includes(values.route_type) ? [] : [values.route_type])].map(
            (k) => ({
              value: k,
              label: typeLabel(k),
              icon: modeIcon(modeOf(k)),
            })
          ),
          (v) => set("route_type", { route_type: Number(v) })
        )}
        {/* An agency to choose only where the feed has more than one. */}
        {agencies.length > 1 &&
          select(
            t("explorer_line_field_agency"),
            values.agency_idx,
            agencies.map((a) => ({ value: a.agency_idx, label: a.name ?? String(a.agency_idx) })),
            (v) => set("agency_idx", { agency_idx: Number(v) })
          )}
      </Stack>
      <Stack spacing="16px">
        {color("color", t("explorer_line_field_color"))}
        {color("text_color", t("explorer_line_field_text_color"))}
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-all", lineHeight: 1.5 }}>
        {`${t("explorer_line_field_id")} · ${route_id}`}
      </Typography>
    </Stack>
  );
}

/** The basic types, named by their mode alone. */
const BASIC_LABELS: Record<number, true> = Object.fromEntries(ROUTE_TYPES.map((k) => [k, true]));

/** A colour typed as `RRGGBB`, its swatch at the left once it is one;
 * clicked, GOAT's colour picker, as the map's layer styles have it. The
 * picker opens under the field, beside it in the page, not inside it: inside,
 * its own input would be a second one in the field's FormControl. */
export function ColourField({
  value,
  label,
  error,
  onBlur,
  onChange,
}: {
  value: string;
  label: string;
  error?: string;
  onBlur?: () => void;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hex = value.trim().replace(/^#/, "");
  const valid = /^[0-9A-Fa-f]{6}$/.test(hex);
  return (
    <ArrowPopper
      open={open}
      placement="bottom-start"
      // Above the field where there is no room below it, not over it.
      enableFlip
      arrow={false}
      onClose={() => setOpen(false)}
      content={
        <Paper
          sx={{
            py: 3,
            boxShadow: "rgba(0, 0, 0, 0.16) 0px 6px 12px 0px",
            width: "235px",
            maxHeight: "500px",
          }}>
          <SingleColorSelector
            selectedColor={valid ? `#${hex}` : "#000000"}
            onSelectColor={(rgb) => onChange(rgbToHex(rgb).replace(/^#/, "").toUpperCase())}
          />
        </Paper>
      }>
      <TextField
        size="small"
        fullWidth
        value={value}
        placeholder="RRGGBB"
        error={!!error}
        helperText={error}
        onBlur={onBlur}
        onChange={(e) => onChange(e.target.value)}
        inputProps={{ "aria-label": label }}
        InputProps={{
          startAdornment: (
            <ButtonBase
              aria-label={label}
              onClick={() => setOpen((o) => !o)}
              sx={{
                // Where a dropdown's mark sits; its words where theirs start.
                ml: "10px",
                mr: "-2px",
                width: 16,
                height: 16,
                flexShrink: 0,
                borderRadius: "50%",
                border: 1,
                borderColor: "divider",
                bgcolor: valid ? `#${hex}` : "transparent",
              }}
            />
          ),
        }}
        sx={FIELD_SX}
      />
    </ArrowPopper>
  );
}

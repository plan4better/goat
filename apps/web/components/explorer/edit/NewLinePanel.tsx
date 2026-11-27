/**
 * Draw a new line (1.1), the Route tool's panel: the line's name, mode,
 * agency and colour, as a line's Properties has them; its stops as the
 * Stops tab draws a line, picked on the map in order (or here, nearest the
 * last first), each can be taken off again; then when it runs: the days (a
 * service the feed has), the first and last departure, how often, and the
 * running time end to end, every stop timed by its share of the path. The
 * Apply bar at the panel's foot creates it.
 */
import { Box, IconButton, MenuItem, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { EditDraft, NewLineValues } from "@/lib/explorer/edit/drafts";
import { metres } from "@/lib/explorer/edit/ops/geo";
import { type NewLineField, newLineProblems } from "@/lib/explorer/edit/ops/newLine";
import { modeOf, routeColor } from "@/lib/explorer/modes";
import { setEditDraft } from "@/lib/store/explorer/slice";
import { setMapCursor } from "@/lib/store/map/slice";

import { useDraftEditShown } from "@/hooks/explorer/useDraftEdit";
import {
  type LocationRow,
  useAgencies,
  useLocationsOfType,
  useServices,
} from "@/hooks/explorer/useExplorerData";
import { useAppDispatch } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";
import { RAIL, Rail, StopDot } from "@/components/explorer/LineDiagram";
import { ICON_GAP, PX } from "@/components/explorer/SectionHeader";
import { StopMarker } from "@/components/explorer/StopMarker";
import { ColourField } from "@/components/explorer/edit/RouteDetails";
import {
  DetailsSection,
  FIELD_SX,
  NearestPicker,
  OPTION_SX,
  POPUP_SX,
  Row,
} from "@/components/explorer/edit/StopDetails";
import { modeIcon } from "@/components/explorer/modeIcon";

type Drawing = Extract<EditDraft, { kind: "line-new" }>;

/** The basic route types, in the order riders meet them most. */
const ROUTE_TYPES = [3, 11, 0, 1, 2, 12, 4, 5, 6, 7];

/** A service's weekdays (Mon=1 … Sun=64), as the locale shortens them. */
function weekdays(days: number | null, locale: string): string {
  if (!days) return "";
  const name = (k: number) =>
    new Date(Date.UTC(2024, 0, 1 + k)).toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" });
  return [0, 1, 2, 3, 4, 5, 6]
    .filter((k) => days & (1 << k))
    .map(name)
    .join(", ");
}

export function NewLinePanel({ draft }: { draft: Drawing }) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const { db } = useExplorer();
  const edit = useDraftEditShown();
  const agencies = useAgencies(db).data ?? [];
  const services = useServices(db).data ?? [];
  const stops = useLocationsOfType(db, 0);
  const byIdx = useMemo(() => new Map((stops.data ?? []).map((s) => [s.stop_idx, s])), [stops.data]);
  const [touched, setTouched] = useState<Set<NewLineField>>(() => new Set());
  const values = draft.values;
  const color =
    values.color && /^[0-9A-Fa-f]{6}$/.test(values.color)
      ? `#${values.color}`
      : routeColor(null, modeOf(values.route_type));
  const facts = edit?.building?.kind === "line-new" && edit.built?.ok ? edit.building.built.facts : null;

  // A crosshair: a stop clicked on the map is the next one.
  useEffect(() => {
    dispatch(setMapCursor("crosshair"));
    return () => {
      dispatch(setMapCursor(undefined));
    };
  }, [dispatch]);

  const set = (f: NewLineField, next: Partial<NewLineValues>) => {
    setTouched((s) => (s.has(f) ? s : new Set(s).add(f)));
    dispatch(setEditDraft({ ...draft, values: { ...values, ...next } }));
  };
  const setStops = (next: number[]) => dispatch(setEditDraft({ ...draft, stops: next }));
  const problems = newLineProblems(values);
  const error = (f: NewLineField) =>
    touched.has(f) && problems[f] ? t(`explorer_field_${problems[f]}`) : undefined;
  const leave = (f: NewLineField) => () => setTouched((s) => new Set(s).add(f));

  const from = byIdx.get(draft.stops[draft.stops.length - 1]);
  const away = useCallback(
    (o: LocationRow) =>
      o.lon !== null && o.lat !== null && from?.lon != null && from?.lat != null
        ? metres([o.lon, o.lat], [from.lon, from.lat])
        : null,
    [from]
  );

  const text = (
    f: "short_name" | "long_name" | "first" | "last" | "headway" | "running",
    label: string,
    placeholder?: string
  ) => (
    <Row label={label}>
      <TextField
        size="small"
        fullWidth
        value={values[f]}
        placeholder={placeholder}
        error={!!error(f)}
        helperText={error(f)}
        onBlur={leave(f)}
        onChange={(e) => set(f, { [f]: e.target.value })}
        inputProps={{ "aria-label": label }}
        sx={FIELD_SX}
      />
    </Row>
  );
  const select = (
    label: string,
    value: string | number,
    options: { value: string | number; label: string; icon?: ICON_NAME }[],
    onChange: (v: string) => void,
    f?: NewLineField
  ) => (
    <Row label={label}>
      <TextField
        select
        size="small"
        fullWidth
        value={value}
        error={!!(f && error(f))}
        helperText={f ? error(f) : undefined}
        onBlur={f ? leave(f) : undefined}
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

  return (
    <Stack sx={{ flex: 1, minHeight: 0, overflowY: "auto", pb: 2 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        fontWeight={700}
        display="block"
        sx={{ px: PX, pt: 0.5, pb: 1 }}>
        {t("explorer_new_line")}
      </Typography>
      <Stack spacing="16px" sx={{ px: PX }}>
        {text("short_name", t("explorer_line_field_short_name"))}
        {text("long_name", t("explorer_line_field_long_name"))}
        {select(
          t("explorer_line_field_mode"),
          values.route_type,
          ROUTE_TYPES.map((k) => ({
            value: k,
            label: t(`explorer_mode_${modeOf(k)}`),
            icon: modeIcon(modeOf(k)),
          })),
          (v) => set("route_type", { route_type: Number(v) })
        )}
        {agencies.length > 1 &&
          select(
            t("explorer_line_field_agency"),
            values.agency_idx,
            agencies.map((a) => ({ value: a.agency_idx, label: a.name ?? String(a.agency_idx) })),
            (v) => set("agency_idx", { agency_idx: Number(v) })
          )}
        <Row label={t("explorer_line_field_color")}>
          <ColourField
            value={values.color}
            label={t("explorer_line_field_color")}
            error={error("color")}
            onBlur={leave("color")}
            onChange={(v) => set("color", { color: v })}
          />
        </Row>
      </Stack>

      <DetailsSection icon={ICON_NAME.ROUTE} label={t("explorer_new_line_stops")}>
        <Box sx={{ px: PX }}>
          {draft.stops.map((s, j) => {
            const end = j === 0 || j === draft.stops.length - 1;
            const name = byIdx.get(s)?.name ?? "…";
            return (
              <Stack
                key={`${s}:${j}`}
                direction="row"
                alignItems="center"
                spacing={1.5}
                sx={{ minHeight: 32 }}>
                <Box sx={{ position: "relative", width: RAIL, alignSelf: "stretch", flexShrink: 0 }}>
                  <Rail color={color} top={j > 0} bottom />
                  <StopDot color={color} end={end} />
                </Box>
                <Typography
                  variant="body2"
                  fontWeight={end ? 700 : 500}
                  noWrap
                  title={name}
                  sx={{ flex: 1, minWidth: 0 }}>
                  {name}
                </Typography>
                <Tooltip title={t("explorer_extend_remove")} placement="top">
                  <IconButton
                    size="small"
                    aria-label={t("explorer_extend_remove")}
                    onClick={() => setStops(draft.stops.filter((_, x) => x !== j))}
                    sx={{ color: "text.secondary" }}>
                    <Icon iconName={ICON_NAME.XCLOSE} style={{ fontSize: 11 }} htmlColor="inherit" />
                  </IconButton>
                </Tooltip>
              </Stack>
            );
          })}
          <Stack direction="row" alignItems="center" spacing={1.5} sx={{ minHeight: 32 }}>
            <Box sx={{ position: "relative", width: RAIL, alignSelf: "stretch", flexShrink: 0 }}>
              <Rail color={color} top={draft.stops.length > 0} bottom={false} />
              <StopDot color={theme.palette.primary.main} end={false} />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0, py: 0.5 }}>
              <NearestPicker
                // Empty again for the next stop, once one is added.
                key={draft.stops.length}
                options={stops.data ?? []}
                loading={stops.loading}
                away={away}
                value={null}
                onChange={(s) =>
                  s !== null && s !== draft.stops[draft.stops.length - 1] && setStops([...draft.stops, s])
                }
                mark={<StopMarker size={10} />}
                label={t("explorer_extend_add")}
                placeholder={t("explorer_insert_choose")}
                noOptions={t("explorer_no_stops")}
              />
            </Box>
          </Stack>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
            {t("explorer_new_line_pick")}
          </Typography>
        </Box>
      </DetailsSection>

      <DetailsSection icon={ICON_NAME.CLOCK} label={t("explorer_schedule_tab")}>
        <Stack spacing="16px" sx={{ px: PX }}>
          {select(
            t("explorer_line_field_service"),
            values.service_idx ?? "",
            services.map((s) => ({
              value: s.service_idx,
              label: [s.service_id, weekdays(s.days, i18n.language), t("explorer_trips", { count: s.trips })]
                .filter(Boolean)
                .join(" · "),
            })),
            (v) => set("service_idx", { service_idx: Number(v) }),
            "service_idx"
          )}
          {text("first", t("explorer_line_field_first"), "06:00")}
          {text("last", t("explorer_line_field_last"), "22:00")}
          {text("headway", t("explorer_line_field_headway"))}
          {text("running", t("explorer_line_field_running"))}
          {facts && (
            <Typography variant="caption" color="text.secondary" display="block">
              {t("explorer_new_line_trips", { count: facts.per_direction })}
            </Typography>
          )}
        </Stack>
      </DetailsSection>
    </Stack>
  );
}

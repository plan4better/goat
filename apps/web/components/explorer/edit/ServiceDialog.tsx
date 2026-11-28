/**
 * The service dialog (4.1; decided 25 Nov 2026, in place of board 22's
 * Service tab): a line's service edited in steps, so the edits that change
 * when it runs need no room in the panels.
 *
 * 1. What changes, on the line and one of its directions: its headways
 *    (4.1; per time period, the headway on the Explorer's date with a field
 *    for the new one, a period left empty staying as it is), its span (4.2;
 *    the first and last departure) or its speed (5.2; running times faster
 *    or slower by a percentage, all day or in one period).
 * 2. Service patterns: which of the line's patterns (as the Schedule tab
 *    has them) it changes, picked and let go with a click; the one the
 *    Explorer's date is on to start with. Patterns sharing trips (a service
 *    on both) are picked together, said on each. Headways and span copy
 *    trips, so they need a service common to a group's days; speed changes
 *    the trips there are, so it does not.
 *
 * Preview hands the edit to the Apply bar, where every edit ends; its Edit
 * brings the dialog back with what was set.
 */
import {
  Box,
  Button,
  ButtonBase,
  Checkbox,
  Divider,
  Stack,
  TextField,
  Typography,
  alpha,
} from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { type ServiceDraft, type ServiceTarget, isServiceDraft } from "@/lib/explorer/edit/drafts";
import {
  type DayTypeGroup,
  HEADWAY_MAX,
  HEADWAY_MIN,
  type HeadwayPeriod,
  dayTypeGroups,
  editableGroup,
} from "@/lib/explorer/edit/ops/headway";
import { SPEED_MAX, SPEED_MIN } from "@/lib/explorer/edit/ops/speed";
import { clock, timeOf } from "@/lib/explorer/format";
import { patternColors } from "@/lib/explorer/patternColors";
import { setEditDraft, setServiceDialog } from "@/lib/store/explorer/slice";

import {
  useDirectionServices,
  useRouteCalendar,
  useRouteSummary,
  useRoutes,
} from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { directionItems } from "@/components/explorer/DirectionPicker";
import { useExplorer } from "@/components/explorer/ExplorerContext";
import { PatternRow, dayTypeName } from "@/components/explorer/RouteCalendar";
import { CHECKBOX_SX, ICON_GAP, SectionHeader } from "@/components/explorer/SectionHeader";
import { SegmentedSwitch } from "@/components/explorer/SegmentedSwitch";
import { directionLabel } from "@/components/explorer/directionWords";
import Selector from "@/components/map/panels/common/Selector";

/** Minutes as typed: a whole number in range, else null. */
function minutesOf(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= HEADWAY_MIN && n <= HEADWAY_MAX ? n : null;
}

/** A percentage as typed, signed or not: a whole number in range and not
 * zero, else null. */
function percentOf(text: string): number | null {
  const t = text.trim().replace(/%$/, "").trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return n !== 0 && n >= SPEED_MIN && n <= SPEED_MAX ? n : null;
}

type What = "headway" | "span" | "speed";
const WHAT_OF: Record<ServiceDraft["kind"], What> = {
  "line-headway": "headway",
  "line-span": "span",
  "line-speed": "speed",
};

export function ServiceDialog() {
  const service = useAppSelector((s) => s.explorer.edit.service);
  // Mounted while open only: each opening starts from what it opens on.
  return service ? <Dialog route_idx={service.route_idx} direction={service.direction} /> : null;
}

function Dialog({ route_idx, direction }: { route_idx: number; direction: number | null }) {
  const { t, i18n } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { db, complete, window, dataPeriod, settings } = useExplorer();
  const date = useAppSelector((s) => s.explorer.date) as string;
  const draft = useAppSelector((s) => s.explorer.edit.draft);
  const route = useRoutes(db).data?.find((r) => r.route_idx === route_idx);
  // The headways now, as the Overview counts them.
  const summary = useRouteSummary(complete ? db : undefined, route, date, dataPeriod ?? window, settings);
  // The patterns, as the Schedule tab has them.
  // Asked once the line is known: asked before, with no trips, its empty
  // answer would be remembered under the line's key.
  const calendar = useRouteCalendar(
    route ? db : undefined,
    route ?? { trip_lo: null, trip_hi: null },
    `route:${route_idx}`,
    window
  );
  // Reopened from the Apply bar: what was set.
  const before = isServiceDraft(draft) && draft.route_idx === route_idx ? draft : null;
  const [what, setWhat] = useState<What>(before ? WHAT_OF[before.kind] : "headway");

  const directions = summary.data?.directions ?? [];
  const directionChoices = route
    ? directionItems(
        directions.map((d) => d.direction),
        route,
        t,
        null
      ).filter((it) => String(it.value).endsWith(":"))
    : [];
  const [dirKey, setDirKey] = useState<number | null>(before?.direction.key ?? direction);
  const shown = directions.find((d) => d.direction.key === dirKey) ?? directions[0];
  const patterns = useMemo(() => shown?.direction.patterns.map((p) => p.pattern_idx) ?? [], [shown]);
  const services = useDirectionServices(db, route_idx, patterns).data;

  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState<Record<string, string>>(
    Object.fromEntries(
      (before?.kind === "line-headway" ? before.periods : []).map((p) => [p.key, String(p.minutes)])
    )
  );
  // Span: the first and last departure as typed; empty stays as it is.
  const spanBefore = before?.kind === "line-span" ? before.span : null;
  const [firstText, setFirstText] = useState(spanBefore?.first_s == null ? "" : clock(spanBefore.first_s));
  const [lastText, setLastText] = useState(spanBefore?.last_s == null ? "" : clock(spanBefore.last_s));
  const first_s = timeOf(firstText);
  const last_s = timeOf(lastText);
  const spanBad = (!!firstText.trim() && first_s === null) || (!!lastText.trim() && last_s === null);
  const spanOrder = first_s !== null && last_s !== null && last_s < first_s;
  // Speed: the percentage, and the period it applies in (all day: "").
  const speedBefore = before?.kind === "line-speed" ? before : null;
  const [percentText, setPercentText] = useState(
    speedBefore ? `${speedBefore.percent > 0 ? "+" : ""}${speedBefore.percent}` : ""
  );
  const [periodKey, setPeriodKey] = useState(speedBefore?.period?.key ?? "");
  const periodItems = [
    { value: "", label: t("explorer_speed_all_day") },
    ...settings.periods.map((p) => ({
      value: p.key,
      label: `${t(`explorer_period_${p.key}`)} · ${clock(p.start_s)}–${clock(p.end_s)}`,
    })),
  ];
  const percent = percentOf(percentText);
  const percentBad = !!percentText.trim() && percent === null;
  const changed: HeadwayPeriod[] = settings.periods.flatMap((p) => {
    const m = minutesOf(typed[p.key] ?? "");
    return m === null ? [] : [{ key: p.key, start_s: p.start_s, end_s: p.end_s, minutes: m }];
  });
  const invalid = settings.periods.some((p) => (typed[p.key] ?? "").trim() && !minutesOf(typed[p.key]));

  const types = useMemo(() => calendar.data?.types ?? [], [calendar.data]);
  const colors = useMemo(() => patternColors(types), [types]);
  const groups = useMemo(
    () => (calendar.data && services ? dayTypeGroups(types, calendar.data.days, services) : []),
    [calendar.data, services, types]
  );
  const groupOf = (key: string) => groups.find((g) => g.types.includes(key));
  // Days the line runs at all, as the Schedule tab counts its service period.
  const runningDays = useMemo(() => (calendar.data?.days ?? []).filter((d) => d.key).length, [calendar.data]);
  const [picked, setPicked] = useState<Set<string> | null>(
    before ? new Set(before.groups.flatMap((g) => g.types)) : null
  );
  // Speed changes the trips there are: any group that runs will do.
  const usableGroup = (g: DayTypeGroup) => g.services.length > 0 && (what === "speed" || editableGroup(g));
  // To start with: the patterns the Explorer's date is on, where they can be
  // changed.
  const onDate = groups.find((g) => g.days.includes(date));
  const chosen = picked ?? new Set(onDate && usableGroup(onDate) ? onDate.types : []);
  const toggle = (g: DayTypeGroup) => {
    const next = new Set(chosen);
    const on = g.types.every((k) => next.has(k));
    for (const k of g.types)
      if (on) next.delete(k);
      else next.add(k);
    setPicked(next);
  };
  const chosenGroups = groups.filter((g) => g.types.every((k) => chosen.has(k)) && usableGroup(g));
  const nameOf = (key: string) => {
    const ty = types.find((x) => x.key === key);
    return ty ? dayTypeName(ty, i18n.language, t) : key;
  };

  const close = () => dispatch(setServiceDialog(null));
  const preview = () => {
    if (!shown || !route) return;
    const target: ServiceTarget = {
      route_idx,
      direction: { key: shown.direction.key, name: directionLabel(shown.direction.name, t) },
      patterns,
      groups: chosenGroups,
      group_names: chosenGroups.map((g) => g.types.map(nameOf).join(", ")),
      date,
    };
    const period = settings.periods.find((p) => p.key === periodKey);
    dispatch(
      setEditDraft(
        what === "headway"
          ? { kind: "line-headway", periods: changed, ...target }
          : what === "span"
            ? { kind: "line-span", span: { first_s, last_s }, ...target }
            : {
                kind: "line-speed",
                percent: percent ?? 0,
                period: period ? { key: period.key, start_s: period.start_s, end_s: period.end_s } : null,
                ...target,
              }
      )
    );
    close();
  };

  const ready =
    what === "headway"
      ? changed.length > 0 && !invalid
      : what === "span"
        ? (first_s !== null || last_s !== null) && !spanBad && !spanOrder
        : percent !== null;
  const ops = shown?.operations;

  const lineName = route ? route.short_name || route.long_name || route.route_id : "";
  return (
    <AppDialog
      open
      onClose={close}
      icon={ICON_NAME.CLOCK}
      title={t("explorer_service_title", { line: lineName, interpolation: { escapeValue: false } })}
      maxWidth={560}
      footer={
        <AppDialogFooter
          extra={
            step === 2 ? (
              <Button
                variant="text"
                color="inherit"
                onClick={() => setStep(1)}
                sx={{ color: "text.secondary" }}>
                <Typography variant="body2" fontWeight="bold" color="inherit">
                  {t("back")}
                </Typography>
              </Button>
            ) : undefined
          }
          cancelLabel={t("cancel")}
          onCancel={close}
          primaryLabel={step === 1 ? t("next") : t("explorer_preview")}
          primaryDisabled={step === 1 ? !ready || !shown : !chosenGroups.length}
          onPrimary={step === 1 ? () => setStep(2) : preview}
        />
      }>
      {step === 1 ? (
        <Stack spacing={1.5}>
          {route && (
            // GOAT's own selector, as the Stops tab's: each direction with the
            // line's badge (its variants are not edited apart).
            <Selector
              label={t("explorer_direction")}
              items={directionChoices}
              selectedItems={directionChoices.find((it) => it.value === `${shown?.direction.key}:`)}
              setSelectedItems={(item) => {
                if (!item || Array.isArray(item)) return;
                setDirKey(Number(String(item.value).split(":")[0]));
                setPicked(null);
              }}
            />
          )}
          {/* As the network assumptions' switch: as wide as its options, not
              the dialog, with room above and below. */}
          <Box sx={{ alignSelf: "flex-start", py: 1 }}>
            <SegmentedSwitch<What>
              label={t("explorer_service_what")}
              value={what}
              onChange={setWhat}
              options={[
                { value: "headway", label: t("explorer_service_tab_headway"), icon: ICON_NAME.CLOCK },
                { value: "span", label: t("explorer_service_tab_span"), icon: ICON_NAME.CALENDAR },
                { value: "speed", label: t("explorer_service_tab_speed"), icon: ICON_NAME.BUS },
              ]}
            />
          </Box>
          {what === "span" && (
            <SpanFields
              rows={[
                {
                  key: "first",
                  label: t("explorer_first_departure"),
                  now: ops?.first_dep_s ?? null,
                  text: firstText,
                  set: setFirstText,
                  bad: !!firstText.trim() && first_s === null,
                },
                {
                  key: "last",
                  label: t("explorer_last_departure"),
                  now: ops?.last_dep_s ?? null,
                  text: lastText,
                  set: setLastText,
                  bad: !!lastText.trim() && last_s === null,
                },
              ]}
              // Said only when a time typed is wrong.
              problem={
                spanBad
                  ? t("explorer_service_time_hint")
                  : spanOrder
                    ? t("explorer_check_goat_span_order")
                    : null
              }
            />
          )}
          {what === "speed" && (
            <Stack spacing={1.5}>
              <Stack direction="row" alignItems="center" spacing={2}>
                <Typography variant="body2" fontWeight={600} sx={{ flex: 1 }}>
                  {t("explorer_speed_change")}
                </Typography>
                <TextField
                  size="small"
                  value={percentText}
                  placeholder="+10"
                  error={percentBad}
                  onChange={(e) => setPercentText(e.target.value)}
                  inputProps={{
                    "aria-label": t("explorer_speed_change"),
                    inputMode: "numeric",
                    style: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
                  }}
                  InputProps={{
                    endAdornment: (
                      <Typography variant="caption" color="text.secondary" sx={{ pl: 0.5 }}>
                        %
                      </Typography>
                    ),
                  }}
                  sx={{ width: 96 }}
                />
              </Stack>
              <Selector
                label={t("explorer_speed_period")}
                items={periodItems}
                // The option as listed, its times too.
                selectedItems={periodItems.find((it) => it.value === periodKey) ?? periodItems[0]}
                setSelectedItems={(item) => {
                  if (!item || Array.isArray(item)) return;
                  setPeriodKey(String(item.value));
                }}
              />
              {/* Said only when the percentage typed is out of range. */}
              {percentBad && (
                <Typography variant="caption" color="error">
                  {t("explorer_check_goat_speed_out_of_range", { min: SPEED_MIN, max: SPEED_MAX })}
                </Typography>
              )}
            </Stack>
          )}
          {what === "headway" && (
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto auto",
                columnGap: 2,
                alignItems: "center",
              }}>
              {[t("explorer_col_time_period"), t("explorer_service_now"), t("explorer_service_new")].map(
                (h, i) => (
                  <Typography
                    key={h}
                    variant="caption"
                    color="text.secondary"
                    fontWeight={600}
                    sx={{ py: 1, textAlign: i ? "right" : "left" }}>
                    {h}
                  </Typography>
                )
              )}
              {settings.periods.map((p) => {
                const h = shown?.headways.get(p.key);
                const now =
                  !h || h.departures === 0
                    ? "–"
                    : h.minutes === null
                      ? t("explorer_one_trip")
                      : `${h.minutes}′`;
                const text = typed[p.key] ?? "";
                const bad = !!text.trim() && minutesOf(text) === null;
                const rule = { borderTop: 1, borderColor: "divider", py: 0.75, alignSelf: "stretch" };
                return (
                  <Box key={p.key} sx={{ display: "contents" }}>
                    <Box sx={rule}>
                      <Typography variant="body2" fontWeight={600} noWrap>
                        {t(`explorer_period_${p.key}`)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" display="block" noWrap>
                        {`${clock(p.start_s)}–${clock(p.end_s)}`}
                      </Typography>
                    </Box>
                    <Box sx={{ ...rule, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                      <Typography
                        variant="body2"
                        color={now === "–" ? "text.secondary" : "text.primary"}
                        sx={{ fontVariantNumeric: "tabular-nums" }}>
                        {now}
                      </Typography>
                    </Box>
                    <Box sx={{ ...rule, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                      <TextField
                        size="small"
                        value={text}
                        placeholder="–"
                        error={bad}
                        onChange={(e) => setTyped((s) => ({ ...s, [p.key]: e.target.value }))}
                        inputProps={{
                          "aria-label": t(`explorer_period_${p.key}`),
                          inputMode: "numeric",
                          style: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
                        }}
                        InputProps={{
                          endAdornment: (
                            <Typography variant="caption" color="text.secondary" sx={{ pl: 0.5 }}>
                              {t("explorer_minutes_short")}
                            </Typography>
                          ),
                        }}
                        sx={{ width: 96 }}
                      />
                    </Box>
                  </Box>
                );
              })}
            </Box>
          )}
          {/* Said only when a headway typed is out of range. */}
          {what === "headway" && invalid && (
            <Typography variant="caption" color="error">
              {t("explorer_check_goat_headway_out_of_range", { min: HEADWAY_MIN, max: HEADWAY_MAX })}
            </Typography>
          )}
        </Stack>
      ) : !calendar.data || !services ? (
        // The line's day types are worked out over the feed's whole window.
        <Typography variant="body2" color="text.secondary">
          {t("explorer_calculating")}
        </Typography>
      ) : (
        // As the Schedule tab lists them: a heading, then each day type as
        // its row there (swatch, name, facts, week), on dividers. What is
        // picked is a group: day types sharing trips go under one box.
        <>
          {/* The header's own 40 px row, less the room it keeps above its
              title: the dialog's padding is room enough at the top. */}
          <Box sx={{ mt: -1.25 }}>
            <SectionHeader
              px={0}
              icon={ICON_NAME.CLOCK}
              label={t("explorer_service_pattern_heading", { count: types.length })}
            />
          </Box>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
            {t("explorer_service_step_patterns")}
          </Typography>
          <Stack divider={<Divider flexItem />}>
            {types.flatMap((ty) => {
              const g = groupOf(ty.key);
              // A group once, at its first day type.
              if (g && g.types[0] !== ty.key) return [];
              const members = g ? g.types : [ty.key];
              const runs = !!g && g.services.length > 0;
              const usable = runs && !!g && usableGroup(g);
              const on = usable && members.every((k) => chosen.has(k));
              const note = !runs
                ? t("explorer_service_pattern_not_run")
                : !usable
                  ? t("explorer_check_goat_headway_no_common_service")
                  : members.length > 1
                    ? t("explorer_service_pattern_shares")
                    : null;
              return [
                <ButtonBase
                  key={ty.key}
                  disabled={!usable}
                  onClick={() => g && toggle(g)}
                  role="checkbox"
                  aria-checked={on}
                  sx={{
                    display: "flex",
                    alignItems: "flex-start",
                    textAlign: "left",
                    // From the box to the row's swatch, as from an icon to text.
                    gap: ICON_GAP,
                    py: 0.5,
                    // Room either side, so the ground reaches past the box
                    // and the week row.
                    px: 2,
                    my: 0.5,
                    // Picked: on a pale ground in the theme's green.
                    borderRadius: 1.5,
                    bgcolor: (theme) => (on ? alpha(theme.palette.primary.main, 0.08) : "transparent"),
                    "&:hover": {
                      bgcolor: (theme) =>
                        on ? alpha(theme.palette.primary.main, 0.12) : theme.palette.action.hover,
                    },
                    "&.Mui-disabled": { opacity: 0.5 },
                  }}>
                  <Checkbox
                    size="small"
                    checked={on}
                    disabled={!usable}
                    tabIndex={-1}
                    disableRipple
                    // Centred on the day type's name, the row's first line.
                    sx={{ ...CHECKBOX_SX, mt: 1 }}
                  />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    {members.map((k) => {
                      const at = types.findIndex((x) => x.key === k);
                      return (
                        <PatternRow
                          key={k}
                          type={types[at]}
                          color={colors[at]}
                          of="line"
                          period={{ days: runningDays }}
                        />
                      );
                    })}
                    {note && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        display="block"
                        sx={{ pb: 1, lineHeight: 1.45 }}>
                        {note}
                      </Typography>
                    )}
                  </Box>
                </ButtonBase>,
              ];
            })}
          </Stack>
        </>
      )}
    </AppDialog>
  );
}

/** The span's two rows, as the headways' table has its periods: what it is
 * now, and a field for the new time. */
function SpanFields({
  rows,
  problem,
}: {
  rows: {
    key: string;
    label: string;
    now: number | null;
    text: string;
    set: (text: string) => void;
    bad: boolean;
  }[];
  problem: string | null;
}) {
  const { t } = useTranslation("common");
  const rule = { borderTop: 1, borderColor: "divider", py: 0.75, alignSelf: "stretch" };
  return (
    <>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto auto",
          columnGap: 2,
          alignItems: "center",
        }}>
        {["", t("explorer_service_now"), t("explorer_service_new")].map((h, i) => (
          <Typography
            key={i}
            variant="caption"
            color="text.secondary"
            fontWeight={600}
            sx={{ py: 1, textAlign: i ? "right" : "left" }}>
            {h}
          </Typography>
        ))}
        {rows.map((r) => (
          <Box key={r.key} sx={{ display: "contents" }}>
            <Box sx={{ ...rule, display: "flex", alignItems: "center" }}>
              <Typography variant="body2" fontWeight={600} noWrap>
                {r.label}
              </Typography>
            </Box>
            <Box sx={{ ...rule, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
              <Typography
                variant="body2"
                color={r.now === null ? "text.secondary" : "text.primary"}
                sx={{ fontVariantNumeric: "tabular-nums" }}>
                {r.now === null ? "–" : clock(r.now)}
              </Typography>
            </Box>
            <Box sx={{ ...rule, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
              <TextField
                size="small"
                value={r.text}
                placeholder="–"
                error={r.bad}
                onChange={(e) => r.set(e.target.value)}
                inputProps={{
                  "aria-label": r.label,
                  style: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
                }}
                sx={{ width: 96 }}
              />
            </Box>
          </Box>
        ))}
      </Box>
      {problem && (
        <Typography variant="caption" color="error">
          {problem}
        </Typography>
      )}
    </>
  );
}

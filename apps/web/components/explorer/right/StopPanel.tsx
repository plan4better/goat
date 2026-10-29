/**
 * A stop's timetable in the right panel (board 13) — a station's, when a
 * station is picked in the list, is that of all its stops together. The
 * stop, the Explorer's date, its lines to pick one from, and either that
 * line's hour × minute timetable per direction — the next departure after
 * the playback time highlighted; short turns not set apart (an "s" was
 * tried and dropped, 22 Oct 2026: unclear, and little use here) — or the next
 * departures of every line. A departure opens its trip, which goes back here.
 */
import AccessibleIcon from "@mui/icons-material/Accessible";
import { Box, ButtonBase, Skeleton, Stack, Typography } from "@mui/material";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { Direction } from "@/lib/explorer/derive/directions";
import {
  type Departure,
  type TimetableDirection,
  type TimetableEntry,
  byDirection,
  byHour,
} from "@/lib/explorer/derive/stopTimetable";
import { resolveChoice } from "@/lib/explorer/directionChoice";
import { clock } from "@/lib/explorer/format";
import {
  type ExplorerPickedStop,
  openExplorerPanel,
  pickExplorerPattern,
  selectExplorerRoute,
} from "@/lib/store/explorer/slice";

import { type RouteRow, useRoutes, useStopTimetable } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";
import { RouteBadge, distinctLines, lineKey } from "@/components/explorer/RouteBadge";
import { DateChip, PX, SectionHeader } from "@/components/explorer/SectionHeader";
import { SegmentedSwitch } from "@/components/explorer/SegmentedSwitch";
import { platformLabel } from "@/components/explorer/StationsList";
import { StopMarker } from "@/components/explorer/StopMarker";
import { directionLabel } from "@/components/explorer/directionWords";
import { PanelKind } from "@/components/explorer/right/PanelKind";
import { usePlaybackMinute } from "@/components/explorer/right/usePlaybackMinute";

type View = "timetable" | "next";

/** How many departures the Next view lists. */
const NEXT_COUNT = 12;
/** One text line of the meta row, as the route summary's. */
const META_LINE = "18px";

/** An hour of the service day as a timetable heads it: 24 is 00 again. */
const hourLabel = (hour: number) => String(hour % 24).padStart(2, "0");
const minute = (sec: number) => String(Math.floor((sec % 3600) / 60)).padStart(2, "0");

/** What an untimed call's window is, in words: the feed's times at the
 * timed stops either side, never a time between them. */
function untimedTitle(
  e: { dep_s: number; until_s: number | null; from_stop: string | null; until_stop: string | null },
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  return t("explorer_untimed_call", {
    from: clock(e.dep_s),
    fromStop: e.from_stop ?? "",
    until: e.until_s === null ? "–" : clock(e.until_s),
    untilStop: e.until_stop ?? "",
    interpolation: { escapeValue: false },
  });
}

/** A segmented switch on the panel's tinted ground, as the bottom bar's speed. */
function ViewSwitch({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  const { t } = useTranslation("common");
  return (
    <SegmentedSwitch
      options={(["timetable", "next"] as const).map((v) => ({
        value: v,
        label: t(`explorer_stop_view_${v}`),
        icon: v === "timetable" ? ICON_NAME.TABLE : ICON_NAME.CLOCK,
      }))}
      value={value}
      onChange={onChange}
    />
  );
}

/** A row of choices beside a quiet label. */
function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack direction="row" alignItems="flex-start" spacing={1} sx={{ mt: 1.25 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        fontWeight={600}
        sx={{ width: 40, flexShrink: 0, lineHeight: "24px" }}>
        {label}
      </Typography>
      <Stack
        direction="row"
        useFlexGap
        flexWrap="wrap"
        alignItems="center"
        columnGap={1.75}
        rowGap={1.25}
        sx={{ flex: 1, minWidth: 0, pt: "3px", px: "4px" }}>
        {children}
      </Stack>
    </Stack>
  );
}

/** A line to pick: its badge as it is everywhere, the chosen one haloed in
 * the theme's colour. */
function LineChoice({ route, chosen, onClick }: { route: RouteRow; chosen: boolean; onClick: () => void }) {
  return (
    <ButtonBase
      onClick={onClick}
      aria-pressed={chosen}
      sx={(theme) => ({
        // The badge's own corners; the halo a little clear of them, the gap
        // showing the panel's own ground.
        borderRadius: 0.75,
        outline: chosen ? `2px solid ${theme.palette.primary.main}` : "none",
        outlineOffset: "2px",
        "&:hover": { opacity: chosen ? 1 : 0.8 },
      })}>
      <RouteBadge route={route} small />
    </ButtonBase>
  );
}

export function StopPanel({ stop }: { stop: ExplorerPickedStop }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { db, complete } = useExplorer();
  const date = useAppSelector((s) => s.explorer.date);
  const now = usePlaybackMinute();
  const routes = useRoutes(db);
  const data = useStopTimetable(complete ? db : undefined, stop.stop_idx, date);
  const [view, setView] = useState<View>("timetable");
  const [picked, setPicked] = useState<string | null>(null);

  const routeByIdx = useMemo(() => new Map((routes.data ?? []).map((r) => [r.route_idx, r])), [routes.data]);
  const departures = useMemo(() => data.data?.departures ?? [], [data.data]);
  // The lines leaving here on the date, in the route list's order. A feed
  // may run one line as several routes (per operator, per variant): riders
  // know one line, so its routes' departures go together.
  const lines = useMemo(() => {
    const idxs = new Set(departures.map((d) => d.route_idx));
    const byKey = new Map<string, { route: RouteRow; idxs: Set<number> }>();
    for (const r of routes.data ?? []) {
      if (!idxs.has(r.route_idx)) continue;
      const line = byKey.get(lineKey(r));
      if (line) line.idxs.add(r.route_idx);
      else byKey.set(lineKey(r), { route: r, idxs: new Set([r.route_idx]) });
    }
    return [...byKey.values()];
  }, [departures, routes.data]);
  // The line shown first: the route the stop was opened from — its Stops
  // tab, or its stop on the map — or the route selected, where it leaves
  // from here; else the first.
  const preferred = useAppSelector((s) => s.explorer.panel.fromRoute ?? s.explorer.selectedRouteId);
  const line =
    lines.find((l) => lineKey(l.route) === picked) ??
    lines.find((l) => [...l.idxs].some((i) => routeByIdx.get(i)?.route_id === preferred)) ??
    lines[0];
  // Its directions, those of its routes with the same name taken as one.
  // On the selected route's line, the direction picked for the route (the
  // strip's and the Stops tab's) is the one shown — all, when all are.
  const selectedRouteId = useAppSelector((s) => s.explorer.selectedRouteId);
  const selectedIdx = (routes.data ?? []).find((r) => r.route_id === selectedRouteId)?.route_idx;
  const choice = useAppSelector((s) => s.explorer.pattern);
  const directions = useMemo(() => {
    if (!line || !data.data) return [];
    const merged = new Map<string, TimetableDirection & { sources: Set<string> }>();
    for (const idx of line.idxs)
      for (const d of byDirection(
        departures.filter((x) => x.route_idx === idx),
        data.data.directions.get(idx) ?? []
      )) {
        const key = `${d.name.kind}|${d.name.place}|${d.name.via ?? ""}`;
        const into = merged.get(key);
        if (into) {
          into.departures.push(...d.departures);
          into.sources.add(`${idx}:${d.key}`);
        } else
          merged.set(key, {
            ...d,
            key,
            departures: [...d.departures],
            sources: new Set([`${idx}:${d.key}`]),
          });
      }
    for (const d of merged.values()) d.departures.sort((x, y) => x.dep_s - y.dep_s);
    const all = [...merged.values()];
    if (selectedIdx === undefined || !line.idxs.has(selectedIdx)) return all;
    const picked = resolveChoice(choice, data.data.directions.get(selectedIdx) ?? []);
    if (!picked.direction) return all;
    const source = `${selectedIdx}:${picked.direction.key}`;
    return all
      .filter((d) => d.sources.has(source))
      .map((d) =>
        picked.pattern_idx === null
          ? d
          : { ...d, departures: d.departures.filter((x) => x.pattern_idx === picked.pattern_idx) }
      );
  }, [line, departures, data.data, selectedIdx, choice]);

  const openTrip = (e: { trip_idx: number; run_dep_s: number }) =>
    dispatch(
      openExplorerPanel({ item: { kind: "trip", trip_idx: e.trip_idx, run_dep_s: e.run_dep_s }, push: true })
    );
  // Named as riders know it: by its station, the stop told apart by its
  // platform where the feed names one.
  const detail = data.data?.stop;
  const station = detail?.is_station ?? false;
  const title = detail?.station ?? detail?.name ?? stop.name;
  // A station; one of a station's platforms; else a stop of its own.
  const kind = station ? "station" : detail?.station ? "platform" : "stop";
  // The platform's own code or name, where it has one: the kind is said above.
  const own = detail?.station ? platformLabel({ name: detail.station }, detail, t).label : null;
  const meta = [
    own !== t("explorer_platform_unnamed") ? own : null,
    // A station counts its platforms: the stops it is made of.
    station && detail ? t("explorer_platforms", { count: detail.n_stops }) : null,
    detail
      ? t("explorer_lines_count", {
          count: distinctLines(detail.routes.map((i) => routeByIdx.get(i))).length,
        })
      : null,
  ].filter(Boolean);

  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Box sx={{ px: PX, pt: 0.5, pb: 1.5 }}>
        <PanelKind kind={kind} />
        <Stack direction="row" spacing={1.25} alignItems="center">
          <StopMarker station={station} />
          <Typography variant="h6" fontWeight="bold" noWrap sx={{ fontSize: 17 }} title={title}>
            {title}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.75, color: "text.secondary" }}>
          <Typography variant="caption" sx={{ lineHeight: META_LINE }}>
            {meta.join(" · ")}
          </Typography>
          {detail?.wheelchair === 1 && (
            <AccessibleIcon sx={{ fontSize: 15 }} titleAccess={t("explorer_wheelchair_boarding")} />
          )}
        </Stack>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 1.5 }}>
          {date && <DateChip date={date} />}
          <Box sx={{ flex: 1 }} />
          <ViewSwitch value={view} onChange={setView} />
        </Stack>
        {view === "timetable" && lines.length > 1 && (
          <ChipRow label={t("explorer_lines")}>
            {lines.map(({ route: r }) => (
              <LineChoice
                key={r.route_idx}
                route={r}
                chosen={r.route_idx === line?.route.route_idx}
                onClick={() => setPicked(lineKey(r))}
              />
            ))}
          </ChipRow>
        )}
      </Box>
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          px: PX,
          pb: 2,
          borderTop: 1,
          borderColor: "divider",
        }}>
        {!data.data && !data.error && <Skeleton variant="rounded" height={240} sx={{ mt: 1.5 }} />}
        {data.error && (
          <Typography variant="body2" color="error" sx={{ mt: 2 }}>
            {data.error}
          </Typography>
        )}
        {data.data && !departures.length && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            {t("explorer_no_departures")}
          </Typography>
        )}
        {data.data && view === "timetable" && line && (
          <Timetable route={line.route} directions={directions} now={now} onOpen={openTrip} />
        )}
        {data.data && view === "next" && departures.length > 0 && (
          <NextDepartures
            departures={departures}
            directions={data.data.directions}
            routeByIdx={routeByIdx}
            now={now}
            onOpen={openTrip}
          />
        )}
      </Box>
    </Stack>
  );
}

/** A line's departures per direction: hour rows of minutes on the panel's
 * tinted ground, as the Overview's headways table. */
function Timetable({
  route,
  directions,
  now,
  onOpen,
}: {
  route: RouteRow;
  /** With where each came from, `${route_idx}:${direction key}`. */
  directions: (TimetableDirection & { sources?: Set<string> })[];
  now: number | null;
  onOpen: (e: TimetableEntry) => void;
}) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  return (
    <>
      {directions.map((d) => {
        // The next departure after the playback time, marked in the grid.
        const next = now === null ? null : d.departures.find((e) => e.dep_s >= now);
        const hours = byHour(d.departures);
        return (
          <Box key={d.key} sx={{ mt: 1 }}>
            {/* The heading is the way from a stop to its line: the line's
                summary, in the direction whose departures these are. */}
            <ButtonBase
              onClick={() => {
                dispatch(selectExplorerRoute(route.route_id));
                const from = [...(d.sources ?? [])].find((x) => x.startsWith(`${route.route_idx}:`));
                const key = Number(from?.split(":")[1]);
                if (Number.isInteger(key))
                  dispatch(pickExplorerPattern({ direction: key, pattern_idx: null }));
              }}
              title={t("explorer_open_line")}
              sx={{
                display: "block",
                width: "100%",
                textAlign: "left",
                borderRadius: 1,
                "&:hover": { bgcolor: "action.hover" },
              }}>
              <SectionHeader
                px={0}
                icon={<RouteBadge route={route} small />}
                // No count beside it: departures, trips or calls, it read as
                // any of them (dropped 22 Oct 2026).
                label={directionLabel(d.name, t)}
              />
            </ButtonBase>
            {/* Said under the line's heading where any of its departures here
                are a window, not a time. */}
            {d.departures.some((e) => e.untimed) && (
              // Laid out as the heading above: the pill in the badge's column,
              // the words where the heading's start.
              <Stack direction="row" spacing={1.25} alignItems="flex-start" sx={{ mb: 1.5 }}>
                {/* A window's pill, as the grid draws one, centred on the
                    note's first line. */}
                <Box
                  aria-hidden
                  sx={{ width: 28, height: "17.4px", flexShrink: 0, display: "flex", alignItems: "center" }}>
                  <Box
                    sx={{
                      width: 28,
                      height: 12,
                      borderRadius: "6px",
                      border: "1px dotted",
                      borderColor: "text.disabled",
                    }}
                  />
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.45 }}>
                  {t("explorer_untimed_line_note")}
                </Typography>
              </Stack>
            )}
            <Box sx={{ bgcolor: "action.hover", borderRadius: 1.5, px: 1.5, py: 0.5 }}>
              {hours.map(({ hour, entries }, i) => (
                <Stack
                  key={hour}
                  direction="row"
                  alignItems="flex-start"
                  sx={{
                    py: 0.5,
                    borderBottom: i < hours.length - 1 ? 1 : 0,
                    borderColor: "divider",
                  }}>
                  <Typography
                    variant="body2"
                    fontWeight="bold"
                    sx={{ width: 30, flexShrink: 0, lineHeight: "24px", fontVariantNumeric: "tabular-nums" }}>
                    {hourLabel(hour)}
                  </Typography>
                  <Stack direction="row" flexWrap="wrap" sx={{ flex: 1 }}>
                    {entries.map((e) => {
                      const isNext = e === next;
                      return (
                        <ButtonBase
                          // A run can call twice, at a loop's stop or at two
                          // of a station's platforms: the call, not the run.
                          key={`${e.trip_idx}:${e.run_dep_s}:${e.stop_idx}:${e.dep_s}`}
                          onClick={() => onOpen(e)}
                          title={e.untimed ? untimedTitle(e, t) : clock(e.dep_s)}
                          sx={{
                            minWidth: 32,
                            height: 24,
                            // A window's pill has room inside its outline, and
                            // apart from its neighbours'.
                            px: e.untimed ? 1.5 : 0.5,
                            mx: e.untimed ? 0.25 : 0,
                            my: e.untimed ? 0.25 : 0,
                            borderRadius: "12px",
                            fontSize: 13,
                            fontVariantNumeric: "tabular-nums",
                            fontWeight: isNext ? 700 : 500,
                            // Untimed in the feed: its window, in grey, dotted
                            // round, in the hour it starts.
                            border: e.untimed && !isNext ? "1px dotted" : "1px solid transparent",
                            borderColor: e.untimed && !isNext ? "text.disabled" : "transparent",
                            color: isNext
                              ? "primary.contrastText"
                              : e.untimed
                                ? "text.secondary"
                                : "text.primary",
                            bgcolor: isNext ? "primary.main" : "transparent",
                            "&:hover": { bgcolor: isNext ? "primary.dark" : "action.selected" },
                          }}>
                          {minute(e.dep_s)}
                          {e.untimed && e.until_s !== null && `-${minute(e.until_s)}`}
                        </ButtonBase>
                      );
                    })}
                  </Stack>
                </Stack>
              ))}
            </Box>
          </Box>
        );
      })}
    </>
  );
}

/** The next departures of every line from the playback time on. */
function NextDepartures({
  departures,
  directions,
  routeByIdx,
  now,
  onOpen,
}: {
  departures: Departure[];
  directions: Map<number, Direction[]>;
  routeByIdx: Map<number, RouteRow>;
  now: number | null;
  onOpen: (e: { trip_idx: number; run_dep_s: number }) => void;
}) {
  const { t } = useTranslation("common");
  const from = now ?? 0;
  const upcoming = departures.filter((d) => d.dep_s >= from).slice(0, NEXT_COUNT);
  if (!upcoming.length)
    return (
      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        {t("explorer_no_more_departures")}
      </Typography>
    );
  return (
    <>
      <Box sx={{ mt: 1.5, bgcolor: "action.hover", borderRadius: 1.5, py: 0.5 }}>
        {upcoming.map((d, i) => {
          const route = routeByIdx.get(d.route_idx);
          const pattern = (directions.get(d.route_idx) ?? [])
            .flatMap((x) => x.patterns)
            .find((p) => p.pattern_idx === d.pattern_idx);
          const wait = Math.floor((d.dep_s - from) / 60);
          return (
            <ButtonBase
              key={`${d.trip_idx}:${d.run_dep_s}:${d.stop_idx}:${d.dep_s}`}
              onClick={() => onOpen(d)}
              sx={{
                width: "100%",
                justifyContent: "flex-start",
                gap: 1.25,
                minHeight: 36,
                px: 1.5,
                borderBottom: i < upcoming.length - 1 ? 1 : 0,
                borderColor: "divider",
                "&:hover": { bgcolor: "action.selected" },
              }}>
              {/* The time, where the feed gives one; an untimed call keeps the
                  column, empty, its window where the wait would be. */}
              <Typography
                variant="body2"
                fontWeight="bold"
                sx={{ width: 42, flexShrink: 0, textAlign: "left", fontVariantNumeric: "tabular-nums" }}>
                {d.untimed ? "" : clock(d.dep_s)}
              </Typography>
              {route && <RouteBadge route={route} small />}
              <Typography variant="body2" noWrap sx={{ flex: 1, textAlign: "left" }}>
                {pattern
                  ? t("explorer_direction_to", {
                      place: pattern.destination,
                      interpolation: { escapeValue: false },
                    })
                  : (d.headsign ?? "")}
              </Typography>
              {d.untimed ? (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  title={untimedTitle(d, t)}
                  sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {clock(d.dep_s)}-{d.until_s === null ? "" : clock(d.until_s)}
                </Typography>
              ) : (
                <Typography variant="caption" color="text.secondary" noWrap>
                  {wait <= 0 ? t("explorer_now") : t("explorer_in_minutes", { count: wait })}
                </Typography>
              )}
            </ButtonBase>
          );
        })}
      </Box>
    </>
  );
}

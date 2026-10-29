/**
 * The Explorer's operating cost, in its own card below the left panel, as
 * a stepped hierarchy: the whole network always; under it the selected line (or the
 * line of the trip the right panel shows); under that the trip. Each step's
 * ≈ cost a year stands in one column, the deepest step's the largest, so a
 * line is read against the network and a trip against its line. The
 * deepest step's vehicle-km and -hours hang off it as branches; a bar at the
 * foot says they are a year's, and the days of the feed counted.
 */
import { Box, IconButton, Skeleton, Stack, Tooltip, Typography } from "@mui/material";
import { type ReactNode, memo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { type AnnualFigures, costYear } from "@/lib/explorer/derive/cost";
import { clock, compact, money, monthYear } from "@/lib/explorer/format";
import { openExplorerSettings, panelItem } from "@/lib/store/explorer/slice";

import { useNetworkCost, useRouteSummary, useRoutes, useTripCost } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";
import { useTimetablesPending } from "@/components/explorer/ExplorerLoading";
import { RouteBadge, routeName } from "@/components/explorer/RouteBadge";
import { PX } from "@/components/explorer/SectionHeader";

/** The days counted, by month: `Oct 2026 - Dec 2026`, one month once. */
function monthSpan(from: string, to: string, lang: string): string {
  const [a, b] = [monthYear(from, lang), monthYear(to, lang)];
  return a === b ? a : `${a} - ${b}`;
}

/** A step's icon size, and the gap after a step's mark, px. */
const MARK = 13;
const MARK_GAP = 8;

/** Each step's indent under the one above, px. */
const STEP = 16;

/** The tree's connector: down from the mark above at `depth - 1`, and
 * across to this row's centre. `top` is where it starts, above the row. */
function Elbow({ depth, top, height }: { depth: number; top: number; height: number }) {
  return (
    <Box
      aria-hidden
      sx={{
        position: "absolute",
        left: `${(depth - 1) * STEP + 6}px`,
        top,
        width: 8,
        height,
        borderLeft: "1.5px solid",
        borderBottom: "1.5px solid",
        borderColor: "divider",
        borderBottomLeftRadius: 4,
      }}
    />
  );
}

/** One step: what it covers and its year's cost; an elbow joins it to the
 * step above. */
function Step({
  depth,
  mark,
  name,
  annual,
  deepest,
}: {
  depth: number;
  mark: ReactNode;
  name: string;
  annual: AnnualFigures | undefined;
  deepest: boolean;
}) {
  const { i18n } = useTranslation("common");
  const { settings } = useExplorer();
  const lang = i18n.language;
  return (
    <Box sx={{ position: "relative", pl: `${depth * STEP}px`, mt: 0.75 }}>
      {depth > 0 && <Elbow depth={depth} top={-10} height={22} />}
      <Stack direction="row" alignItems="center" spacing={`${MARK_GAP}px`} sx={{ minHeight: 24 }}>
        <Box sx={{ display: "flex", alignItems: "center", color: "text.secondary", flexShrink: 0 }}>
          {mark}
        </Box>
        <Typography
          variant="body2"
          fontWeight={deepest ? 700 : 600}
          noWrap
          title={name}
          sx={{ flex: 1, minWidth: 0 }}>
          {name}
        </Typography>
        {annual ? (
          <Typography
            fontWeight="bold"
            noWrap
            sx={{ fontSize: deepest ? 20 : 14, lineHeight: 1.2, fontVariantNumeric: "tabular-nums" }}>
            ≈ {money(annual.cost, lang, settings.currency)}
          </Typography>
        ) : (
          <Skeleton variant="rounded" width={deepest ? 72 : 52} height={deepest ? 22 : 16} />
        )}
      </Stack>
    </Box>
  );
}

/** Row height of a figure, and the gap above it, px. */
const FIGURE_H = 20;
const FIGURE_GAP = 2;

/** One of the deepest step's yearly figures, hung off it as a branch, so
 * it reads as that step's: what it counts, and how many. The first
 * branch starts under the step's mark; the next carries the line on. */
function Figure({
  depth,
  first,
  label,
  value,
}: {
  depth: number;
  first: boolean;
  label: string;
  value: string;
}) {
  return (
    <Box sx={{ position: "relative", pl: `${depth * STEP}px`, mt: `${FIGURE_GAP}px` }}>
      <Elbow
        depth={depth}
        top={first ? -6 : -(FIGURE_GAP + FIGURE_H / 2)}
        height={first ? 6 + FIGURE_H / 2 : FIGURE_GAP + FIGURE_H}
      />
      <Stack direction="row" alignItems="center" spacing={1} sx={{ height: FIGURE_H }}>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {label}
        </Typography>
        <Typography
          variant="caption"
          fontWeight={600}
          noWrap
          sx={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
          {value}
        </Typography>
      </Stack>
    </Box>
  );
}

/** Memoised: the map layout re-renders around the left panel. */
export const CostSection = memo(Cost);

function Cost() {
  const { t, i18n } = useTranslation("common");
  const dispatch = useAppDispatch();
  const lang = i18n.language;
  const { db, complete, window, settings } = useExplorer();
  const selectedRouteId = useAppSelector((s) => s.explorer.selectedRouteId);
  const date = useAppSelector((s) => s.explorer.date);
  const trip = useAppSelector((s) => {
    const item = panelItem(s.explorer);
    return item?.kind === "trip" ? item : null;
  });
  const routes = useRoutes(db);
  // The open trip's own line: a route's trips are one range of trip_idx.
  const tripLine = trip
    ? routes.data?.find(
        (r) =>
          r.trip_lo !== null && r.trip_hi !== null && r.trip_lo <= trip.trip_idx && trip.trip_idx <= r.trip_hi
      )
    : undefined;
  // The line: the selected one, or the open trip's. The trip is a step only
  // under its own line: a trip left open from another line, when a line is
  // selected in the panel, is not part of it.
  const line = routes.data?.find((r) => r.route_id === selectedRouteId) ?? tripLine;
  const tripShown = !!trip && !!line && line.route_id === tripLine?.route_id;
  // Each answer is remembered per database: the route summary above asks
  // for the same ones, so nothing is computed twice.
  const network = useNetworkCost(complete ? db : undefined, window, settings);
  const summary = useRouteSummary(complete && line ? db : undefined, line, date, window, settings);
  const tripCost = useTripCost(
    complete && tripShown ? db : undefined,
    trip?.trip_idx ?? -1,
    tripLine,
    window,
    settings
  );
  const pending = useTimetablesPending();
  const year = window ? costYear(window) : null;

  const steps: { mark: ReactNode; name: string; annual: AnnualFigures | undefined }[] = [
    {
      mark: <Icon iconName={ICON_NAME.WORKFLOW} style={{ fontSize: MARK }} htmlColor="inherit" />,
      name: t("explorer_network"),
      annual: network.data,
    },
  ];
  if (line)
    steps.push({
      mark: <RouteBadge route={line} small />,
      name: routeName(line, t),
      annual: summary.data?.annual,
    });
  if (trip && tripShown)
    steps.push({
      mark: <Icon iconName={ICON_NAME.CLOCK} style={{ fontSize: MARK }} htmlColor="inherit" />,
      name: t("explorer_cost_trip", { time: clock(trip.run_dep_s) }),
      annual: tripCost.data,
    });

  const deepest = steps[steps.length - 1].annual;

  return (
    <Stack
      sx={{
        px: PX,
        pt: 1.5,
      }}>
      {/* Laid out like the tab's section headers: icon, name, action. */}
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ minHeight: 32 }}>
        <Icon iconName={ICON_NAME.COINS} style={{ fontSize: 14 }} htmlColor="inherit" />
        <Typography variant="body2" fontWeight="bold" noWrap sx={{ flex: 1 }}>
          {t("explorer_operating_cost")}
        </Typography>
        {!network.data && (
          <Typography variant="caption" color="text.secondary" noWrap>
            {pending ?? t("explorer_calculating")}
          </Typography>
        )}
        <Tooltip title={t("explorer_cost_rates")}>
          <IconButton
            size="small"
            aria-label={t("explorer_cost_rates")}
            onClick={() => dispatch(openExplorerSettings("rates"))}
            sx={{ mr: -0.75 }}>
            <Icon iconName={ICON_NAME.SLIDERS} style={{ fontSize: 13 }} />
          </IconButton>
        </Tooltip>
      </Stack>
      {steps.map((s, i) => (
        <Step
          key={i}
          depth={i}
          mark={s.mark}
          name={s.name}
          annual={s.annual}
          deepest={i === steps.length - 1}
        />
      ))}
      {/* The deepest step's vehicle-km and -hours, as its branches. */}
      <Box sx={{ mt: "4px" }}>
        {[
          ["explorer_cost_km", deepest?.vehicle_km],
          ["explorer_cost_hours", deepest?.vehicle_hours],
        ].map(([key, value], i) => (
          <Figure
            key={key}
            depth={steps.length}
            first={i === 0}
            label={t(key as string)}
            value={value === undefined ? "–" : compact(value as number, lang)}
          />
        ))}
      </Box>
      {/* The foot of the card: every figure above is a year's, and the
          days of the feed it is counted from. */}
      {year && (
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="center"
          spacing={1}
          sx={{
            mx: -PX,
            mt: 1.5,
            px: PX,
            py: 0.75,
            borderTop: 1,
            borderColor: "divider",
            bgcolor: "action.hover",
            minWidth: 0,
          }}>
          <Typography variant="caption" fontWeight={600} noWrap>
            {t("explorer_cost_annual")}
          </Typography>
          {/* Darker than the divider colour, which barely shows on the bar's
              tint. */}
          <Box aria-hidden sx={{ width: "1px", height: 14, bgcolor: "text.disabled", flexShrink: 0 }} />
          <Typography variant="caption" color="text.secondary" noWrap>
            {t("explorer_cost_based_on", {
              span: monthSpan(year.from, year.to, lang),
            })}
          </Typography>
        </Stack>
      )}
    </Stack>
  );
}

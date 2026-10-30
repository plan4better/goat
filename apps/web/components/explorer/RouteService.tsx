/**
 * A route's Overview tab (board 22), read-only for now: per direction how
 * often it runs in each time period, vehicles in service through the day,
 * how long a trip takes, and its first and last departure. In the editing
 * phase these become the fields that change service; the layout is theirs
 * already.
 */
import { Box, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { clock } from "@/lib/explorer/format";
import { modeOf, routeColor } from "@/lib/explorer/modes";

import type { RouteRow, RouteSummaryData } from "@/hooks/explorer/useExplorerData";
import { useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";
import { DateChip, SectionHeader } from "@/components/explorer/SectionHeader";
import { VehiclesCurve } from "@/components/explorer/VehiclesCurve";
import { directionLabel } from "@/components/explorer/directionWords";

/** The time period's column: wide enough for "07:00–09:00"; the directions
 * share what is left, so their names have the room. */
const PERIOD_COL = 84;

/** A period × direction table: titled columns, rows between hairlines. */
function PeriodTable({
  data,
  cell,
}: {
  data: RouteSummaryData;
  cell: (
    d: RouteSummaryData["directions"][number],
    period: string
  ) => { text: string; muted: boolean; title?: string };
}) {
  const { t } = useTranslation("common");
  const { periods } = useExplorer().settings;
  const cols = data.directions;
  return (
    <Box>
      <Stack direction="row" columnGap={1.5} alignItems="flex-end" sx={{ py: 1 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          fontWeight={600}
          sx={{ width: PERIOD_COL, flexShrink: 0 }}>
          {t("explorer_col_time_period")}
        </Typography>
        {cols.map((c) => (
          <Typography
            key={c.direction.key}
            variant="caption"
            color="text.secondary"
            fontWeight={600}
            title={directionLabel(c.direction.name, t)}
            // Wrapping, not cut short: the whole name, over two lines where
            // two directions share a narrow panel.
            sx={{ flex: 1, minWidth: 0, textAlign: "right", lineHeight: 1.35, overflowWrap: "anywhere" }}>
            {directionLabel(c.direction.name, t)}
          </Typography>
        ))}
      </Stack>
      {periods.map((p) => (
        <Stack
          key={p.key}
          direction="row"
          columnGap={1.5}
          alignItems="center"
          sx={{ py: 0.75, borderTop: 1, borderColor: "divider" }}>
          <Box sx={{ width: PERIOD_COL, flexShrink: 0 }}>
            <Typography variant="body2" fontWeight={600} noWrap sx={{ lineHeight: 1.3 }}>
              {t(`explorer_period_${p.key}`)}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              display="block"
              noWrap
              sx={{ lineHeight: 1.3 }}>
              {p.start_s ? clock(p.start_s) : ""}–{p.end_s < 30 * 3600 ? clock(p.end_s) : ""}
            </Typography>
          </Box>
          {cols.map((c) => {
            const { text, muted, title } = cell(c, p.key);
            return (
              <Typography
                key={c.direction.key}
                variant="body2"
                fontWeight={muted ? 400 : 600}
                color={muted ? "text.secondary" : "text.primary"}
                title={title}
                sx={{ flex: 1, minWidth: 0, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {text}
              </Typography>
            );
          })}
        </Stack>
      ))}
    </Box>
  );
}

function Section({ icon, label, children }: { icon: ICON_NAME; label: string; children: ReactNode }) {
  const date = useAppSelector((s) => s.explorer.date) as string;
  return (
    <Box sx={{ mt: 1 }}>
      <SectionHeader px={0} icon={icon} label={label} aside={<DateChip date={date} />} />
      {children}
    </Box>
  );
}

export function RouteService({ route, data }: { route: RouteRow; data: RouteSummaryData }) {
  const { t } = useTranslation("common");
  if (!data.operations.runs) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        {t("explorer_no_service_today")}
      </Typography>
    );
  }
  return (
    <Box sx={{ pb: 2 }}>
      <Section icon={ICON_NAME.CLOCK} label={t("explorer_headways")}>
        <PeriodTable
          data={data}
          cell={(d, period) => {
            const h = d.headways.get(period);
            if (!h || h.departures === 0) return { text: "–", muted: true };
            if (h.minutes === null) return { text: t("explorer_one_trip"), muted: true };
            return { text: `${h.minutes}′`, muted: false };
          }}
        />
      </Section>

      <Section icon={ICON_NAME.BUS} label={t("explorer_vehicles_in_service_title")}>
        <VehiclesCurve values={data.curve} color={routeColor(route.color, modeOf(route.route_type))} />
      </Section>

      <Section icon={ICON_NAME.CLOCK} label={t("explorer_running_time")}>
        <PeriodTable
          data={data}
          cell={(d, period) => {
            const m = d.running.get(period);
            return m === null || m === undefined
              ? { text: "–", muted: true }
              : // The median, marked as not exact (≈), the end-to-end time on the
                // period's most common pattern.
                { text: `≈ ${m} min`, muted: false, title: t("explorer_median") };
          }}
        />
      </Section>

      <Section icon={ICON_NAME.CALENDAR} label={t("explorer_span")}>
        {/* As the period tables below: titled columns, rows between hairlines. */}
        <Box>
          <Stack direction="row" columnGap={1.5} sx={{ py: 1 }}>
            <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ flex: 1 }}>
              {t("explorer_direction")}
            </Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ flexShrink: 0 }}>
              {t("explorer_col_period")}
            </Typography>
          </Stack>
          {data.directions.map((d) => (
            <Stack
              key={d.direction.key}
              direction="row"
              columnGap={1.5}
              alignItems="center"
              sx={{ py: 0.75, borderTop: 1, borderColor: "divider" }}>
              <Typography
                variant="body2"
                fontWeight={600}
                noWrap
                title={`${d.direction.ends[0]} – ${d.direction.ends[1]}`}
                sx={{ flex: 1, minWidth: 0 }}>
                {directionLabel(d.direction.name, t)}
              </Typography>
              <Typography
                variant="body2"
                fontWeight={600}
                sx={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                {d.operations.runs
                  ? `${clock(d.operations.first_dep_s)}–${clock(d.operations.last_dep_s)}`
                  : "–"}
              </Typography>
            </Stack>
          ))}
        </Box>
      </Section>
    </Box>
  );
}

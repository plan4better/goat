/**
 * The destination picker (02-panel-behaviour-spec › Direction): "All
 * directions" first where there are several, then each direction with its
 * variants indented under it, every option with its trips. One choice, in
 * the store, drives the trip strip, the Stops tab and the stop timetable.
 *
 * The Stops tab shows it as GOAT's Selector (`directionItems`); the strip's
 * header as a compact rounded select (`DirectionPicker`).
 */
import { Box, MenuItem, Select, Typography } from "@mui/material";
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { Direction, VariantKind } from "@/lib/explorer/derive/directions";
import {
  type ResolvedChoice,
  choiceFromValue,
  choiceValue,
  resolveChoice,
} from "@/lib/explorer/directionChoice";
import { pickExplorerPattern } from "@/lib/store/explorer/slice";

import type { SelectorItem } from "@/types/map/common";

import type { RouteRow } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { RouteBadge } from "@/components/explorer/RouteBadge";
import { directionLabel } from "@/components/explorer/directionWords";

const KIND_KEY: Record<Exclude<VariantKind, "main">, string> = {
  short_turn: "explorer_variant_short_turn",
  express: "explorer_variant_express",
  branch: "explorer_variant_branch",
};

/** Trips on the Explorer's date by pattern, from the day's runs: what the
 * picker counts, as the trip strip does. */
export function tripsByPattern(runs: { pattern_idx: number }[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of runs) out.set(r.pattern_idx, (out.get(r.pattern_idx) ?? 0) + 1);
  return out;
}

/** The picker's options: each direction, its variants under it, each with
 * its trips on the Explorer's date (`dayTrips`), as the strip counts them;
 * no count until they are in. */
export function directionItems(
  directions: Direction[],
  route: RouteRow,
  t: TFunction,
  dayTrips: Map<number, number> | null
): SelectorItem[] {
  const trips = (patterns: number[]) =>
    dayTrips
      ? ` · ${t("explorer_trips", { count: patterns.reduce((n, p) => n + (dayTrips.get(p) ?? 0), 0) })}`
      : "";
  const badge = <RouteBadge route={route} small />;
  // A variant sits under its direction, where the badge would be.
  const under = (
    <Box component="span" sx={{ width: 28, textAlign: "center", color: "text.secondary" }}>
      ↳
    </Box>
  );
  return [
    ...directions.flatMap((d) => [
      // A direction by its destination, an arrow before it in place of "To".
      {
        value: `${d.key}:`,
        label: `${directionLabel(d.name, t)}${trips(d.patterns.map((p) => p.pattern_idx))}`,
        iconNode: badge,
      },
      ...d.patterns
        .filter((p) => p.kind !== "main")
        .map((p) => ({
          value: `${d.key}:${p.pattern_idx}`,
          label: `${t(KIND_KEY[p.kind as Exclude<VariantKind, "main">], {
            destination: p.destination,
            interpolation: { escapeValue: false },
          })}${trips([p.pattern_idx])}`,
          iconNode: under,
        })),
    ]),
  ];
}

/** The store's choice for `directions`, and how to change it. */
export function useDirectionChoice(directions: Direction[]): {
  resolved: ResolvedChoice;
  pick: (value: string) => void;
} {
  const dispatch = useAppDispatch();
  const choice = useAppSelector((s) => s.explorer.pattern);
  // Kept while neither changes, so what is drawn from it is not redrawn.
  const resolved = useMemo(() => resolveChoice(choice, directions), [choice, directions]);
  return {
    resolved,
    pick: (value) => dispatch(pickExplorerPattern(choiceFromValue(value))),
  };
}

/** The strip header's picker: the route's badge and where the choice goes;
 * `compact`, the destination alone. */
export function DirectionPicker({
  route,
  directions,
  dayTrips,
  compact = false,
}: {
  route: RouteRow;
  directions: Direction[];
  /** The day's trips by pattern (`tripsByPattern`). */
  dayTrips: Map<number, number> | null;
  compact?: boolean;
}) {
  const { t } = useTranslation("common");
  const { resolved, pick } = useDirectionChoice(directions);
  const items = directionItems(directions, route, t, dayTrips);
  const value = choiceValue(resolved);
  // A variant by its own words ("Short turn to …"); short, its destination.
  const variant = resolved.direction?.patterns.find((p) => p.pattern_idx === resolved.pattern_idx);
  const shown =
    variant && variant.kind !== "main"
      ? compact
        ? variant.destination
        : t(KIND_KEY[variant.kind], {
            destination: variant.destination,
            interpolation: { escapeValue: false },
          })
      : resolved.direction
        ? directionLabel(resolved.direction.name, t)
        : "";
  return (
    <Select
      size="small"
      value={items.some((it) => it.value === value) ? value : ""}
      onChange={(e) => pick(String(e.target.value))}
      SelectDisplayProps={{ "aria-label": t("explorer_direction") }}
      renderValue={() => (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
          <RouteBadge route={route} small />
          <Typography variant="body2" fontWeight={600} noWrap>
            {shown}
          </Typography>
        </Box>
      )}
      sx={{
        height: 32,
        maxWidth: compact ? 180 : 280,
        borderRadius: "16px",
        // A quiet pill, as the date beside it.
        bgcolor: "action.hover",
        "& .MuiOutlinedInput-notchedOutline": { border: "none" },
        // As much room before the badge as after the arrow, and a little
        // between the words and the arrow.
        "& .MuiSelect-select": {
          py: 0.5,
          pl: "8px",
          pr: "34px !important",
          display: "flex",
          alignItems: "center",
        },
        "& .MuiSelect-icon": { right: "8px" },
      }}
      MenuProps={{
        anchorOrigin: { vertical: "top", horizontal: "left" },
        transformOrigin: { vertical: "bottom", horizontal: "left" },
      }}>
      {items.map((it) => (
        <MenuItem key={String(it.value)} value={String(it.value)} sx={{ gap: 1, fontSize: 14 }}>
          {it.iconNode}
          {it.label}
        </MenuItem>
      ))}
    </Select>
  );
}

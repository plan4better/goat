import { Box } from "@mui/material";
import type { TFunction } from "i18next";

import { modeOf, routeColor, routeTextColor } from "@/lib/explorer/modes";

import type { RouteRow } from "@/hooks/explorer/useExplorerData";

/** A route's number on its colour, as riders see it on the vehicle. */
export function RouteBadge({ route, small }: { route: RouteRow; small?: boolean }) {
  const background = routeColor(route.color, modeOf(route.route_type));
  const color = routeTextColor(route.text_color, background);
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: small ? 28 : 36,
        height: small ? 18 : 22,
        px: 0.75,
        borderRadius: 0.75,
        fontSize: small ? 11 : 12,
        fontWeight: 700,
        lineHeight: 1,
        whiteSpace: "nowrap",
        backgroundColor: background,
        color,
        flexShrink: 0,
      }}>
      {route.short_name || route.long_name?.slice(0, 4) || route.route_id}
    </Box>
  );
}

/** The name to show beside a route's badge once it is selected: its long
 * name, or — when it has none, or one that only repeats the number on the
 * badge — its mode. */
export function routeName(route: RouteRow, t: TFunction): string {
  return route.long_name && route.long_name !== route.short_name
    ? route.long_name
    : t(`explorer_mode_${modeOf(route.route_type)}`);
}

/** Whether `routeName` fell back to the route's mode. */
export function namedByMode(route: RouteRow): boolean {
  return !route.long_name || route.long_name === route.short_name;
}

/** What makes routes one line to riders: number, colour and type. */
export function lineKey(r: RouteRow): string {
  return `${r.short_name || r.long_name || r.route_id}|${r.color}|${r.route_type}`;
}

/** One route per number, colour and type: a feed may run several routes as
 * "S3" (per operator, per variant), and a stop's badges mean the lines. */
export function distinctLines(routes: (RouteRow | undefined)[]): RouteRow[] {
  const seen = new Set<string>();
  return routes.filter((r): r is RouteRow => {
    if (!r) return false;
    const key = lineKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

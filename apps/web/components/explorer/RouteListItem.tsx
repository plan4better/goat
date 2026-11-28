/**
 * A line as the Explorer lists it, wherever it does (the left panel's
 * Lines, a stop's Properties): its badge, its name, its mode at the right;
 * the whole row opens it. One not running on the date is dimmed.
 */
import { Box, ListItemButton, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { Icon } from "@p4b/ui/components/Icon";

import { modeOf } from "@/lib/explorer/modes";
import { selectExplorerRoute } from "@/lib/store/explorer/slice";

import type { RouteRow } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch } from "@/hooks/store/ContextHooks";

import { RouteBadge } from "@/components/explorer/RouteBadge";
import { PX } from "@/components/explorer/SectionHeader";
import { modeIcon } from "@/components/explorer/modeIcon";

/** A row's height, as the left panel's lists have it. */
const ROW_HEIGHT = 36;

export function RouteListItem({ route, idle = false }: { route: RouteRow; idle?: boolean }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  return (
    <ListItemButton
      onClick={() => dispatch(selectExplorerRoute(route.route_id))}
      title={idle ? t("explorer_route_no_trips_on_date") : undefined}
      sx={{ px: PX, py: 0.75, gap: 1.5, minHeight: ROW_HEIGHT, opacity: idle ? 0.5 : 1 }}>
      <RouteBadge route={route} />
      <Typography variant="body2" noWrap title={route.long_name ?? undefined} sx={{ flex: 1 }}>
        {route.long_name || route.short_name || route.route_id}
      </Typography>
      <Box sx={{ color: "text.disabled", display: "flex" }}>
        <Icon iconName={modeIcon(modeOf(route.route_type))} style={{ fontSize: 13 }} htmlColor="inherit" />
      </Box>
    </ListItemButton>
  );
}

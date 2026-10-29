/** The icon a route's mode is shown with, in lists and headers. */
import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { ModeKey } from "@/lib/explorer/modes";

const ICONS: Record<ModeKey, ICON_NAME> = {
  tram: ICON_NAME.TRAM,
  cable_tram: ICON_NAME.TRAM,
  metro: ICON_NAME.SUBWAY,
  monorail: ICON_NAME.SUBWAY,
  rail: ICON_NAME.RAIL,
  bus: ICON_NAME.BUS,
  trolleybus: ICON_NAME.BUS,
  ferry: ICON_NAME.FERRY,
  aerial_lift: ICON_NAME.GONDOLA,
  funicular: ICON_NAME.CABLE_CAR,
  other: ICON_NAME.ROUTE,
};

export function modeIcon(mode: ModeKey): ICON_NAME {
  return ICONS[mode];
}

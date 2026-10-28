// The icons of the "Draw as" choices (points and rasters), shown in the field and in its menu.
import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

const ICONS: Record<string, ICON_NAME> = {
  features: ICON_NAME.POINT_FEATURE,
  heatmap: ICON_NAME.BULLSEYE,
  cluster: ICON_NAME.AGGREGATE,
  h3: ICON_NAME.HEXAGON,
  image: ICON_NAME.IMAGE,
  continuous: ICON_NAME.RASTER,
  categorical: ICON_NAME.CATEGORIES,
  terrain: ICON_NAME.MOUNTAIN,
};

export function drawAsIcon(value: string) {
  const icon = ICONS[value];
  return icon ? <Icon iconName={icon} sx={{ fontSize: 14, color: "text.secondary" }} /> : undefined;
}

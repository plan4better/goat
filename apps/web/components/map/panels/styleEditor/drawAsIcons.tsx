// The icons of the "Draw as" choices (points and rasters), shown in the field and in its menu. A choice carries the
// icon's name: the field and the menu's rows draw it at the rows' icon size and color.
import { ICON_NAME } from "@p4b/ui/components/Icon";

const ICONS: Record<string, ICON_NAME> = {
  features: ICON_NAME.POINT_FEATURE,
  heatmap: ICON_NAME.BULLSEYE,
  cluster: ICON_NAME.CLUSTER,
  h3: ICON_NAME.HEXAGON,
  image: ICON_NAME.IMAGE,
  continuous: ICON_NAME.RASTER,
  categorical: ICON_NAME.CATEGORIES,
  hillshade: ICON_NAME.MOUNTAIN,
};

export function drawAsIcon(value: string): ICON_NAME | undefined {
  return ICONS[value];
}

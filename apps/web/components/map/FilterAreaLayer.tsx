import { useTheme } from "@mui/material";
import type { Geometry } from "geojson";
import { Layer, Source } from "react-map-gl/maplibre";

import { useShownAreaOutline } from "@/components/map/panels/filter/area/outline";

/** The area of a layer filter: an outline over a halo that keeps it readable on any map, dashed while the area is
 * switched off. No fill: the filtered layer already shows what is inside. */
const FilterAreaLayer = () => {
  const theme = useTheme();
  const outline = useShownAreaOutline();
  if (!outline) return null;
  const dash = !outline.enabled && { "line-dasharray": [2, 1.5] };

  return (
    // The geometry is the same object as long as the polygons are, so the source only gets new data with new ones.
    <Source id="filter-area" type="geojson" data={outline.geometry as unknown as Geometry}>
      <Layer
        id="filter-area-halo"
        type="line"
        layout={{ "line-join": "round", "line-cap": "round" }}
        paint={{ "line-color": theme.palette.background.paper, "line-width": 5, "line-opacity": 0.85 }}
      />
      <Layer
        id="filter-area-line"
        type="line"
        layout={{ "line-join": "round", "line-cap": "round" }}
        paint={{ "line-color": theme.palette.primary.main, "line-width": 2.5, ...dash }}
      />
    </Source>
  );
};

export default FilterAreaLayer;

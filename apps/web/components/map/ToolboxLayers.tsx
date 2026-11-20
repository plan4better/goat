import { useTheme } from "@mui/material";
import { useMemo } from "react";
import { Marker } from "react-map-gl/maplibre";
import { v4 } from "uuid";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { GEOFENCE_LAYERS_PATH } from "@/lib/constants";

import { useAppSelector } from "@/hooks/store/ContextHooks";

import MaskLayer from "@/components/map/MaskLayer";

const ToolboxLayers = () => {
  const maskLayer = useAppSelector((state) => state.map.maskLayer);
  const theme = useTheme();
  const maskLayerUrl = useMemo(() => {
    if (maskLayer) {
      return `${GEOFENCE_LAYERS_PATH}/${maskLayer}.geojson`;
    }
    return null;
  }, [maskLayer]);
  const startingPoints = useAppSelector((state) => state.map.toolboxStartingPoints);

  return (
    <>
      {/* MASK LAYER  (Shows where tool computation is available*/}
      {maskLayerUrl && <MaskLayer mask={maskLayerUrl} id="mask-layer" />}
      {startingPoints &&
        startingPoints.map((marker) => (
          <Marker key={v4()} longitude={marker[0]} latitude={marker[1]} anchor="bottom">
            <Icon iconName={ICON_NAME.LOCATION} htmlColor={theme.palette.error.main} fontSize="large" />
          </Marker>
        ))}
    </>
  );
};

export default ToolboxLayers;

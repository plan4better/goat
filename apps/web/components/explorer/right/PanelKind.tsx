/**
 * What the right panel shows, said above its name (02-panel-behaviour-spec
 * › Viewers): a location by its type's name, as the Type field has it (a
 * stop or platform, a station, an entrance or exit), or a trip.
 */
import { Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

export type PanelKindName = "station" | "platform" | "stop" | "entrance" | "trip";

/** A location's kind by its location_type's name; a platform and a stop on
 * its own are one type. */
const KEY: Record<PanelKindName, string> = {
  stop: "explorer_location_type_0",
  platform: "explorer_location_type_0",
  station: "explorer_location_type_1",
  entrance: "explorer_location_type_2",
  trip: "explorer_panel_kind_trip",
};

export function PanelKind({ kind }: { kind: PanelKindName }) {
  const { t } = useTranslation("common");
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      display="block"
      sx={{
        fontWeight: 700,
        lineHeight: 1.6,
        mb: 0.25,
      }}>
      {t(KEY[kind])}
    </Typography>
  );
}

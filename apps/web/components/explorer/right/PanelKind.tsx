/**
 * What the right panel shows, said above its name (02-panel-behaviour-spec
 * › Viewers): a station, one of its platforms, a stop on its own, or a trip.
 */
import { Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

export type PanelKindName = "station" | "platform" | "stop" | "trip";

export function PanelKind({ kind }: { kind: PanelKindName }) {
  const { t } = useTranslation("common");
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      display="block"
      sx={{
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        lineHeight: 1.6,
        mb: 0.25,
      }}>
      {t(`explorer_panel_kind_${kind}`)}
    </Typography>
  );
}

import { Paper, type Theme } from "@mui/material";

import type { Legend } from "@/lib/style/legend";

import { StyleLegend } from "@/components/map/legend/StyleLegend";

/** The legend's text, one step above the layer list's caption: the box stands on a map, read from further away. The
 * entries, the headings and the caption share it, so the sizes do not mix. */
const TEXT_SX = { fontSize: (theme: Theme) => theme.typography.body2.fontSize };

/**
 * The legend of the dashboard's detail maps (the dataset detail, a catalog entry), in their bottom-left corner: drawn
 * by the layer list's own component from the style the features use, with its section headings, as the field a
 * classification reads turns a column of swatches into an explanation. At least 200 px wide, so a ramp spans the box
 * and its end labels stand apart, and a long class list scrolls inside it.
 */
const DetailMapLegend = ({ legend }: { legend: Legend | null | undefined }) => {
  if (!legend) return null;
  return (
    <Paper
      data-detail-map-legend
      elevation={0}
      sx={{
        position: "absolute",
        left: 8,
        bottom: 8,
        minWidth: 200,
        maxWidth: 280,
        maxHeight: "70%",
        overflowY: "auto",
        px: 2,
        py: 1.5,
        borderRadius: 1.5,
        backgroundColor: "background.paper",
        opacity: 0.96,
        // Above the credit strip, which sets a z-index of its own and would otherwise cover the legend where the two
        // meet on a narrow map.
        zIndex: 2,
      }}>
      <StyleLegend legend={legend} variant="tree" itemSx={TEXT_SX} headingSx={TEXT_SX} captionSx={TEXT_SX} />
    </Paper>
  );
};

export default DetailMapLegend;

"use client";

// The marker's shape (prototype "Marker shapes and pins"): the shapes, then the pins that point at their place, as
// tiles; each drawn with the marker's icon and color while those are one value, else as a gray outline, since only the
// shape is picked here. The hovered or chosen shape's name shows above them.
import { Box, ButtonBase, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { MarkerShape } from "@/lib/style/editor/parts";
import { choiceLabel } from "@/lib/style/editor/summaries";
import { MARKER_SHAPES, SHAPE_IDS } from "@/lib/style/markerShapes";

import { IconGlyph } from "@/components/map/panels/styleEditor/pickers/IconGlyph";

/** A shape's fill while the marker's color varies (by zoom, attribute or classes). */
export const SHAPE_NEUTRAL = "#9aa3ad";

/** What a shape's picture shows of the marker: its color and icon where each is one value, and whether it is hollow. */
export interface ShapePreview {
  fill?: string;
  icon?: string;
  iconColor?: string;
  /** A hollow marker (spec 3.3 `fill: false`): the shape's outline in the marker color. */
  hollow?: boolean;
}

/** The marker as `shape` draws it, `size` px: the outline in the fill (a hollow marker its outline only), the icon in
 * its head; the icon alone, itself. */
export function MarkerPicture({
  shape,
  size = 28,
  preview = {},
}: {
  shape: MarkerShape;
  size?: number;
  preview?: ShapePreview;
}) {
  if (shape === "icon")
    return preview.icon ? (
      <IconGlyph
        iconRef={preview.icon}
        size={Math.round(size * 0.85)}
        color={preview.fill ?? SHAPE_NEUTRAL}
      />
    ) : (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}>
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke={SHAPE_NEUTRAL}
          strokeWidth="1.6"
          strokeDasharray="3 2.4"
        />
      </svg>
    );
  const spec = MARKER_SHAPES[shape];
  const icon = spec.icon.share * size;
  return (
    <Box
      component="span"
      data-marker-shape={shape}
      sx={{ position: "relative", display: "inline-block", width: size, height: size, flex: "none" }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        style={{ display: "block", overflow: "visible" }}>
        {preview.hollow ? (
          <path
            d={spec.path}
            fill="none"
            stroke={preview.fill ?? SHAPE_NEUTRAL}
            strokeWidth={2.4}
            strokeLinejoin="round"
          />
        ) : (
          <path d={spec.path} fill={preview.fill ?? SHAPE_NEUTRAL} />
        )}
      </svg>
      {preview.icon && (
        <Box
          component="span"
          sx={{
            position: "absolute",
            left: (spec.icon.cx / 24) * size - icon / 2,
            top: (spec.icon.cy / 24) * size - icon / 2,
            display: "flex",
          }}>
          <IconGlyph iconRef={preview.icon} size={icon} color={preview.iconColor ?? "#ffffff"} />
        </Box>
      )}
    </Box>
  );
}

const SHAPES: MarkerShape[] = SHAPE_IDS.filter((id) => !MARKER_SHAPES[id].pin);
const PINS: MarkerShape[] = SHAPE_IDS.filter((id) => MARKER_SHAPES[id].pin);

export function ShapeTiles({
  value,
  onChange,
  preview,
  allowIcon = true,
}: {
  value: MarkerShape;
  onChange: (shape: MarkerShape) => void;
  preview: ShapePreview;
  /** Offer the icon alone (the layer's marker; a class takes a shape). */
  allowIcon?: boolean;
}) {
  const { t } = useTranslation("common");
  const [hover, setHover] = useState<MarkerShape | null>(null);
  const name = (shape: MarkerShape) => choiceLabel(t, "marker.shape", shape);
  const tiles = (shapes: MarkerShape[]) => (
    <Box sx={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 1.5, px: 3 }}>
      {shapes.map((shape) => {
        const on = shape === value;
        return (
          <ButtonBase
            key={shape}
            aria-label={name(shape)}
            aria-pressed={on}
            title={name(shape)}
            onClick={() => onChange(shape)}
            onMouseEnter={() => setHover(shape)}
            onFocus={() => setHover(shape)}
            sx={{
              height: 44,
              borderRadius: 2,
              border: 1,
              borderColor: on ? "primary.main" : "divider",
              bgcolor: (theme) => (on ? `${theme.palette.primary.main}14` : "transparent"),
              "&:hover": { borderColor: on ? "primary.main" : "text.disabled" },
            }}>
            <MarkerPicture shape={shape} size={26} preview={preview} />
          </ButtonBase>
        );
      })}
    </Box>
  );
  return (
    <Box onMouseLeave={() => setHover(null)}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          height: 32,
          mx: 3,
          mb: 2,
          px: 3,
          borderRadius: 2,
          bgcolor: "action.hover",
        }}>
        <Typography variant="body2" fontWeight="bold" noWrap>
          {name(hover ?? value)}
        </Typography>
      </Box>
      {tiles(allowIcon ? ["icon", ...SHAPES] : SHAPES)}
      <Typography
        variant="caption"
        color="text.secondary"
        component="p"
        sx={{ px: 3, pt: 2, pb: 1, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>
        {t("style_editor.pins")}
      </Typography>
      {tiles(PINS)}
    </Box>
  );
}

// The zooms a layer, part or class shows at (spec 3.5): a two-thumb slider over 0 to 24 with the map zoom marked by
// the zoom chart's pointer under the track; the ends mean "no limit" and write undefined. Under the track, as in the
// zoom chart, the pointer drags the map's zoom and a press zooms the map there, a faint pointer showing where.
import { Box, Slider, Typography } from "@mui/material";
import { type PointerEvent, type ReactNode, memo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useZoomTo } from "@/components/map/panels/styleEditor/context";
import { Row } from "@/components/map/panels/styleEditor/rows/Row";

export const MAX_ZOOM = 24;

export interface ZoomRangeRowProps {
  label?: ReactNode;
  from?: number;
  until?: number;
  mapZoom: number;
  /** The range the layer itself allows, shaded on the track. */
  layerRange?: [number, number];
  onChange: (from: number | undefined, until: number | undefined) => void;
}

/** The zoom chart's pointer at `zoom`: the map's zoom, or (`ghost`) where a press would take it; with its zoom. */
function ZoomPointer({ zoom, label, ghost }: { zoom: number; label?: boolean; ghost?: boolean }) {
  const text = (Math.round(zoom * 10) / 10).toFixed(1);
  return (
    <Box
      {...(ghost ? { "data-ghost": "zoom" } : { "data-zoom-pointer": true })}
      aria-hidden="true"
      title={ghost ? undefined : String(Math.round(zoom * 10) / 10)}
      style={{ left: `${(zoom / MAX_ZOOM) * 100}%` }}
      sx={{ position: "absolute", top: 1, opacity: ghost ? 0.5 : 1, pointerEvents: "none" }}>
      <Box
        sx={{
          transform: "translateX(-50%)",
          width: 0,
          height: 0,
          // The zoom chart's pointer as it draws in a popover (8 by 6 of its units, scaled to the popover's width).
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderBottom: (theme) => `7px solid ${theme.palette.text.primary}`,
        }}
      />
      {label && (
        <Typography
          component="span"
          sx={{
            position: "absolute",
            left: 0,
            top: 11,
            transform: "translateX(-50%)",
            fontSize: 10.5,
            color: "text.primary",
            lineHeight: 1,
            whiteSpace: "nowrap",
          }}>
          {text}
        </Typography>
      )}
    </Box>
  );
}

export const ZoomRangeRow = memo(function ZoomRangeRow({
  label,
  from,
  until,
  mapZoom,
  layerRange,
  onChange,
}: ZoomRangeRowProps) {
  const { t } = useTranslation("common");
  const low = from ?? 0;
  const high = until ?? MAX_ZOOM;
  const zoom = Math.min(Math.max(mapZoom, 0), MAX_ZOOM);
  const zoomTo = useZoomTo();
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const [onPointer, setOnPointer] = useState(false);
  const zoomAt = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const t = rect.width ? (event.clientX - rect.left) / rect.width : 0;
    return Math.min(MAX_ZOOM, Math.max(0, t * MAX_ZOOM));
  };
  // Within a few px of the map zoom's pointer.
  const nearPointer = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.abs(((zoomAt(event) - zoom) / MAX_ZOOM) * rect.width) <= 6;
  };
  return (
    <Row label={label ?? t("style_editor.visible")}>
      {/* Room under the track for the map zoom's pointer and its number. */}
      <Box sx={{ flex: 1, minWidth: 0, px: 2.5, pb: 3 }}>
        {/* The track's own width: the layer's range, the pointer and the slider share it. */}
        <Box sx={{ position: "relative" }}>
          {layerRange && (
            <Box
              sx={{
                position: "absolute",
                top: "50%",
                height: 4,
                mt: "-2px",
                left: `${(layerRange[0] / MAX_ZOOM) * 100}%`,
                width: `${((layerRange[1] - layerRange[0]) / MAX_ZOOM) * 100}%`,
                bgcolor: "action.hover",
              }}
            />
          )}
          {zoomTo ? (
            <Box
              data-zoom-strip
              onPointerMove={(event) => {
                if (drag) return zoomTo(Math.round(zoomAt(event) * 10) / 10, false);
                const near = nearPointer(event);
                setOnPointer(near);
                setHover(near ? null : Math.round(zoomAt(event) * 2) / 2);
              }}
              onPointerDown={(event) => {
                setHover(null);
                if (nearPointer(event)) {
                  setDrag(true);
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                } else zoomTo(Math.round(zoomAt(event) * 2) / 2, true);
              }}
              onPointerUp={(event) => {
                setDrag(false);
                event.currentTarget.releasePointerCapture?.(event.pointerId);
              }}
              onPointerLeave={() => {
                setHover(null);
                setOnPointer(false);
              }}
              sx={{
                position: "absolute",
                top: "calc(50% + 5.5px)",
                left: 0,
                right: 0,
                height: 12,
                zIndex: 1,
                cursor: drag || onPointer ? "ew-resize" : "pointer",
                touchAction: "none",
              }}>
              <ZoomPointer zoom={zoom} label />
              {hover !== null && <ZoomPointer zoom={hover} label ghost />}
            </Box>
          ) : (
            <ZoomPointer zoom={zoom} label />
          )}
          <Slider
            size="small"
            min={0}
            max={MAX_ZOOM}
            step={1}
            value={[low, high]}
            getAriaLabel={(index) => t(index === 0 ? "style_editor.zoom_from" : "style_editor.zoom_until")}
            onChange={(_, next) => {
              const [a, b] = next as number[];
              onChange(a <= 0 ? undefined : a, b >= MAX_ZOOM ? undefined : b);
            }}
          />
        </Box>
      </Box>
      <Typography
        variant="caption"
        color="text.secondary"
        noWrap
        sx={{ flex: "none", minWidth: 52, textAlign: "right", pl: 3 }}>
        {t("style_editor.zoom_from_to", { from: low, until: high })}
      </Typography>
    </Row>
  );
});

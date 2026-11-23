import { Box, IconButton, Stack, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Popup, useMap } from "react-map-gl/maplibre";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { PopupProperties } from "@/lib/validations/layer";

import useLayerFields from "@/hooks/map/CommonHooks";

import type { LayerField } from "./formatFeatureProperties";
import { formatFeatureProperties } from "./formatFeatureProperties";
import { PopupBlockRenderer } from "./PopupBlockRenderer";
import { PopupFixedHost } from "./PopupFixedHost";
import { PopupHtmlStyles } from "./popupStyles";
import { sanitizePopupHtml } from "./sanitize";
import { renderTemplate } from "./renderTemplate";

export interface MapFeaturePopoverProps {
  /**
   * The project layer the feature belongs to; its field definitions drive
   * formatting. Optional so a caller with no layer can pass `fields` instead —
   * the catalog previews datasets nobody has added to a project yet, and a
   * dataset has no layer id until promote-on-use creates one.
   */
  layerId?: string;
  /** Field definitions, when the caller already holds them. */
  fields?: LayerField[];
  /**
   * Shown in the header. Optional for the same reason as `layerId`, and needed
   * by nothing when `popup.header` is `"none"` — a caller with no layer would
   * otherwise have to invent an empty name for a header that never renders.
   */
  layerName?: string;
  popup: PopupProperties;
  properties: Record<string, unknown>;
  lngLat: { lng: number; lat: number };
  onClose: () => void;
  /**
   * Icon shown next to the layer name in the popup header. Caller provides
   * a `<LayerIcon>` (or anything else) built from the layer's style so the
   * popup matches what the Layers panel shows. Omitted when there's no
   * reasonable single icon (e.g. complex categorical legends).
   */
  layerIcon?: ReactNode;
  /** A hover popup: it lets the pointer through to the map, which keeps the moves that move it along (it sits near
   * the pointer and would otherwise catch it). */
  passive?: boolean;
}

export function MapFeaturePopover(props: MapFeaturePopoverProps) {
  const { current: mapRef } = useMap();
  const body = <PopoverBody {...props} />;

  // Compute the anchor ONCE at open time based on where the feature sits
  // on screen, then pass it as a fixed prop. If we leave `anchor` unset,
  // maplibre re-evaluates on every pan and the popup flips around as the
  // user moves the map — jarring once it's already open. Re-runs only
  // when the clicked feature changes (different lngLat).
  const initialAnchor = useMemo<"top" | "bottom">(() => {
    if (!mapRef) return "bottom";
    const point = mapRef.project([props.lngLat.lng, props.lngLat.lat]);
    const height = mapRef.getContainer().clientHeight;
    // Features in the top 40% of the viewport: anchor at the popup's
    // top edge so it grows downward (clears the toolbar). Otherwise
    // anchor at the bottom so it grows upward (default behavior).
    return point.y < height * 0.4 ? "top" : "bottom";
  }, [mapRef, props.lngLat.lng, props.lngLat.lat]);

  if (props.popup.layout === "pinned") {
    return <PopupFixedHost anchor={props.popup.anchor ?? "top_right"}>{body}</PopupFixedHost>;
  }
  return (
    <Popup
      longitude={props.lngLat.lng}
      latitude={props.lngLat.lat}
      anchor={initialAnchor}
      offset={24}
      closeButton={false}
      closeOnClick={false}
      onClose={props.onClose}
      maxWidth="340px"
      // A passive popup's content lets the pointer through too (MapLibre gives popup content pointer events): the map
      // host styles `goat-popup-passive`.
      className={props.passive ? "goat-feature-popup goat-popup-passive" : "goat-feature-popup"}>
      {body}
    </Popup>
  );
}

function PopoverBody({
  layerId,
  fields,
  layerName,
  popup,
  properties,
  onClose,
  layerIcon,
}: MapFeaturePopoverProps) {
  const theme = useTheme();

  return (
    <Box
      // Carries the scoped popup-content styles (popupStyles.tsx) on BOTH the
      // in-place and pinned branches — the maplibre <Popup> also sets this
      // class for in-place, but the pinned branch (PopupFixedHost) does not,
      // so it must live on the body to style custom-HTML content everywhere.
      className="goat-feature-popup"
      sx={{
        width: popup.width ?? 320,
        // Match the FloatingPanel surface used by the side panels
        // (apps/web/components/common/FloatingPanel.tsx).
        bgcolor: alpha(theme.palette.background.paper, 0.9),
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        borderRadius: "0.625rem",
        overflow: "hidden",
        boxShadow: theme.shadows[6],
        display: "flex",
        flexDirection: "column",
        maxHeight: popup.max_height ? `${popup.max_height}px` : "min(420px, 60vh)",
      }}>
      <PopupHtmlStyles />
      {popup.header !== "none" && (
        <PopupHeader
          layerName={layerName ?? ""}
          layerIcon={layerIcon}
          onClose={onClose}
          compact={popup.header === "compact"}
        />
      )}
      <PopupContent
        layerId={layerId}
        fields={fields}
        popup={popup}
        properties={properties}
      />
    </Box>
  );
}

/**
 * Standard popup header — layer icon + name + close button. Exported so
 * the mobile bottom sheet can use it for its "layerInfo" view and
 * match the desktop popup's chrome 1:1. The icon falls back to a
 * generic layers glyph when the caller doesn't pass a LayerIcon.
 */
export function PopupHeader({
  layerName,
  layerIcon,
  onClose,
  compact = false,
}: {
  layerName: string;
  layerIcon?: ReactNode;
  onClose: () => void;
  compact?: boolean;
}) {
  const theme = useTheme();
  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      sx={{
        px: 1.75,
        py: 1.75,
        flexShrink: 0,
        borderBottom: 1,
        // Note: MUI's `alpha()` replaces (not multiplies) the alpha
        // channel, so wrapping `divider` (already ~12%) in `alpha`
        // actually made the line heavier. Use a light gray derived
        // from text.primary at ~8% opacity for a softer separation
        // that adapts to light/dark themes.
        borderColor: alpha(theme.palette.text.primary, 0.08),
      }}>
      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ minWidth: 0 }}>
        {layerIcon !== undefined ? (
          // Caller supplies a LayerIcon (or any node) that matches the
          // layer's style — same affordance the Layers panel uses.
          <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            {layerIcon}
          </Box>
        ) : (
          <Icon
            iconName={ICON_NAME.LAYERS}
            style={{ fontSize: 14 }}
            htmlColor={alpha(theme.palette.text.primary, 0.5)}
          />
        )}
        {!compact && (
          <Typography
            variant="body2"
            fontWeight={600}
            sx={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
            {layerName}
          </Typography>
        )}
      </Stack>
      <IconButton
        disableRipple
        size="small"
        onClick={onClose}
        sx={{
          p: 0.5,
          ml: 1,
          color: alpha(theme.palette.text.primary, 0.55),
          "&:hover": {
            bgcolor: "transparent",
            color: theme.palette.text.primary,
          },
        }}>
        <Icon iconName={ICON_NAME.XCLOSE} style={{ fontSize: 14 }} />
      </IconButton>
    </Stack>
  );
}

/**
 * Renders the body of a popup — block list (simple mode) or sanitized
 * HTML (html mode). Extracted from `PopoverBody` so the mobile bottom
 * sheet (and any other host that already provides its own chrome)
 * can reuse the same block rendering without duplicating fetching /
 * formatting / scrolling concerns.
 *
 * `sx` overrides the scrollable container's styles. Callers that
 * already supply their own scroll affordance (e.g. the mobile drawer)
 * pass `{ overflowY: "visible", maxHeight: "none" }` to keep the host's
 * scroll behavior.
 */
export function PopupContent({
  layerId,
  fields,
  popup,
  properties,
  sx,
}: {
  /**
   * The project layer whose field definitions drive formatting. Optional so a
   * caller that has no layer can pass `fields` instead: the catalog renders this
   * body for a dataset nobody has added to a project yet, and a dataset has no
   * layer id until promote-on-use creates one.
   */
  layerId?: string;
  /** Field definitions, when the caller already holds them. */
  fields?: LayerField[];
  popup: PopupProperties;
  properties: Record<string, unknown>;
  sx?: import("@mui/material").SxProps<import("@mui/material").Theme>;
}) {
  const { i18n } = useTranslation("common");
  const theme = useTheme();
  // Called unconditionally, as a hook must be; with no id it resolves to nothing
  // and `fields` answers instead.
  const { layerFields: fetched } = useLayerFields(layerId ?? "");
  const layerFields = fields ?? fetched;
  const { byColumn } = useMemo(
    () =>
      formatFeatureProperties({
        properties,
        layerFields: layerFields as LayerField[],
        lang: i18n.language,
      }),
    [properties, layerFields, i18n.language],
  );

  const thumbColor = alpha(theme.palette.text.primary, 0.3);

  return (
    <Stack
      spacing={1}
      sx={[
        {
          px: 1.25,
          py: 1.5,
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          // Reserve an equal-width scrollbar gutter on BOTH sides so the
          // content stays centered whether or not the scrollbar is
          // visible. Without this, the right side looks more padded than
          // the left because the scrollbar eats into the content width.
          scrollbarGutter: "stable both-edges",
          // Felt-style: scrollbar invisible at rest, appears when the
          // user hovers anywhere in the scrollable body. Firefox uses
          // scrollbar-* shorthands, WebKit uses pseudo-elements.
          scrollbarWidth: "thin",
          scrollbarColor: "transparent transparent",
          transition: "scrollbar-color 180ms",
          "&:hover": {
            scrollbarColor: `${thumbColor} transparent`,
          },
          "&::-webkit-scrollbar": { width: 8, height: 8 },
          "&::-webkit-scrollbar-track": { background: "transparent" },
          "&::-webkit-scrollbar-thumb": {
            background: "transparent",
            borderRadius: 4,
            transition: "background 180ms",
          },
          "&:hover::-webkit-scrollbar-thumb": {
            background: thumbColor,
          },
          "&::-webkit-scrollbar-thumb:hover": {
            background: alpha(theme.palette.text.primary, 0.45),
          },
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}>
      {popup.mode === "simple" ? (
        popup.blocks.map((b) => (
          <PopupBlockRenderer
            key={b.id}
            block={b}
            valuesByColumn={byColumn}
            rawValues={properties}
            layerFields={layerFields as LayerField[]}
            lang={i18n.language}
          />
        ))
      ) : (
        <Box
          sx={{
            "& p": { m: 0 },
            "& > *:not(:last-child)": { mb: 1 },
          }}
          dangerouslySetInnerHTML={{
            __html: sanitizePopupHtml(renderTemplate(popup.html, byColumn)),
          }}
        />
      )}
    </Stack>
  );
}

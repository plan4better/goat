import type { LayerStyle } from "@/lib/style/generated/types";
import { popupConfigOf } from "@/lib/style/popup";
import { type PopupRaster, rasterPopupConfig } from "@/lib/style/raster/popup";
import type { PopupProperties } from "@/lib/validations/layer";

/**
 * Maps legacy popup fields (position / show_layer_header) forward onto the
 * unified layout/header model and strips the deprecated keys. Pure and
 * idempotent — safe to call at every read site. New popups (no legacy keys)
 * pass through unchanged.
 *
 * Disambiguation rule: the PRESENCE of a legacy key signals legacy data and
 * wins over the zod-defaulted `layout`/`header`, because new code never writes
 * `position` / `show_layer_header`.
 */
export function normalizePopup(popup: PopupProperties): PopupProperties {
  const next: PopupProperties = { ...popup };

  if (popup.position !== undefined) {
    next.layout = popup.position === "fixed" ? "pinned" : "popup";
  }
  if (popup.show_layer_header !== undefined) {
    next.header = popup.show_layer_header ? "standard" : "none";
  }
  if (next.layout === "pinned" && !next.anchor) {
    next.anchor = "top_right";
  }

  delete next.position;
  delete next.show_layer_header;
  return next;
}

/** A map layer's popup: its style's (spec 7.4) in today's configuration, normalized; undefined when it shows none. A
 * raster file's popup lists the cell values it was opened with (`values`, spec 9.7). */
export function layerPopup(
  layer: (PopupRaster & { style?: { document: LayerStyle } | null }) | null | undefined,
  values?: Record<string, unknown>
): PopupProperties | undefined {
  if (layer?.style?.document.kind === "raster") return values ? rasterPopupConfig(layer, values) : undefined;
  const config = popupConfigOf(layer?.style?.document);
  return config ? normalizePopup(config) : undefined;
}

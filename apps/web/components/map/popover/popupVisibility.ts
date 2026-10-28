/**
 * Popup ↔ layer-visibility reconciliation.
 *
 * A feature popup is bound to a specific layer, but its state (`popupInfo`)
 * lives in Redux independently of whether that layer is drawn. When
 * the user toggles the owning layer off in the Layers panel (or deletes it),
 * nothing clears `popupInfo` — so the popup and its active-feature pulse would
 * otherwise stay stranded on a layer the map no longer draws. These pure
 * helpers let the map hosts decide when to dismiss such an orphaned popup.
 */

/** A ProjectLayer/Layer as far as popup visibility resolution is concerned. */
export interface PopupLayerLike {
  id: string | number;
  /** ProjectLayer carries the dataset id here; plain Layer leaves it unset. */
  layer_id?: string | null;
  /** A map layer: drawn when it and every group around it are visible. */
  visible?: boolean;
}

/**
 * Find the layer that owns an open popup. `popupInfo.projectLayerId` (the
 * clicked ProjectLayer's own id, set at dispatch time) is authoritative: the
 * same dataset can back several project layers, each with its own popup
 * config, and the dataset id alone can't tell the twins apart. Fall back to
 * `popupInfo.layerId` (`layer_id ?? id` at dispatch time, matched against
 * both — ProjectLayer stores the dataset id on `layer_id` while a plain
 * Layer uses `id`) for popups dispatched without a project layer.
 */
export function findPopupLayer<T extends PopupLayerLike>(
  layerId: string | undefined,
  layers: T[] | undefined,
  projectLayerId?: string,
): T | undefined {
  if (!layers) return undefined;
  if (projectLayerId) {
    const exact = layers.find((l) => l.id.toString() === projectLayerId);
    if (exact) return exact;
  }
  if (!layerId) return undefined;
  return layers.find((l) => l.layer_id === layerId || l.id.toString() === layerId);
}

/**
 * True when an open popup should be dismissed because its owning layer is no
 * longer drawn on the map — either hidden (visibility toggled off) or removed
 * from the project.
 *
 * Returns false when `layers` is undefined (still loading / mid-refetch) so a
 * transient fetch never closes a valid popup, and false when there is no
 * `layerId` so non-layer-bound popups are left untouched. A missing
 * `visible` flag counts as drawn.
 */
export function shouldClosePopupForHiddenLayer(
  layerId: string | undefined,
  layers: PopupLayerLike[] | undefined,
  projectLayerId?: string,
): boolean {
  if (!layerId || !layers) return false;
  const layer = findPopupLayer(layerId, layers, projectLayerId);
  if (!layer) return true; // owning layer was removed from the project
  return layer.visible === false;
}

/**
 * Whether the feature-recolor highlight should be drawn for the feature whose
 * popup is currently open.
 *
 * "Highlight active feature" (`popup.highlight_active_feature`) governs ALL
 * active-object highlighting — the pulsing dot AND the feature recolor — so the
 * recolor must mirror the pulse's on/off state (both read the same flag; an
 * unset flag counts as off, exactly like the pulse's `visible` prop).
 *
 * Returns true when no popup config is active, so the shared `highlightedFeature`
 * state driven by other sources (click-to-filter, hover-to-highlight, the data
 * table, the geocoder) is left untouched.
 */
export function shouldHighlightActivePopupFeature(
  hasActivePopupConfig: boolean,
  highlightActiveFeature: boolean | undefined,
): boolean {
  if (!hasActivePopupConfig) return true;
  return Boolean(highlightActiveFeature);
}

/**
 * Whether a clicked feature on a given layer may be recolored as the "active
 * object". Highlighting requires BOTH that the layer's popup is enabled and its
 * "highlight active feature" option is on.
 *
 * This gates the click-to-filter highlight (builder/public map modes), which
 * fires on every click regardless of popup settings and would otherwise recolor
 * features even for layers whose popup — and therefore highlight — is off. Keeps
 * the promise "no popup ⇒ no highlight" while click-to-filter still filters.
 */
export function layerHighlightsActiveFeature(
  popupEnabled: boolean | undefined,
  highlightActiveFeature: boolean | undefined,
): boolean {
  return Boolean(popupEnabled) && Boolean(highlightActiveFeature);
}

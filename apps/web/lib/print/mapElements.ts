/**
 * Map elements that arrive without their project state.
 *
 * A layout template carries a map element's design but not where the author's
 * map was or which of the author's layers were locked into it (core strips
 * both: they are that project's data). Opened in another project the element
 * has no `viewState`, and if `lock_layers` is set, no snapshot to lock. The
 * same happens to a layout saved before locks existed, or copied from a
 * project whose layer ids mean nothing here. `materializeMapElements` fills
 * those in from the project the layout is opened in, once, so the map shows
 * this project's view and layers and then stays locked to them.
 */
import type { StyleSpecification } from "maplibre-gl";

import { isObject } from "@/lib/style/json";
import type { ProjectViewState } from "@/lib/validations/project";
import type { ReportElement } from "@/lib/validations/reportLayout";

import type { MapLayer } from "@/hooks/map/useMapLayers";

export interface MapElementContext {
  /** The project's initial view; undefined while it is still loading. */
  initialView?: ProjectViewState;
  /** The project's map layers; empty while they are still loading. */
  projectLayers: MapLayer[];
  /** The project's basemap as the map element would render it. */
  basemapUrl?: string | StyleSpecification;
}

type MapConfig = Record<string, unknown>;

/** The layers the project's map draws (their own and their groups' visibility). */
export const visibleProjectLayers = (layers: MapLayer[]): MapLayer[] =>
  layers.filter((layer) => layer.visible);

/**
 * The lock snapshot for `config` taken from `layers` (the project's visible
 * layers): which layers, the basemap, and, with `lock_styles`, each layer's
 * active style document frozen as it is now. Clears the snapshot when layers
 * are not locked.
 */
export const lockSnapshot = (
  config: MapConfig,
  layers: MapLayer[],
  basemapUrl: string | StyleSpecification | undefined
): MapConfig => {
  if (config.lock_layers !== true) {
    return {
      ...config,
      locked_layer_ids: undefined,
      locked_layer_styles: undefined,
      locked_basemap_url: undefined,
    };
  }
  const styles: Record<number, unknown> = {};
  if (config.lock_styles === true) {
    for (const layer of layers) if (layer.style) styles[layer.id] = structuredClone(layer.style.document);
  }
  return {
    ...config,
    locked_layer_ids: layers.map((layer) => layer.id),
    locked_basemap_url: basemapUrl,
    locked_layer_styles: config.lock_styles === true ? styles : undefined,
  };
};

const hasView = (config: MapConfig): boolean => {
  const view = config.viewState as Record<string, unknown> | undefined;
  return (
    typeof view?.latitude === "number" &&
    typeof view?.longitude === "number" &&
    typeof view?.zoom === "number"
  );
};

/** A frozen style the renderer can draw: a GOAT Style document. A snapshot taken before GOAT Style holds layer
 * properties instead, and the live style is drawn. */
const frozenDocument = (value: unknown) => (isObject(value) && value.version === 1 ? value : undefined);

/**
 * The layers a map element draws: the locked ones (shown whatever the project's
 * visibility is now, with their frozen documents when styles are locked), else
 * the project's drawn layers with their live styles; `hide` leaves out an atlas
 * page's coverage layer.
 */
export const mapElementLayers = (
  layers: MapLayer[],
  config: MapConfig,
  opts: { hide?: number } = {}
): MapLayer[] => {
  const lockedIds =
    config.lock_layers === true ? (config.locked_layer_ids as number[] | undefined) : undefined;
  const frozen =
    lockedIds && config.lock_styles === true
      ? ((config.locked_layer_styles as Record<string, unknown> | undefined) ?? {})
      : {};
  const drawn = lockedIds
    ? layers
        .filter((layer) => lockedIds.includes(layer.id))
        .map((layer) => {
          const document = frozenDocument(frozen[String(layer.id)]);
          return {
            ...layer,
            visible: true,
            style:
              document && layer.style
                ? { ...layer.style, id: `locked:${layer.style.id}`, revision: 0, document: document as never }
                : layer.style,
          };
        })
    : visibleProjectLayers(layers);
  return opts.hide === undefined ? drawn : drawn.filter((layer) => layer.id !== opts.hide);
};

/** A locked map whose snapshot names none of this project's layers. */
const snapshotIsForeign = (config: MapConfig, projectLayers: MapLayer[]): boolean => {
  if (config.lock_layers !== true) return false;
  const ids = config.locked_layer_ids as number[] | undefined;
  if (!ids) return true;
  const known = new Set(projectLayers.map((layer) => layer.id));
  return !ids.some((id) => known.has(id));
};

/**
 * Fill in what a map element lacks from the project it is opened in: the
 * project's initial view when it has none, and a lock snapshot of the
 * project's visible layers when `lock_layers` is set but the snapshot is
 * missing or belongs to another project. Waits for the view and the layers to
 * load rather than filling in defaults. Returns the same array when no
 * element needs to change.
 */
export const materializeMapElements = (
  elements: ReportElement[],
  ctx: MapElementContext
): ReportElement[] => {
  let changed = false;
  const next = elements.map((element) => {
    if (element.type !== "map") return element;
    let config = (element.config ?? {}) as MapConfig;

    if (!hasView(config) && ctx.initialView) {
      const { latitude, longitude, zoom, bearing, pitch } = ctx.initialView;
      config = {
        ...config,
        viewState: { latitude, longitude, zoom, bearing: bearing ?? 0, pitch: pitch ?? 0 },
      };
    }
    if (ctx.projectLayers.length > 0 && snapshotIsForeign(config, ctx.projectLayers)) {
      config = lockSnapshot(config, visibleProjectLayers(ctx.projectLayers), ctx.basemapUrl);
    }

    if (config === element.config) return element;
    changed = true;
    return { ...element, config };
  });
  return changed ? next : elements;
};

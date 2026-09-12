/* eslint-disable @typescript-eslint/no-explicit-any */
import { setColorFunction } from "@geomatico/maplibre-cog-protocol";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { FilterSpecification } from "maplibre-gl";
import type { LayerProps, MapGeoJSONFeature } from "react-map-gl/maplibre";
import { Layer as MapLayer, Source, useMap } from "react-map-gl/maplibre";

import { GEOAPI_BASE_URL, SYSTEM_LAYERS_IDS } from "@/lib/constants";
import {
  buildClusterBadgeSpec,
  buildClusterCirclePaint,
  buildClusterCountTextSpec,
  buildClusterMarkerIconColor,
  buildClusterMarkerIconExpression,
  buildClusterSourceProps,
  getClusterGeoJsonUrl,
  isClusteringEnabled,
} from "@/lib/transformers/cluster";
import {
  getHightlightStyleSpec,
  getSymbolStyleSpec,
  transformToMapboxLayerStyleSpec,
} from "@/lib/transformers/layer";
import { addOrUpdateMarkerImages, loadImage } from "@/lib/transformers/map-image";
import { transformToLineDecorationLayers } from "@/lib/transformers/lineStyle";
import { computeStackOrder, resolveTarget } from "@/lib/utils/map/basemapLayers";
import { generateCOGColorFunction } from "@/lib/utils/map/cog-styling";
import { getLayerKey, selectDataLayers } from "@/lib/utils/map/layer";
import { registerSpriteImages } from "@/lib/utils/map/registerSpriteImages";
import type {
  FeatureLayerLineProperties,
  FeatureLayerPointProperties,
  FeatureLayerProperties,
  Layer,
  RasterLayerProperties,
} from "@/lib/validations/layer";
import type { BasemapLayerConfig, ProjectLayer } from "@/lib/validations/project";

import { useAppSelector } from "@/hooks/store/ContextHooks";

interface LayersProps {
  layers?: ProjectLayer[] | Layer[];
  highlightFeature?: MapGeoJSONFeature | null;
  /**
   * Atlas-driven filter applied client-side to the matching layer's MapLibre
   * filter. Lets the report renderer restrict the coverage layer to the
   * current atlas page's feature without changing the tile URL (which would
   * trigger setTiles() and refetch the entire tile cache on every page).
   */
  atlasFilter?: { layerId: number; featureId: string | number };
}

const Layers = (props: LayersProps) => {
  const { current: mapRef } = useMap();
  const temporaryFilters = useAppSelector((state) => state.map.temporaryFilters);
  const mapMode = useAppSelector((state) => state.map.mapMode);
  const pendingFeatures = useAppSelector((state) => state.featureEditor.pendingFeatures);
  const editLayerId = useAppSelector((state) => state.featureEditor.activeLayerId);
  const activeBasemap = useAppSelector((state) => state.map.activeBasemap);
  const basemapLayerConfigOverride = useAppSelector((state) => state.map.basemapLayerConfigOverride);
  const basemapLayerConfig = useMemo<BasemapLayerConfig>(() => {
    // Live preview (dialog open) takes precedence over the persisted config.
    if (basemapLayerConfigOverride !== undefined) {
      return basemapLayerConfigOverride;
    }
    if (
      activeBasemap &&
      activeBasemap.source === "custom" &&
      activeBasemap.type === "vector"
    ) {
      return (activeBasemap.layer_config as BasemapLayerConfig | undefined) ?? {};
    }
    return {};
  }, [activeBasemap, basemapLayerConfigOverride]);

  // Get editing layer to copy its style to the overlay
  const editingLayer = useMemo(() => {
    if (!editLayerId || !props.layers) return null;
    return props.layers.find((l) => (l as ProjectLayer).layer_id === editLayerId) as ProjectLayer | undefined;
  }, [editLayerId, props.layers]);

  // Build list of feature IDs to hide from the tile layer (features being edited)
  const editExcludeIds = useMemo(() => {
    return Object.values(pendingFeatures)
      .filter((f) => f.action === "update" || f.action === "delete")
      .map((f) => f.id);
  }, [pendingFeatures]);

  // Build GeoJSON FeatureCollection from pending features for overlay rendering
  const pendingGeoJSON = useMemo(() => {
    const features = Object.values(pendingFeatures)
      .filter((f) => f.geometry !== null && f.committed && f.action !== "delete" && !f.drawFeatureId)
      .map((f) => ({
        type: "Feature" as const,
        id: f.id,
        geometry: f.geometry!,
        properties: { ...f.properties, _pending: true, _pendingId: f.id },
      }));
    return { type: "FeatureCollection" as const, features };
  }, [pendingFeatures]);

  // Exclude CustomLayerInterface from LayerProps since our layers are always standard style layers.
  // This avoids TS errors when spreading the style spec onto <MapLayer> with minzoom/maxzoom.
  type StandardLayerProps = Exclude<LayerProps, { type: "custom" }>;

  const splitLayerFilter = (style: LayerProps) => {
    const styleWithFilter = style as any & { filter?: unknown };
    const { filter, ...layerStyleSpec } = styleWithFilter;
    return { filter, layerStyleSpec: layerStyleSpec as StandardLayerProps };
  };

  const getMapLayerFilter = (filter: unknown): FilterSpecification | undefined => {
    return Array.isArray(filter) ? (filter as FilterSpecification) : undefined;
  };

  const getLayerQueryFilter = (layer: ProjectLayer | Layer) => {
    const cqlFilter = layer["query"]?.cql;
    if (!layer["layer_id"] || mapMode === "data") return cqlFilter;

    const extendedFilter = JSON.parse(JSON.stringify(cqlFilter || {}));

    if (temporaryFilters.length > 0) {
      // Primary layer filters (filter.layer_id matches this layer)
      // Skip filters with excludeFromSourceLayer (used by click-to-filter to keep features clickable)
      const primaryFilters = temporaryFilters
        .filter((filter) => filter.layer_id === layer.id && !filter.excludeFromSourceLayer)
        .map((filter) => filter.filter);

      // Additional target filters (from multi-layer attribute filtering)
      const additionalTargetFilters = temporaryFilters
        .flatMap((f) => f.additional_targets || [])
        .filter((t) => t.layer_id === layer.id)
        .map((t) => t.filter);

      // Merge all filters
      const allFilters = [...primaryFilters, ...additionalTargetFilters];
      if (allFilters.length === 0) return extendedFilter;
      const extendedWithTemporaryFilters = {
        op: "and",
        args: allFilters,
      };
      if (extendedFilter["args"]) {
        extendedWithTemporaryFilters["args"].push(extendedFilter);
      }
      return extendedWithTemporaryFilters;
    }
    return extendedFilter;
  };

  const getFeatureTileUrl = (
    layer: ProjectLayer | Layer,
    label = false,
    decoration: "start" | "end" | "start_and_end" | "center" | null = null,
  ) => {
    const extendedQuery = getLayerQueryFilter(layer);
    const parts: string[] = [];

    if (extendedQuery && Object.keys(extendedQuery).length > 0) {
      parts.push(`filter=${encodeURIComponent(JSON.stringify(extendedQuery))}`);
    }
    if (label) {
      parts.push("label=true");
    }
    if (decoration) {
      parts.push(`decoration=${decoration}`);
    }
    // Force dynamic tiles when editing — bypasses old PMTiles that lack MVT feature IDs
    const layerId = layer["layer_id"] || layer["id"];
    if (editLayerId && editLayerId === layerId) {
      parts.push("dynamic=true");
    }
    // Cache-busting: if layer was updated within the last hour, append a version
    // param so the browser doesn't serve stale cached tiles after schema changes
    const updatedAt = layer["updated_at"];
    if (updatedAt) {
      const updatedMs = new Date(updatedAt).getTime();
      const ageMs = Date.now() - updatedMs;
      if (ageMs < 3600_000) {
        parts.push(`v=${Math.floor(updatedMs / 1000)}`);
      }
    }

    const query = parts.length > 0 ? `?${parts.join("&")}` : "";
    return `${GEOAPI_BASE_URL}/collections/${layerId}/tiles/WebMercatorQuad/{z}/{x}/{y}${query}`;
  };

  const getClusterDataUrl = (layer: ProjectLayer | Layer): string => {
    const layerId = String(layer["layer_id"] || layer["id"]);
    const extendedQuery = getLayerQueryFilter(layer);
    const filterStr =
      extendedQuery && Object.keys(extendedQuery).length > 0
        ? JSON.stringify(extendedQuery)
        : undefined;
    return getClusterGeoJsonUrl(GEOAPI_BASE_URL ?? "", layerId, filterStr);
  };

  const useDataLayers = useMemo(
    () => selectDataLayers(props.layers, SYSTEM_LAYERS_IDS) as ProjectLayer[] | Layer[],
    [props.layers]
  );

  // Lazy-load clustered (GeoJSON) layers: their source downloads the full
  // dataset (/items?limit=100000) eagerly on mount, so we only mount it once a
  // layer has been made visible — and keep it mounted afterwards so re-toggling
  // never refetches. Vector-tile layers don't need this (MapLibre skips tiles
  // for hidden layers). Tracks the set of layer ids that have ever been visible.
  const [revealedLayerIds, setRevealedLayerIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const nowVisible = (props.layers ?? [])
      .filter((l) => (l.properties as { visibility?: boolean } | undefined)?.visibility)
      .map((l) => String(l.id));
    if (nowVisible.length === 0) return;
    setRevealedLayerIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of nowVisible) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [props.layers]);

  // Map of icon-image name (`${layer.id}-${marker.name}`) → url+sdf for
  // lazy loading via styleimagemissing. The eager useEffect below preloads
  // these, but for cluster symbol layers the eager load can lose the race —
  // MapLibre's addBucket throws if the image isn't in the atlas at bucket
  // creation time. styleimagemissing is the official escape hatch.
  const markerImagesRef = useRef<Record<string, { url: string; sdf: boolean }>>({});
  useEffect(() => {
    const map: Record<string, { url: string; sdf: boolean }> = {};
    props.layers?.forEach((layer) => {
      if (
        layer.type === "feature" &&
        layer.feature_layer_geometry_type === "point" &&
        layer.properties?.["custom_marker"]
      ) {
        const pointProps = layer.properties as FeatureLayerPointProperties;
        const allMarkers = [
          pointProps.marker,
          ...(pointProps.marker_mapping ?? []).map((m) => m[1]),
        ];
        allMarkers.forEach((marker) => {
          if (marker?.url && marker?.name) {
            map[`${layer.id}-${marker.name}`] = {
              url: marker.url,
              sdf: marker.source === "library",
            };
          }
        });
      }
    });
    markerImagesRef.current = map;
  }, [props.layers]);

  // styleimagemissing: when MapLibre encounters an unknown icon-image,
  // resolve it lazily from the layer's marker config.
  useEffect(() => {
    if (!mapRef) return;
    const map = mapRef.getMap();
    const handler = (e: { id: string }) => {
      const info = markerImagesRef.current[e.id];
      if (info && !map.hasImage(e.id)) {
        loadImage(mapRef, info.url, e.id, info.sdf);
      }
    };
    map.on("styleimagemissing", handler);
    return () => {
      map.off("styleimagemissing", handler);
    };
  }, [mapRef]);

  // Ensure marker images are loaded for custom marker layers.
  // Icons are initially loaded in handleMapLoad, but layers toggled on later
  // need their images loaded on demand (otherwise MapLibre silently skips them).
  useEffect(() => {
    if (!mapRef || !props.layers?.length) return;
    const map = mapRef.getMap();

    const loadMissingMarkerImages = () => {
      props.layers?.forEach((layer) => {
        if (
          layer.type === "feature" &&
          layer.feature_layer_geometry_type === "point" &&
          layer.properties?.["custom_marker"]
        ) {
          const pointProperties = layer.properties as FeatureLayerPointProperties;
          const markers = [pointProperties.marker];
          pointProperties.marker_mapping?.forEach((markerMap) => {
            if (markerMap && markerMap[1]) markers.push(markerMap[1]);
          });
          const hasMissing = markers.some(
            (marker) => marker && marker.name && !map.hasImage(`${layer.id}-${marker.name}`)
          );
          if (hasMissing) {
            addOrUpdateMarkerImages(layer.id, pointProperties, mapRef);
          }
        }
      });
    };

    if (map.isStyleLoaded()) {
      loadMissingMarkerImages();
    } else {
      map.once("styledata", loadMissingMarkerImages);
      return () => {
        map.off("styledata", loadMissingMarkerImages);
      };
    }
  }, [props.layers, mapRef]);

  // Register decoration sprites (e.g. the arrow used for line decorations).
  // SDF icons let `icon-color` tint per-layer. Re-register on style reloads
  // because basemap changes wipe registered images.
  useEffect(() => {
    if (!mapRef) return;
    const map = mapRef.getMap();

    const register = () => {
      void registerSpriteImages(map);
    };
    if (map.isStyleLoaded()) {
      register();
    } else {
      map.once("load", register);
    }
    map.on("styledata", register);
    return () => {
      map.off("load", register);
      map.off("styledata", register);
    };
  }, [mapRef]);

  // Render in reverse order for correct initial stacking (MapLibre stacks bottom-to-top).
  // Reordering is handled imperatively via map.moveLayer() to avoid cross-Source timing
  // issues with beforeId (layers in different Sources don't mount synchronously).
  const reversedDataLayers = useMemo(
    () => (useDataLayers ? [...useDataLayers].reverse() : []),
    [useDataLayers]
  );

  // Imperatively reorder layers when the stack has to be re-sorted: a drag
  // changes the order, and any edit to a layer (a rename, a style change)
  // remounts its Source — the key below carries `updated_at` — which re-adds
  // its MapLibre layers on top of everything whatever the tree says.
  const prevOrderRef = useRef<string>("");
  useEffect(() => {
    if (!mapRef || !useDataLayers || useDataLayers.length < 2) return;

    const orderKey = useDataLayers.map((l) => `${l.id}:${l.updated_at || ""}`).join(",");
    // On initial mount, just record the order (reversed rendering handles it)
    if (!prevOrderRef.current) {
      prevOrderRef.current = orderKey;
      return;
    }
    // Skip if neither the order nor any layer has changed
    if (orderKey === prevOrderRef.current) return;
    prevOrderRef.current = orderKey;

    const map = mapRef.getMap();
    const reorder = () => {
      const styleLayers = map.getStyle()?.layers || [];

      // For each data layer, find all MapLibre layers sharing its source
      const desiredTopToBottom: string[] = [];
      for (const layer of useDataLayers) {
        const mainLayerId = layer.id.toString();
        const mainLayer = styleLayers.find((l) => l.id === mainLayerId);
        if (!mainLayer || !("source" in mainLayer)) continue;
        const sourceId = mainLayer.source;
        // Collect all layers with this source (styleLayers is bottom-to-top, reverse for top-to-bottom)
        const group = styleLayers
          .filter((l) => "source" in l && l.source === sourceId)
          .map((l) => l.id)
          .reverse();
        desiredTopToBottom.push(...group);
      }

      // Reorder by moving each layer before the previous one in the desired order
      for (let i = 1; i < desiredTopToBottom.length; i++) {
        try {
          map.moveLayer(desiredTopToBottom[i], desiredTopToBottom[i - 1]);
        } catch {
          // Layer might not be on map yet
        }
      }
    };

    reorder();
    // A remounted Source mounts its layers after this effect has run, so the
    // pass above cannot see them yet; sort once more when the map settles.
    map.once("idle", reorder);
    return () => {
      map.off("idle", reorder);
    };
  }, [useDataLayers, mapRef]);

  // Apply basemap layer visibility and stacking for custom vector basemaps.
  // Fully declarative: reset to the basemap's pristine layer order, then apply
  // the current config — so toggling off↔on and promoting↔un-promoting both
  // reflect correctly (no stuck state).
  const basemapAppliedRef = useRef(false);
  useEffect(() => {
    if (!mapRef) return;
    const map = mapRef.getMap();

    const apply = () => {
      // Gate only on the style JSON being loaded (getStyle() returns undefined
      // before that). isStyleLoaded() is the wrong gate here: it stays false
      // while any source is still fetching tiles — which is the entire window
      // in which react-map-gl mounts the user layers (each addLayer fires
      // styledata). Tile completion fires sourcedata/idle but no styledata, so
      // gating on isStyleLoaded() would skip every styledata event and leave
      // the stacking permanently unapplied. moveLayer/setLayoutProperty are
      // safe while tiles load.
      const styleLayers = map.getStyle()?.layers;
      if (!styleLayers) return;
      const hasConfig = Object.keys(basemapLayerConfig).length > 0;
      // Nothing configured and nothing was ever applied → nothing to do/restore.
      if (!hasConfig && !basemapAppliedRef.current) return;

      const allIdsBottomToTop = styleLayers.map((l) => l.id);
      const styleIds = new Set(allIdsBottomToTop);

      // User data layers (panel order top→bottom), each expanded to its source group.
      const userLayers = (useDataLayers ?? [])
        .map((layer) => {
          const mainId = layer.id.toString();
          const main = styleLayers.find((l) => l.id === mainId);
          if (!main || !("source" in main)) return null;
          const sublayers = styleLayers
            .filter((l) => "source" in l && l.source === main.source)
            .map((l) => l.id)
            .reverse();
          return { id: mainId, sublayers };
        })
        .filter(Boolean) as Array<{ id: string; sublayers: string[] }>;
      const userSubIds = new Set(userLayers.flatMap((u) => u.sublayers));

      // Overlay layers (active-feature pulse, pending-feature edits, draw
      // controls) must always sit ABOVE the data layers — they highlight/annotate
      // features, so they are neither user data nor basemap. Excluding them here
      // keeps the restack from pushing them underneath the features.
      const isOverlayId = (id: string) =>
        id.startsWith("popup-active-feature") ||
        id.startsWith("pending-features") ||
        id.startsWith("gl-draw") ||
        id.startsWith("mapbox-gl-draw") ||
        id.startsWith("__measure");

      // Basemap layers = everything that isn't a user data layer or an overlay.
      // Capture their pristine order once per basemap style (keyed by the basemap
      // layer-id set, which is stable when user layers are added/removed).
      const basemapIds = allIdsBottomToTop.filter(
        (id) => !userSubIds.has(id) && !isOverlayId(id)
      );
      const styleKey = [...basemapIds].sort().join("|");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cache = map as any;
      if (!cache.__basemapPristine || cache.__basemapPristine.key !== styleKey) {
        cache.__basemapPristine = { key: styleKey, order: basemapIds.slice() };
      }
      const pristineTopToBottom: string[] = [...cache.__basemapPristine.order]
        .reverse()
        .filter((id: string) => styleIds.has(id));

      // 1) Visibility — every basemap layer reflects config (default: visible).
      for (const id of pristineTopToBottom) {
        const desired = (basemapLayerConfig[id]?.visible ?? true) ? "visible" : "none";
        try {
          if ((map.getLayoutProperty(id, "visibility") ?? "visible") !== desired) {
            map.setLayoutProperty(id, "visibility", desired);
          }
        } catch {
          /* layer not ready */
        }
      }

      // 2) Stacking — promoted basemap layers move into the user-layer region;
      //    everything else stays below in pristine order. Resolve the target the
      //    same way computeStackOrder does, so an orphaned "below <deleted layer>"
      //    collapses to "below all" and falls through to the native-position group
      //    (rather than being promoted-but-never-placed).
      const userMainIds = new Set(userLayers.map((u) => u.id));
      const promoted = pristineTopToBottom
        .filter((id) => {
          const s = basemapLayerConfig[id];
          if (!s) return false;
          const target = resolveTarget(s.target, userMainIds);
          return !(s.relation === "below" && target === "all");
        })
        .map((id) => {
          const s = basemapLayerConfig[id];
          return { id, relation: s.relation, target: s.target };
        });
      const promotedIds = new Set(promoted.map((p) => p.id));

      const stack = computeStackOrder(userLayers, promoted); // top→bottom
      const below = pristineTopToBottom.filter((id) => !promotedIds.has(id));
      const desiredOrder = [...stack, ...below]; // full top→bottom

      basemapAppliedRef.current = hasConfig;

      if (desiredOrder.length === 0) return;

      const orderSet = new Set(desiredOrder);
      const currentRelative = allIdsBottomToTop
        .slice()
        .reverse() // style is bottom→top; compare in top→bottom
        .filter((id) => orderSet.has(id));
      const alreadyOrdered =
        currentRelative.length === desiredOrder.length &&
        currentRelative.every((id, i) => id === desiredOrder[i]);
      if (alreadyOrdered) return;

      // Place the top data/basemap layer just beneath the lowest overlay layer
      // (pulse/pending/draw) so those overlays stay on top. With no overlays
      // present, move it to the absolute top.
      const lowestOverlayId = allIdsBottomToTop.find(isOverlayId);
      try {
        if (lowestOverlayId) map.moveLayer(desiredOrder[0], lowestOverlayId);
        else map.moveLayer(desiredOrder[0]);
      } catch {
        /* not ready */
      }
      for (let i = 1; i < desiredOrder.length; i++) {
        try {
          map.moveLayer(desiredOrder[i], desiredOrder[i - 1]);
        } catch {
          /* not ready */
        }
      }
    };

    apply();
    map.on("styledata", apply);
    // Safety net: react-map-gl mounts user layers asynchronously after
    // styledata, so the map can go idle before they exist. A persistent idle
    // listener (not once() — a single shot can be consumed during that gap)
    // re-applies after everything settles; the alreadyOrdered check makes
    // repeat idle calls cheap, so pan/zoom idles cost a style scan, no
    // mutations.
    map.on("idle", apply);
    return () => {
      map.off("styledata", apply);
      map.off("idle", apply);
    };
  }, [useDataLayers, mapRef, basemapLayerConfig]);

  return (
    <>
      {reversedDataLayers.length
        ? reversedDataLayers.map((layer: ProjectLayer | Layer) =>
            (() => {
              if (layer.type === "feature") {
                if (
                  layer.feature_layer_geometry_type === "point" &&
                  isClusteringEnabled(layer)
                ) {
                  // Defer the full-dataset GeoJSON download until the layer has
                  // been visible at least once (see revealedLayerIds above).
                  const isVisible = !!(
                    layer.properties as { visibility?: boolean } | undefined
                  )?.visibility;
                  if (!isVisible && !revealedLayerIds.has(String(layer.id))) {
                    return null;
                  }
                  const pointProps = layer.properties as FeatureLayerPointProperties;
                  const isCustomMarker = !!pointProps.custom_marker;
                  const clusterSourceProps = buildClusterSourceProps(layer);
                  const dataUrl = getClusterDataUrl(layer);

                  const unclusteredFilter: FilterSpecification = ["!", ["has", "point_count"]];
                  const clusteredFilter: FilterSpecification = ["has", "point_count"];

                  // Pre-build unclustered style + filter using the EXISTING transformer path
                  const { filter: layerFilter, layerStyleSpec } = splitLayerFilter(
                    transformToMapboxLayerStyleSpec(layer) as any
                  );
                  const mapLayerFilter = getMapLayerFilter(layerFilter);
                  const { filter: labelFilter, layerStyleSpec: labelStyleSpec } = splitLayerFilter(
                    getSymbolStyleSpec((layer.properties as FeatureLayerProperties)?.text_label, layer) as any
                  );
                  const mapLabelFilter = getMapLayerFilter(labelFilter);

                  // Build edit-exclusion + atlas filter helpers (mirroring the vector branch)
                  const isEditingThisLayer = editLayerId === (layer as ProjectLayer).layer_id;
                  const mergeEditExclusion = (
                    baseFilter: FilterSpecification | undefined,
                  ): FilterSpecification | undefined => {
                    if (!isEditingThisLayer || editExcludeIds.length === 0) return baseFilter;
                    const numericIds = editExcludeIds.map(Number);
                    const excludeFilter: FilterSpecification = [
                      "!",
                      ["in", ["id"], ["literal", numericIds]],
                    ];
                    return baseFilter ? (["all", baseFilter, excludeFilter] as FilterSpecification) : excludeFilter;
                  };
                  const isAtlasCoverageLayer =
                    props.atlasFilter !== undefined && props.atlasFilter.layerId === layer.id;
                  const mergeAtlasFilter = (
                    baseFilter: FilterSpecification | undefined,
                  ): FilterSpecification | undefined => {
                    if (!isAtlasCoverageLayer) return baseFilter;
                    const featureId = Number(props.atlasFilter!.featureId);
                    const atlasFilter: FilterSpecification = ["==", ["id"], featureId];
                    return baseFilter ? (["all", baseFilter, atlasFilter] as FilterSpecification) : atlasFilter;
                  };
                  const composeFilters = (
                    baseFilter: FilterSpecification | undefined,
                  ): FilterSpecification | undefined => mergeAtlasFilter(mergeEditExclusion(baseFilter));

                  const andUnclustered = (
                    base: FilterSpecification | undefined,
                  ): FilterSpecification =>
                    base ? (["all", base, unclusteredFilter] as FilterSpecification) : unclusteredFilter;

                  // GeoJSON source props (clusterRadius, clusterMaxZoom, clusterMinPoints,
                  // clusterProperties) are read once at source creation — react-map-gl's
                  // updateSource only re-sets `data` for geojson sources. Include the
                  // cluster config in the key so the source is remounted when the user
                  // changes any of these in the style panel.
                  const clusterKeySalt = JSON.stringify({
                    r: pointProps.cluster?.radius,
                    z: pointProps.cluster?.max_zoom,
                    p: pointProps.cluster?.min_points,
                    f: pointProps.marker_field?.name,
                    n: pointProps.marker_mapping?.length ?? 0,
                  });
                  return (
                    <Source
                      id={`src-${layer.id}`}
                      key={`${layer.id}-cluster-${layer.updated_at || ""}-${clusterKeySalt}`}
                      type="geojson"
                      data={dataUrl}
                      {...clusterSourceProps}
                    >
                      {/* Unclustered features: existing paint, plus the !has(point_count) filter */}
                      {!isCustomMarker && (
                        <MapLayer
                          key={getLayerKey(layer)}
                          id={layer.id.toString()}
                          minzoom={layer.properties.min_zoom || 0}
                          maxzoom={layer.properties.max_zoom || 24}
                          {...(layerStyleSpec as any)}
                          filter={andUnclustered(composeFilters(mapLayerFilter))}
                        />
                      )}
                      {isCustomMarker && (
                        <MapLayer
                          key={getLayerKey(layer)}
                          id={layer.id.toString()}
                          minzoom={layer.properties.min_zoom || 0}
                          maxzoom={layer.properties.max_zoom || 24}
                          {...(labelStyleSpec as any)}
                          filter={andUnclustered(composeFilters(mapLabelFilter))}
                        />
                      )}

                      {/* Clustered: circle bubble OR marker icon, then count badge.
                          Each Layer must be a DIRECT child of Source — react-map-gl
                          uses React.Children.map + cloneElement to inject the source
                          id, which doesn't traverse fragments. Layer ids differ
                          between the two branches (-cluster-bubble vs -cluster-icon)
                          because react-map-gl's render-phase getLayer() will hit the
                          old layer before its cleanup runs, and asserts on type
                          mismatch ("layer type changed") if circle→symbol toggles.
                          All cluster sub-layers inherit the parent layer's visibility
                          and min/max zoom so the layer's eye-icon toggle hides them. */}
                      {!isCustomMarker && (
                        <MapLayer
                          key={`${layer.id}-cluster-bubble`}
                          id={`${layer.id}-cluster-bubble`}
                          type="circle"
                          minzoom={layer.properties.min_zoom || 0}
                          maxzoom={layer.properties.max_zoom || 24}
                          layout={{
                            visibility: layer.properties.visibility ? "visible" : "none",
                          }}
                          paint={buildClusterCirclePaint(layer) as any}
                          filter={clusteredFilter}
                        />
                      )}
                      {!isCustomMarker && (
                        <MapLayer
                          key={`${layer.id}-cluster-count`}
                          id={`${layer.id}-cluster-count`}
                          type="symbol"
                          minzoom={layer.properties.min_zoom || 0}
                          maxzoom={layer.properties.max_zoom || 24}
                          layout={{
                            ...(buildClusterCountTextSpec(layer).layout as any),
                            visibility: layer.properties.visibility ? "visible" : "none",
                          }}
                          paint={buildClusterCountTextSpec(layer).paint as any}
                          filter={clusteredFilter}
                        />
                      )}
                      {isCustomMarker && (
                        <MapLayer
                          key={`${layer.id}-cluster-icon`}
                          id={`${layer.id}-cluster-icon`}
                          type="symbol"
                          minzoom={layer.properties.min_zoom || 0}
                          maxzoom={layer.properties.max_zoom || 24}
                          layout={{
                            visibility: layer.properties.visibility ? "visible" : "none",
                            "icon-image": buildClusterMarkerIconExpression(layer) as any,
                            "icon-allow-overlap": true,
                            "icon-ignore-placement": true,
                            // Match the unclustered marker size (marker_size/200, see
                            // getMapboxStyleSize) so the cluster icon and unclustered
                            // marker visually agree.
                            "icon-size": (pointProps.marker_size ?? 10) / 200,
                          }}
                          paint={{
                            ...(buildClusterMarkerIconColor(layer)
                              ? { "icon-color": buildClusterMarkerIconColor(layer) as string }
                              : {}),
                            "icon-opacity-transition": { duration: 0, delay: 0 },
                          }}
                          filter={clusteredFilter}
                        />
                      )}
                      {isCustomMarker && (
                        <MapLayer
                          key={`${layer.id}-cluster-badge`}
                          id={`${layer.id}-cluster-badge`}
                          type="symbol"
                          minzoom={layer.properties.min_zoom || 0}
                          maxzoom={layer.properties.max_zoom || 24}
                          layout={{
                            ...(buildClusterBadgeSpec(layer).layout as any),
                            visibility: layer.properties.visibility ? "visible" : "none",
                          }}
                          paint={buildClusterBadgeSpec(layer).paint as any}
                          filter={clusteredFilter}
                        />
                      )}
                    </Source>
                  );
                }

                const { filter: layerFilter, layerStyleSpec } = splitLayerFilter(
                  transformToMapboxLayerStyleSpec(layer) as any
                );
                const mapLayerFilter = getMapLayerFilter(layerFilter);
                const { filter: strokeFilter, layerStyleSpec: strokeStyleSpec } = splitLayerFilter(
                  transformToMapboxLayerStyleSpec({
                    ...layer,
                    feature_layer_geometry_type: "line",
                    properties: {
                      ...layer.properties,
                      opacity: 1,
                      visibility:
                        layer.properties?.visibility &&
                        (layer.properties as FeatureLayerProperties)?.stroked,
                    },
                  }) as any
                );
                const mapStrokeFilter = getMapLayerFilter(strokeFilter);

                const { filter: labelFilter, layerStyleSpec: labelStyleSpec } = splitLayerFilter(
                  getSymbolStyleSpec((layer.properties as FeatureLayerProperties)?.text_label, layer) as any
                );
                const mapLabelFilter = getMapLayerFilter(labelFilter);

                const needsLabel =
                  layer.feature_layer_geometry_type === "polygon" &&
                  !!(layer.properties as FeatureLayerProperties)?.text_label;

                // Build exclusion filter for features being edited on this layer
                const isEditingThisLayer = editLayerId === (layer as ProjectLayer).layer_id;
                const mergeEditExclusion = (baseFilter: FilterSpecification | undefined): FilterSpecification | undefined => {
                  if (!isEditingThisLayer || editExcludeIds.length === 0) return baseFilter;
                  // Exclude by MVT feature ID (rowid+1). IDs are always numeric.
                  const numericIds = editExcludeIds.map(Number);
                  const excludeFilter: FilterSpecification = [
                    "!",
                    ["in", ["id"], ["literal", numericIds]],
                  ];
                  if (baseFilter) {
                    return ["all", baseFilter, excludeFilter] as FilterSpecification;
                  }
                  return excludeFilter;
                };

                // Atlas filter: restrict the coverage layer to the current
                // atlas page's feature. Uses MVT feature ID (rowid+1) to match
                // the existing convention. Applied client-side so the tile URL
                // is unchanged across page navigation.
                const isAtlasCoverageLayer =
                  props.atlasFilter !== undefined && props.atlasFilter.layerId === layer.id;
                const mergeAtlasFilter = (
                  baseFilter: FilterSpecification | undefined,
                ): FilterSpecification | undefined => {
                  if (!isAtlasCoverageLayer) return baseFilter;
                  const featureId = Number(props.atlasFilter!.featureId);
                  const atlasFilter: FilterSpecification = ["==", ["id"], featureId];
                  if (baseFilter) {
                    return ["all", baseFilter, atlasFilter] as FilterSpecification;
                  }
                  return atlasFilter;
                };

                const composeFilters = (
                  baseFilter: FilterSpecification | undefined,
                ): FilterSpecification | undefined =>
                  mergeAtlasFilter(mergeEditExclusion(baseFilter));

                // Only send ?decoration=... when decoration is actually enabled
                // for the layer — sending it when type === "none" forces dynamic
                // tile generation on the backend (PMTiles is bypassed if the
                // request has a decoration param).
                const lineProps =
                  layer.feature_layer_geometry_type === "line"
                    ? (layer.properties as FeatureLayerLineProperties | undefined)
                    : undefined;
                const decorationParam =
                  lineProps?.decoration_type &&
                  lineProps.decoration_type !== "none" &&
                  lineProps.decoration_placement &&
                  lineProps.decoration_placement !== "repeat"
                    ? (lineProps.decoration_placement as "start" | "end" | "start_and_end" | "center")
                    : null;

                return (
                  <Source
                    id={`src-${layer.id}`}
                    key={`${layer.id}-${layer.updated_at || ""}`}
                    type="vector"
                    tiles={[getFeatureTileUrl(layer, needsLabel, decorationParam)]}
                    maxzoom={14}>
                    {!layer.properties?.["custom_marker"] && (
                      <MapLayer
                        key={getLayerKey(layer)}
                        minzoom={layer.properties.min_zoom || 0}
                        maxzoom={layer.properties.max_zoom || 24}
                        id={layer.id.toString()}
                        {...(layerStyleSpec as any)}
                        {...(composeFilters(mapLayerFilter) ? { filter: composeFilters(mapLayerFilter) } : {})}
                        source-layer="default"
                      />
                    )}
                    {layer.feature_layer_geometry_type === "line" &&
                      transformToLineDecorationLayers(layer).map((decoSpec) => (
                        <MapLayer
                          key={`${decoSpec.id}-${layer.updated_at || ""}`}
                          id={decoSpec.id}
                          minzoom={layer.properties.min_zoom || 0}
                          maxzoom={layer.properties.max_zoom || 24}
                          type="symbol"
                          layout={decoSpec.layout as any}
                          paint={decoSpec.paint as any}
                          {...(composeFilters(mapLayerFilter) ? { filter: composeFilters(mapLayerFilter) } : {})}
                          source-layer={decoSpec.sourceLayer}
                        />
                      ))}
                    {layer.feature_layer_geometry_type === "polygon" && (
                      <MapLayer
                        key={`stroke-${layer.id.toString()}`}
                        id={`stroke-${layer.id.toString()}`}
                        minzoom={layer.properties.min_zoom || 0}
                        maxzoom={layer.properties.max_zoom || 24}
                        {...(strokeStyleSpec as any)}
                        {...(composeFilters(mapStrokeFilter) ? { filter: composeFilters(mapStrokeFilter) } : {})}
                        source-layer="default"
                      />
                    )}

                    {/* Labels for all layers that aren't a custom marker*/}
                    {((layer.properties as FeatureLayerProperties)?.text_label ||
                      layer.properties?.["custom_marker"]) && (
                      <MapLayer
                        key={
                          layer.properties?.["custom_marker"] ? getLayerKey(layer) : `text-label-${layer.id}`
                        }
                        id={
                          layer.properties?.["custom_marker"] ? layer.id.toString() : `text-label-${layer.id}`
                        }
                        source-layer={
                          layer.feature_layer_geometry_type === "polygon" ? "default_anchor" : "default"
                        }
                        minzoom={layer.properties.min_zoom || 0}
                        maxzoom={layer.properties.max_zoom || 24}
                        {...(labelStyleSpec as any)}
                        {...(layer.properties?.["custom_marker"] || layer.feature_layer_geometry_type === "polygon"
                          ? (composeFilters(mapLabelFilter) ? { filter: composeFilters(mapLabelFilter) } : {})
                          : (mapLabelFilter ? { filter: mapLabelFilter } : {})
                        )}
                      />
                    )}

                    {/* HighlightLayer */}
                    {props.highlightFeature &&
                      props.highlightFeature.layer.id === layer.id.toString() && (
                        <MapLayer
                          id={`highlight-${layer.id}`}
                          source-layer="default"
                          {...(getHightlightStyleSpec(props.highlightFeature) as any)}
                        />
                      )}
                  </Source>
                );
              } else if (layer.type === "raster" && layer.url) {
                const rasterProperties = layer.properties as RasterLayerProperties;

                // Register color function for COG layers with custom styling
                // Only needed for color_range, categories, hillshade (not image - use native MapLibre properties)
                if (layer.data_type === "cog" && rasterProperties?.style?.style_type !== "image") {
                  const colorFunction = generateCOGColorFunction(rasterProperties.style);
                  if (colorFunction) {
                    setColorFunction(layer.url, colorFunction);
                  }
                }

                return (
                  <Source
                    id={`src-${layer.id}`}
                    key={layer.id}
                    type="raster"
                    {...(layer.data_type === "cog" ? { url: `cog://${layer.url}` } : { tiles: [layer.url] })}
                    tileSize={layer.other_properties?.tile_size || 256}>
                    <MapLayer
                      key={getLayerKey(layer)}
                      id={layer.id.toString()}
                      minzoom={layer.properties?.min_zoom || 0}
                      maxzoom={layer.properties?.max_zoom || 24}
                      type="raster"
                      source-layer="default"
                      layout={{
                        visibility: layer.properties?.visibility ? "visible" : "none",
                      }}
                      paint={{
                        "raster-opacity": rasterProperties?.opacity || 1.0,
                        "raster-resampling": rasterProperties?.resampling ?? "nearest",
                        ...(rasterProperties?.style?.style_type === "image" && {
                          "raster-brightness-min": rasterProperties.style.brightness_min ?? 0,
                          "raster-brightness-max": rasterProperties.style.brightness_max ?? 1,
                          "raster-contrast": rasterProperties.style.contrast ?? 0,
                          "raster-saturation": rasterProperties.style.saturation ?? 0,
                        }),
                      }}
                    />
                  </Source>
                );
              } else {
                return null;
              }
            })()
          )
        : null}
      {/* Pending features overlay — uses editing layer's original style */}
      {editLayerId && editingLayer && pendingGeoJSON.features.length > 0 && (() => {
        const layerStyle = transformToMapboxLayerStyleSpec(editingLayer) as any & { paint?: Record<string, unknown> };
        const geomType = editingLayer.feature_layer_geometry_type;
        const isCustomMarker = !!editingLayer.properties?.["custom_marker"];
        const symbolStyle = isCustomMarker
          ? getSymbolStyleSpec(undefined, editingLayer) as any & { layout?: Record<string, unknown>; paint?: Record<string, unknown> }
          : null;

        return (
          <Source id="src-pending-features" key="pending-features" type="geojson" data={pendingGeoJSON}>
            {geomType === "polygon" && layerStyle.type === "fill" && (
              <MapLayer
                id="pending-features-fill"
                type="fill"
                paint={layerStyle.paint as Record<string, unknown>}
                filter={["==", "$type", "Polygon"]}
              />
            )}
            {(geomType === "line" || geomType === "polygon") && (
              <MapLayer
                id="pending-features-line"
                type="line"
                paint={{
                  "line-color": "#ef4444",
                  "line-dasharray": [3, 2],
                  "line-width": 2,
                }}
                filter={["any", ["==", "$type", "LineString"], ["==", "$type", "Polygon"]]}
              />
            )}
            {geomType === "point" && isCustomMarker && symbolStyle && (
              <MapLayer
                id="pending-features-ring"
                type="circle"
                paint={{
                  "circle-radius": Math.max(12, Math.round(((editingLayer.properties as Record<string, unknown>)?.marker_size as number ?? 100) / 200 * 16) + 4),
                  "circle-color": "transparent",
                  "circle-stroke-color": "#ef4444",
                  "circle-stroke-width": 2,
                }}
                filter={["==", "$type", "Point"]}
              />
            )}
            {geomType === "point" && isCustomMarker && symbolStyle && (
              <MapLayer
                id="pending-features-symbol"
                type="symbol"
                layout={{
                  ...symbolStyle.layout,
                  visibility: "visible",
                  "icon-allow-overlap": true,
                }}
                paint={symbolStyle.paint as Record<string, unknown>}
                filter={["==", "$type", "Point"]}
              />
            )}
            {geomType === "point" && !isCustomMarker && layerStyle.type === "circle" && (
              <MapLayer
                id="pending-features-circle"
                type="circle"
                paint={layerStyle.paint as Record<string, unknown>}
                filter={["==", "$type", "Point"]}
              />
            )}
            {/* Fallbacks if style type doesn't match */}
            {geomType === "polygon" && layerStyle.type !== "fill" && (
              <MapLayer
                id="pending-features-fill"
                type="fill"
                paint={{ "fill-color": "#ef4444", "fill-opacity": 0.15 }}
                filter={["==", "$type", "Polygon"]}
              />
            )}
            {geomType === "point" && !isCustomMarker && layerStyle.type !== "circle" && (
              <MapLayer
                id="pending-features-circle"
                type="circle"
                paint={{ "circle-radius": 6, "circle-color": "#ef4444", "circle-stroke-width": 2, "circle-stroke-color": "#fff" }}
                filter={["==", "$type", "Point"]}
              />
            )}
          </Source>
        );
      })()}
    </>
  );
};

export default Layers;

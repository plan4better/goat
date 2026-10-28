"use client";

// The development page of the style panel: one dataset layer on a map with the live preview, the panel beside it,
// and the document with its issues in a drawer. Saves go through the memory transport (processes style-check) until
// the core endpoints exist.
import { Box, Button, Drawer, Typography } from "@mui/material";
import type { Map as MaplibreMap } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Map as MapView } from "react-map-gl/maplibre";

import { useDataset } from "@/lib/api/layers";
import { getBasemapUrl } from "@/lib/constants/basemaps";
import { compileLayer, sourceKind } from "@/lib/style/compile";
import type { CompileInput, Geometry } from "@/lib/style/compile/types";
import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type SourceLayer, compileSourceFor, sourceOf } from "@/lib/style/layerSource";
import { withTileParams } from "@/lib/style/render/apply";
import { useLivePreview } from "@/lib/style/render/useLivePreview";
import { StyleSaver, bindPageLifecycle } from "@/lib/style/save";
import { createMemoryTransport, styleCheck } from "@/lib/style/transports/memory";
import { wktToBBox } from "@/lib/utils/map/crs-suggestions";
import { MAPLIBRE_MAP_OPTIONS } from "@/lib/utils/map/maplibre";

import { useStyleData } from "@/hooks/style/useStyleData";

import { StyleEditor } from "@/components/map/panels/styleEditor/StyleEditor";
import { StyleSections } from "@/components/map/panels/styleEditor/StyleSections";

const PREVIEW_ID = "dev-style";

type LayerKind = "vector" | "raster" | "service";

function parseDoc(text: string | undefined, kind: LayerKind): LayerStyle {
  try {
    const parsed = text ? JSON.parse(text) : null;
    if (parsed && typeof parsed === "object") return parsed as LayerStyle;
  } catch {
    // A broken doc parameter starts from the empty style.
  }
  return (
    kind === "vector" ? { version: 1, kind } : { version: 1, kind: "raster", render: { type: "image" } }
  ) as LayerStyle;
}

interface PreviewSetup {
  layerId: string;
  /** The dataset row: where its data comes from. */
  layer: SourceLayer;
  geometry?: Geometry;
  fields: CompileInput["fields"];
}

/** What the live preview compiles: the layer's tiles, its points when the style draws clusters, the raster file or
 * the map service. */
function previewInput(style: LayerStyle, setup: PreviewSetup): CompileInput | null {
  const source = compileSourceFor(setup.layer, { kind: sourceKind(style), id: `${PREVIEW_ID}-source` });
  if (!source) return null;
  if (source.type === "raster" || source.type === "service") return { id: PREVIEW_ID, style, source };
  return {
    id: PREVIEW_ID,
    style,
    geometry: setup.geometry,
    fields: setup.fields,
    source,
  };
}

function useDocument(store: EditorStore): LayerStyle {
  const read = () => store.document;
  return useSyncExternalStore(store.subscribe, read, read);
}

/** Keeps the map in step with the document. It is its own subscriber, so an edit renders nothing else of the page. */
function LivePreview({
  store,
  map,
  setup,
}: {
  store: EditorStore;
  map: MaplibreMap | null;
  setup: PreviewSetup;
}) {
  const style = useDocument(store);
  const input = useMemo(() => previewInput(style, setup), [style, setup]);
  useLivePreview(map, input);
  return null;
}

function DrawerContent({ store, setup }: { store: EditorStore; setup: PreviewSetup }) {
  const document = useDocument(store);
  const subscribeSaver = useCallback((listener: () => void) => store.saver.subscribe(listener), [store]);
  const readIssues = () => store.saver.issues;
  const issues = useSyncExternalStore(subscribeSaver, readIssues, readIssues);
  const json = JSON.stringify(document, null, 2);
  const input = previewInput(document, setup);
  const compiled = input ? withTileParams(compileLayer(input)) : null;
  return (
    <Box sx={{ display: "flex", gap: 2, p: 1, maxHeight: "40vh" }}>
      <Box sx={{ flex: 2, minWidth: 0, overflow: "auto" }}>
        <Button size="small" onClick={() => void navigator.clipboard?.writeText(json).catch(() => undefined)}>
          Copy
        </Button>
        <pre data-testid="style-document" style={{ margin: 0, fontSize: 12 }}>
          {json}
        </pre>
      </Box>
      <Box sx={{ flex: 2, minWidth: 0, overflow: "auto" }}>
        <Typography variant="caption">MapLibre</Typography>
        <pre data-testid="maplibre-output" style={{ margin: 0, fontSize: 12 }}>
          {compiled ? JSON.stringify({ sources: compiled.sources, layers: compiled.layers }, null, 2) : ""}
        </pre>
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, overflow: "auto" }}>
        {issues.map((issue, i) => (
          <Typography key={`${issue.path}-${i}`} variant="caption" component="p">
            {issue.level} · {issue.code} · {issue.path}: {issue.message}
          </Typography>
        ))}
      </Box>
    </Box>
  );
}

/** The document, the MapLibre output and the issues; rendered only while open, as it follows every edit. */
function DocumentDrawer({ store, setup }: { store: EditorStore; setup: PreviewSetup }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="small"
        variant="outlined"
        onClick={() => setOpen(!open)}
        sx={{ position: "absolute", left: 8, top: 8, bgcolor: "background.paper" }}>
        Document
      </Button>
      <Drawer anchor="bottom" open={open} onClose={() => setOpen(false)} variant="persistent">
        {open && <DrawerContent store={store} setup={setup} />}
      </Drawer>
    </>
  );
}

type Dataset = NonNullable<ReturnType<typeof useDataset>["dataset"]>;

/** The id of a layer given by its address: the style check takes a dataset id, and services are checked without
 * data. */
const ADDRESS_ID = "00000000-0000-0000-0000-000000000000";

/** A map service given by its address, drawn without a GOAT dataset. A raster file opens as its layer: the raster
 * service reads only the address a layer stores. */
function addressDataset(service?: string, kind?: string): Dataset | undefined {
  if (service) {
    const dataType = kind === "wms" || kind === "wmts" ? kind : "xyz";
    return {
      id: ADDRESS_ID,
      name: service,
      type: "raster",
      data_type: dataType,
      url: service,
    } as unknown as Dataset;
  }
  return undefined;
}

export function DevStyleEditor({
  layerId,
  initialDoc,
  service,
  kind,
}: {
  layerId: string;
  initialDoc?: string;
  service?: string;
  kind?: string;
}) {
  const address = useMemo(() => addressDataset(service, kind), [service, kind]);
  const loaded = useDataset(address ? "" : layerId);
  const dataset = address ?? loaded.dataset;
  const isLoading = !address && loaded.isLoading;
  // The style check needs the geometry, so the editor starts once the dataset is known.
  if (!dataset)
    return (
      <Typography variant="body2" sx={{ p: 2 }}>
        {isLoading ? "Loading…" : `No dataset ${layerId}`}
      </Typography>
    );
  return <DevEditor layerId={address ? address.id : layerId} dataset={dataset} initialDoc={initialDoc} />;
}

function DevEditor({
  layerId,
  dataset,
  initialDoc,
}: {
  layerId: string;
  dataset: Dataset;
  initialDoc?: string;
}) {
  const geometry = dataset.feature_layer_geometry_type as Geometry | undefined;
  const name = dataset.name ?? layerId;
  const source = useMemo(() => sourceOf(dataset as SourceLayer), [dataset]);
  const kind: LayerKind = !source ? "vector" : source.kind === "cog" ? "raster" : "service";
  const data = useStyleData({ id: layerId, name, geometry, source });
  const [store] = useState(() => {
    const document = parseDoc(initialDoc, kind);
    const saver = new StyleSaver({
      // A layer given by its address is no dataset of the style check: its saves stay here unchecked.
      transport: createMemoryTransport({
        document,
        check:
          layerId === ADDRESS_ID
            ? async (doc) => ({ document: doc, issues: [] })
            : styleCheck({ layerId, geometry }),
      }),
      document,
      revision: 1,
    });
    return new EditorStore({ saver });
  });
  // The route owns its store: leaving the page sends what is pending (the panel only shows the store).
  useEffect(() => {
    const unbind = bindPageLifecycle(store.saver);
    return () => {
      unbind();
      store.saver.flush();
      store.dispose();
    };
  }, [store]);
  const [map, setMap] = useState<MaplibreMap | null>(null);
  const [zoom, setZoom] = useState(12);
  // Closing and opening the panel is how the panel's opening is measured.
  const [panelOpen, setPanelOpen] = useState(true);
  const setup = useMemo<PreviewSetup>(
    () => ({
      layerId,
      layer: dataset as SourceLayer,
      geometry,
      fields: data.fieldTypes,
    }),
    [layerId, dataset, geometry, data.fieldTypes]
  );

  const bbox = dataset.extent ? wktToBBox(dataset.extent) : null;
  return (
    <Box sx={{ display: "flex", height: "100vh" }}>
      <Box sx={{ flex: 1, position: "relative" }}>
        <MapView
          {...MAPLIBRE_MAP_OPTIONS}
          initialViewState={
            bbox
              ? { bounds: [bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax], fitBoundsOptions: { padding: 40 } }
              : { longitude: 11.575, latitude: 48.137, zoom: 12 }
          }
          mapStyle={getBasemapUrl(null)}
          onLoad={(event) => {
            // For measurements and end-to-end tests on this page.
            (window as unknown as { styleEditorMap?: MaplibreMap }).styleEditorMap = event.target;
            setMap(event.target);
            setZoom(event.target.getZoom());
          }}
          onMoveEnd={(event) => setZoom(event.viewState.zoom)}
        />
        <LivePreview store={store} map={map} setup={setup} />
        <DocumentDrawer store={store} setup={setup} />
        <Button
          size="small"
          variant="outlined"
          onClick={() => setPanelOpen(!panelOpen)}
          sx={{ position: "absolute", left: 120, top: 8, bgcolor: "background.paper" }}>
          {panelOpen ? "Close panel" : "Open panel"}
        </Button>
      </Box>
      {/* No scroll container here: the panel's popovers open to its left, over the map. */}
      <Box sx={{ display: "flex", borderLeft: 1, borderColor: "divider" }}>
        {panelOpen && (
          <StyleEditor
            layer={{ id: layerId, name, geometry, kind }}
            store={store}
            data={data}
            map={map}
            mapZoom={zoom}>
            <StyleSections kind={kind} />
          </StyleEditor>
        )}
      </Box>
    </Box>
  );
}

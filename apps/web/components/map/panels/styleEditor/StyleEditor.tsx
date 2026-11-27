"use client";

// The style panel of one layer: header with undo and redo, the save status, damaged-data notice and the Style
// sections, with their popovers. The store belongs to its owner (the page's registry, or the dev route), which keeps
// it, and its pending save, after the panel closes.
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import type { Map as MaplibreMap } from "maplibre-gl";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { Geometry } from "@/lib/style/compile/types";
import type { EditorStore } from "@/lib/style/editor/store";
import type { Tone } from "@/lib/style/tone";

import { layerSwatchIcon } from "@/components/map/legend/StyleLegend";
import { DamagedNotice, IssuesProvider } from "@/components/map/panels/styleEditor/IssueNotice";
import { StatusLine } from "@/components/map/panels/styleEditor/StatusLine";
import { type StyleData, StyleEditorProvider } from "@/components/map/panels/styleEditor/context";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";

export interface EditorLayer {
  id: string;
  name: string;
  geometry?: Geometry;
  kind: "vector" | "raster" | "service";
}

export interface StyleEditorProps {
  layer: EditorLayer;
  store: EditorStore;
  data: StyleData;
  map: MaplibreMap | null;
  mapZoom: number;
  /** The tone of the basemap the map draws (`basemapTone`); light by default. */
  tone?: Tone;
  /** Shown under the header, outside the scrolling sections (the named styles row). */
  top?: ReactNode;
  /** Off where the host shows the header itself (the project page's layer panel). */
  header?: boolean;
  /** Off while the panel is hidden (its tab left): its popovers close, as they draw outside it. */
  shown?: boolean;
  children?: ReactNode;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Undo and redo keys within the panel only: elsewhere they belong to whoever has the focus (the feature editor). */
function useHistoryKeys(store: EditorStore, root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const panel = root.current;
    if (!panel) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) store.undo();
      else if ((key === "z" && event.shiftKey) || key === "y") store.redo();
      else return;
      event.preventDefault();
    };
    panel.addEventListener("keydown", onKey);
    return () => panel.removeEventListener("keydown", onKey);
  }, [store, root]);
}

const noSubscribe = () => () => undefined;

/** The layer's icon as every list of layers draws it, from the style being edited. */
function LayerIcon({
  layer,
  store,
  storedDocument,
  table,
  zoom,
}: {
  layer: EditorLayer;
  store: EditorStore | null;
  storedDocument?: unknown;
  table?: boolean;
  zoom: number;
}) {
  const read = () => store?.document;
  const document = useSyncExternalStore(store?.subscribe ?? noSubscribe, read, read) ?? storedDocument;
  const icon = layerSwatchIcon(
    {
      type: table ? "table" : layer.kind === "vector" ? "feature" : "raster",
      feature_layer_geometry_type: layer.geometry,
      style: document ? { document } : null,
    },
    zoom
  );
  return icon ? <Box sx={{ display: "flex", flex: "none" }}>{icon}</Box> : null;
}

export interface StyleHeaderProps {
  layer: EditorLayer;
  /** The style's store, whose document the layer's swatch draws; none while it loads and for a table. */
  store: EditorStore | null;
  /** The layer's stored style document, drawn while there is no store. */
  storedDocument?: unknown;
  /** The zoom the layer's swatch is drawn for: the legends'. */
  zoom: number;
  /** A table: its icon, and no swatch. */
  table?: boolean;
  featureCount?: number;
  /** No line under the name: what the layer holds says nothing (a table, several layers). */
  noHint?: boolean;
}

/** Undo and redo of the style's edits. */
export function HistoryButtons({ store }: { store: EditorStore }) {
  const { t } = useTranslation("common");
  const readHistory = () => `${store.canUndo}|${store.canRedo}`;
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const history = useSyncExternalStore(subscribe, readHistory, readHistory);
  const [canUndo, canRedo] = history.split("|").map((v) => v === "true");
  return (
    <>
      <Tooltip title={t("style_editor.undo")}>
        <span>
          <IconButton
            size="small"
            aria-label={t("style_editor.undo")}
            disabled={!canUndo}
            onClick={() => store.undo()}>
            <Icon iconName={ICON_NAME.UNDO} sx={{ fontSize: 14 }} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={t("style_editor.redo")}>
        <span>
          <IconButton
            size="small"
            aria-label={t("style_editor.redo")}
            disabled={!canRedo}
            onClick={() => store.redo()}>
            <Icon iconName={ICON_NAME.REDO} sx={{ fontSize: 14 }} />
          </IconButton>
        </span>
      </Tooltip>
    </>
  );
}

/** The panel's header content (prototype `.phead`): the layer's icon and name and what it holds. On the
 * project page it sits in the panel `Container`'s header, which adds the paddings and the close button. */
export function StyleHeader({
  layer,
  store,
  storedDocument,
  zoom,
  table,
  featureCount,
  noHint,
}: StyleHeaderProps) {
  const { t } = useTranslation("common");
  const kind =
    layer.kind === "vector" && layer.geometry
      ? t(`style_editor.geometry_${layer.geometry}`)
      : t(`style_editor.kind_${layer.kind}`);
  const hint =
    featureCount !== undefined
      ? `${kind} · ${t("style_editor.feature_count", { count: featureCount })}`
      : kind;
  return (
    <Box
      data-testid="layer-settings-header"
      sx={{ display: "flex", alignItems: "center", gap: 2, flex: 1, minWidth: 0 }}>
      <LayerIcon layer={layer} store={store} storedDocument={storedDocument} table={table} zoom={zoom} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography component="h2" variant="body1" fontWeight="bold" noWrap title={layer.name}>
          {layer.name}
        </Typography>
        {!noHint && (
          <Typography component="p" variant="caption" noWrap color="text.secondary">
            {hint}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

function useIssuesOf(store: EditorStore) {
  const subscribe = useCallback((listener: () => void) => store.saver.subscribe(listener), [store]);
  const read = () => store.saver.issues;
  return useSyncExternalStore(subscribe, read, read);
}

export function StyleEditor({
  layer,
  store,
  data,
  map,
  mapZoom,
  tone,
  top,
  header = true,
  shown = true,
  children,
}: StyleEditorProps) {
  const root = useRef<HTMLDivElement | null>(null);
  useHistoryKeys(store, root);
  const issues = useIssuesOf(store);

  return (
    <StyleEditorProvider store={store} data={data} mapZoom={mapZoom} map={map} tone={tone}>
      <IssuesProvider issues={issues}>
        <Box
          ref={root}
          data-style-panel
          data-testid="style-panel-body"
          sx={{
            position: "relative",
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
          }}>
          <PopoverProvider scope={store} shown={shown}>
            {header && (
              <Box sx={{ display: "flex", px: 3, pt: 4, pb: 2 }}>
                <StyleHeader layer={layer} store={store} zoom={mapZoom} featureCount={data.featureCount} />
                <HistoryButtons store={store} />
              </Box>
            )}
            {top}
            <StatusLine saver={store.saver} problemsOnly={!header} />
            <DamagedNotice />
            <Box sx={{ overflowY: "auto", flex: 1, minHeight: 0 }}>{children}</Box>
          </PopoverProvider>
        </Box>
      </IssuesProvider>
    </StyleEditorProvider>
  );
}

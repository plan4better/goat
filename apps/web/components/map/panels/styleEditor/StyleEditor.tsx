"use client";

// The style panel of one layer: header with undo and redo, the save status, damaged-data notice and the Style
// sections, with their popovers. The store belongs to its owner (the page's registry, or the dev route), which keeps
// it, and its pending save, after the panel closes.
import { Box, IconButton, Tooltip, Typography, useTheme } from "@mui/material";
import type { Map as MaplibreMap } from "maplibre-gl";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { Geometry } from "@/lib/style/compile/types";
import { MAIN_COLOR } from "@/lib/style/editor/forms";
import type { EditorStore } from "@/lib/style/editor/store";
import { DEFAULTS } from "@/lib/style/generated/defaults";

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
  /** Shown under the header, outside the scrolling sections (the named styles row). */
  top?: ReactNode;
  /** Off where the host shows the header itself (the project page's layer panel). */
  header?: boolean;
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

/** The layer's main color as a dot; gray while it varies (by zoom, attribute or classes). */
function LayerDot({ geometry, store }: { geometry: Geometry; store: EditorStore }) {
  const theme = useTheme();
  const key = MAIN_COLOR[geometry];
  const read = () => store.get(`symbol.${key}`);
  const value = useSyncExternalStore(store.subscribe, read, read);
  const color =
    value === undefined
      ? (DEFAULTS[key] as string)
      : typeof value === "string"
        ? value
        : theme.palette.text.disabled;
  return (
    <Box
      data-testid="layer-dot"
      style={{ backgroundColor: color }}
      sx={{ width: 12, height: 12, borderRadius: "50%", flex: "none" }}
    />
  );
}

export interface StyleHeaderProps {
  layer: EditorLayer;
  /** The style's store: undo and redo, and the dot's color; none while it loads. */
  store: EditorStore | null;
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

/** The panel's header content (prototype `.phead`): the layer's dot and name and what it holds. On the
 * project page it sits in the panel `Container`'s header, which adds the paddings and the close button. */
export function StyleHeader({ layer, store, featureCount, noHint }: StyleHeaderProps) {
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
      {layer.geometry && store && <LayerDot geometry={layer.geometry} store={store} />}
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
  top,
  header = true,
  children,
}: StyleEditorProps) {
  const root = useRef<HTMLDivElement | null>(null);
  useHistoryKeys(store, root);
  const issues = useIssuesOf(store);

  return (
    <StyleEditorProvider store={store} data={data} mapZoom={mapZoom} map={map}>
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
          <PopoverProvider scope={store}>
            {header && (
              <Box sx={{ display: "flex", px: 3, pt: 4, pb: 2 }}>
                <StyleHeader layer={layer} store={store} featureCount={data.featureCount} />
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

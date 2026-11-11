"use client";

// The View button (3D spec 8.1, 8.2): a round button like Zoom's, with a cube whose top face fills in 3D. It opens the
// View popover to its left; for editors the popover drills into Sky and atmosphere, whose popovers are the style
// editor's own, placed left of the View popover (its surface is their panel).
import { Box, Fab, Popper, Tooltip, useTheme } from "@mui/material";
import type { Map as MaplibreMap, StyleSpecification } from "maplibre-gl";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";

import { BUILDINGS_TILES_URL, TERRAIN_TILES_URL } from "@/lib/constants";
import { BASEMAPS, DEFAULT_BASEMAP } from "@/lib/constants/basemaps";
import { buildingsPlan } from "@/lib/scene/buildings";
import { projectLayerOf } from "@/lib/style/render/mapLayers";

import { useSceneStoreContext } from "@/hooks/map/useSceneStore";
import { useAppSelector } from "@/hooks/store/ContextHooks";

import { SkyPanel } from "@/components/map/controls/view/SkyPanel";
import { ViewPanel, useProjectView } from "@/components/map/controls/view/ViewPanel";
import { EMPTY_DATA, StyleEditorProvider } from "@/components/map/panels/styleEditor/context";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";

/** The gap between the button and the popover, as between the style editor's popovers. */
const GAP = 12;
/** As the style editor's popovers: above the floating panels, below dialogs. */
const VIEW_Z = 1250;

/** The cube: its top face filled in 3D. */
function CubeIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <path d="M12 3 20 7.5 12 12 4 7.5z" fill={filled ? "currentColor" : "none"} />
      <path d="M4 7.5v9L12 21l8-4.5v-9M12 12v9" />
    </svg>
  );
}

/** What the View popover needs to know of the map: whether a project layer extrudes, whether the basemap has a way to
 * 3D buildings, the zoom. Read while the popover is open, again whenever the style changes. */
function useMapFacts(map: MaplibreMap | undefined, open: boolean) {
  const activeBasemap = useAppSelector((state) => state.map.activeBasemap);
  const basemap = activeBasemap ?? BASEMAPS.find((b) => b.value === DEFAULT_BASEMAP) ?? BASEMAPS[0];
  const [facts, setFacts] = useState({ projectExtrudes: false, hasBuildings: false, zoom: 0 });
  useEffect(() => {
    if (!map || !open) return;
    const read = () => {
      const style = map.getStyle() as StyleSpecification | undefined;
      const layers = style?.layers ?? [];
      const projectExtrudes = layers.some(
        (l) =>
          l.type === "fill-extrusion" && l.layout?.visibility !== "none" && !!projectLayerOf(map, l.id)
      );
      const hasBuildings =
        buildingsPlan(basemap, style, BUILDINGS_TILES_URL, (id) => projectLayerOf(map, id) !== undefined).kind !==
        "none";
      const zoom = map.getZoom();
      setFacts((prev) =>
        prev.projectExtrudes === projectExtrudes && prev.hasBuildings === hasBuildings && prev.zoom === zoom
          ? prev
          : { projectExtrudes, hasBuildings, zoom }
      );
    };
    read();
    map.on("styledata", read);
    map.on("moveend", read);
    return () => {
      map.off("styledata", read);
      map.off("moveend", read);
    };
  }, [map, open, basemap]);
  return facts;
}

export function ViewControl({ showSky }: { showSky: boolean }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { map: mapRef } = useMap();
  const map = mapRef?.getMap();
  const store = useSceneStoreContext();
  const { mode } = useProjectView();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [sky, setSky] = useState(false);
  const open = anchor !== null;
  const facts = useMapFacts(map, open);
  const close = () => {
    setAnchor(null);
    setSky(false);
  };
  if (!mapRef || !store) return null;

  return (
    <>
      <Tooltip title={open ? "" : t("view3d.title")} arrow placement="left">
        <Fab
          size="small"
          aria-label={t("view3d.title")}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={(event) => (open ? close() : setAnchor(event.currentTarget))}
          sx={{
            backgroundColor: theme.palette.background.paper,
            marginTop: theme.spacing(1),
            marginBottom: theme.spacing(1),
            pointerEvents: "all",
            color: open ? theme.palette.primary.main : theme.palette.action.active,
            "&:hover": { backgroundColor: theme.palette.background.default },
          }}>
          <CubeIcon filled={mode === "3d"} />
        </Fab>
      </Tooltip>
      <Popper
        open={open}
        anchorEl={anchor}
        placement="left-end"
        modifiers={[
          { name: "offset", options: { offset: [0, GAP] } },
          { name: "preventOverflow", options: { padding: GAP } },
        ]}
        sx={{ zIndex: VIEW_Z, pointerEvents: "all" }}>
        {/* The style editor's popovers open left of this surface, at the row that opened them. */}
        <Box
          data-style-panel
          role="dialog"
          aria-label={t(sky ? "view3d.sky" : "view3d.title")}
          sx={{ position: "relative" }}>
          <StyleEditorProvider store={store} data={EMPTY_DATA} mapZoom={facts.zoom} map={map ?? null}>
            <PopoverProvider scope={sky}>
              {sky ? (
<SkyPanel onBack={() => setSky(false)} onClose={close} />
              ) : (
                <ViewPanel
                  terrainUrl={TERRAIN_TILES_URL}
                  hasBuildings={facts.hasBuildings}
                  projectExtrudes={facts.projectExtrudes}
                  showSky={showSky}
                  onClose={close}
                  onOpenSky={() => setSky(true)}
                />
              )}
            </PopoverProvider>
          </StyleEditorProvider>
        </Box>
      </Popper>
    </>
  );
}

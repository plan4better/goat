import { Global } from "@emotion/react";
import type { Theme } from "@mui/material";
import { Box, IconButton, Stack, SwipeableDrawer, Typography, styled, useTheme } from "@mui/material";
import type { MapMovementEvent } from "maplibre-gl";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";
import "swiper/css";
import "swiper/css/pagination";
import { Pagination } from "swiper/modules";
import { Swiper, SwiperSlide } from "swiper/react";
import { v4 } from "uuid";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { DEFAULT_BASEMAP } from "@/lib/constants/basemaps";
import { setActiveRightPanel } from "@/lib/store/map/slice";
import type { ViewLayer } from "@/lib/style/render/viewLayers";
import type { CustomBasemap } from "@/lib/validations/project";
import { projectSchema } from "@/lib/validations/project";

import { MapSidebarItemID } from "@/types/map/common";

import { useDashboardLanguageOverride } from "@/hooks/dashboard/useDashboardLanguageOverride";
import { useLayerStyleChange } from "@/hooks/map/LayerStyleHooks";
import { useBasemap } from "@/hooks/map/MapHooks";
import { useCustomBasemapMutations } from "@/hooks/map/useCustomBasemapMutations";
import type { MapLayer } from "@/hooks/map/useMapLayers";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import WidgetWrapper from "@/components/builder/widgets/WidgetWrapper";
import { ProjectInfo } from "@/components/builder/widgets/information/ProjectInfo";
import Header from "@/components/header/Header";
import AttributionControl from "@/components/map/controls/Attribution";
import { BaseMapSelectorList, BasemapSelectorButton } from "@/components/map/controls/BasemapSelector";
import { CustomBasemapDialog } from "@/components/map/controls/CustomBasemapDialog";
import Scalebar from "@/components/map/controls/Scalebar";
import { UserLocation } from "@/components/map/controls/UserLocation";
import { Zoom } from "@/components/map/controls/Zoom";
import SearchControl from "@/components/map/controls/search/SearchControl";
import { usePublicSearchSource } from "@/components/map/controls/search/publicSearchLayers";
import type { PublicProjectLayoutProps } from "@/components/map/layouts/desktop/PublicProjectLayout";
import { featureSwatchIcon } from "@/components/map/legend/StyleLegend";
import PropertiesPanel from "@/components/map/panels/properties/Properties";
import SimpleLayerStyle from "@/components/map/panels/style/SimpleLayerStyle";
import { PopupContent } from "@/components/map/popover/MapFeaturePopover";
import { layerPopup } from "@/components/map/popover/normalizePopup";
import { findPopupLayer } from "@/components/map/popover/popupVisibility";

// --- Constants ---
// Height of the puller strip above the drawer paper. In the default dashboard
// view it holds only the 6px grab handle (top: 8) and the pagination dots
// (centred), so 56px left ~20px of dead space above the first widget. The
// special views render a full InfoHeader in this strip and still need the
// taller bar. Total (puller + paper) is drawerHeightRatio either way, so the
// sheet's top edge does not move when this switches.
const DRAWER_BLEEDING_DEFAULT = 40;
const DRAWER_BLEEDING_WITH_HEADER = 56;
// Fraction of the viewport the open bottom drawer covers (paper +
// puller). The paper height rule in GlobalSwiperStyles and the
// pan-into-view logic below both derive from this.
const drawerHeightRatio = 0.6;

// --- Types ---
type DrawerView = "default" | "layerInfo" | "basemapSelector" | "layerSettings";

// --- GlobalSwiperStyles (Unchanged) ---
const GlobalSwiperStyles = ({
  open,
  drawerView,
  drawerBleeding,
}: {
  open: boolean;
  drawerView: DrawerView;
  drawerBleeding: number;
}) => (
  <Global
    styles={(theme: Theme) => ({
      "#swiper-pagination-container": {
        position: "absolute",
        top: "50%", // Centered vertically within the puller area
        transform: "translateY(-50%)",
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 1, // Below Puller, above drawer content
        pointerEvents: "auto", // Allow clicking bullets
        transition: "opacity 0.3s ease-in-out, visibility 0.3s ease-in-out",
        // Show only when drawer is open AND in default view
        opacity: open && drawerView === "default" ? 1 : 0,
        visibility: open && drawerView === "default" ? "visible" : "hidden",
        ".swiper-pagination-bullet": {
          backgroundColor: theme.palette.mode === "dark" ? theme.palette.grey[400] : theme.palette.grey[600],
          opacity: 0.7,
          margin: "0 4px !important",
        },
        ".swiper-pagination-bullet-active": {
          backgroundColor: theme.palette.primary.main,
          opacity: 1,
        },
      },
      ".MuiDrawer-root > .MuiPaper-root": {
        height: `calc(${drawerHeightRatio * 100}% - ${drawerBleeding}px)`,
        overflow: "visible",
      },
    })}
  />
);

// --- Puller (Unchanged) ---
const Puller = styled("div")(({ theme }) => ({
  width: 30,
  height: 6,
  backgroundColor: theme.palette.grey[300],
  borderRadius: 3,
  position: "absolute",
  top: 8,
  left: "calc(50% - 15px)",
  zIndex: 2, // Ensure puller is above pagination
  ...theme.applyStyles("dark", {
    backgroundColor: theme.palette.grey[700],
  }),
}));

// --- InfoHeader ---
interface InfoHeaderProps {
  title: string;
  onClose: () => void;
  iconName?: ICON_NAME;
  /**
   * Optional custom icon node — e.g. a `<LayerIcon>` built from the
   * layer's style so the feature popup's header matches what the
   * Layers panel shows. Takes precedence over `iconName`.
   */
  icon?: React.ReactNode;
}
export const InfoHeader: React.FC<InfoHeaderProps> = ({ title, iconName, icon, onClose }) => {
  return (
    <Stack sx={{ pl: 4, pr: 2, pt: 2 }} direction="row" alignItems="center" justifyContent="space-between">
      <Stack direction="row" spacing={2} alignItems="center" sx={{ width: "90%" }}>
        {icon ? icon : iconName && <Icon iconName={iconName} fontSize="small" />}
        <Typography variant="body1" fontWeight="bold" noWrap>
          {title}
        </Typography>
      </Stack>
      <IconButton onClick={onClose} sx={{ pointerEvents: "all" }}>
        <Icon iconName={ICON_NAME.XCLOSE} />
      </IconButton>
    </Stack>
  );
};

// --- MobileProjectLayout component ---
const MobileProjectLayout = ({
  projectLayers = [],
  projectLayerGroups = [],
  project: _project,
  onProjectUpdate,
  viewOnly,
}: PublicProjectLayoutProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dispatch = useAppDispatch();

  // Apply dashboard language override only for public/shared view (mirrors PublicProjectLayout)
  useDashboardLanguageOverride(_project?.builder_config?.settings?.language, viewOnly);

  // Layer style change hook
  const { onOpacityChange, onStyleChange } = useLayerStyleChange(_project?.id, viewOnly);
  const project = useMemo(() => {
    const parsedProject = projectSchema.safeParse(_project);
    if (parsedProject.success) {
      return parsedProject.data;
    } else {
      console.error("Invalid project data:", parsedProject.error);
      return undefined;
    }
  }, [_project]);

  const {
    source: searchSource,
    layersById: searchLayersById,
    placeholder: searchPlaceholder,
    // The rows here are the published map's layers, with their styles.
  } = usePublicSearchSource(project, projectLayers as MapLayer[]);

  // --- State ---
  const [open, setOpen] = useState(false); // Drawer open/closed state
  const [drawerView, setDrawerView] = useState<DrawerView>("default"); // Explicit view state
  // Snapshot of the drawer's open state taken when the user enters a
  // non-default view (layerInfo / basemapSelector / layerSettings).
  // `handleCloseView` restores this so closing a special view returns
  // the drawer to its prior state instead of forcing it to stay open
  // on the default view.
  const openBeforeSpecialViewRef = useRef<boolean>(false);

  // --- Redux State ---
  const layerInfo = useAppSelector((state) => state.map.popupInfo);
  const highlightedFeature = useAppSelector((state) => state.map.highlightedFeature);
  const selectedLayerIds = useAppSelector((state) => state.layers.selectedLayerIds || []);
  const activeRightPanel = useAppSelector((state) => state.map.activeRightPanel);

  // Layer settings logic for mobile
  const activeLayer = useMemo(() => {
    if (selectedLayerIds.length === 1) {
      return projectLayers.find((l) => l.id === selectedLayerIds[0]);
    }
    return null;
  }, [selectedLayerIds, projectLayers]);

  // Resolve the popup config + layer for the currently-clicked feature.
  // Mirrors the resolution used by `MapViewer` / `MapFixedPopupSlot`:
  //  - resolve the owning layer by the clicked ProjectLayer's own id (the
  //    same dataset can back several project layers), dataset id as fallback
  //  - the popup is the layer's style's (the rows here are the published
  //    map's layers, with their styles)
  const clickedPopupLayer = useMemo(
    () => findPopupLayer(layerInfo?.layerId, projectLayers, layerInfo?.projectLayerId),
    [layerInfo?.layerId, layerInfo?.projectLayerId, projectLayers],
  );
  const activePopupConfig = useMemo(
    () => layerInfo?.popup ?? layerPopup(clickedPopupLayer as ViewLayer | undefined, layerInfo?.featureProperties),
    [clickedPopupLayer, layerInfo?.popup, layerInfo?.featureProperties]
  );
  // Layer-style icon for the popup header (same look as the Layers panel
  // and the desktop popup).
  const clickedFeatureProperties = (layerInfo?.featureProperties ??
    layerInfo?.properties) as Record<string, unknown> | undefined;
  const clickedPopupLayerIcon = useMemo(
    () => featureSwatchIcon(clickedPopupLayer as ViewLayer | undefined, clickedFeatureProperties),
    [clickedPopupLayer, clickedFeatureProperties]
  );

  // --- Hooks ---
  const { translatedBaseMaps, activeBasemap, setActiveBasemap } = useBasemap(project);
  const allowedStyles = useMemo(() => {
    const allowed = project?.builder_config?.settings?.allowed_basemaps;
    if (!allowed) return translatedBaseMaps;
    return translatedBaseMaps.filter((b) => b.source === "custom" || allowed.includes(b.value));
  }, [project?.builder_config, translatedBaseMaps]);
  // Ephemeral preview of a non-active basemap while its edit dialog is open;
  // restored on close (never persisted).
  const basemapBeforeEdit = useRef<string | null>(null);
  const mapMode = useAppSelector((state) => state.map.mapMode);
  const editable = mapMode !== "public";
  const { addCustomBasemap, editCustomBasemap, deleteCustomBasemap } =
    useCustomBasemapMutations(project, onProjectUpdate);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CustomBasemap | null>(null);
  const scrollableContentRef = useRef<HTMLDivElement | null>(null);

  // --- Panel appearance (mobile) ---
  // The bottom drawer is a single shared surface that pages through the
  // builder panels via Swiper. Mirror the desktop PanelContainer so the
  // configured panel background color (e.g. a branded yellow) is honored
  // on mobile too, instead of always falling back to background.paper.
  const panels = useMemo(
    () =>
      (project?.builder_config?.interface ?? []).filter(
        (item) => item.type === "panel" && (item?.widgets?.length ?? 0) > 0
      ),
    [project?.builder_config?.interface]
  );
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  // Inherit the panel's branded color but NOT its opacity: on desktop a panel is
  // a translucent card floating over the map, while here it backs a bottom sheet
  // the map sits behind — carrying the alpha over left the sheet see-through.
  const getPanelBgColor = (panel: (typeof panels)[number] | undefined) =>
    panel?.config?.appearance?.backgroundColor || theme.palette.background.paper;
  // Color for the shared drawer chrome (puller + content area). Use the
  // active panel's color while showing panels; fall back to the theme
  // surface for utility views (basemap selector, layer settings, popup).
  const drawerBgColor =
    drawerView === "default"
      ? getPanelBgColor(panels[activeSlideIndex] ?? panels[0])
      : theme.palette.background.paper;

  // --- Effects ---
  // Effect to handle changes in layerInfo (feature selection/deselection)
  useEffect(() => {
    if (layerInfo) {
      // Clear activeRightPanel when switching to layerInfo to prevent conflicts
      if (activeRightPanel) {
        dispatch(setActiveRightPanel(undefined));
      }

      // Snapshot the drawer state on the first transition from
      // default into any special view, so we can restore it on close.
      // Don't overwrite mid-flight (e.g. layerInfo → basemap → close).
      if (drawerView === "default") {
        openBeforeSpecialViewRef.current = open;
      }
      // When a feature is selected, switch to layerInfo view and open drawer
      setDrawerView("layerInfo");
      setOpen(true);
    } else {
      // When a feature is deselected externally (e.g. user clicks
      // empty map area → handlePopoverClose), drop back to default
      // and restore the pre-view open state.
      if (drawerView === "layerInfo") {
        setDrawerView("default");
        setOpen(openBeforeSpecialViewRef.current);
      }
    }
    // Only react to changes in layerInfo itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerInfo]);

  // Keep the tapped feature visible above the drawer. The sheet covers
  // the bottom `drawerHeightRatio` of the viewport, so a feature tapped
  // in that band would be hidden the moment the drawer opens — ease it
  // into the middle of the still-visible band. Features already above
  // the drawer stay put (no gratuitous camera movement).
  const { map } = useMap();

  // Tracks whether the camera is currently mid-flight on a search-selection
  // animation (`SearchControl`'s flyTo/fitBounds, tagged with
  // `SEARCH_CAMERA_EVENT_DATA`), as opposed to a user gesture (drag/pinch)
  // that also leaves `map.isMoving()` true. Only the former should make the
  // drawer-offset effect below wait — deferring to a user pan's `moveend`
  // would apply a stale correction to wherever the user panned away to.
  const searchCameraAnimatingRef = useRef(false);
  useEffect(() => {
    if (!map) return;
    const handleMoveStart = (event: MapMovementEvent & { searchSelection?: boolean }) => {
      if (event.searchSelection) {
        searchCameraAnimatingRef.current = true;
      }
    };
    const handleMoveEnd = () => {
      searchCameraAnimatingRef.current = false;
    };
    map.on("movestart", handleMoveStart);
    map.on("moveend", handleMoveEnd);
    return () => {
      map.off("movestart", handleMoveStart);
      map.off("moveend", handleMoveEnd);
    };
  }, [map]);

  useEffect(() => {
    if (!layerInfo || !map) return;

    const applyDrawerOffset = () => {
      const rect = map.getContainer().getBoundingClientRect();
      // Top edge of the open drawer (paper + puller), in map-container px.
      const drawerTop = window.innerHeight * (1 - drawerHeightRatio) - rect.top;
      if (drawerTop <= 0) return;
      const lngLat: [number, number] = [layerInfo.lngLat[0], layerInfo.lngLat[1]];
      if (map.project(lngLat).y <= drawerTop) return;
      map.easeTo({
        center: lngLat,
        // Land the feature in the center of the visible band above the
        // drawer (offset is relative to the map-container center).
        offset: [0, drawerTop / 2 - rect.height / 2],
        duration: 500,
      });
    };

    // A search selection's flyTo/fitBounds may still be animating the camera
    // to its own target zoom. Firing easeTo on top of that would interrupt
    // it mid-flight and stop at whatever zoom it had reached, since this
    // effect never specifies one — defer to the end of that animation
    // instead of competing with it. A plain user gesture (isMoving() true
    // for any other reason) keeps the pre-existing immediate behavior.
    if (map.isMoving() && searchCameraAnimatingRef.current) {
      map.once("moveend", applyDrawerOffset);
      return () => {
        map.off("moveend", applyDrawerOffset);
      };
    }

    applyDrawerOffset();
  }, [layerInfo, map]);

  // Effect to handle layer settings panel requests from ProjectLayerTree three dots menu
  useEffect(() => {
    if (activeRightPanel && activeLayer) {
      // Clear any existing layer info selection
      if (layerInfo) {
        layerInfo.onClose();
      }

      if (activeRightPanel === MapSidebarItemID.PROPERTIES || activeRightPanel === MapSidebarItemID.STYLE) {
        if (drawerView === "default") {
          openBeforeSpecialViewRef.current = open;
        }
        setDrawerView("layerSettings");
        setOpen(true);
      }
    }
  }, [activeRightPanel, activeLayer, layerInfo]);

  useEffect(() => {
    const isLayerSettingsPanel =
      activeRightPanel === MapSidebarItemID.PROPERTIES || activeRightPanel === MapSidebarItemID.STYLE;

    if (drawerView === "layerSettings" && (!activeLayer || !isLayerSettingsPanel)) {
      if (activeRightPanel) {
        dispatch(setActiveRightPanel(undefined));
      }
      setDrawerView("default");
      setOpen(openBeforeSpecialViewRef.current);
    }
  }, [drawerView, activeLayer, activeRightPanel, dispatch]);

  // --- Visibility Helper ---
  const hasControl = (key: string): boolean => {
    const positions = project?.builder_config?.settings?.control_positions;
    if (!positions) return false;
    return Object.values(positions).some((arr) => (arr as string[]).includes(key));
  };

  // --- Handlers ---
  const toggleDrawer = (newOpen: boolean) => () => {
    setOpen(newOpen);
  };

  // Swipe-dismiss (SwipeableDrawer onClose). Unlike the X button, a swipe
  // means "close the drawer" regardless of what was open before, so the
  // drawer stays closed — but the map state must still be cleared:
  // popupInfo left behind would block taps on other layers' features
  // (MapViewer ignores cross-layer clicks while a popup is open).
  const handleDrawerDismiss = () => {
    if (drawerView === "layerInfo" && layerInfo) {
      layerInfo.onClose();
    }
    if (activeRightPanel) {
      dispatch(setActiveRightPanel(undefined));
    }
    setDrawerView("default");
    setOpen(false);
  };

  // Handles clicks on the close ('X') button in the InfoHeader
  const handleCloseView = () => {
    // Always clear map state if layerInfo was active
    if (drawerView === "layerInfo" && layerInfo) {
      layerInfo.onClose(); // This should set layerInfo to null via Redux
    }

    // Clear activeRightPanel when closing any view to ensure clean state
    if (activeRightPanel) {
      dispatch(setActiveRightPanel(undefined));
    }

    // Reset the view to default and restore the drawer's pre-view
    // open state. If the user tapped a feature / opened basemap from
    // a closed drawer, the drawer collapses again now; if the default
    // view was already up, it stays up.
    setDrawerView("default");
    setOpen(openBeforeSpecialViewRef.current);
  };

  // Handles clicks on the BasemapSelectorButton
  const handleOpenBasemapSelector = () => {
    // Clear any existing layer info selection first
    if (layerInfo) {
      layerInfo.onClose();
    }

    // Clear activeRightPanel to prevent conflicts with layer settings
    if (activeRightPanel) {
      dispatch(setActiveRightPanel(undefined));
    }

    if (drawerView === "default") {
      openBeforeSpecialViewRef.current = open;
    }
    setDrawerView("basemapSelector");
    setOpen(true);
  };

  // Stops propagation for internal scrolling
  const handleContentTouchMove = (event: React.TouchEvent) => {
    event.stopPropagation();
  };

  // --- Derived State ---
  // Determine the title and icon for the current view in the header area
  const currentHeaderInfo = useMemo(() => {
    switch (drawerView) {
      case "layerInfo":
        return layerInfo ? { title: layerInfo.title, icon: ICON_NAME.LAYERS } : null;
      case "basemapSelector":
        return { title: t("map_style"), icon: ICON_NAME.MAP };
      case "layerSettings":
        if (activeLayer && activeRightPanel) {
          const isProperties = activeRightPanel === MapSidebarItemID.PROPERTIES;
          const title = isProperties
            ? `${t("data_source_info")}: ${activeLayer.name || t("layer")}`
            : `${t("style")}: ${activeLayer.name || t("layer")}`;
          const icon = isProperties ? ICON_NAME.LAYERS : ICON_NAME.STYLE;
          return { title, icon };
        }
        return null;
      case "default":
      default:
        return null; // No header needed for default view (only pagination)
    }
  }, [drawerView, layerInfo, activeLayer, activeRightPanel, t]);

  // Only the header views need the taller puller strip — see the constants.
  const drawerBleeding = currentHeaderInfo ? DRAWER_BLEEDING_WITH_HEADER : DRAWER_BLEEDING_DEFAULT;

  return (
    <>
      {/* Pass drawerView to GlobalSwiperStyles */}
      <GlobalSwiperStyles open={open} drawerView={drawerView} drawerBleeding={drawerBleeding} />
      <Box sx={{ height: `calc(100% - 56px)`, width: "100%", display: "flex", flexDirection: "column" }}>
        {/* Header and Map Controls (Unchanged structure) */}
        {project?.builder_config?.settings?.toolbar && (
          <Header showHambugerMenu={false} mapHeader={true} project={project} viewOnly />
        )}
        <Box
          display="flex"
          sx={{
            zIndex: 1,
            position: "relative",
            height: "100%",
            flexGrow: 1,
            justifyContent: "space-between",
            pointerEvents: "none",
          }}>
          {hasControl("location") && (
            <Box
              sx={{
                position: "absolute",
                left: 0,
                top: 0,
                m: 2,
                zIndex: 2,
                pointerEvents: "all",
              }}>
              {searchSource?.mode === "public" && (searchSource.placesEnabled || searchSource.hasLayers) && (
                <SearchControl
                  source={searchSource}
                  layersById={searchLayersById}
                  placeholder={searchPlaceholder}
                  bbox={project?.max_extent ?? undefined}
                />
              )}
            </Box>
          )}
          {/* Top-Right Controls (Unchanged) */}
          <Box
            sx={{
              position: "absolute",
              right: 0,
              top: 0,
              m: 2,
              zIndex: 2,
              pointerEvents: "all",
              display: "flex",
              flexDirection: "column",
              gap: 1,
            }}>
            {project && hasControl("project_info") && (
              <ProjectInfo project={project} viewOnly={viewOnly} onProjectUpdate={onProjectUpdate} />
            )}
            {hasControl("zoom_controls") && (
              <Zoom tooltipZoomIn={t("zoom_in")} tooltipZoomOut={t("zoom_out")} />
            )}
            {hasControl("find_my_location") && (
              <UserLocation tooltip={t("find_location")} />
            )}
            {hasControl("basemap") && allowedStyles.length > 0 && (
              <BasemapSelectorButton
                // Use `open` state derived from drawerView for visual indication (optional)
                open={drawerView === "basemapSelector"}
                // Use specific handler to switch view
                setOpen={handleOpenBasemapSelector}
              />
            )}
          </Box>

          {/* Bottom-Left Controls */}
          <Box
            sx={{
              position: "absolute",
              left: 0,
              zIndex: 2,
              bottom: 0,
              pointerEvents: "all",
            }}>
            {project?.builder_config?.settings?.scalebar !== false && (
              <Box sx={{ m: 2 }}>
                <Scalebar />
              </Box>
            )}
            <AttributionControl
              extraAttribution={
                activeBasemap.source === "custom" ? activeBasemap.attribution : null
              }
            />
          </Box>
        </Box>

        {/* Drawer */}
        <SwipeableDrawer
          anchor="bottom"
          open={open}
          hideBackdrop={true}
          ModalProps={{
            sx: {
              pointerEvents: "none", // Allow interactions with map behind
              "& .MuiDialog-container": { pointerEvents: "none" },
              "& .MuiPaper-root": { pointerEvents: "auto" }, // Drawer itself is interactive
            },
            keepMounted: true, // Keep content mounted for transitions/state
          }}
          // While the drawer is closed, MUI forces an inline
          // `style={{ pointerEvents: 'none' }}` on the Paper (see
          // SwipeableDrawer source). That inline style beats the
          // `& .MuiPaper-root` sx rule below, so on desktop the puller's
          // click-to-open handler never fires (mouse produces no touch swipe).
          // Override it via PaperProps.style — MUI merges PaperProps.style
          // AFTER its computed value, so this wins and keeps the puller
          // clickable when closed. Touch swipe is unaffected.
          PaperProps={{ style: { pointerEvents: "auto" } }}
          onClose={handleDrawerDismiss}
          onOpen={toggleDrawer(true)}
          swipeAreaWidth={drawerBleeding}
          disableSwipeToOpen={false}
          // Swipe-to-OPEN is otherwise dead: MUI ignores a closed-drawer touch
          // unless it starts on its own invisible SwipeArea *or* this is set
          // (SwipeableDrawer.js — `allowSwipeInChildren` defaults to false).
          // Our visible puller is a child of the Paper and covers that
          // SwipeArea, so every upward swipe was discarded while swipe-to-close
          // (a different code path) kept working. Only the bleeding strip is
          // on-screen while closed, so allowing Paper children is safe here.
          allowSwipeInChildren
          disableDiscovery={false}>
          {/* Puller Area */}
          <Box
            // Click-to-toggle for pointer devices. MUI's SwipeableDrawer only
            // opens/closes via touch gestures, so on desktop (a narrow window
            // renders this mobile layout) there is otherwise no way to pull the
            // sheet up with a mouse. Only toggle in the default view — special
            // views (layerInfo / basemap / layerSettings) own an explicit X
            // close button in the InfoHeader, so a bar click must not hijack it.
            onClick={drawerView === "default" ? () => setOpen((o) => !o) : undefined}
            sx={{
              position: "absolute",
              top: -drawerBleeding,
              borderTopLeftRadius: 8,
              borderTopRightRadius: 8,
              visibility: "visible",
              right: 0,
              left: 0,
              height: drawerBleeding,
              cursor: drawerView === "default" ? "pointer" : "grab",
              // Suppress the browser's grey tap-flash on the sheet handle: it
              // reads as the sheet's background changing for a moment.
              WebkitTapHighlightColor: "transparent",
              userSelect: "none",
              backgroundColor: drawerBgColor,
              boxShadow: "0 -3px 6px -2px rgba(0,0,0,0.15)",
            }}>
            <Puller />
            {/* Dynamic Header Content */}
            <Box sx={{ pt: currentHeaderInfo ? 1 : 0 }}>
              {currentHeaderInfo && (
                <InfoHeader
                  title={currentHeaderInfo.title}
                  // For the feature popup view, pass the layer's own
                  // style icon (same affordance as the desktop popup
                  // and the Layers panel) instead of the generic
                  // ICON_NAME so users can recognize the layer at a
                  // glance. Other drawer views keep using `iconName`.
                  {...(drawerView === "layerInfo" && clickedPopupLayerIcon
                    ? { icon: clickedPopupLayerIcon }
                    : { iconName: currentHeaderInfo.icon })}
                  onClose={handleCloseView}
                />
              )}
              {/* Pagination container, visibility controlled by GlobalSwiperStyles.
                  Stop clicks on the page dots from bubbling to the puller's
                  click-to-toggle handler (which would close the sheet). */}
              <div id="swiper-pagination-container" onClick={(e) => e.stopPropagation()} />
            </Box>
          </Box>

          {/* Content Area */}
          <Box
            sx={{
              height: "100%",
              overflow: "auto", // Hide overflow, specific content scrolls internally
              // Square top: the Puller Area above already provides the sheet's
              // rounded top, so rounding here would notch under the flat puller.
              backgroundColor: drawerBgColor,
            }}
            // Attach touch move handler to prevent drawer swipe when scrolling content
            onTouchMove={handleContentTouchMove}>
            {/* Conditional Rendering based on drawerView */}
            {drawerView === "layerInfo" && layerInfo && activePopupConfig && (
              <PopupContent
                // Force re-mount when the clicked feature changes so the
                // block list refreshes against the new feature properties.
                key={highlightedFeature?.id ?? layerInfo.title ?? v4()}
                layerId={layerInfo.layerId ?? ""}
                popup={activePopupConfig}
                properties={
                  (layerInfo.featureProperties ??
                    highlightedFeature?.properties ??
                    layerInfo.properties ??
                    {}) as Record<string, unknown>
                }
                // The drawer already owns its scrollable content area,
                // so neutralize PopupContent's internal scroll/maxHeight
                // affordance — the surrounding drawer body provides it.
                sx={{ overflowY: "visible", maxHeight: "none", px: 1.5, py: 1 }}
              />
            )}

            {drawerView === "basemapSelector" && (
              <BaseMapSelectorList
                styles={allowedStyles}
                active={activeBasemap.value}
                editable={editable}
                basemapChange={async (basemap) => {
                  await onProjectUpdate?.("basemap", basemap);
                  // Optionally close drawer or switch back to default view after selection
                  // setOpen(false);
                  // setDrawerView('default');
                }}
                onAdd={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
                onEdit={(id) => {
                  const target =
                    (project?.custom_basemaps as CustomBasemap[] | undefined)?.find(
                      (c) => c.id === id
                    ) ?? null;
                  if (target && project?.basemap !== id) {
                    // Ephemeral preview only — reverted on close, never persisted.
                    basemapBeforeEdit.current = project?.basemap ?? DEFAULT_BASEMAP;
                    setActiveBasemap(id);
                  }
                  setEditing(target);
                  setDialogOpen(true);
                }}
                // Close drawer on item click for immediate map feedback
                onClick={() => setOpen(false)}
                hideHeader // Header is now in the puller area
                flat // The sheet is the surface; no nested card
              />
            )}

            {drawerView === "layerSettings" && activeLayer && activeRightPanel && (
              <Box
                sx={{
                  p: 3,
                  minHeight: "200px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}>
                {activeRightPanel === MapSidebarItemID.PROPERTIES && (
                  <PropertiesPanel activeLayer={activeLayer} />
                )}
                {activeRightPanel === MapSidebarItemID.STYLE && (
                  <SimpleLayerStyle
                    layer={activeLayer as MapLayer}
                    onOpacityChange={onOpacityChange}
                    onStyleChange={onStyleChange}
                  />
                )}
              </Box>
            )}

            {drawerView === "default" && project?.builder_config?.interface && (
              <Swiper
                pagination={{
                  clickable: true,
                  el: "#swiper-pagination-container", // Target the div in puller area
                }}
                modules={[Pagination]}
                style={{ height: "100%", width: "100%" }}
                // Ensure Swiper doesn't conflict with drawer swipe
                touchStartPreventDefault={false} // Let drawer handle swipe if needed
                // Swiper defaults to threshold 0 with preventClicks on, so a
                // single pixel of horizontal drift during a tap starts a swipe
                // and cancels the click that would have followed. That silently
                // swallowed taps on every control in the sheet (layer toggles
                // especially). 8px is well under a deliberate page swipe.
                threshold={8}
                // Track the active panel so the shared drawer chrome
                // (puller + content area) can match its background color.
                onSlideChange={(swiper: { activeIndex: number }) =>
                  setActiveSlideIndex(swiper.activeIndex)
                }>
                {panels.map((item, index) => (
                  <SwiperSlide key={index} style={{ height: "100%", boxSizing: "border-box" }}>
                    {/* Scrollable container for widgets */}
                    <Box
                      ref={scrollableContentRef}
                      sx={{
                        display: "flex",
                        flexDirection: "column",
                        height: "100%",
                        width: "100%",
                        // Each slide carries its own configured panel color so
                        // adjacent panels render correctly mid-swipe.
                        backgroundColor: getPanelBgColor(item),
                        overflowY: "auto", // Enable vertical scrolling for widgets
                        overflowX: "hidden",
                        boxSizing: "border-box",
                        pb: 4, // Padding at the bottom
                        touchAction: "pan-y", // Hint for browser scroll handling
                      }}
                      // No touch handlers needed here anymore, handled by parent Box
                    >
                      {item?.widgets?.map((widget) => (
                        // No padding here: WidgetWrapper already applies 16px of
                        // its own (8px outer + 8px content), the same as the
                        // desktop PanelContainer. Adding p:2 on top gave the
                        // mobile sheet double the desktop padding on the
                        // smaller screen, which ate a lot of vertical space.
                        <Box key={widget.id} sx={{ width: "100%", flexShrink: 0 }}>
                          <WidgetWrapper
                            widget={widget}
                            projectLayers={projectLayers}
                            projectLayerGroups={projectLayerGroups}
                            viewOnly
                          />
                        </Box>
                      ))}
                    </Box>
                  </SwiperSlide>
                ))}
              </Swiper>
            )}
          </Box>
        </SwipeableDrawer>
      </Box>
      <CustomBasemapDialog
        open={dialogOpen}
        initial={editing}
        projectLayers={projectLayers}
        onClose={() => {
          setDialogOpen(false);
          if (basemapBeforeEdit.current !== null) {
            setActiveBasemap(basemapBeforeEdit.current);
            basemapBeforeEdit.current = null;
          }
        }}
        onSubmit={async (payload) => {
          if (editing) {
            await editCustomBasemap(editing.id, payload);
          } else {
            await addCustomBasemap(payload, /* selectAfterAdd */ true);
          }
        }}
        onDelete={
          editing
            ? async () => {
                await deleteCustomBasemap(editing.id, DEFAULT_BASEMAP);
              }
            : undefined
        }
      />
    </>
  );
};

export default MobileProjectLayout;

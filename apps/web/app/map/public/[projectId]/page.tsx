"use client";

import type { Theme } from "@mui/material";
import dynamic from "next/dynamic";
import { Box, useMediaQuery, useTheme } from "@mui/material";
import { GlobalStyles } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useMemo, useRef, use } from "react";
import type { MapRef, ViewStateChangeEvent } from "react-map-gl/maplibre";
import { MapProvider } from "react-map-gl/maplibre";
import { shallowEqual, useSelector } from "react-redux";

import type { StyleRead } from "@/lib/api/map";
import { usePublicProject } from "@/lib/api/projects";
import { SYSTEM_LAYERS_IDS } from "@/lib/constants";
import { DrawProvider } from "@/lib/providers/DrawProvider";
import { MeasureProvider } from "@/lib/providers/MeasureProvider";
import { PublicProjectProvider } from "@/lib/providers/PublicProjectProvider";
import type { RootState } from "@/lib/store";
import { selectProjectLayers } from "@/lib/store/layer/selectors";
import { setProjectLayerGroups, setProjectLayers } from "@/lib/store/layer/slice";
import { setMapMode, setProject } from "@/lib/store/map/slice";
import { filterSelectableProjectLayers } from "@/lib/utils/map/layer";
import { getLocFromUrl, writeLocToUrl, writeMapLocToUrl } from "@/lib/utils/map/loc-url";
import type { ProjectLayerGroup } from "@/lib/validations/project";
import { type Project, type ProjectLayer, projectSchema } from "@/lib/validations/project";

import { useBrandedTheme } from "@/hooks/dashboard/useBrandedTheme";
import { useBasemap } from "@/hooks/map/MapHooks";
import { type MapLayer, foldVisibility, publishedGroups, usePublicMapLayers } from "@/hooks/map/useMapLayers";
import { useAppDispatch } from "@/hooks/store/ContextHooks";

import { AnalyticsTracker } from "@/components/analytics/AnalyticsTracker";
import type { AnalyticsConfig } from "@/components/analytics/AnalyticsTracker";
import { ConsentBanner } from "@/components/analytics/ConsentBanner";
import { LoadingPage } from "@/components/common/LoadingPage";
import MapViewer from "@/components/map/MapViewer";
import PublicProjectLayout from "@/components/map/layouts/desktop/PublicProjectLayout";
const MobileProjectLayout = dynamic(() => import("@/components/map/layouts/mobile/MobileProjectLayout"), { ssr: false });

export default function MapPage(props: { params: Promise<{ projectId: string }> }) {
  const params = use(props.params);

  const {
    projectId
  } = params;

  const { sharedProject, isLoading, isError: projectError } = usePublicProject(projectId);
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const { mapStyle, setActiveBasemap } = useBasemap(sharedProject?.config?.["project"] as Project);
  // The published map's layers with their styles; what the viewer changes (visibility, a named style) is view state
  // kept on these rows in Redux.
  const publicConfig = useMemo(
    () =>
      sharedProject
        ? {
            layers: (sharedProject.config.layers ?? []) as unknown as ProjectLayer[],
            map: sharedProject.config.map,
            styles: sharedProject.config.styles as Record<string, StyleRead[]> | null | undefined,
          }
        : undefined,
    [sharedProject]
  );
  const projectLayers = usePublicMapLayers(publicConfig);

  // The groups with their visibility from the published map document.
  const projectLayerGroups = useMemo(
    () =>
      publishedGroups({
        layer_groups: (sharedProject?.config?.["layer_groups"] ?? []) as ProjectLayerGroup[],
        map: sharedProject?.config?.map,
      }),
    [sharedProject]
  );

  const _project = sharedProject?.config?.["project"] as Project;
  const mapRef = useRef<MapRef | null>(null);
  const initialView = sharedProject?.config?.["project"]?.["initial_view_state"] ?? {};

  // Read ?loc= once on mount; it wins over the published initial view. Nothing is
  // persisted on public maps — the URL is the only carrier of position across reloads.
  const urlLoc = useMemo(() => getLocFromUrl(), []);

  const handleMoveEnd = useCallback((e: ViewStateChangeEvent) => {
    writeLocToUrl(e.viewState);
  }, []);

  const handleMapLoaded = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    writeMapLocToUrl(map);
  }, []);

  // Include all layers (with tables) for widgets — use unfiltered selector so that
  // data widgets (filters, numbers, tables, etc.) still work when a layer or its
  // parent group has visibility toggled off.
  const _allProjectLayers = useSelector((state: RootState) => selectProjectLayers(state), shallowEqual);
  const viewGroups = useSelector((state: RootState) => state.layers.projectLayerGroups, shallowEqual);
  // On this page the rows in Redux are the published map's layers (above), in the map's order, with the viewer's
  // changes (view state) folded through the groups.
  const mapLayers = useMemo(
    () => foldVisibility(_allProjectLayers as MapLayer[], viewGroups),
    [_allProjectLayers, viewGroups]
  );
  const drawnLayers = useMemo(
    () => filterSelectableProjectLayers(mapLayers, ["table"], SYSTEM_LAYERS_IDS) as MapLayer[],
    [mapLayers]
  );

  const project = useMemo(() => {
    if (!_project) return undefined;
    const parsedProject = projectSchema.safeParse(_project);
    if (parsedProject.success) {
      return parsedProject.data;
    } else {
      console.error("Invalid project data:", parsedProject.error);
      return undefined;
    }
  }, [_project]);

  const mapView = project?.builder_config?.settings?.map_view;
  const minZoom = mapView?.min_zoom ?? undefined;
  const maxZoom = mapView?.max_zoom ?? undefined;

  useEffect(() => {
    if (projectLayers && project) {
      dispatch(setProjectLayers(projectLayers));
      dispatch(setProjectLayerGroups((projectLayerGroups || []) as ProjectLayerGroup[]));
      dispatch(setProject(project));
      dispatch(setMapMode("public"));
      setActiveBasemap(project.basemap ?? "streets");
    }
  }, [dispatch, project, projectLayers, projectLayerGroups, setActiveBasemap]);

  const primaryColor = project?.builder_config?.settings?.primary_color;
  const iconColor = project?.builder_config?.settings?.icon_color;
  const fontColor = project?.builder_config?.settings?.font_color;
  // "light": a published dashboard must render identically for every visitor,
  // not in the viewer's own dark/light preference.
  const brandedTheme = useBrandedTheme(primaryColor, iconColor, fontColor, "light");

  const isMobile = useMediaQuery((theme: Theme) => theme.breakpoints.down("md"));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onProjectUpdate = (key: string, value: any) => {
    if (key === "basemap") {
      setActiveBasemap(value);
    }
  };

  const analytics = (sharedProject as { analytics?: AnalyticsConfig | null } | undefined)
    ?.analytics;
  const trackingRequireConsent =
    (sharedProject as { tracking_require_consent?: boolean } | undefined)
      ?.tracking_require_consent ?? true;

  return (
    <PublicProjectProvider projectId={projectId}>
      {/* One theme for the whole page — the loading screen renders before the
          project (and its branding) is known, and must not fall back to the
          viewer's own dark/light preference either. */}
      <ThemeProvider theme={brandedTheme}>
      {/* The root CssBaseline paints scrollbars and the body background from the
          viewer's theme. These selectors are more specific than its own
          ("html ::-webkit-scrollbar-thumb", "body"), and being document-wide
          they also cover portalled modals. Unmounting the page removes them. */}
      <GlobalStyles
        styles={{
          // No standard `scrollbar-color`/`scrollbar-width` here: setting either
          // makes Chrome ignore every ::-webkit-scrollbar rule for the scroller,
          // including the app's 5px width, so the bar would render native-thick.
          "html body": {
            backgroundColor: brandedTheme.palette.background.default,
          },
          "html body ::-webkit-scrollbar-thumb": {
            backgroundColor: brandedTheme.palette.grey[400],
          },
          "html body ::-webkit-scrollbar-track": {
            background: "transparent",
          },
        }}
      />
      {isLoading && <LoadingPage />}
      {!isLoading && !projectError && project && (
        <>
          <AnalyticsTracker
            analytics={analytics}
            projectId={projectId}
            projectName={project.name}
            requireConsent={trackingRequireConsent}
          />
          {analytics && trackingRequireConsent && (
            <ConsentBanner provider={analytics.provider} />
          )}
          <MapProvider>
          <DrawProvider>
            <MeasureProvider>
              <Box
                sx={{
                  display: "flex",
                  height: "100vh",
                  width: "100%",
                  [theme.breakpoints.down("sm")]: {
                    marginLeft: "0",
                    width: `100%`,
                  },
                }}>
                <Box
                  sx={{
                    position: "absolute",
                    width: "100%",
                    height: "100%",
                  }}>
                  <Box sx={{ color: "text.primary", height: "100%", width: "100%" }}>
                      {isMobile ? (
                        <MobileProjectLayout
                          project={project}
                          projectLayers={_allProjectLayers}
                          projectLayerGroups={projectLayerGroups}
                          viewOnly
                          onProjectUpdate={onProjectUpdate}
                        />
                      ) : (
                        <PublicProjectLayout
                          project={project}
                          projectLayers={_allProjectLayers}
                          mapLayers={mapLayers}
                          projectLayerGroups={projectLayerGroups}
                          viewOnly
                          onProjectUpdate={onProjectUpdate}
                        />
                      )}
                  </Box>
                </Box>
                <MapViewer
                  layers={drawnLayers}
                  locale={sharedProject?.config.map?.locale}
                  mapRef={mapRef}
                  touchZoomRotate
                  maxExtent={project?.max_extent || undefined}
                  minZoom={minZoom}
                  maxZoom={maxZoom}
                  initialViewState={{
                    zoom: urlLoc?.zoom ?? initialView?.zoom ?? 3,
                    latitude: urlLoc?.latitude ?? initialView?.latitude ?? 48.13,
                    longitude: urlLoc?.longitude ?? initialView?.longitude ?? 11.57,
                    pitch: urlLoc?.pitch ?? initialView?.pitch ?? 0,
                    bearing: urlLoc?.bearing ?? initialView?.bearing ?? 0,
                    fitBoundsOptions: {
                      minZoom: initialView?.min_zoom ?? 0,
                      maxZoom: initialView?.max_zoom ?? 24,
                    },
                  }}
                  mapStyle={mapStyle}
                  onMoveEnd={handleMoveEnd}
                  onLoad={handleMapLoaded}
                  isEditor={false}
                />
              </Box>
            </MeasureProvider>
          </DrawProvider>
        </MapProvider>
        </>
      )}
      </ThemeProvider>
    </PublicProjectProvider>
  );
}

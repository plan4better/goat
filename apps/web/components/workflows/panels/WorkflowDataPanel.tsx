"use client";

/**
 * Workflow Data Panel
 *
 * A collapsible/resizable bottom panel that shows Table or Map view
 * for the currently selected node's data. Only active when:
 * - A dataset node with a layer is selected
 * - A tool node with results is selected
 *
 * Map tab is disabled if the data doesn't have geometry.
 */
import { KeyboardArrowDown as CollapseIcon, DragHandle as DragHandleIcon } from "@mui/icons-material";
import {
  Box,
  IconButton,
  Skeleton,
  Stack,
  Tab,
  TablePagination,
  Tabs,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { styled } from "@mui/material/styles";
import bbox from "@turf/bbox";
import "maplibre-gl/dist/maplibre-gl.css";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Map, { Layer as MapLayer, Source } from "react-map-gl/maplibre";
import type { LayerProps, MapRef } from "react-map-gl/maplibre";
import { useDispatch, useSelector } from "react-redux";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDataset, useDatasetCollectionItems } from "@/lib/api/layers";
import { getExtent } from "@/lib/api/processes";
import { useTempLayerFeatures } from "@/lib/api/workflows";
import { GEOAPI_BASE_URL } from "@/lib/constants";
import { getBasemapUrl } from "@/lib/constants/basemaps";
import { rgbToHex } from "@/lib/utils/helpers";
import { getMapboxStyleColor } from "@/lib/transformers/layer";
import { DrawProvider } from "@/lib/providers/DrawProvider";
import type { AppDispatch } from "@/lib/store";
import { selectRequestMapView, selectRequestTableView } from "@/lib/store/workflow/selectors";
import {
  clearMapViewRequest,
  clearTableViewRequest,
  setActiveDataPanelView,
} from "@/lib/store/workflow/slice";
import { createTheCQLBasedOnExpression } from "@/lib/transformers/filter";
import { fitBounds } from "@/lib/utils/map/navigate";
import { globalExtent, wktToGeoJSON } from "@/lib/utils/map/wkt";
import type { Expression } from "@/lib/validations/filter";
import type { DatasetCollectionItems, GetCollectionItemsQueryParams } from "@/lib/validations/layer";
import type { ProjectLayer } from "@/lib/validations/project";
import type { WorkflowNode } from "@/lib/validations/workflow";

import useLayerFields from "@/hooks/map/CommonHooks";

import FeatureTable from "@/components/common/FeatureTable";
import MapViewer from "@/components/map/MapViewer";

// Panel heights
const MIN_PANEL_HEIGHT = 200; // Minimum when resizing (not fully collapsed)
const DEFAULT_PANEL_HEIGHT = 350;
const MAX_PANEL_HEIGHT = 700;
const COLLAPSED_HEIGHT = 44;

// Styled components
const PanelContainer = styled(Box, {
  shouldForwardProp: (prop) => prop !== "height" && prop !== "isCollapsed" && prop !== "isDragging",
})<{ height: number; isCollapsed: boolean; isDragging?: boolean }>(
  ({ theme, height, isCollapsed, isDragging }) => ({
    position: "relative",
    width: "100%",
    height: isCollapsed ? COLLAPSED_HEIGHT : height,
    minHeight: COLLAPSED_HEIGHT,
    backgroundColor: theme.palette.background.default,
    borderTop: `1px solid ${theme.palette.divider}`,
    display: "flex",
    flexDirection: "column",
    // Animate expand/collapse, but not during drag resize
    transition: isDragging ? "none" : "height 0.2s ease",
  })
);

const PanelHeader = styled(Box)(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: theme.spacing(0, 1, 0, 2),
  minHeight: COLLAPSED_HEIGHT,
  borderBottom: `1px solid ${theme.palette.divider}`,
  backgroundColor: theme.palette.background.default,
  cursor: "default",
  userSelect: "none",
  position: "relative",
}));

const DragHandle = styled(Box)(({ theme }) => ({
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: 48,
  height: 24,
  cursor: "ns-resize",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: theme.shape.borderRadius,
  "&:hover": {
    backgroundColor: theme.palette.action.hover,
  },
  "& .drag-icon": {
    fontSize: 20,
    color: theme.palette.text.disabled,
    transition: "color 0.2s",
  },
  "&:hover .drag-icon": {
    color: theme.palette.text.secondary,
  },
}));

const PanelContent = styled(Box)(() => ({
  flex: 1,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
}));

const ContentArea = styled(Box)(() => ({
  flex: 1,
  overflow: "auto",
  position: "relative",
}));

const EmptyState = styled(Box)(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  padding: theme.spacing(4),
  color: theme.palette.text.secondary,
}));

const MapContainer = styled(Box)(() => ({
  position: "relative",
  width: "100%",
  height: "100%",
}));

// Tab panels
interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <ContentArea
      role="tabpanel"
      hidden={value !== index}
      id={`data-panel-tabpanel-${index}`}
      aria-labelledby={`data-panel-tab-${index}`}
      {...other}
      sx={{ display: value === index ? "flex" : "none", flexDirection: "column" }}>
      {value === index && children}
    </ContentArea>
  );
}

function a11yProps(index: number) {
  return {
    id: `data-panel-tab-${index}`,
    "aria-controls": `data-panel-tabpanel-${index}`,
  };
}

// Get layer ID from node (either dataset layer ID or tool output layer ID)
function getNodeDataInfo(
  node: WorkflowNode | null,
  tempLayerIds?: Record<string, string>
): {
  hasData: boolean;
  layerId: string | null; // UUID of the layer (for regular layers)
  tempLayerId: string | null; // Temp layer ID format: "workflow_id:node_id" (for temp results)
  nodeFilter: { op: string; expressions: Expression[] } | null;
} {
  if (!node) {
    return { hasData: false, layerId: null, tempLayerId: null, nodeFilter: null };
  }

  // Dataset node - use layerId directly
  if (node.type === "dataset" && node.data.type === "dataset") {
    const layerId = node.data.layerId;
    if (!layerId) {
      return { hasData: false, layerId: null, tempLayerId: null, nodeFilter: null };
    }
    // Get node's workflow filter
    const nodeFilter = node.data.filter as { op: string; expressions: Expression[] } | undefined;
    return {
      hasData: true,
      layerId,
      tempLayerId: null,
      nodeFilter: nodeFilter || null,
    };
  }

  // Tool node with results - check for temp layer ID first, then permanent output
  if (node.type === "tool" && node.data.type === "tool") {
    // Check if we have a temp result from workflow execution
    const tempLayerId = tempLayerIds?.[node.id];
    if (tempLayerId) {
      return {
        hasData: true,
        layerId: null,
        tempLayerId,
        nodeFilter: null,
      };
    }

    // Fall back to permanent output layer (saved result)
    const outputLayerId = node.data.outputLayerId;
    if (!outputLayerId) {
      return { hasData: false, layerId: null, tempLayerId: null, nodeFilter: null };
    }
    return {
      hasData: true,
      layerId: outputLayerId,
      tempLayerId: null,
      nodeFilter: null, // Tool nodes don't have workflow filters
    };
  }

  return { hasData: false, layerId: null, tempLayerId: null, nodeFilter: null };
}

interface WorkflowDataPanelProps {
  selectedNode: WorkflowNode | null;
  tempLayerIds?: Record<string, string>; // Map of node_id -> temp_layer_id for executed workflow
  tempLayerProperties?: Record<string, Record<string, unknown>>; // Layer style properties by node ID
  workflowId?: string; // Current workflow ID
}

const WorkflowDataPanel: React.FC<WorkflowDataPanelProps> = ({
  selectedNode,
  tempLayerIds = {},
  tempLayerProperties = {},
  workflowId: _workflowId, // Available for future use (e.g., refreshing temp data)
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dispatch = useDispatch<AppDispatch>();
  const mapRef = useRef<MapRef | null>(null);

  // Redux state for map/table view requests
  const requestMapViewFlag = useSelector(selectRequestMapView);
  const requestTableViewFlag = useSelector(selectRequestTableView);

  // Panel state
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const [tabValue, setTabValue] = useState(0);

  // Dragging state
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ y: number; height: number } | null>(null);

  // Get node data info - returns layerId (UUID) or tempLayerId for fetching
  const { hasData, layerId, tempLayerId, nodeFilter } = useMemo(
    () => getNodeDataInfo(selectedNode, tempLayerIds),
    [selectedNode, tempLayerIds]
  );

  // Check if we're viewing a temp layer
  const isTempLayer = !!tempLayerId;

  // Get style properties for the selected temp layer node
  const nodeProperties = selectedNode ? tempLayerProperties[selectedNode.id] : undefined;

  // Compute MapLibre paint styles from GOAT tool properties
  // Uses Record<string, unknown> to match MapLibre's dynamic expression types
  const tempLayerPaint = useMemo((): {
    fill: Record<string, unknown>;
    line: Record<string, unknown>;
    circle: Record<string, unknown>;
  } | null => {
    if (!nodeProperties) return null;

    // Create a minimal wrapper object for getMapboxStyleColor()
    // That function accesses data.properties[...] so we just need { properties: ... }
    const dataWrapper = { properties: nodeProperties } as Parameters<typeof getMapboxStyleColor>[0];

    const fillColor = getMapboxStyleColor(dataWrapper, "color");
    const strokeColor = getMapboxStyleColor(dataWrapper, "stroke_color");

    const opacity = typeof nodeProperties.opacity === "number" ? nodeProperties.opacity : 0.7;
    const filled = nodeProperties.filled !== false;
    const stroked = nodeProperties.stroked !== false;
    const strokeWidth = typeof nodeProperties.stroke_width === "number" ? nodeProperties.stroke_width : 2;
    const radius = typeof nodeProperties.radius === "number" ? nodeProperties.radius : 6;

    // Solid fallback color
    const solidColor = nodeProperties.color
      ? rgbToHex(nodeProperties.color as [number, number, number])
      : undefined;

    return {
      fill: {
        "fill-color": fillColor,
        "fill-opacity": filled ? opacity : 0,
      },
      line: {
        "line-color": stroked ? strokeColor : fillColor,
        "line-width": stroked ? strokeWidth : 1.5,
      },
      circle: {
        "circle-radius": radius,
        "circle-color": fillColor,
        "circle-opacity": filled ? opacity : 0,
        "circle-stroke-width": stroked ? strokeWidth : 2,
        "circle-stroke-color": stroked ? strokeColor : (solidColor || "#ffffff"),
      },
    };
  }, [nodeProperties]);

  // Fetch layer data by layerId (only for regular layers, not temp)
  const { dataset: layer } = useDataset(!isTempLayer && layerId ? layerId : "");

  // Get the layer UUID
  const effectiveLayerId = layer?.id || layerId || "";

  // Determine if regular layer has geometry (temp layer geometry is detected later from actual data)
  const isTable = layer?.type === "table";
  const regularHasGeometry = layer ? !isTable : false;

  // Get layer fields for regular layers (from layer metadata)
  const { layerFields: regularFields, isLoading: areRegularFieldsLoading } = useLayerFields(
    !isTempLayer ? effectiveLayerId : "",
    undefined
  );

  // Build CQL filter from node's workflow filter (only for regular layers)
  // Temp layers don't use CQL filters since they're already filtered by the workflow
  const cqlFilter = useMemo(() => {
    if (isTempLayer || !nodeFilter || !nodeFilter.expressions || nodeFilter.expressions.length === 0) {
      return null;
    }
    try {
      return createTheCQLBasedOnExpression(
        nodeFilter.expressions,
        regularFields,
        nodeFilter.op as "and" | "or"
      );
    } catch {
      return null;
    }
  }, [isTempLayer, nodeFilter, regularFields]);

  // Stringify CQL filter for stable comparison
  const cqlFilterString = useMemo(() => {
    return cqlFilter ? JSON.stringify(cqlFilter) : null;
  }, [cqlFilter]);

  // Table data query params
  const [dataQueryParams, setDataQueryParams] = useState<GetCollectionItemsQueryParams>({
    limit: 50,
    offset: 0,
  });

  // Track previous filter string to avoid unnecessary updates
  const prevFilterRef = useRef<string | null>(null);
  const prevLayerIdRef = useRef<string | null>(null);

  // Reset query params when layer or filter changes
  useEffect(() => {
    // Only use node's workflow filter, NOT the layer's CQL filter
    // Workflow filter is independent and should not fall back to layer filter
    const filterString = cqlFilterString;

    // Skip if nothing changed
    if (effectiveLayerId === prevLayerIdRef.current && filterString === prevFilterRef.current) {
      return;
    }

    prevLayerIdRef.current = effectiveLayerId;
    prevFilterRef.current = filterString;

    const newParams: GetCollectionItemsQueryParams = {
      limit: 50,
      offset: 0,
    };
    if (filterString) {
      newParams.filter = filterString;
    }
    setDataQueryParams(newParams);
  }, [effectiveLayerId, cqlFilterString]);

  // Regular layer data (from DuckLake)
  const { data: regularTableData } = useDatasetCollectionItems(
    !isTempLayer && effectiveLayerId ? effectiveLayerId : "",
    dataQueryParams
  );

  // Parse temp layer ID to extract components
  // Format: "workflow_id:node_id:layer_uuid"
  const tempLayerParts = useMemo(() => {
    if (!tempLayerId) return { workflowId: undefined, nodeId: undefined, layerUuid: undefined };
    const parts = tempLayerId.split(":");
    if (parts.length === 3) {
      return { workflowId: parts[0], nodeId: parts[1], layerUuid: parts[2] };
    }
    return { workflowId: undefined, nodeId: undefined, layerUuid: undefined };
  }, [tempLayerId]);

  const { layerUuid: tempLayerUuid } = tempLayerParts;

  // Build vector tile URL for temp layer map (same as regular layers, just use layer UUID)
  const tempTileUrl = useMemo(() => {
    if (!tempLayerUuid) return null;
    return `${GEOAPI_BASE_URL}/collections/${tempLayerUuid}/tiles/WebMercatorQuad/{z}/{x}/{y}`;
  }, [tempLayerUuid]);

  // Temp layer data (from temp storage) - only for table pagination
  // Use the layer UUID as the collection ID, just add temp=true
  const { data: tempTableData } = useTempLayerFeatures(isTempLayer ? tempLayerUuid : undefined, {
    limit: dataQueryParams.limit,
    offset: dataQueryParams.offset,
  });

  // Derive fields from temp layer data (from feature properties)
  const tempFields = useMemo(() => {
    if (!isTempLayer || !tempTableData?.features?.length) return [];
    const firstFeature = tempTableData.features[0] as { properties?: Record<string, unknown> };
    if (!firstFeature?.properties) return [];

    const hiddenFields = ["layer_id", "id", "h3_3", "h3_6", "geom", "geometry"];
    return Object.entries(firstFeature.properties)
      .filter(([key]) => !hiddenFields.includes(key))
      .map(([key, value]) => ({
        name: key,
        type: typeof value === "number" ? "number" : typeof value === "object" ? "object" : "string",
      }));
  }, [isTempLayer, tempTableData]);

  // Detect geometry from temp layer features (non-null geometry = has geometry)
  const hasGeometry = useMemo(() => {
    if (isTempLayer) {
      if (!tempTableData?.features?.length) return false;
      const firstFeature = tempTableData.features[0] as { geometry?: unknown };
      return !!firstFeature?.geometry;
    }
    return regularHasGeometry;
  }, [isTempLayer, tempTableData, regularHasGeometry]);

  // Open map view when requested via Redux (e.g., from spatial filter creation)
  useEffect(() => {
    if (requestMapViewFlag && hasGeometry) {
      setIsCollapsed(false);
      setTabValue(1); // Map tab
      dispatch(setActiveDataPanelView("map"));
      dispatch(clearMapViewRequest());
    }
  }, [requestMapViewFlag, hasGeometry, dispatch]);

  // Open table view when requested via Redux
  useEffect(() => {
    if (requestTableViewFlag && hasData) {
      setIsCollapsed(false);
      setTabValue(0); // Table tab
      dispatch(setActiveDataPanelView("table"));
      dispatch(clearTableViewRequest());
    }
  }, [requestTableViewFlag, hasData, dispatch]);

  // Use appropriate fields based on layer type
  const fields = isTempLayer ? tempFields : regularFields;
  const areFieldsLoading = isTempLayer ? false : areRegularFieldsLoading;

  // Use appropriate data source based on layer type
  // Transform temp layer data to match DatasetCollectionItems interface
  const tableData: DatasetCollectionItems | undefined = useMemo(() => {
    if (isTempLayer && tempTableData) {
      return {
        type: tempTableData.type,
        features: tempTableData.features as DatasetCollectionItems["features"],
        numberMatched: tempTableData.numberMatched ?? 0,
        numberReturned: tempTableData.numberReturned ?? 0,
        title: "Temporary Layer",
        links: [],
      };
    }
    return regularTableData;
  }, [isTempLayer, tempTableData, regularTableData]);

  // Map state - compute bounds from layer extent or temp GeoJSON
  const mapBounds = useMemo(() => {
    // For regular layers, use the layer extent
    if (!isTempLayer && layer && hasGeometry) {
      const geojson = wktToGeoJSON(layer.extent || globalExtent);
      return bbox(geojson) as [number, number, number, number];
    }
    // For temp layers, compute bounds from available features (for initial view)
    if (isTempLayer && tempTableData && hasGeometry) {
      const featureCollection = {
        type: "FeatureCollection" as const,
        features: tempTableData.features,
      };
      try {
        const bounds = bbox(featureCollection);
        // Check if bounds are valid (not Infinity)
        if (bounds.every((b) => isFinite(b))) {
          return bounds as [number, number, number, number];
        }
      } catch {
        // Fallback to global extent
      }
      return bbox(wktToGeoJSON(globalExtent)) as [number, number, number, number];
    }
    return null;
  }, [isTempLayer, layer, hasGeometry, tempTableData]);

  // Ensure map tab is not selected if no geometry
  useEffect(() => {
    if (!hasGeometry && tabValue === 1) {
      setTabValue(0);
    }
  }, [hasGeometry, tabValue]);

  // Track what we've already zoomed to, to avoid repeated zooms
  const lastZoomKeyRef = useRef<string | null>(null);

  // Helper function to perform the zoom
  const performZoom = useCallback(
    (layerId: string, filterString: string | null) => {
      if (filterString) {
        getExtent(layerId, filterString)
          .then((result) => {
            if (result.bbox && mapRef.current) {
              fitBounds(mapRef.current, result.bbox, 40, 18, 1000);
            }
          })
          .catch((error) => {
            console.warn("Failed to fetch filtered extent:", error);
            // Fall back to layer bounds
            if (mapBounds && mapRef.current) {
              mapRef.current.fitBounds(mapBounds, { padding: 40, duration: 1000 });
            }
          });
      } else if (mapBounds && mapRef.current) {
        // No filter, zoom to full layer extent
        mapRef.current.fitBounds(mapBounds, { padding: 40, duration: 1000 });
      }
    },
    [mapBounds]
  );

  // Zoom to appropriate extent when opening map view or when filter/layer changes
  useEffect(() => {
    // Reset zoom tracking when not on map view or no valid data
    if (!hasGeometry || !effectiveLayerId || tabValue !== 1 || isCollapsed) {
      // Reset so we zoom again next time map view opens
      if (tabValue !== 1 || !effectiveLayerId) {
        lastZoomKeyRef.current = null;
      }
      return;
    }

    // Wait for fields to load if there's a filter, so we can generate proper CQL
    if (nodeFilter && nodeFilter.expressions.length > 0 && areFieldsLoading) {
      return;
    }

    const filterString = cqlFilterString;

    // Create a unique key for this zoom target
    const zoomKey = `${effectiveLayerId}:${filterString || "none"}`;

    // Skip if we already zoomed to this exact target
    if (lastZoomKeyRef.current === zoomKey) {
      return;
    }

    // Mark as zoomed
    lastZoomKeyRef.current = zoomKey;

    // If map is ready, zoom immediately
    if (mapRef.current) {
      performZoom(effectiveLayerId, filterString);
      return;
    }

    // Map not ready yet - poll for it (faster than waiting for onLoad)
    const checkMapReady = () => {
      if (mapRef.current) {
        performZoom(effectiveLayerId, filterString);
        return true;
      }
      return false;
    };

    // Check immediately, then poll every 50ms until ready (max 1 second)
    if (!checkMapReady()) {
      let attempts = 0;
      const maxAttempts = 20;
      const intervalId = setInterval(() => {
        attempts++;
        if (checkMapReady() || attempts >= maxAttempts) {
          clearInterval(intervalId);
        }
      }, 50);

      return () => clearInterval(intervalId);
    }
  }, [
    effectiveLayerId,
    hasGeometry,
    tabValue,
    isCollapsed,
    cqlFilterString,
    nodeFilter,
    areFieldsLoading,
    performZoom,
  ]);

  // Handle tab change - also expand if collapsed
  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
    // Auto-expand when clicking on a tab while collapsed
    if (isCollapsed) {
      setIsCollapsed(false);
    }
    // Track active view in Redux
    dispatch(setActiveDataPanelView(newValue === 0 ? "table" : "map"));
  };

  // Handle pagination
  const handleChangePage = (_event: unknown, newPage: number) => {
    setDataQueryParams((prev) => ({
      ...prev,
      offset: newPage * (prev.limit || 50),
    }));
  };

  const handleChangeRowsPerPage = (event: React.ChangeEvent<HTMLInputElement>) => {
    setDataQueryParams({
      limit: parseInt(event.target.value, 10),
      offset: 0,
    });
  };

  // Handle drag resize
  const handleDragStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      setIsDragging(true);
      dragStartRef.current = { y: event.clientY, height: panelHeight };
    },
    [panelHeight]
  );

  useEffect(() => {
    const handleDragMove = (event: MouseEvent) => {
      if (!isDragging || !dragStartRef.current) return;

      const deltaY = dragStartRef.current.y - event.clientY;
      const newHeight = Math.min(
        MAX_PANEL_HEIGHT,
        Math.max(MIN_PANEL_HEIGHT, dragStartRef.current.height + deltaY)
      );
      setPanelHeight(newHeight);
    };

    const handleDragEnd = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    if (isDragging) {
      document.addEventListener("mousemove", handleDragMove);
      document.addEventListener("mouseup", handleDragEnd);
    }

    return () => {
      document.removeEventListener("mousemove", handleDragMove);
      document.removeEventListener("mouseup", handleDragEnd);
    };
  }, [isDragging]);

  // Toggle collapse
  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  // Sync data panel view to Redux after collapse state changes
  useEffect(() => {
    if (isCollapsed) {
      dispatch(setActiveDataPanelView(null));
    } else {
      dispatch(setActiveDataPanelView(tabValue === 0 ? "table" : "map"));
    }
  }, [isCollapsed, tabValue, dispatch]);

  // Layer with visibility and workflow filter for map
  // Convert Layer to ProjectLayer-like format for MapViewer
  const layerForMap = useMemo((): ProjectLayer | null => {
    if (!layer || !hasGeometry) return null;

    return {
      ...layer,
      // Add ProjectLayer-specific fields
      id: 0, // Placeholder - not used for map rendering
      layer_id: layer.id,
      folder_id: layer.folder_id,
      properties: {
        ...layer.properties,
        visibility: true,
      },
      query: cqlFilter ? { cql: cqlFilter } : undefined,
    } as ProjectLayer;
  }, [layer, hasGeometry, cqlFilter]);

  // Don't render if no data available from any node
  if (!hasData) {
    return (
      <PanelContainer height={COLLAPSED_HEIGHT} isCollapsed={true} isDragging={false}>
        <PanelHeader>
          <Tabs value={false} onChange={() => {}} sx={{ minHeight: 44 }}>
            <Tab
              label={
                <Stack direction="row" alignItems="center" spacing={1.5}>
                  <Icon iconName={ICON_NAME.TABLE} style={{ fontSize: 14 }} />
                  <span>{t("table")}</span>
                </Stack>
              }
              disabled
              sx={{ minHeight: 44, py: 0, px: 2, fontSize: "0.8125rem", textTransform: "none" }}
              {...a11yProps(0)}
            />
            <Tab
              label={
                <Stack direction="row" alignItems="center" spacing={1.5}>
                  <Icon iconName={ICON_NAME.MAP} style={{ fontSize: 14 }} />
                  <span>{t("map")}</span>
                </Stack>
              }
              disabled
              sx={{ minHeight: 44, py: 0, px: 2, fontSize: "0.8125rem", textTransform: "none" }}
              {...a11yProps(1)}
            />
          </Tabs>
        </PanelHeader>
      </PanelContainer>
    );
  }

  return (
    <PanelContainer height={panelHeight} isCollapsed={isCollapsed} isDragging={isDragging}>
      {/* Header with tabs */}
      <PanelHeader>
        <Tabs value={tabValue} onChange={handleTabChange} sx={{ minHeight: 44 }}>
          <Tab
            label={
              <Stack direction="row" alignItems="center" spacing={1.5}>
                <Icon iconName={ICON_NAME.TABLE} style={{ fontSize: 14 }} />
                <span>{t("table")}</span>
              </Stack>
            }
            onClick={() => isCollapsed && setIsCollapsed(false)}
            sx={{ minHeight: 44, py: 0, px: 2, fontSize: "0.8125rem", textTransform: "none" }}
            {...a11yProps(0)}
          />
          <Tab
            label={
              <Stack direction="row" alignItems="center" spacing={1.5}>
                <Icon iconName={ICON_NAME.MAP} style={{ fontSize: 14 }} />
                <span>{t("map")}</span>
              </Stack>
            }
            disabled={!hasGeometry}
            onClick={() => isCollapsed && hasGeometry && setIsCollapsed(false)}
            sx={{ minHeight: 44, py: 0, px: 2, fontSize: "0.8125rem", textTransform: "none" }}
            {...a11yProps(1)}
          />
        </Tabs>
        {/* Centered drag handle - only show when expanded */}
        {!isCollapsed && (
          <DragHandle onMouseDown={handleDragStart}>
            <DragHandleIcon className="drag-icon" />
          </DragHandle>
        )}
        {/* Only show collapse button when expanded */}
        {!isCollapsed && (
          <Tooltip title={t("collapse")} placement="top">
            <IconButton size="small" onClick={toggleCollapse}>
              <CollapseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </PanelHeader>

      {/* Content */}
      {!isCollapsed && (
        <PanelContent>
          {/* Table View */}
          <TabPanel value={tabValue} index={0}>
            {areFieldsLoading && !tableData && (
              <Box sx={{ p: 2 }}>
                <Skeleton variant="rectangular" height={60} />
                <Skeleton variant="rectangular" height={200} sx={{ mt: 2 }} />
              </Box>
            )}
            {!areFieldsLoading && tableData && fields && (
              <>
                <Box sx={{ flex: 1, overflow: "auto" }}>
                  <FeatureTable fields={fields} data={tableData} isLoading={areFieldsLoading} />
                </Box>
                <Box sx={{ borderTop: `1px solid ${theme.palette.divider}` }}>
                  <TablePagination
                    rowsPerPageOptions={[10, 25, 50]}
                    component="div"
                    count={tableData.numberMatched ?? 0}
                    rowsPerPage={dataQueryParams.limit || 50}
                    page={
                      dataQueryParams.offset
                        ? Math.floor(dataQueryParams.offset / (dataQueryParams.limit || 50))
                        : 0
                    }
                    onPageChange={handleChangePage}
                    onRowsPerPageChange={handleChangeRowsPerPage}
                  />
                </Box>
              </>
            )}
            {!areFieldsLoading && !tableData && (
              <EmptyState>
                <Typography variant="body2">{t("no_data_available")}</Typography>
              </EmptyState>
            )}
          </TabPanel>

          {/* Map View */}
          <TabPanel value={tabValue} index={1}>
            {/* Regular layer map - uses MapViewer with tile-based rendering */}
            {hasGeometry && !isTempLayer && layerForMap && mapBounds && (
              <MapContainer>
                <DrawProvider>
                  <MapViewer
                    mapRef={mapRef}
                    layers={[layerForMap]}
                    initialViewState={{
                      bounds: mapBounds,
                      fitBoundsOptions: { padding: 20 },
                    }}
                    mapStyle={getBasemapUrl("light")}
                    dragRotate={false}
                    touchZoomRotate={false}
                    containerSx={{
                      position: "relative",
                      display: "flex",
                      height: "100%",
                      width: "100%",
                      overflow: "hidden",
                    }}
                  />
                </DrawProvider>
              </MapContainer>
            )}
            {/* Temp layer map - uses vector tiles for performance */}
            {hasGeometry && isTempLayer && tempTileUrl && mapBounds && (
              <MapContainer>
                <Map
                  ref={mapRef}
                  initialViewState={{
                    bounds: mapBounds,
                    fitBoundsOptions: { padding: 40 },
                  }}
                  mapStyle={getBasemapUrl("light")}
                  dragRotate={false}
                  touchZoomRotate={false}
                  style={{ width: "100%", height: "100%" }}>
                  <Source id="temp-layer-source" type="vector" tiles={[tempTileUrl]} maxzoom={14}>
                    {/* Polygon fill layer */}
                    <MapLayer
                      {...({
                        id: "temp-layer-fill",
                        type: "fill",
                        "source-layer": "default",
                        filter: ["==", ["geometry-type"], "Polygon"],
                        paint: tempLayerPaint?.fill ?? {
                          "fill-color": theme.palette.primary.main,
                          "fill-opacity": 0.3,
                        },
                      } as LayerProps)}
                    />
                    {/* Polygon outline / line layer */}
                    <MapLayer
                      {...({
                        id: "temp-layer-outline",
                        type: "line",
                        "source-layer": "default",
                        filter: [
                          "any",
                          ["==", ["geometry-type"], "Polygon"],
                          ["==", ["geometry-type"], "LineString"],
                        ],
                        paint: tempLayerPaint?.line ?? {
                          "line-color": theme.palette.primary.main,
                          "line-width": 2,
                        },
                      } as LayerProps)}
                    />
                    {/* Point layer */}
                    <MapLayer
                      {...({
                        id: "temp-layer-points",
                        type: "circle",
                        "source-layer": "default",
                        filter: ["==", ["geometry-type"], "Point"],
                        paint: tempLayerPaint?.circle ?? {
                          "circle-radius": 6,
                          "circle-color": theme.palette.primary.main,
                          "circle-stroke-width": 2,
                          "circle-stroke-color": "#ffffff",
                        },
                      } as LayerProps)}
                    />
                  </Source>
                </Map>
              </MapContainer>
            )}
            {!hasGeometry && (
              <EmptyState>
                <Typography variant="body2">{t("no_geometry_available")}</Typography>
              </EmptyState>
            )}
          </TabPanel>
        </PanelContent>
      )}
    </PanelContainer>
  );
};

export default WorkflowDataPanel;

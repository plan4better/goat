import { createSlice } from "@reduxjs/toolkit";
import type { PayloadAction } from "@reduxjs/toolkit";
import type { MapGeoJSONFeature } from "react-map-gl/maplibre";

import { BASEMAPS } from "@/lib/constants/basemaps";
import type { UnitPreference } from "@/lib/utils/measurementUnits";
import type {
  BasemapLayerConfig,
  BuilderPanelSchema,
  BuilderWidgetSchema,
  Project,
} from "@/lib/validations/project";

import type { Basemap } from "@/types/map/common";
import { MapSidebarItemID } from "@/types/map/common";
import type { Result } from "@/types/map/controllers";
import type { MapPopoverEditorProps, MapPopoverInfoProps } from "@/types/map/popover";

export type MeasureToolType = "line" | "distance" | "circle" | "area" | "walking" | "car";

export type Measurement = {
  id: string;
  drawFeatureId: string; // Links to the MapboxDraw feature ID
  type: MeasureToolType;
  value: number;
  formattedValue: string;
  geometry: GeoJSON.Geometry;
  unitSystem?: UnitPreference;
  properties?: {
    perimeter?: number;
    formattedPerimeter?: string;
    radius?: number;
    formattedRadius?: string;
    azimuth?: number; // Bearing angle in degrees (0-360) for circles
    formattedAzimuth?: string;
    center?: [number, number]; // Center point for circles
    // Routing-specific properties
    routeDistance?: number; // Route distance in meters (from routing engine)
    duration?: number; // Route duration in seconds
    formattedDuration?: string; // Formatted duration string
    legs?: Array<{
      mode: string;
      duration: number;
      distance: number;
    }>; // Route leg details
    transfers?: number; // Number of transfers (for transit routes)
  };
};

export type TemporaryFilterTarget = {
  layer_id: number;
  filter: object;
};

export type TemporaryFilter = {
  id: string; // unique identifier
  layer_id: number; // primary layer id
  filter: object;
  // Additional layers to apply the same filter values to (with different column names)
  additional_targets?: TemporaryFilterTarget[];
  // When true, this filter is NOT applied to the source layer's tiles (keeps all features visible/clickable)
  excludeFromSourceLayer?: boolean;
};

export type ClickedFeatureForFilter = {
  layerProjectId: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  properties: Record<string, any>;
  timestamp: number;
};

/**
 * Ephemeral preview state for the popup live-editor. When set, MapViewer auto-pins
 * a `MapFeaturePopover` to the sample feature so the user can see edits in real time
 * while configuring the Popup section.
 */
export interface PopupPreview {
  layerId: string;
  feature: {
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: number[] | number[][] | number[][][] };
  };
}

export type MapMode = "data" | "builder" | "reports" | "workflows" | "public";

export interface MapState {
  project: Project | undefined;
  basemaps: Basemap[];
  activeBasemap: Basemap | undefined;
  // The project activeBasemap was chosen for. The store outlives the map page,
  // so a project opened next must not start from the previous one's basemap.
  activeBasemapProjectId: string | undefined;
  // Ephemeral live-preview of basemap layer settings while the edit dialog is
  // open. undefined = no preview (use the persisted activeBasemap.layer_config).
  basemapLayerConfigOverride: BasemapLayerConfig | undefined;
  maskLayer: string | undefined; // Toolbox mask layer
  toolboxStartingPoints: [number, number][] | undefined;
  activeLeftPanel: MapSidebarItemID | undefined;
  activeRightPanel: MapSidebarItemID | undefined;
  isMapGetInfoActive: boolean;
  mapCursor: string | undefined; // Toolbox features will override this. If undefined, the map will use the default cursor with pointer on hover
  highlightedFeature: MapGeoJSONFeature | undefined;
  popupInfo: MapPopoverInfoProps | undefined;
  popupEditor: MapPopoverEditorProps | undefined;
  popupPreview: PopupPreview | null;
  mapMode: MapMode;
  userLocation:
    | {
        active: boolean;
        position: GeolocationPosition | undefined;
      }
    | undefined;
  geocoderResult: Result | null;
  selectedBuilderItem: BuilderPanelSchema | BuilderWidgetSchema | undefined;
  currentZoom: number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  temporaryFilters: TemporaryFilter[]; // Temporary filters for the map,
  clickedFeatureForFilter: ClickedFeatureForFilter | undefined;
  collapsedPanels: Record<string, boolean>;
  // Measurement state
  activeMeasureTool: MeasureToolType | undefined;
  measurements: Measurement[];
  isMeasuring: boolean;
  selectedMeasurementId: string | undefined;
  measureSnapEnabled: boolean;
  isDataPanelOpen: boolean;
  dataPanelLayerId: number | null;
  dataPanelHeight: number;
  reportCanvasZoom: number;
}

const initialState = {
  project: undefined,
  basemaps: BASEMAPS,
  maskLayer: undefined,
  activeBasemap: undefined,
  activeBasemapProjectId: undefined,
  basemapLayerConfigOverride: undefined,
  activeLeftPanel: MapSidebarItemID.LAYERS,
  toolboxStartingPoints: undefined,
  activeRightPanel: undefined,
  isMapGetInfoActive: true,
  mapCursor: undefined,
  popupInfo: undefined,
  popupEditor: undefined,
  popupPreview: null,
  highlightedFeature: undefined,
  mapMode: "data",
  userLocation: undefined,
  geocoderResult: null,
  selectedBuilderItem: undefined,
  temporaryFilters: [] as TemporaryFilter[],
  clickedFeatureForFilter: undefined,
  collapsedPanels: {},
  activeMeasureTool: undefined,
  measurements: [] as Measurement[],
  isMeasuring: false,
  selectedMeasurementId: undefined,
  measureSnapEnabled: false,
  isDataPanelOpen: false,
  dataPanelLayerId: null,
  dataPanelHeight: 0,
  reportCanvasZoom: 1,
} as MapState;

const mapSlice = createSlice({
  name: "map",
  initialState: initialState,
  reducers: {
    setProject: (state, action: PayloadAction<Project | undefined>) => {
      state.project = action.payload;
    },
    updateProject: (state, action: PayloadAction<Project>) => {
      if (state.project) {
        state.project = { ...state.project, ...action.payload };
      }
    },
    setActiveBasemap: (state, action: PayloadAction<{ basemap: Basemap; projectId: string | undefined }>) => {
      state.activeBasemap = action.payload.basemap;
      state.activeBasemapProjectId = action.payload.projectId;
    },
    // Back to the project's own basemap: what the session chose is dropped
    // (the Explorer's theme basemap, when the Explorer closes).
    clearActiveBasemap: (state) => {
      state.activeBasemap = undefined;
      state.activeBasemapProjectId = undefined;
    },
    // Live preview of basemap layer settings (dialog edits before save). Set
    // while the dialog is open; the map renderer prefers it over the persisted
    // activeBasemap.layer_config. Cleared (undefined) on dialog close.
    setBasemapLayerConfigOverride: (
      state,
      action: PayloadAction<BasemapLayerConfig | undefined>
    ) => {
      state.basemapLayerConfigOverride = action.payload;
    },
    setActiveLeftPanel: (state, action: PayloadAction<MapSidebarItemID | undefined>) => {
      state.activeLeftPanel = action.payload;
    },
    setActiveRightPanel: (state, action: PayloadAction<MapSidebarItemID | undefined>) => {
      if (state.activeRightPanel === MapSidebarItemID.TOOLBOX) {
        state.maskLayer = undefined;
        state.toolboxStartingPoints = undefined;
        state.mapCursor = undefined;
      }
      state.activeRightPanel = action.payload;
    },
    setMaskLayer: (state, action: PayloadAction<string | undefined>) => {
      state.maskLayer = action.payload;
    },
    setToolboxStartingPoints: (state, action: PayloadAction<[number, number][] | undefined>) => {
      if (state.toolboxStartingPoints === undefined) {
        state.toolboxStartingPoints = action.payload;
      } else {
        if (action.payload === undefined) {
          state.toolboxStartingPoints = undefined;
        } else {
          state.toolboxStartingPoints = [...state.toolboxStartingPoints, ...action.payload];
        }
      }
    },
    setIsMapGetInfoActive: (state, action: PayloadAction<boolean>) => {
      state.isMapGetInfoActive = action.payload;
      if (action.payload === false) {
        state.popupInfo = undefined;
        state.highlightedFeature = undefined;
      }
    },
    setMapCursor: (state, action: PayloadAction<string | undefined>) => {
      state.mapCursor = action.payload;
    },
    setPopupInfo: (state, action: PayloadAction<MapPopoverInfoProps | undefined>) => {
      state.popupInfo = action.payload;
    },
    setPopupEditor: (state, action) => {
      state.popupEditor = action.payload;
    },
    setPopupPreview: (state, action: PayloadAction<PopupPreview | null>) => {
      state.popupPreview = action.payload;
    },
    setHighlightedFeature: (state, action) => {
      state.highlightedFeature = action.payload;
    },
    setMapMode: (state, action: PayloadAction<MapMode>) => {
      state.mapMode = action.payload;
      if (action.payload === "data") {
        state.selectedBuilderItem = undefined;
      }
      // Clean up data panel when leaving data mode
      if (action.payload !== "data") {
        state.isDataPanelOpen = false;
        state.dataPanelHeight = 0;
        state.dataPanelLayerId = null;
      }
    },
    setUserLocation: (state, action: PayloadAction<MapState["userLocation"]>) => {
      state.userLocation = action.payload;
    },
    setGeocoderResult: (state, action: PayloadAction<MapState["geocoderResult"]>) => {
      state.geocoderResult = action.payload;
    },
    setSelectedBuilderItem: (state, action: PayloadAction<MapState["selectedBuilderItem"]>) => {
      state.selectedBuilderItem = action.payload;
    },
    setCurrentZoom: (state, action: PayloadAction<number | undefined>) => {
      state.currentZoom = action.payload;
    },
    // Temporary filters for the map
    addTemporaryFilter: (state, action: PayloadAction<TemporaryFilter>) => {
      state.temporaryFilters.push(action.payload);
    },
    updateTemporaryFilter: (state, action: PayloadAction<TemporaryFilter>) => {
      const index = state.temporaryFilters.findIndex((f) => f.id === action.payload.id);
      if (index !== -1) {
        state.temporaryFilters[index] = action.payload;
      }
    },
    removeTemporaryFilter: (state, action: PayloadAction<string>) => {
      state.temporaryFilters = state.temporaryFilters.filter((f) => f.id !== action.payload);
    },
    setClickedFeatureForFilter: (state, action: PayloadAction<ClickedFeatureForFilter | undefined>) => {
      state.clickedFeatureForFilter = action.payload;
    },
    setCollapsedPanels: (state, action: PayloadAction<Record<string, boolean>>) => {
      state.collapsedPanels = {
        ...state.collapsedPanels,
        ...action.payload,
      };
    },
    // Measurement reducers
    setActiveMeasureTool: (state, action: PayloadAction<MeasureToolType | undefined>) => {
      state.activeMeasureTool = action.payload;
      state.isMeasuring = action.payload !== undefined;
    },
    addMeasurement: (state, action: PayloadAction<Measurement>) => {
      state.measurements.push(action.payload);
    },
    updateMeasurement: (state, action: PayloadAction<Measurement>) => {
      const index = state.measurements.findIndex((m) => m.id === action.payload.id);
      if (index !== -1) {
        state.measurements[index] = action.payload;
      }
    },
    removeMeasurement: (state, action: PayloadAction<string>) => {
      state.measurements = state.measurements.filter((m) => m.id !== action.payload);
      // Clear selection if the removed measurement was selected
      if (state.selectedMeasurementId === action.payload) {
        state.selectedMeasurementId = undefined;
      }
    },
    clearMeasurements: (state) => {
      state.measurements = [];
      state.selectedMeasurementId = undefined;
    },
    setIsMeasuring: (state, action: PayloadAction<boolean>) => {
      state.isMeasuring = action.payload;
    },
    setSelectedMeasurementId: (state, action: PayloadAction<string | undefined>) => {
      state.selectedMeasurementId = action.payload;
    },
    setMeasureSnapEnabled: (state, action: PayloadAction<boolean>) => {
      state.measureSnapEnabled = action.payload;
    },
    setIsDataPanelOpen: (state, action: PayloadAction<boolean>) => {
      state.isDataPanelOpen = action.payload;
      if (!action.payload) {
        state.dataPanelHeight = 0;
        state.dataPanelLayerId = null;
      }
    },
    setDataPanelLayerId: (state, action: PayloadAction<number | null>) => {
      state.dataPanelLayerId = action.payload;
    },
    setDataPanelHeight: (state, action: PayloadAction<number>) => {
      state.dataPanelHeight = action.payload;
    },
    setReportCanvasZoom: (state, action: PayloadAction<number>) => {
      state.reportCanvasZoom = action.payload;
    },
  },
});

export const {
  setProject,
  updateProject,
  setActiveBasemap,
  clearActiveBasemap,
  setBasemapLayerConfigOverride,
  setActiveLeftPanel,
  setActiveRightPanel,
  setMaskLayer,
  setToolboxStartingPoints,
  setIsMapGetInfoActive,
  setMapCursor,
  setPopupInfo,
  setPopupEditor,
  setPopupPreview,
  setHighlightedFeature,
  setMapMode,
  setUserLocation,
  setGeocoderResult,
  setSelectedBuilderItem,
  setCurrentZoom,
  addTemporaryFilter,
  updateTemporaryFilter,
  removeTemporaryFilter,
  setClickedFeatureForFilter,
  setCollapsedPanels,
  setActiveMeasureTool,
  addMeasurement,
  updateMeasurement,
  removeMeasurement,
  clearMeasurements,
  setIsMeasuring,
  setSelectedMeasurementId,
  setMeasureSnapEnabled,
  setIsDataPanelOpen,
  setDataPanelLayerId,
  setDataPanelHeight,
  setReportCanvasZoom,
} = mapSlice.actions;

export const mapReducer = mapSlice.reducer;

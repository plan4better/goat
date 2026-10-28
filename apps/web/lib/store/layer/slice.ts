import { createSlice } from "@reduxjs/toolkit";
import type { PayloadAction } from "@reduxjs/toolkit";

import type { Geometry } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { ProjectLayer, ProjectLayerGroup } from "@/lib/validations/project";

/** A copied style: pasted only onto a layer of the same kind and geometry. */
export interface StyleClipboard {
  sourceLayerName: string;
  document: LayerStyle;
  kind: "vector" | "raster" | "service";
  geometry?: Geometry;
}

export interface LayerState {
  activeLayerId: number | null;
  selectedLayerIds: number[];
  /** Bundle whose settings panel is open. A bundle is a layer *group* in the
   *  tree, so it cannot be addressed by `selectedLayerIds` — those are
   *  layer_project ids, a different id space. The two are mutually exclusive:
   *  selecting one clears the other. */
  selectedBundleId: string | null;
  projectLayers: ProjectLayer[];
  projectLayerGroups: ProjectLayerGroup[];
  styleClipboard: StyleClipboard | null;
}

const initialState = {
  activeLayerId: -1,
  selectedLayerIds: [],
  selectedBundleId: null,
  projectLayers: [],
  projectLayerGroups: [],
  styleClipboard: null,
} as LayerState;

const layerSlice = createSlice({
  name: "layer",
  initialState: initialState,
  reducers: {
    setActiveLayer: (state, action: PayloadAction<number | null>) => {
      if (action.payload === state.activeLayerId) {
        state.activeLayerId = null;
      } else {
        state.activeLayerId = action.payload;
      }
    },
    setSelectedBundle: (state, action: PayloadAction<string | null>) => {
      state.selectedBundleId = action.payload;
      if (action.payload) state.selectedLayerIds = [];
    },
    setSelectedLayers: (state, action: PayloadAction<number[]>) => {
      state.selectedLayerIds = action.payload;
      if (action.payload.length) state.selectedBundleId = null;

      // Sync the primary active ID:
      // If exactly one item is selected, it becomes the "Active" layer.
      // If 0 or >1 items selected, activeLayerId is null (Properties panel handles bulk/empty state).
      if (action.payload.length === 1) {
        state.activeLayerId = action.payload[0];
      } else {
        state.activeLayerId = null;
      }
    },
    setProjectLayers: (state, action: PayloadAction<ProjectLayer[]>) => {
      state.projectLayers = action.payload;
    },
    updateProjectLayer: (state, action: PayloadAction<{ id: number; changes: Partial<ProjectLayer> }>) => {
      const { id, changes } = action.payload;
      state.projectLayers = state.projectLayers.map((layer) =>
        layer.id === id ? { ...layer, ...changes } : layer
      );
    },
    addProjectLayer: (state, action: PayloadAction<ProjectLayer>) => {
      state.projectLayers.push(action.payload);
    },
    removeProjectLayer: (state, action: PayloadAction<number>) => {
      state.projectLayers = state.projectLayers.filter((layer) => layer.id !== action.payload);
    },
    setProjectLayerGroups: (state, action: PayloadAction<ProjectLayerGroup[]>) => {
      state.projectLayerGroups = action.payload;
    },
    updateProjectLayerGroup: (
      state,
      action: PayloadAction<{ id: number; changes: Partial<ProjectLayerGroup> }>
    ) => {
      const { id, changes } = action.payload;
      state.projectLayerGroups = state.projectLayerGroups.map((group) =>
        group.id === id ? { ...group, ...changes } : group
      );
    },
    addProjectLayerGroup: (state, action: PayloadAction<ProjectLayerGroup>) => {
      state.projectLayerGroups.push(action.payload);
    },
    removeProjectLayerGroup: (state, action: PayloadAction<number>) => {
      state.projectLayerGroups = state.projectLayerGroups.filter((group) => group.id !== action.payload);
    },
    setStyleClipboard: (state, action: PayloadAction<StyleClipboard>) => {
      state.styleClipboard = action.payload;
    },
    clearStyleClipboard: (state) => {
      state.styleClipboard = null;
    },
  },
});

export const {
  setActiveLayer,
  setSelectedBundle,
  setSelectedLayers,
  setProjectLayers,
  updateProjectLayer,
  addProjectLayer,
  removeProjectLayer,
  setProjectLayerGroups,
  updateProjectLayerGroup,
  addProjectLayerGroup,
  removeProjectLayerGroup,
  setStyleClipboard,
  clearStyleClipboard,
} = layerSlice.actions;

export const layerReducer = layerSlice.reducer;

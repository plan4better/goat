import type { RootState } from "@/lib/store";

export const selectProjectLayers = (state: RootState) => state.layers.projectLayers;
export const selectProjectLayerGroups = (state: RootState) => state.layers.projectLayerGroups;
export const selectProject = (state: RootState) => state.map.project;

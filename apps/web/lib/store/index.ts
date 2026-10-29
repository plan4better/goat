import { configureStore } from "@reduxjs/toolkit";

import { jobsReduces } from "@/lib/store/jobs/slice";
import { uploadsReducer } from "@/lib/store/uploads/slice";

import { explorerReducer } from "./explorer/slice";
import { featureEditorReducer } from "./featureEditor/slice";
import { interactionReducer } from "./interaction/slice";
import { layerReducer } from "./layer/slice";
import { mapReducer } from "./map/slice";
import { workflowReducer } from "./workflow/slice";

const store = configureStore({
  reducer: {
    layers: layerReducer,
    map: mapReducer,
    jobs: jobsReduces,
    uploads: uploadsReducer,
    workflow: workflowReducer,
    featureEditor: featureEditorReducer,
    interaction: interactionReducer,
    explorer: explorerReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false,
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export default store;

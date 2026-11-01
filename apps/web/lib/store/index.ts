import { configureStore } from "@reduxjs/toolkit";

import { jobsReduces } from "@/lib/store/jobs/slice";
import { uploadsReducer } from "@/lib/store/uploads/slice";

import { explorerReducer } from "./explorer/slice";
import { featureEditorReducer } from "./featureEditor/slice";
import { interactionReducer } from "./interaction/slice";
import { layerReducer } from "./layer/slice";
import { mapReducer } from "./map/slice";
import { workflowReducer } from "./workflow/slice";

/** A fresh store. The app has one; a preview map gets its own, so what it
 * writes (popups, highlighted features, the zoom) never reaches the page's map. */
export const makeStore = () =>
  configureStore({
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

const store = makeStore();

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export default store;

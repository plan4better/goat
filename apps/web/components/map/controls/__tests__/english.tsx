// Renders map controls with the app's English copy, a Redux store whose open project is in a given mode, and the
// project's scene store (local: nothing is sent).
import { ThemeProvider, createTheme } from "@mui/material";
import { configureStore } from "@reduxjs/toolkit";
import { render } from "@testing-library/react";
import i18next from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { Provider } from "react-redux";

import en from "@/i18n/locales/en/common.json";
import type { ViewMode } from "@/lib/scene/view";
import { initView, mapReducer } from "@/lib/store/map/slice";
import type { Scene } from "@/lib/style/generated/types";

import { SceneStoreProvider, useSceneDocument, useSceneStoreContext } from "@/hooks/map/useSceneStore";

export const english = i18next.createInstance();
void english.use(initReactI18next).init({
  lng: "en",
  ns: ["common"],
  defaultNS: "common",
  resources: { en: { common: en } },
  initImmediate: false,
  react: { useSuspense: false },
});

/** The scene as the store holds it, after each render. */
export const seen: { scene?: Scene } = {};

function SceneSpy() {
  seen.scene = useSceneDocument(useSceneStoreContext());
  return null;
}

export function renderControl(
  ui: ReactNode,
  opts: { mode?: ViewMode; projection?: "mercator" | "globe"; scene?: Scene } = {}
) {
  const store = configureStore({ reducer: { map: mapReducer } });
  store.dispatch(
    initView({ projectId: "p1", mode: opts.mode ?? "3d", projection: opts.projection ?? "mercator" })
  );
  const result = render(
    <I18nextProvider i18n={english}>
      <ThemeProvider theme={createTheme()}>
        <Provider store={store}>
          <SceneStoreProvider projectId="p1" initial={opts.scene} editable={false}>
            {ui}
            <SceneSpy />
          </SceneStoreProvider>
        </Provider>
      </ThemeProvider>
    </I18nextProvider>
  );
  return { ...result, store };
}

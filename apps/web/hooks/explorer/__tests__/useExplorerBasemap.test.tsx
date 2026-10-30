import { ThemeProvider, createTheme } from "@mui/material";
import { configureStore } from "@reduxjs/toolkit";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { describe, expect, it } from "vitest";

import { closeExplorer, explorerReducer, openExplorer } from "@/lib/store/explorer/slice";
import { mapReducer } from "@/lib/store/map/slice";

import { useExplorerBasemap } from "@/hooks/explorer/useExplorerBasemap";

type Project = { id: string; basemap?: string | null };

function setup(mode: "light" | "dark", project: Project, open = true) {
  const store = configureStore({ reducer: { map: mapReducer, explorer: explorerReducer } });
  if (open) store.dispatch(openExplorer({ bundleId: "b1", bundleName: "Feed" }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <ThemeProvider theme={createTheme({ palette: { mode } })}>{children}</ThemeProvider>
    </Provider>
  );
  const hook = renderHook(({ p }: { p: Project }) => useExplorerBasemap(p), {
    wrapper,
    initialProps: { p: project },
  });
  const shown = () => store.getState().map.activeBasemap?.value;
  return { store, hook, shown };
}

describe("the Explorer's basemap", () => {
  it("follows the theme where nobody has chosen the project's basemap", () => {
    expect(setup("dark", { id: "p1", basemap: null }).shown()).toBe("dark");
    expect(setup("light", { id: "p1", basemap: null }).shown()).toBe("light");
    expect(setup("dark", { id: "p1", basemap: null }).store.getState().map.activeBasemapProjectId).toBe("p1");
    // Core leaves an unset basemap out.
    expect(setup("dark", { id: "p1" }).shown()).toBe("dark");
  });

  it("leaves a basemap chosen for the project as it is", () => {
    expect(setup("dark", { id: "p1", basemap: "light" }).shown()).toBeUndefined();
    expect(setup("dark", { id: "p1", basemap: "satellite" }).shown()).toBeUndefined();
    // High Fidelity picked: what an unset one is shown as, but chosen.
    expect(setup("dark", { id: "p1", basemap: "streets" }).shown()).toBeUndefined();
  });

  it("waits for the project", () => {
    const store = configureStore({ reducer: { map: mapReducer, explorer: explorerReducer } });
    store.dispatch(openExplorer({ bundleId: "b1", bundleName: "Feed" }));
    renderHook(() => useExplorerBasemap(undefined), {
      wrapper: ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>,
    });
    expect(store.getState().map.activeBasemap).toBeUndefined();
  });

  it("does nothing outside the Explorer", () => {
    expect(setup("dark", { id: "p1", basemap: null }, false).shown()).toBeUndefined();
  });

  it("gives the project its own basemap back when the Explorer closes", () => {
    const { store, hook, shown } = setup("dark", { id: "p1", basemap: null });
    expect(shown()).toBe("dark");
    act(() => {
      store.dispatch(closeExplorer());
    });
    hook.rerender({ p: { id: "p1", basemap: null } });
    expect(shown()).toBeUndefined();
  });

  it("keeps High Fidelity picked in the Explorer, then and on coming back", () => {
    const { store, hook, shown } = setup("dark", { id: "p1" });
    expect(shown()).toBe("dark");
    // Picked in the Explorer: saved, so core now sends it.
    hook.rerender({ p: { id: "p1", basemap: "streets" } });
    expect(shown()).toBeUndefined();
    act(() => {
      store.dispatch(closeExplorer());
    });
    hook.rerender({ p: { id: "p1", basemap: "streets" } });
    act(() => {
      store.dispatch(openExplorer({ bundleId: "b1", bundleName: "Feed" }));
    });
    hook.rerender({ p: { id: "p1", basemap: "streets" } });
    expect(shown()).toBeUndefined();
  });

  it("lets a basemap the user picks take over", () => {
    const { hook, shown } = setup("dark", { id: "p1", basemap: null });
    // Saved to the project; the map page then sets it in the store.
    hook.rerender({ p: { id: "p1", basemap: "light" } });
    expect(shown()).toBeUndefined();
  });
});

import { configureStore } from "@reduxjs/toolkit";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import { takeLeave } from "@/lib/explorer/edit/leave";
import { editApplied, explorerReducer, openExplorer } from "@/lib/store/explorer/slice";

import { useExplorerLeave } from "@/hooks/explorer/useExplorerLeave";

function setup(changed: boolean) {
  const store = configureStore({ reducer: { explorer: explorerReducer } });
  store.dispatch(openExplorer({ bundleId: "b1", bundleName: "Feed" }));
  if (changed) store.dispatch(editApplied({ id: "a", kind: "stop_rename", label: "Renamed" }));
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  const { result } = renderHook(() => useExplorerLeave(), { wrapper });
  return { store, leave: result.current };
}

describe("leaving the Explorer", () => {
  it("goes ahead at once with nothing unsaved", () => {
    const { store, leave } = setup(false);
    const proceed = vi.fn();
    leave(proceed);
    expect(proceed).toHaveBeenCalledOnce();
    expect(store.getState().explorer.edit.exit).toBeNull();
  });

  it("asks first with unsaved changes, and waits for the answer", () => {
    const { store, leave } = setup(true);
    const proceed = vi.fn();
    leave(proceed);
    expect(proceed).not.toHaveBeenCalled();
    expect(store.getState().explorer.edit.exit).toBe("asking");
    // The dialog, answered with a save or a discard, goes on with it.
    takeLeave()?.();
    expect(proceed).toHaveBeenCalledOnce();
    expect(takeLeave()).toBeNull();
  });
});

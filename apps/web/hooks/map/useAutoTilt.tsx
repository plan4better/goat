"use client";

// The tilt a first height brings (3D spec 8.4): giving a layer a height on a 2D map switches the map to 3D once and
// says so, with Undo; after Undo the layer does not tilt the map again in this session.
import { Box, Button, Typography } from "@mui/material";
import { useCallback, useContext, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ReactReduxContext } from "react-redux";
import { toast } from "react-toastify";

import type { ViewMode } from "@/lib/scene/view";
import { setViewMode } from "@/lib/store/map/slice";

/** Layers whose tilt was undone in this session. */
const declined = new Set<string>();

const NO_SUBSCRIBE = () => () => undefined;

/** The open project's view mode and a way to change it; undefined outside a map page (a store without the slice). */
export function useViewModeControl(): { mode: ViewMode | undefined; set: (mode: ViewMode) => void } {
  const store = useContext(ReactReduxContext)?.store;
  const read = () =>
    (store?.getState() as { map?: { view?: { mode: ViewMode } } } | undefined)?.map?.view?.mode;
  const mode = useSyncExternalStore(store ? store.subscribe : NO_SUBSCRIBE, read, read);
  const set = useCallback((next: ViewMode) => store?.dispatch(setViewMode(next)), [store]);
  return { mode, set };
}

function TiltToast({ onUndo }: { onUndo: () => void }) {
  const { t } = useTranslation("common");
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
      <Typography variant="body2" sx={{ flex: 1 }}>
        {t("view3d.switched_to_3d")}
      </Typography>
      <Button size="small" onClick={onUndo} sx={{ textTransform: "none", fontWeight: 700 }}>
        {t("view3d.undo")}
      </Button>
    </Box>
  );
}

/** Whether the map shows a layer's height flat because its tilt was undone, or the map is in 2D. */
export function useAutoTilt(layerKey: string): {
  /** Call after a height was set: `fromNone` when the layer had none before. */
  tilt: (fromNone: boolean) => void;
  mode: ViewMode | undefined;
  show3d: () => void;
} {
  const { mode, set } = useViewModeControl();
  const tilt = useCallback(
    (fromNone: boolean) => {
      if (!fromNone || mode !== "2d" || declined.has(layerKey)) return;
      set("3d");
      const id = toast.info(
        <TiltToast
          onUndo={() => {
            declined.add(layerKey);
            set("2d");
            toast.dismiss(id);
          }}
        />,
        { icon: false }
      );
    },
    [mode, set, layerKey]
  );
  return { tilt, mode, show3d: () => set("3d") };
}

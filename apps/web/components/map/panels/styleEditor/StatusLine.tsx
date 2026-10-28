"use client";

// The save status (spec 13.1), in words and without dialogs; when saving stopped, why, and for a style someone else
// changed meanwhile the choice to apply or discard this page's changes.
import { Box, Button, Typography } from "@mui/material";
import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import type { StyleSaver } from "@/lib/style/save";

export function useSaverState(saver: StyleSaver) {
  const subscribe = useCallback((listener: () => void) => saver.subscribe(listener), [saver]);
  const read = () => `${saver.status}|${saver.stopReason ?? ""}`;
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const [status, reason] = snapshot.split("|");
  return { status, reason: reason || null };
}

/** The save status in words, for a line beside the style's name. */
export function useStatusText(saver: StyleSaver): { text: string; stopped: boolean } {
  const { t } = useTranslation("common");
  const { status, reason } = useSaverState(saver);
  return {
    text: status === "stopped" ? t(`style_editor.stopped_${reason}`) : t(`style_editor.status_${status}`),
    stopped: status === "stopped",
  };
}

/** `problemsOnly`: where the status is shown beside the style's name, this line appears only when saving stopped. */
export function StatusLine({ saver, problemsOnly = false }: { saver: StyleSaver; problemsOnly?: boolean }) {
  const { t } = useTranslation("common");
  const { status, reason } = useSaverState(saver);
  if (problemsOnly && status !== "stopped") return null;
  const text =
    status === "stopped" ? t(`style_editor.stopped_${reason}`) : t(`style_editor.status_${status}`);
  return (
    // Beside the style's name the status is announced already: this line only spells out why saving stopped.
    <Box
      role={problemsOnly ? undefined : "status"}
      sx={{ px: 3, py: 1, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2 }}>
      <Typography variant="caption" color={status === "stopped" ? "error" : "text.secondary"}>
        {text}
      </Typography>
      {reason === "base_too_old" && (
        <Box sx={{ display: "flex", gap: 2 }}>
          <Button size="small" variant="contained" onClick={() => void saver.resolveBaseTooOld("apply")}>
            {t("style_editor.apply_my_changes")}
          </Button>
          <Button size="small" onClick={() => void saver.resolveBaseTooOld("discard")}>
            {t("style_editor.discard_my_changes")}
          </Button>
        </Box>
      )}
    </Box>
  );
}

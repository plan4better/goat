"use client";

// The save status (spec 13.1), in words and without dialogs; when saving stopped, why (with the server's issues when
// it refused the document), and for a style someone else changed meanwhile the choice to apply or discard this page's
// changes.
import { Box, Button, Typography } from "@mui/material";
import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import type { StyleSaver } from "@/lib/style/save";

export function useSaverState(saver: StyleSaver) {
  const subscribe = useCallback((listener: () => void) => saver.subscribe(listener), [saver]);
  const read = () => `${saver.status}|${saver.stopReason ?? ""}|${saver.stopCode ?? ""}`;
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const [status, reason, code] = snapshot.split("|");
  return { status, reason: reason || null, code: code || null };
}

/** Refusal codes of a document or request body over the server's size limit. */
const TOO_LARGE = new Set(["document_too_large", "body_too_large"]);

/** The text key of a save status: why saving stopped, a style too large to save by its own words. */
function statusKey({ status, reason, code }: ReturnType<typeof useSaverState>): string {
  if (status !== "stopped") return `style_editor.status_${status}`;
  if (reason === "refused" && code && TOO_LARGE.has(code)) return "style_editor.stopped_too_large";
  return `style_editor.stopped_${reason}`;
}

/** The save status in words, for a line beside the style's name. */
export function useStatusText(saver: StyleSaver): { text: string; stopped: boolean } {
  const { t } = useTranslation("common");
  const state = useSaverState(saver);
  return { text: t(statusKey(state)), stopped: state.status === "stopped" };
}

/** `problemsOnly`: where the status is shown beside the style's name, this line appears only when saving stopped. */
export function StatusLine({ saver, problemsOnly = false }: { saver: StyleSaver; problemsOnly?: boolean }) {
  const { t } = useTranslation("common");
  const state = useSaverState(saver);
  const { status, reason } = state;
  if (problemsOnly && status !== "stopped") return null;
  const text = t(statusKey(state));
  const refusal = saver.stopIssues.map((issue) => issue.message).join(" ");
  return (
    // Beside the style's name the status is announced already: this line only spells out why saving stopped.
    <Box
      role={problemsOnly ? undefined : "status"}
      sx={{ px: 3, py: 1, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2 }}>
      <Typography variant="caption" color={status === "stopped" ? "error" : "text.secondary"}>
        {refusal ? `${text} ${refusal}` : text}
      </Typography>
      {reason === "base_too_old" && (
        <Box sx={{ display: "flex", gap: 2 }}>
          <Button size="small" variant="text" onClick={() => void saver.resolveBaseTooOld("discard")}>
            {t("style_editor.discard_my_changes")}
          </Button>
          <Button
            size="small"
            variant="contained"
            disableElevation
            onClick={() => void saver.resolveBaseTooOld("apply")}>
            {t("style_editor.apply_my_changes")}
          </Button>
        </Box>
      )}
    </Box>
  );
}

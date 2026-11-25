"use client";

import { Box, Button, Stack } from "@mui/material";
import type { TFunction } from "i18next";
import { toast } from "react-toastify";

/** How long a toast that can be undone stays (decision 16). */
export const UNDO_TOAST_MS = 7000;

/**
 * A success toast with "Rückgängig", for changes the API can put back (a
 * role, a domain's assignment, the active AI connection, the AI switch). The
 * undo runs once and closes the toast; a failed undo says so.
 */
export function undoToast(message: string, onUndo: () => Promise<unknown> | unknown, t: TFunction): void {
  let used = false;
  toast.success(
    ({ closeToast }) => (
      <Stack direction="row" alignItems="center" gap={2}>
        <Box sx={{ flex: 1, minWidth: 0 }}>{message}</Box>
        <Button
          variant="text"
          size="small"
          color="inherit"
          sx={{ flexShrink: 0, fontWeight: 700 }}
          onClick={async () => {
            if (used) return;
            used = true;
            closeToast?.();
            try {
              await onUndo();
            } catch {
              toast.error(t("settings_undo_failed"));
            }
          }}>
          {t("undo")}
        </Button>
      </Stack>
    ),
    { autoClose: UNDO_TOAST_MS }
  );
}

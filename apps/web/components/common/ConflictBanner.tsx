"use client";

import { Alert, Box, Button, Stack } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { plainTranslate } from "@/lib/assistant/chips";
import { type ConflictDocument, changedElsewhereText } from "@/lib/utils/changedElsewhereText";
import type { SaveConflict } from "@/lib/utils/revisionedSaver";

import { useNow } from "@/hooks/assistant/useNow";

interface ConflictBannerProps {
  /** The document the editor shows; its texts name it. */
  document: ConflictDocument;
  conflict: SaveConflict;
  /** The change is the assistant's (or the dock's Undo of it), which the
   * editor was about to load: said so, since it is saved under the person's
   * own account and would read as their own change elsewhere. */
  byAssistant?: boolean;
  /** Loads the stored document over the editor's copy. */
  onReload: () => unknown;
  /** Saves the editor's copy on top of the stored document. */
  onKeepMine: () => unknown;
}

/**
 * A notice at the top of an editor whose save core refused because the
 * document changed elsewhere: who changed it and when, with Reload and Keep
 * mine. The editor's positioned area holds it, as the canvas holds the "Not
 * saved" notice.
 */
export default function ConflictBanner({
  document,
  conflict,
  byAssistant = false,
  onReload,
  onKeepMine,
}: ConflictBannerProps) {
  const { t, i18n } = useTranslation("common");
  const now = useNow();
  const [busy, setBusy] = useState(false);

  const run = (action: () => unknown) => async () => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      sx={{
        position: "absolute",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 11,
        width: "calc(100% - 32px)",
        maxWidth: 560,
      }}>
      <Alert
        severity="warning"
        sx={{ boxShadow: 3, alignItems: "center" }}
        action={
          <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
            {/* Each label on one line: the message gives way, as German's longer labels need. */}
            <Button
              color="inherit"
              size="small"
              disabled={busy}
              onClick={run(onReload)}
              sx={{ whiteSpace: "nowrap", flexShrink: 0 }}>
              {t("changed_elsewhere_reload")}
            </Button>
            <Button
              color="inherit"
              size="small"
              disabled={busy}
              onClick={run(onKeepMine)}
              sx={{ whiteSpace: "nowrap", flexShrink: 0 }}>
              {t("changed_elsewhere_keep_mine")}
            </Button>
          </Stack>
        }>
        {byAssistant
          ? t(`${document}_changed_by_assistant`)
          : changedElsewhereText(plainTranslate(t), document, conflict, i18n?.language ?? "en", now)}
      </Alert>
    </Box>
  );
}

"use client";

import { Alert, Box, CircularProgress, Stack } from "@mui/material";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { assistantErrorKey } from "@/lib/assistant/errors";
import { startConversation } from "@/lib/assistant/startConversation";
import {
  NEW_CONVERSATION_DRAFT,
  clearDraft,
  getDraft,
  saveDraft,
  useActiveSurface,
} from "@/lib/assistant/store";
import { pageOrigin, useProjectSurfaceWait } from "@/lib/assistant/surface";

import Composer from "@/components/assistant/Composer";
import EmptyState from "@/components/assistant/EmptyState";
import { composerFooterSx } from "@/components/assistant/styles";
import { useComposerContext } from "@/components/assistant/useComposerContext";

/**
 * A conversation that does not exist yet: it is created on the first send and
 * opened with that message. Its first accepted run binds it to the open project
 * (spec §10).
 */
export default function NewConversation({ big }: { big?: boolean }) {
  const { t } = useTranslation("common");
  const surface = useActiveSurface();
  const pathname = usePathname();
  const composer = useComposerContext(NEW_CONVERSATION_DRAFT);
  // Restored after a remount (expanding or collapsing the dock); see `saveDraft`.
  const [draft, setDraft] = useState(() => getDraft(NEW_CONVERSATION_DRAFT)?.text ?? "");
  const changeDraft = (value: string) => {
    setDraft(value);
    saveDraft(NEW_CONVERSATION_DRAFT, { text: value });
  };
  // A starter that is a sentence start goes into the composer in front of what the user typed
  // there already, and the composer takes the focus.
  const [focusRequest, setFocusRequest] = useState(0);
  const prependDraft = (start: string) => {
    changeDraft(`${start}${draft.trimStart()}`);
    setFocusRequest((n) => n + 1);
  };
  const [creating, setCreating] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  // On a project page before its project registered, a conversation would start without it.
  const waiting = useProjectSurfaceWait(pathname, surface);

  const start = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || creating || waiting) return;
    setCreating(true);
    setErrorKey(null);
    try {
      await startConversation(trimmed, {
        origin: surface?.surface ?? pageOrigin(pathname),
        context: composer.context,
      });
      // The message moved to the new conversation; its chat view keeps it if the first run is refused.
      clearDraft(NEW_CONVERSATION_DRAFT);
    } catch (error) {
      setErrorKey(assistantErrorKey(error));
      setCreating(false);
    }
  };

  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Box
        sx={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          px: big ? "24px" : "20px",
          py: "24px",
        }}>
        {/* Centred in the free space by its auto margins; a taller start page scrolls from its top. */}
        <Box sx={{ width: "100%", maxWidth: big ? 720 : "none", mx: "auto", my: "auto" }}>
          {waiting ? (
            <Box sx={{ display: "flex", justifyContent: "center", pt: "16px" }}>
              <CircularProgress size={20} />
            </Box>
          ) : (
            <EmptyState
              big={big}
              context={composer.context}
              onPick={(text) => void start(text)}
              onDraft={prependDraft}
            />
          )}
          {errorKey && (
            <Alert severity="error" sx={{ mt: "16px" }}>
              {t(errorKey)}
            </Alert>
          )}
        </Box>
      </Box>
      <Box sx={composerFooterSx(big)}>
        <Box sx={{ maxWidth: big ? 720 : "none", mx: "auto" }}>
          <Composer
            draft={draft}
            onDraftChange={changeDraft}
            busy={creating || waiting}
            onSend={() => void start(draft)}
            chips={composer.chips}
            onRemoveChip={composer.removeChip}
            mentionsEnabled={composer.mentionsEnabled}
            onAddSource={composer.addSource}
            sourcesFull={composer.sourcesFull}
            excludeProjectId={composer.projectId}
            big={big}
            focusRequest={focusRequest}
          />
        </Box>
      </Box>
    </Stack>
  );
}

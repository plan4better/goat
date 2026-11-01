"use client";

import { Button, Popover, Stack, Tooltip, Typography } from "@mui/material";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { plainTranslate } from "@/lib/assistant/chips";
import { assistantErrorKey, toRequestError } from "@/lib/assistant/errors";
import { type ChangedSince, undoAnswer } from "@/lib/assistant/transport";
import { changedText } from "@/lib/utils/changedElsewhereText";

import { useNow } from "@/hooks/assistant/useNow";

import { useDockActions } from "@/components/assistant/DockActions";
import { mutedText } from "@/components/assistant/styles";

/**
 * The runs whose edits this tab undid: a chat mounts again when the dock
 * expands or reconnects, and its stored answers carry the state only after a
 * reload of the conversation.
 */
const undoneRuns = new Set<string>();

/** Tests: forget the answers undone, as a fresh tab would. */
export function resetUndoneAnswers(): void {
  undoneRuns.clear();
}

/** What the popover asks about before an Undo writes over it. */
type Asking = { kind: "unsaved" } | { kind: "changed"; changed: ChangedSince[] };

/**
 * Undo of an answer's workflow edits: writes back what they replaced, and the
 * page follows (the open workflow loads the stored version). Nothing is
 * written over without asking: changes of the workflow the editor has not
 * saved yet (then the editor asks which version to keep), and a workflow
 * saved since the answer's edits (the popover says who changed it and when,
 * and Undo anyway saves on top of it). Once done, the button reads Undone.
 */
export default function UndoAnswer({
  conversationId,
  runId,
  workflowIds,
  undone: undoneBefore = false,
}: {
  conversationId: string;
  runId: string;
  /** The workflows the answer changed. */
  workflowIds: string[];
  /** The answer's edits were undone before (the stored conversation says so). */
  undone?: boolean;
}) {
  const { t, i18n } = useTranslation("common");
  const actions = useDockActions();
  const now = useNow();
  const button = useRef<HTMLButtonElement>(null);
  const [undone, setUndone] = useState(() => undoneBefore || undoneRuns.has(runId));
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);

  const done = () => {
    undoneRuns.add(runId);
    setUndone(true);
  };

  const undo = async (force: boolean, unsavedAsked = false) => {
    setAsking(null);
    if (!force && !unsavedAsked && actions.unsavedWorkflowChanges(workflowIds)) {
      setAsking({ kind: "unsaved" });
      return;
    }
    setBusy(true);
    try {
      const outcome = await undoAnswer(conversationId, runId, force);
      if (outcome.restored.length) actions.followWorkflowChanges(outcome.restored);
      if (outcome.kind === "undone") done();
      else setAsking({ kind: "changed", changed: outcome.changed });
    } catch (error) {
      const code = toRequestError(error)?.code;
      if (code === "already_undone") {
        done();
        toast.info(t("assistant_undo_already"));
      } else if (code === "undo_in_progress") {
        toast.info(t("assistant_undo_in_progress"));
      } else {
        toast.error(t(assistantErrorKey(error)));
      }
    } finally {
      setBusy(false);
    }
  };

  if (undone) {
    return (
      <Tooltip title={t("assistant_undone_hint")} describeChild>
        {/* A disabled button shows no tooltip of its own. */}
        <span>
          <Button
            size="small"
            variant="text"
            disabled
            startIcon={<Icon iconName={ICON_NAME.CHECK} style={{ fontSize: 12 }} />}>
            {t("assistant_undone")}
          </Button>
        </span>
      </Tooltip>
    );
  }

  const changed = asking?.kind === "changed" ? asking.changed : [];
  const [only] = changed;
  // The person's name is user text: React escapes it, so i18next must not.
  const question =
    asking?.kind === "unsaved"
      ? t("assistant_undo_unsaved")
      : changed.length > 1
        ? t("assistant_undo_changed_many", { count: changed.length })
        : only?.between
          ? t("assistant_undo_changed_between")
          : only
            ? changedText(plainTranslate(t), "assistant_undo_changed", only, i18n?.language ?? "en", now)
            : "";
  const hint =
    asking?.kind === "unsaved" ? t("assistant_undo_unsaved_hint") : t("assistant_undo_anyway_hint");

  return (
    <>
      <Tooltip title={t("assistant_undo_hint")} describeChild>
        <Button
          ref={button}
          size="small"
          variant="text"
          disabled={busy}
          onClick={() => void undo(false)}
          startIcon={<Icon iconName={ICON_NAME.UNDO} style={{ fontSize: 12 }} />}>
          {t("assistant_undo")}
        </Button>
      </Tooltip>
      <Popover
        open={!!asking}
        anchorEl={button.current}
        onClose={() => setAsking(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}>
        <Stack gap="10px" sx={{ p: "12px", width: 320 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{question}</Typography>
          <Typography sx={(theme) => ({ fontSize: 12.5, color: mutedText(theme) })}>{hint}</Typography>
          <Stack direction="row" gap="8px" justifyContent="flex-end">
            <Button size="small" color="inherit" onClick={() => setAsking(null)}>
              {t("cancel")}
            </Button>
            <Button
              size="small"
              variant="contained"
              disabled={busy}
              onClick={() => void (asking?.kind === "unsaved" ? undo(false, true) : undo(true))}>
              {t("assistant_undo_anyway")}
            </Button>
          </Stack>
        </Stack>
      </Popover>
    </>
  );
}

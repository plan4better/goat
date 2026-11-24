"use client";

import { Button, Popover, Stack, Tooltip, Typography } from "@mui/material";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { type AnswerChanges, hasChanges } from "@/lib/assistant/answerChanges";
import { plainTranslate } from "@/lib/assistant/chips";
import { assistantErrorKey, toRequestError } from "@/lib/assistant/errors";
import { getMapBridge } from "@/lib/assistant/mapBridge";
import { type MapChange, mergedMapChange } from "@/lib/assistant/mapEdits";
import { type Restored, type UndoOutcome, undoAnswer } from "@/lib/assistant/transport";
import { followUndone } from "@/lib/assistant/undoReply";
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

/** What went back of a run in this tab, over all its Undo calls (an Undo anyway goes on where a first call stopped). */
interface WentBack {
  workflows: Set<string>;
  styles: Set<string>;
  map: boolean;
  partial: boolean;
  layerRemoved: boolean;
  mapRefused: boolean;
  groupInUse: boolean;
  /** Core stored nothing of a style's restore in the latest call: that style is still as the answer left it. */
  styleRefused: boolean;
}
const wentBack = new Map<string, WentBack>();

/** Tests: forget the answers undone, as a fresh tab would. */
export function resetUndoneAnswers(): void {
  undoneRuns.clear();
  wentBack.clear();
}

function count(runId: string, restored: Restored): void {
  const tally = wentBack.get(runId) ?? {
    workflows: new Set<string>(),
    styles: new Set<string>(),
    map: false,
    partial: false,
    layerRemoved: false,
    mapRefused: false,
    groupInUse: false,
    styleRefused: false,
  };
  restored.workflows.forEach((workflow) => tally.workflows.add(workflow.workflowId));
  restored.styles.forEach((style) => tally.styles.add(`${style.layerProjectId}/${style.styleId}`));
  tally.map ||= restored.map !== null;
  tally.partial ||= restored.styles.some((style) => style.partial);
  tally.layerRemoved ||= restored.notRestored.includes("layer_removed");
  tally.mapRefused ||= restored.notRestored.includes("map_refused");
  tally.groupInUse ||= restored.notRestored.includes("group_in_use");
  // A later call may put that style back.
  tally.styleRefused = restored.notRestored.includes("style");
  wentBack.set(runId, tally);
}

/** A line under an answer's actions about its Undo: after the row's other actions, on a line of its own, where
 * the answer's text starts. */
export function UndoNote({ children }: { children: string }) {
  return (
    <Typography
      sx={(theme) => ({
        order: 1,
        flexBasis: "100%",
        pl: "6px",
        fontSize: 12.5,
        color: mutedText(theme),
      })}>
      {children}
    </Typography>
  );
}

type Changed = Extract<UndoOutcome, { kind: "changed" }>["changed"];

/** What the popover asks about before an Undo writes over it. */
type Asking = { kind: "unsaved" } | { kind: "changed"; changed: Changed };

/**
 * Undo of an answer's edits of workflows, styles and the map: writes back
 * what they replaced, and the page follows (the open workflow loads the stored
 * version, the map page reads the styles and what went back of its map).
 * Pending style saves of the map page go out first, so the Undo sees them.
 * Nothing is written over without asking: changes of the workflow the editor
 * has not saved yet (then the editor asks which version to keep), and
 * anything saved since the answer's edits (the popover says what, for one
 * workflow who changed it and when, and Undo anyway saves on top of it). Once
 * done, the button reads Undone and its hint counts what went back. Lines
 * below say what could not go back (also while the button stays Undo, for a
 * style core refused) and, while the rest is asked about, what went back already.
 */
export default function UndoAnswer({
  conversationId,
  runId,
  changes,
  undone: undoneBefore = false,
}: {
  conversationId: string;
  runId: string;
  /** What the answer changed. */
  changes: AnswerChanges;
  /** The answer's edits were undone elsewhere: before (the stored conversation says so), or by a typed undo. */
  undone?: boolean;
}) {
  const { t, i18n } = useTranslation("common");
  const actions = useDockActions();
  const now = useNow();
  const button = useRef<HTMLButtonElement>(null);
  const [undoneHere, setUndoneHere] = useState(() => undoneRuns.has(runId));
  const undone = undoneBefore || undoneHere;
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);

  const done = () => {
    undoneRuns.add(runId);
    setUndoneHere(true);
  };

  /** Has the page read again everything the answer changed, as an Undo whose reply names nothing. */
  const followAll = () => {
    if (changes.workflows.length) {
      actions.followWorkflowChanges(
        changes.workflows.map(({ workflowId }) => ({ workflowId, revision: null }))
      );
    }
    if (changes.styles.length) {
      actions.followStyleChanges(
        changes.styles.map((change) => ({ ...change, revision: null, listChanged: true }))
      );
    }
    const maps = new Map<string, MapChange>();
    for (const change of changes.map) {
      const known = maps.get(change.projectId);
      maps.set(change.projectId, known ? mergedMapChange(known, change) : change);
    }
    maps.forEach((change) => actions.followMapChange(change));
  };

  const undo = async (force: boolean, unsavedAsked = false) => {
    setAsking(null);
    const workflowIds = [...new Set(changes.workflows.map((edit) => edit.workflowId))];
    if (!force && !unsavedAsked && workflowIds.length > 0 && actions.unsavedWorkflowChanges(workflowIds)) {
      setAsking({ kind: "unsaved" });
      return;
    }
    setBusy(true);
    try {
      // An undo of the map reads the styles too (the active one goes back). An answer whose steps name no change
      // (a Stop ended its write) may have changed the open map page's project: that page's saves go first.
      const projectIds = new Set([...changes.styles, ...changes.map].map((change) => change.projectId));
      const bridges = hasChanges(changes)
        ? [...projectIds].map((projectId) => getMapBridge(projectId))
        : [getMapBridge()];
      for (const bridge of bridges) {
        await bridge?.settle().catch(() => undefined);
      }
      const outcome = await undoAnswer(conversationId, runId, force);
      const { restored } = outcome;
      followUndone(restored, actions);
      count(runId, restored);
      if (outcome.kind === "changed") setAsking({ kind: "changed", changed: outcome.changed });
      // Core stored nothing of a style's restore: the Undo stays, and a line says so.
      else if (!restored.notRestored.includes("style")) done();
    } catch (error) {
      const code = toRequestError(error)?.code;
      if (code === "already_undone") {
        // Another call undid it and its reply did not reach this tab: what the answer changed is read again.
        followAll();
        const counted = wentBack.get(runId);
        if (counted) counted.styleRefused = false;
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

  /** One thing changed since has its own question; several, of any kind, share one. */
  const changedQuestion = ({ workflows, styles, map }: Changed): string => {
    const total = workflows.length + styles.length + map.length;
    if (total > 1) {
      return workflows.length === total
        ? t("assistant_undo_changed_many", { count: total })
        : t("assistant_undo_changed_several");
    }
    const [workflow] = workflows;
    const [style] = styles;
    if (workflow) {
      // The person's name is user text: React escapes it, so i18next must not.
      return workflow.between
        ? t("assistant_undo_changed_between")
        : changedText(plainTranslate(t), "assistant_undo_changed", workflow, i18n?.language ?? "en", now);
    }
    if (style) {
      if (style.tooOld) return t("assistant_undo_changed_style_old");
      return style.between ? t("assistant_undo_changed_style_between") : t("assistant_undo_changed_style");
    }
    if (map.length) return t("assistant_undo_changed_map");
    // Every row of the reply was of a shape this page does not know.
    return t("assistant_undo_changed_several");
  };

  /**
   * What Undo anyway does. A workflow goes back whole, and so do a style saved too often since or between the
   * answer's edits, the scene and the tree: later changes go too. A style otherwise and the rest of the map get back
   * only what the answer changed. With workflows beside only the latter, the hint names both.
   */
  const anywayHint = ({ workflows, styles, map }: Changed): string => {
    const wholeStyles = styles.some((style) => style.tooOld || style.between);
    const wholeMap = map.some((part) => part.object === "scene" || part.object === "tree");
    const settings = styles.length > 0 || map.length > 0;
    if (!settings || wholeStyles || wholeMap) return t("assistant_undo_anyway_hint");
    return workflows.length
      ? t("assistant_undo_anyway_hint_mixed")
      : t("assistant_undo_anyway_hint_settings");
  };

  // Counted only in the tab that undid it (or began to): after a reload the plain hint.
  const tally = wentBack.get(runId);
  const parts = [
    tally?.workflows.size ? t("assistant_undone_workflows", { count: tally.workflows.size }) : "",
    tally?.styles.size ? t("assistant_undone_styles", { count: tally.styles.size }) : "",
    tally?.map ? t("assistant_undone_map") : "",
  ].filter(Boolean);
  const notes = [
    tally?.partial ? t("assistant_undone_partial_style") : "",
    tally?.layerRemoved ? t("assistant_undone_layer_removed") : "",
    tally?.mapRefused ? t("assistant_undone_map_refused") : "",
    tally?.groupInUse ? t("assistant_undone_group_in_use") : "",
    // A later undo, typed or pressed, took the answer back, that style included.
    !undone && tally?.styleRefused ? t("assistant_undone_style_refused") : "",
  ].filter(Boolean);

  if (undone) {
    const hint = parts.length
      ? `${t("assistant_undone_hint").replace(/\.$/, "")}: ${parts.join(", ")}`
      : t("assistant_undone_hint");
    return (
      <>
        <Tooltip title={hint} describeChild>
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
        {notes.map((note) => (
          <UndoNote key={note}>{note}</UndoNote>
        ))}
      </>
    );
  }

  const question =
    asking?.kind === "unsaved"
      ? t("assistant_undo_unsaved")
      : asking?.kind === "changed"
        ? changedQuestion(asking.changed)
        : "";
  const hint =
    asking?.kind === "unsaved"
      ? t("assistant_undo_unsaved_hint")
      : asking?.kind === "changed"
        ? anywayHint(asking.changed)
        : "";
  // Part of the answer's changes went back before the question: said in it, and below the answer once it closes.
  const partly = parts.length ? t("assistant_undo_partly", { parts: parts.join(", ") }) : "";

  return (
    <>
      <Tooltip title={t("assistant_undo_hint")} describeChild>
        {/* A disabled button shows no tooltip of its own. */}
        <span>
          <Button
            ref={button}
            size="small"
            variant="text"
            disabled={busy}
            onClick={() => void undo(false)}
            startIcon={<Icon iconName={ICON_NAME.UNDO} style={{ fontSize: 12 }} />}>
            {t("assistant_undo")}
          </Button>
        </span>
      </Tooltip>
      <Popover
        open={!!asking}
        anchorEl={button.current}
        onClose={() => setAsking(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}>
        <Stack gap="10px" sx={{ p: "12px", width: 320 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{question}</Typography>
          {partly && (
            <Typography sx={(theme) => ({ fontSize: 12.5, color: mutedText(theme) })}>{partly}</Typography>
          )}
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
      {partly && !asking && <UndoNote>{partly}</UndoNote>}
      {notes.map((note) => (
        <UndoNote key={note}>{note}</UndoNote>
      ))}
    </>
  );
}

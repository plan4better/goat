"use client";

import { Box, Button, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { visuallyHidden } from "@mui/utils";
import {
  type ReactNode,
  type Ref,
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { type AnswerChanges, hasChanges } from "@/lib/assistant/answerChanges";
import { type Translate, plainTranslate } from "@/lib/assistant/chips";
import { assistantErrorKey, toRequestError } from "@/lib/assistant/errors";
import { getMapBridge } from "@/lib/assistant/mapBridge";
import { type MapChange, mergedMapChange } from "@/lib/assistant/mapEdits";
import { type Restored, type UndoOutcome, undoAnswer } from "@/lib/assistant/transport";
import { followUndone } from "@/lib/assistant/undoReply";
import { changedText } from "@/lib/utils/changedElsewhereText";

import { useNow } from "@/hooks/assistant/useNow";

import { type DockActions, DockActionsContext } from "@/components/assistant/DockActions";
import { accentText, focusRing, mutedText, pillButtonSx } from "@/components/assistant/styles";

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

/** A copy of what went back, or nothing yet. */
const tallyOf = (known?: WentBack): WentBack => ({
  map: false,
  partial: false,
  layerRemoved: false,
  mapRefused: false,
  groupInUse: false,
  styleRefused: false,
  ...known,
  workflows: new Set(known?.workflows),
  styles: new Set(known?.styles),
});

/** Adds what one Undo wrote back to `tally`. */
function addTo(tally: WentBack, restored: Restored): WentBack {
  restored.workflows.forEach((workflow) => tally.workflows.add(workflow.workflowId));
  restored.styles.forEach((style) => tally.styles.add(`${style.layerProjectId}/${style.styleId}`));
  tally.map ||= restored.map !== null;
  tally.partial ||= restored.styles.some((style) => style.partial);
  tally.layerRemoved ||= restored.notRestored.includes("layer_removed");
  tally.mapRefused ||= restored.notRestored.includes("map_refused");
  tally.groupInUse ||= restored.notRestored.includes("group_in_use");
  // A later call may put that style back.
  tally.styleRefused = restored.notRestored.includes("style");
  return tally;
}

function count(runId: string, restored: Restored): void {
  wentBack.set(runId, addTo(tallyOf(wentBack.get(runId)), restored));
}

/** A line in an answer's action row about what Undo cannot put back: after the row's actions, on a line of its
 * own, where the answer's text starts. */
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

/** What the line asks about before an Undo writes over it. */
type Asking = { kind: "unsaved" } | { kind: "changed"; changed: Changed };

/** What an answer's change rows show of its Undo: `UndoAnswer` provides it, `StepList` draws it. */
export interface UndoRows {
  /** The steps whose lines are the answer's changes that Undo takes back. */
  steps: ReadonlySet<string>;
  /** The answer's last change: the group that holds it carries the Undo, on its last change row. */
  last: string;
  /** Every change went back: each change row reads as taken back. */
  undone: boolean;
  /** The end of the row that carries the Undo: the button, or Undone. */
  end: ReactNode;
  /** In place of that row while an Undo asks before it writes over something; null otherwise. */
  question: ReactNode;
  /** Lines under that row: what went back already, and what could not go back. */
  notes: ReactNode;
}

const UndoRowsContext = createContext<UndoRows | null>(null);

/** The Undo of the answer a step row belongs to; null outside an answer that offers one. */
export const useUndoRows = (): UndoRows | null => useContext(UndoRowsContext);

/** The dock's small pill, tighter, so it fits the height of a step row. */
const rowButtonSx = {
  ...pillButtonSx,
  "&&": { ...pillButtonSx["&&"], px: "8px", py: "2px" },
  "& .MuiButton-startIcon": { mr: "4px" },
};

/**
 * What the line asks: a short question that fits two lines of the dock, and
 * the whole sentence when the question leaves part of it out (who changed a
 * workflow and when, what Undo anyway does to a style changed many times).
 */
function questionOf(
  asking: Asking,
  t: Translate,
  language: string,
  now: number
): { question: string; sentence?: string; saysAnyway?: boolean } {
  if (asking.kind === "unsaved") return { question: t("assistant_undo_unsaved") };
  const { workflows, styles, map } = asking.changed;
  const total = workflows.length + styles.length + map.length;
  if (total > 1) {
    return {
      question:
        workflows.length === total
          ? t("assistant_undo_changed_many", { count: total })
          : t("assistant_undo_changed_several"),
    };
  }
  const [workflow] = workflows;
  const [style] = styles;
  if (workflow) {
    if (workflow.between) return { question: t("assistant_undo_changed_between") };
    const question = t("assistant_undo_changed");
    const sentence = changedText(t, "assistant_undo_changed", workflow, language, now);
    return sentence === question ? { question } : { question, sentence };
  }
  if (style?.tooOld) {
    // The sentence says what Undo anyway does to that style.
    return {
      question: t("assistant_undo_changed_style_many"),
      sentence: t("assistant_undo_changed_style_old"),
      saysAnyway: true,
    };
  }
  if (style) {
    return {
      question: style.between ? t("assistant_undo_changed_style_between") : t("assistant_undo_changed_style"),
    };
  }
  if (map.length) return { question: t("assistant_undo_changed_map") };
  // Every row of the reply was of a shape this page does not know.
  return { question: t("assistant_undo_changed_several") };
}

/**
 * The question before an Undo writes over something, in place of the row
 * that carries the Undo, with "Undo anyway" and "Cancel". The whole sentence
 * and what Undo anyway does are the line's tooltip (on hover, and on focus of
 * its buttons), the description of "Undo anyway", and without a hover (touch)
 * a line below the buttons.
 */
function UndoQuestion({
  asking,
  anyway,
  busy,
  textRef,
  onAnyway,
  onCancel,
}: {
  asking: Asking;
  /** What Undo anyway does. */
  anyway: string;
  busy: boolean;
  /** The question's text: focus goes there when the line appears. */
  textRef: Ref<HTMLParagraphElement>;
  onAnyway: () => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const now = useNow();
  const hintId = useId();
  // The person's name is user text: React escapes it, so i18next must not.
  const { question, sentence, saysAnyway } = questionOf(
    asking,
    plainTranslate(t),
    i18n?.language ?? "en",
    now
  );
  const hint = sentence ? (saysAnyway ? sentence : `${sentence} ${anyway}`) : anyway;
  return (
    <Tooltip title={hint} describeChild>
      <Stack
        direction="row"
        alignItems="center"
        flexWrap="wrap"
        gap="6px"
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
        sx={{ px: "8px", py: "5px", borderRadius: "8px", bgcolor: "action.hover" }}>
        <Typography
          ref={textRef}
          tabIndex={-1}
          sx={{
            flex: "1 1 180px",
            minWidth: 0,
            fontSize: 12.5,
            fontWeight: 600,
            lineHeight: 1.5,
            borderRadius: "4px",
            ...focusRing(theme),
          }}>
          {question}
        </Typography>
        <Box
          component="span"
          id={hintId}
          sx={{
            ...visuallyHidden,
            "@media (hover: none)": {
              position: "static",
              width: "auto",
              height: "auto",
              margin: 0,
              overflow: "visible",
              clip: "auto",
              whiteSpace: "normal",
              order: 1,
              flexBasis: "100%",
              fontSize: 12,
              lineHeight: 1.5,
              color: mutedText(theme),
            },
          }}>
          {hint}
        </Box>
        <Stack direction="row" gap="4px" sx={{ ml: "auto" }}>
          <Button
            size="small"
            variant="contained"
            disabled={busy}
            aria-describedby={hintId}
            onClick={onAnyway}
            sx={rowButtonSx}>
            {t("assistant_undo_anyway")}
          </Button>
          <Button size="small" color="inherit" onClick={onCancel} sx={rowButtonSx}>
            {t("cancel")}
          </Button>
        </Stack>
      </Stack>
    </Tooltip>
  );
}

/**
 * Undo of an answer's edits of workflows, styles and the map: writes back
 * what they replaced, and the page follows (the open workflow loads the stored
 * version, the map page reads the styles and what went back of its map).
 * Pending style saves of the map page go out first, so the Undo sees them.
 * It wraps the answer's parts and owns the Undo's states: the change rows of
 * the steps read them (`useUndoRows`), and the last change row carries the
 * button at its end. Nothing is written over without asking: changes of the
 * workflow the editor has not saved yet (then the editor asks which version to
 * keep), and anything saved since the answer's edits (for one workflow who
 * changed it and when, and Undo anyway saves on top of it). The question takes
 * that row's place (`UndoQuestion`). Once done, every change row reads as
 * taken back and the last one ends with Undone, whose hint counts what went
 * back, or Undone, in part. Lines under it say what could not go back (also
 * while the button stays Undo, for a style core refused, and after a typed
 * undo or a reload, as far as the typed undo's result and the answer's steps
 * tell) and what went back already while the rest is still in place. An
 * answer with no change row (a Stop ended its write) shows the same on a line
 * of its own after its parts.
 */
export default function UndoAnswer({
  conversationId,
  runId,
  changes,
  changeSteps = [],
  undone: undoneBefore = false,
  restores = [],
  children,
}: {
  conversationId: string;
  /** The answer's run; null when it offers no Undo (still running, read only, nothing saved): its parts as they are. */
  runId: string | null;
  /** What the answer changed. */
  changes: AnswerChanges;
  /** The steps that saved those changes (`savesChange`), in the answer's order. */
  changeSteps?: string[];
  /** The answer's edits were undone elsewhere: before (the stored conversation says so), or by a typed undo. */
  undone?: boolean;
  /** What typed undos of the answer wrote back (`typedRestores`): counted as a press's reply is. */
  restores?: Restored[];
  /** The answer's parts. */
  children?: ReactNode;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  // Outside the dock there is nothing to follow an Undo: the parts show as they are.
  const actions = useContext(DockActionsContext);
  const button = useRef<HTMLButtonElement>(null);
  const questionText = useRef<HTMLParagraphElement>(null);
  const doneText = useRef<HTMLSpanElement>(null);
  /** The question was cancelled: focus goes back to the button that asked it. */
  const refocus = useRef(false);
  /** This tab's Undo finished: focus, lost with the button, goes to the Undone that took its place. */
  const focusDone = useRef(false);
  const [undoneHere, setUndoneHere] = useState(false);
  // Read at every render: the answer may come to offer its Undo after it mounted, its run undone in this tab.
  const undone = undoneBefore || undoneHere || (runId !== null && undoneRuns.has(runId));
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);

  useEffect(() => {
    if (asking) {
      // The conversation stays where the person scrolled it.
      questionText.current?.focus({ preventScroll: true });
      return;
    }
    if (!refocus.current) return;
    refocus.current = false;
    button.current?.focus();
  }, [asking]);

  useEffect(() => {
    if (!undone || !focusDone.current) return;
    focusDone.current = false;
    // Only focus that went with the button or the question: not where the person has moved it since.
    const active = document.activeElement;
    if (!active || active === document.body) doneText.current?.focus({ preventScroll: true });
  }, [undone]);

  if (runId === null || actions === null) {
    // The same shape as below, so the parts keep their state when the answer comes to offer an Undo.
    return (
      <UndoRowsContext.Provider value={null}>
        {children}
        {null}
      </UndoRowsContext.Provider>
    );
  }

  const done = () => {
    undoneRuns.add(runId);
    focusDone.current = true;
    setUndoneHere(true);
  };

  /** Has the page read again everything the answer changed, as an Undo whose reply names nothing. */
  const followAll = (dock: DockActions) => {
    if (changes.workflows.length) {
      dock.followWorkflowChanges(changes.workflows.map(({ workflowId }) => ({ workflowId, revision: null })));
    }
    if (changes.styles.length) {
      dock.followStyleChanges(
        changes.styles.map((change) => ({ ...change, revision: null, listChanged: true }))
      );
    }
    const maps = new Map<string, MapChange>();
    for (const change of changes.map) {
      const known = maps.get(change.projectId);
      maps.set(change.projectId, known ? mergedMapChange(known, change) : change);
    }
    maps.forEach((change) => dock.followMapChange(change));
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
        followAll(actions);
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

  const cancel = () => {
    refocus.current = true;
    setAsking(null);
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

  // Counted in the tab that pressed it (or began to) and from typed undos of the answer: after a reload, only what
  // the answer's steps say (a removed layer never comes back).
  const tally = restores.reduce(addTo, tallyOf(wentBack.get(runId)));
  tally.layerRemoved ||= undone && changes.layersRemoved;
  const parts = [
    tally.workflows.size ? t("assistant_undone_workflows", { count: tally.workflows.size }) : "",
    tally.styles.size ? t("assistant_undone_styles", { count: tally.styles.size }) : "",
    tally.map ? t("assistant_undone_map") : "",
  ].filter(Boolean);
  const notes = [
    tally.partial ? t("assistant_undone_partial_style") : "",
    tally.layerRemoved ? t("assistant_undone_layer_removed") : "",
    tally.mapRefused ? t("assistant_undone_map_refused") : "",
    tally.groupInUse ? t("assistant_undone_group_in_use") : "",
    // A later undo, typed or pressed, took the answer back, that style included.
    !undone && tally.styleRefused ? t("assistant_undone_style_refused") : "",
  ].filter(Boolean);
  // Part of the answer's changes went back before a question: said while the rest is still in place.
  const partly = !undone && parts.length ? t("assistant_undo_partly", { parts: parts.join(", ") }) : "";
  const lines = [partly, ...notes].filter(Boolean);
  const last = changeSteps.at(-1);

  let end: ReactNode;
  if (undone) {
    const hint = parts.length
      ? `${t("assistant_undone_hint").replace(/\.$/, "")}: ${parts.join(", ")}`
      : t("assistant_undone_hint");
    end = (
      <Tooltip title={hint} describeChild>
        <Typography
          ref={doneText}
          component="span"
          tabIndex={-1}
          sx={{
            flexShrink: 0,
            px: "8px",
            borderRadius: "4px",
            ...focusRing(theme),
            fontSize: 12,
            fontWeight: 700,
            lineHeight: 1.5,
            whiteSpace: "nowrap",
            color: mutedText(theme),
          }}>
          {/* Something the answer changed did not go back: a line below says what. */}
          {notes.length ? t("assistant_undone_in_part") : t("assistant_undone")}
        </Typography>
      </Tooltip>
    );
  } else {
    end = (
      <Tooltip title={t("assistant_undo_hint")} describeChild>
        {/* A disabled button shows no tooltip of its own. On a change row of an older answer it shows on hover or
            focus, as the answer's actions do; on a line of its own it always shows. */}
        <Box
          component="span"
          className={last === undefined ? undefined : "answer-actions"}
          sx={{ flexShrink: 0 }}>
          <Button
            ref={button}
            size="small"
            variant="text"
            disabled={busy}
            onClick={() => void undo(false)}
            startIcon={<Icon iconName={ICON_NAME.UNDO} style={{ fontSize: 11, color: "inherit" }} />}
            sx={{ ...rowButtonSx, color: accentText(theme) }}>
            {t("assistant_undo")}
          </Button>
        </Box>
      </Tooltip>
    );
  }

  // Once undone (also by a typed undo or the history while it asks), nothing is left to ask about.
  const question = !undone && asking && (
    <UndoQuestion
      asking={asking}
      anyway={asking.kind === "unsaved" ? t("assistant_undo_unsaved_hint") : anywayHint(asking.changed)}
      busy={busy}
      textRef={questionText}
      onAnyway={() => void (asking.kind === "unsaved" ? undo(false, true) : undo(true))}
      onCancel={cancel}
    />
  );

  /** The lines under the Undo, where the text of its row starts (`inset`). */
  const captions = (inset: string) =>
    lines.map((line) => (
      <Typography key={line} sx={{ pl: inset, fontSize: 12, lineHeight: 1.5, color: mutedText(theme) }}>
        {line}
      </Typography>
    ));

  const rows: UndoRows | null =
    last === undefined
      ? null
      : {
          steps: new Set(changeSteps),
          last,
          undone,
          end,
          question: question || null,
          notes: captions("27px"),
        };
  return (
    <UndoRowsContext.Provider value={rows}>
      {children}
      {/* No change row to carry it: a line of its own. */}
      {last === undefined && (
        <Box>
          {question || <Box sx={{ ml: "-8px" }}>{end}</Box>}
          {captions("0px")}
        </Box>
      )}
    </UndoRowsContext.Provider>
  );
}

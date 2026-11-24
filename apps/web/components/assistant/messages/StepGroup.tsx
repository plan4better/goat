"use client";

import { Box, ButtonBase, Stack, Typography, useMediaQuery, useTheme } from "@mui/material";
import type { DynamicToolUIPart } from "ai";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { plainTranslate } from "@/lib/assistant/chips";
import {
  type StepNames,
  type StepRow,
  foldRepeatedWrites,
  groupSummary,
  staysVisible,
  stepFailed,
  stepNames,
  stepRows,
  stepRunning,
} from "@/lib/assistant/stepLabels";

import StepList, { REDUCED_MOTION, StepSpinner, rowSx } from "@/components/assistant/messages/StepList";
import { focusRing, mutedText, shimmerSx } from "@/components/assistant/styles";

/**
 * One run of steps between the parts of an answer. While it still receives
 * steps (`open`) it lists them as they come; then it closes into one summary
 * line that opens the full list. Writes, failures and, once the answer ended,
 * steps it left without a result stay visible next to the summary as lines of
 * their own. Closed, the finished writes that say the same show as one line
 * with their count, wherever they sit; open, the list keeps the answer's order
 * and folds only writes right next to each other. A failed write that a later
 * success of its tool in the answer corrected is part of that success's line,
 * not a failure: it shows no line of its own and is not counted as failed. A
 * group with fewer than two steps to fold shows its lines as they are; a group
 * of corrected attempts only shows nothing.
 */
export default function StepGroup({
  steps,
  open,
  running,
  openProject = null,
  names,
  answerSteps,
}: {
  steps: DynamicToolUIPart[];
  /** Still receiving steps: the newest group of a running answer. */
  open: boolean;
  /** The answer is still running. */
  running: boolean;
  /** The project the answer's tools read when a call names none (`groupSummary`). */
  openProject?: string | null;
  /** The names the whole answer's steps returned (`stepNames`): a step names what an earlier group read. */
  names?: StepNames;
  /** All of the answer's steps, which tell a failed write the answer corrected later; the group's own when absent. */
  answerSteps?: DynamicToolUIPart[];
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const reducedMotion = useMediaQuery(REDUCED_MOTION);
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const rows = stepRows(steps, answerSteps);
  const visible = rows.filter((row) => staysVisible(row, running));
  // In the answer's order (`inOrder`) a line between two repeated writes ends their run; closed, it does not.
  const shown = (lines: StepRow[], inOrder: boolean) =>
    foldRepeatedWrites(lines, names ?? stepNames(steps), plainTranslate(t), !inOrder);
  if (!rows.length) return null;
  if (open || rows.length - visible.length < 2) {
    return <StepList steps={steps} rows={shown(rows, open)} running={running} names={names} />;
  }

  const failed = rows.filter((row) => stepFailed(row.step)).length;
  // One shimmer at a time: a line of its own shows its step under way, and so
  // does the open list.
  const underWay =
    running && !expanded && rows.some((row) => !staysVisible(row, running) && stepRunning(row.step));
  return (
    <Stack gap="1px">
      <ButtonBase
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={listId}
        sx={{ ...rowSx, ...focusRing(theme), alignItems: "center", gap: "6px" }}>
        <Typography sx={{ minWidth: 0, fontSize: 12.5, lineHeight: 1.5, overflowWrap: "anywhere" }}>
          <Box component="span" sx={underWay && !reducedMotion ? shimmerSx : { color: mutedText }}>
            {groupSummary(rows, plainTranslate(t), running, openProject)}
          </Box>
          {failed > 0 && (
            <Box component="span" sx={{ color: "error.main" }}>
              {` · ${t("assistant_steps_failed", { count: failed })}`}
            </Box>
          )}
        </Typography>
        {underWay && reducedMotion && <StepSpinner />}
        <Icon
          iconName={ICON_NAME.CHEVRON_RIGHT}
          style={{
            fontSize: 9,
            flexShrink: 0,
            color: mutedText(theme),
            transform: expanded ? "rotate(90deg)" : undefined,
            transition: reducedMotion ? undefined : "transform 120ms",
          }}
        />
      </ButtonBase>
      {/* Open, the list holds every step in the answer's order: the visible lines are part of it. */}
      <Box
        id={listId}
        hidden={!expanded}
        sx={{ ml: "10px", pl: "6px", borderLeft: 1, borderColor: "divider" }}>
        {expanded && <StepList steps={steps} rows={shown(rows, true)} running={running} names={names} />}
      </Box>
      {!expanded && visible.length > 0 && (
        <StepList steps={steps} rows={shown(visible, false)} running={running} names={names} />
      )}
    </Stack>
  );
}

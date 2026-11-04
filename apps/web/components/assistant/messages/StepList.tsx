"use client";

import { Box, ButtonBase, CircularProgress, Stack, Typography, useMediaQuery, useTheme } from "@mui/material";
import type { DynamicToolUIPart } from "ai";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { GOATLogoIconOnlyGreen } from "@p4b/ui/assets/svg/GOATLogoIconOnlyGreen";
import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { plainTranslate } from "@/lib/assistant/chips";
import {
  type StepNames,
  type StepRow,
  stepLabel,
  stepNames,
  stepResult,
  stepRows,
  stepRunning,
} from "@/lib/assistant/stepLabels";

import { focusRing, mutedText, shimmerSx } from "@/components/assistant/styles";

const JSON_CHARS = 4000;
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const pretty = (value: unknown): string => {
  const text = JSON.stringify(value, null, 2) ?? "";
  return text.length > JSON_CHARS ? `${text.slice(0, JSON_CHARS)}…` : text;
};

/** The system asks for less motion: a running step shows a spinner instead of the shimmer. */
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** A small spinner for something under way, in the 14px slot of a status icon. */
export function StepSpinner({ status }: { status?: StepStatus }) {
  return (
    <Box
      aria-hidden
      data-status={status}
      sx={{ width: 14, height: 14, mt: "2px", flexShrink: 0, display: "flex", justifyContent: "center" }}>
      <CircularProgress size={10} thickness={5} sx={{ mt: "2px", color: mutedText }} />
    </Box>
  );
}

export const rowSx = {
  // A button does not inherit the page font by itself.
  fontFamily: "inherit",
  width: "100%",
  justifyContent: "flex-start",
  alignItems: "flex-start",
  gap: "9px",
  px: "4px",
  py: "4px",
  borderRadius: "6px",
  textAlign: "left",
  "&:hover": { bgcolor: "action.hover" },
} as const;

/**
 * A step's state: done, failed, running (GOAT's mark, or a spinner with
 * reduced motion), or stopped (the answer ended before the step returned).
 */
type StepStatus = "done" | "running" | "spinning" | "failed" | "stopped";

/** A step's state in one 14px slot. */
function StatusIcon({ state }: { state: StepStatus }) {
  const theme = useTheme();
  if (state === "spinning") return <StepSpinner status={state} />;
  if (state === "running") {
    return (
      <Box data-status={state} sx={{ display: "flex", flexShrink: 0, mt: "2px" }}>
        <GOATLogoIconOnlyGreen style={{ width: 14, height: 14 }} />
      </Box>
    );
  }
  const failed = state === "failed";
  return (
    <Box
      data-status={state}
      sx={{
        width: 14,
        height: 14,
        mt: "2px",
        flexShrink: 0,
        borderRadius: "50%",
        border: 1,
        borderColor: failed ? "error.main" : mutedText,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
      <Icon
        iconName={failed ? ICON_NAME.CLOSE : state === "stopped" ? ICON_NAME.MINUS : ICON_NAME.CHECK}
        style={{ fontSize: 7, color: failed ? theme.palette.error.main : mutedText(theme) }}
      />
    </Box>
  );
}

/**
 * The tools an answer used (spec §4.7, §10): one line per call with what it
 * found, its input and result on click. The list shows every row it is given;
 * `StepGroup` folds a group's rows behind its summary. While the answer runs
 * (`running`), a step that has not returned says what it is doing, with the
 * shimmer of the Answering line; once the answer ended, such a step is marked
 * as stopped, with the same words: it was under way, not done.
 */
export default function StepList({
  steps,
  rows: only,
  running = false,
  names: known,
}: {
  /** The group's steps: they name the layers, also those of rows not shown here. */
  steps: DynamicToolUIPart[];
  /** The rows to show, in their order; all of the group's when absent. */
  rows?: StepRow[];
  running?: boolean;
  /** The names the whole answer's steps returned; the group's own when absent. */
  names?: StepNames;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const reducedMotion = useMediaQuery(REDUCED_MOTION);
  const [open, setOpen] = useState<string | null>(null);
  const rows = only ?? stepRows(steps);
  const names = known ?? stepNames(steps);
  // The labels carry the call's arguments (search words, layer names): React escapes them as text.
  const translate = plainTranslate(t);

  return (
    <Stack gap="1px">
      {rows.map(({ step, rejected }) => {
        const expanded = open === step.toolCallId;
        const output = (step as { output?: unknown }).output;
        const failed = step.state === "output-error";
        const unreturned = stepRunning(step);
        const underWay = running && unreturned;
        const stopped = !running && unreturned;
        const result = failed
          ? t("assistant_step_failed")
          : stopped
            ? t("assistant_step_stopped")
            : stepResult(step, translate);
        const extras = [result, rejected.length ? t("assistant_step_retried") : null].filter(Boolean);
        const status: StepStatus = underWay
          ? reducedMotion
            ? "spinning"
            : "running"
          : stopped
            ? "stopped"
            : failed
              ? "failed"
              : "done";
        return (
          <Box key={step.toolCallId}>
            <ButtonBase
              onClick={() => setOpen(expanded ? null : step.toolCallId)}
              aria-expanded={expanded}
              sx={{ ...rowSx, ...focusRing(theme) }}>
              <StatusIcon state={status} />
              <Typography
                sx={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.5, overflowWrap: "anywhere" }}>
                <Box component="span" sx={underWay && !reducedMotion ? shimmerSx : { color: "text.primary" }}>
                  {stepLabel(step, names, translate, unreturned)}
                </Box>
                {extras.map((extra) => (
                  <Box
                    key={extra}
                    component="span"
                    sx={{ color: failed && extra === result ? "error.main" : mutedText }}>
                    {` · ${extra}`}
                  </Box>
                ))}
              </Typography>
            </ButtonBase>
            {expanded && (
              <Box
                component="pre"
                sx={{
                  m: "2px 0 6px 27px",
                  px: "11px",
                  py: "10px",
                  border: 1,
                  borderColor: "divider",
                  borderRadius: "10px",
                  bgcolor: "background.default",
                  color: mutedText,
                  fontFamily: MONO,
                  fontSize: 11,
                  lineHeight: 1.7,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  maxHeight: 280,
                  overflowY: "auto",
                }}>
                {[
                  // The tool's own name, for whoever wants to know what ran.
                  step.toolName,
                  // Rejected attempts first, in the order the model made them. The server's error text
                  // is English and may quote the service, so only the translated mark is shown.
                  ...rejected.map(
                    (attempt) =>
                      `${t("assistant_step_rejected")}\n${pretty(attempt.input)}\n${t("assistant_step_failed")}`
                  ),
                  `${t("assistant_step_input")}\n${pretty(step.input)}`,
                  ...(output === undefined ? [] : [`${t("assistant_step_output")}\n${pretty(output)}`]),
                ].join("\n\n")}
              </Box>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}

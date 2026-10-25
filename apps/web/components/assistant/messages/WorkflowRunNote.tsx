"use client";

import { Button, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { plain } from "@/lib/assistant/chips";
import type { WorkflowRunData } from "@/lib/assistant/types";

import { useDockActions } from "@/components/assistant/DockActions";
import { mutedText } from "@/components/assistant/styles";

const secondsSince = (startedAt: string | null, now: number): number | null => {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(started) ? Math.max(0, Math.round((now - started) / 1000)) : null;
};

const minutes = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * One line for a workflow run of an answer: the running step while it runs (with the
 * time since it started, ticking only in the running answer), how it ended after, and
 * a button that opens the workflow in the Workflows view, where the canvas shows the run.
 * A part that still says running in an answer that is over (stopped, or ended while the
 * run went on) was the last the answer saw, so its line is in the past tense.
 */
export default function WorkflowRunNote({ data, live }: { data: WorkflowRunData; live: boolean }) {
  const { t } = useTranslation("common");
  const actions = useDockActions();
  const running = data.status === "running";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running, live]);
  const seconds = running && live ? secondsSince(data.started_at, now) : null;
  // A step's name is user text: React escapes it, so i18next must not (`plain`).
  const text = running
    ? !live
      ? t("assistant_workflow_run_ended_running")
      : data.step
        ? t("assistant_workflow_run_step", plain({ done: data.done + 1, total: data.total, step: data.step }))
        : t("assistant_workflow_run_running")
    : t(`assistant_workflow_run_${data.status}`);
  // The live region holds the step or outcome only: the time changes every second and
  // would have a screen reader read the line again each time.
  return (
    <Stack direction="row" alignItems="center" gap="8px" sx={{ color: mutedText }}>
      <Typography sx={{ fontSize: 12.5, color: "inherit" }}>
        <span role="status">{text}</span>
        {seconds !== null && <span aria-hidden="true">{` · ${minutes(seconds)}`}</span>}
      </Typography>
      <Button
        size="small"
        variant="text"
        onClick={() => actions.openInProjectMode(data.project_id, "workflows", data.workflow_id)}>
        {t("assistant_workflow_run_open")}
      </Button>
    </Stack>
  );
}

"use client";

// The foot of a layer's filter tab: the features the saved filter keeps become a new layer of the project, in this
// layer's style. Its tonal button opens a popover beside the panel, in the panel's own stack as a condition's editor
// is, where the new layer is named (this layer's name, marked as filtered) before the job starts. The foot sits under
// the tab's scrolling body, so it stays in view however many conditions there are; without a saved filter there is
// nothing to save and it is not shown.
import { LoadingButton } from "@mui/lab";
import { Box, Button, Divider, alpha, useTheme } from "@mui/material";
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { setRunningJobIds } from "@/lib/store/jobs/slice";
import { creditsErrorMessage, readableText } from "@/lib/utils/credits";
import type { ProjectLayer } from "@/lib/validations/project";

import { useProcessExecution } from "@/hooks/map/useOgcProcesses";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
import {
  anchorTopOf,
  useIsOpener,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";

type SourceLayer = Pick<ProjectLayer, "id" | "layer_id" | "name" | "query">;

interface Latest {
  projectId: string;
  projectLayer: SourceLayer;
}

const KEY = "save-as-layer";

/** The popover's content: the name, Cancel and "Save layer". The stack draws it once, when it opens, so it reads the
 * filter from `latest` when the job starts: a row switched in the panel meanwhile is in what is saved. The popover
 * closes once the job has started and stays open, the name kept, when it could not. */
function SaveLayerForm({
  latest,
  defaultName,
  onClose,
}: {
  latest: RefObject<Latest>;
  defaultName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);
  const { execute } = useProcessExecution();
  const [name, setName] = useState(defaultName);
  const [isSaving, setIsSaving] = useState(false);
  const trimmed = name.trim();

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const { projectId, projectLayer } = latest.current;
    const cql = projectLayer.query?.cql;
    if (!trimmed || !cql || isSaving) return;
    setIsSaving(true);
    try {
      const result = await execute("layer_create_filtered", {
        source_layer_id: projectLayer.layer_id,
        cql_filter: cql,
        project_id: projectId,
        result_layer_name: trimmed,
        // The new layer takes this project layer's active style.
        source_layer_project_id: projectLayer.id,
      });
      if (result?.jobID) {
        toast.info(`${t("save_as_new_layer")} - ${t("job_started")}`);
        dispatch(setRunningJobIds([...runningJobIds, result.jobID]));
      }
      onClose();
    } catch (error) {
      toast.error(creditsErrorMessage(error, t) ?? t("save_as_new_layer_error"));
      setIsSaving(false);
    }
  };

  return (
    // A form: Enter in the name confirms it, as the button does.
    <Box component="form" noValidate onSubmit={save}>
      <Box sx={{ px: 3, pt: 1 }}>
        <TextFieldInput
          label={t("layer_name")}
          value={name}
          onChange={setName}
          autoFocus
          clearable={false}
          // Selected whenever it takes the focus (on open too): typing replaces the suggested name.
          inputProps={{ "aria-label": t("layer_name"), onFocus: (event) => event.target.select() }}
        />
      </Box>
      {/* The foot of a popover that creates something (the new rule's): Cancel beside the primary action. */}
      <Divider sx={{ mt: 3 }} />
      <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 2, px: 3, pt: 3 }}>
        <Button variant="text" size="small" onClick={onClose}>
          {t("cancel")}
        </Button>
        <LoadingButton
          type="submit"
          variant="contained"
          size="small"
          disableElevation
          loading={isSaving}
          disabled={!trimmed}>
          {t("filter_panel.save_layer")}
        </LoadingButton>
      </Box>
    </Box>
  );
}

export function SaveAsLayer({ projectId, projectLayer }: { projectId: string; projectLayer: SourceLayer }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const popover = usePopover();
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const open = useIsOpener(button);
  const latest = useRef<Latest>({ projectId, projectLayer });
  latest.current = { projectId, projectLayer };
  // The filter as it is saved: what the map shows, without the rows that are switched off or unfinished.
  const cql = projectLayer.query?.cql;

  // The last row switched off or the filter cleared with the popover open: nothing is left to save.
  useEffect(() => {
    if (!cql && popover.current(1)?.key === KEY) popover.close(1);
  }, [cql, popover]);

  if (!cql) return null;
  const primary = theme.palette.primary.main;
  return (
    // The prototype's tonal button, under the result it saves: the primary color's tint, its text in the shade of
    // it that reads.
    <Button
      ref={setButton}
      variant="text"
      fullWidth
      aria-haspopup="dialog"
      aria-expanded={open}
      // The same key again closes it (the stack's toggle), as a row's editor does.
      onClick={(event) =>
        popover.open(1, {
          key: KEY,
          title: t("save_as_new_layer"),
          anchorTop: anchorTopOf(event.currentTarget),
          render: () => (
            <SaveLayerForm
              latest={latest}
              defaultName={`${projectLayer.name} (${t("filtered")})`}
              onClose={() => popover.close(1)}
            />
          ),
        })
      }
      sx={{
        height: 32,
        borderRadius: 2,
        fontSize: 13,
        fontWeight: 700,
        bgcolor: alpha(primary, 0.12),
        color: readableText(theme, primary),
        "&:hover, &[aria-expanded='true']": {
          bgcolor: alpha(primary, 0.12),
          boxShadow: `inset 0 0 0 1px ${primary}`,
        },
      }}>
      {t("save_as_new_layer")}
    </Button>
  );
}

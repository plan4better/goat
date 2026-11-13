/**
 * Spatial filter for a whole bundle.
 *
 * A bundle is filtered as one thing, so the filter has to mean something
 * against every member layer's schema — and only a geometry predicate does.
 * Hence a single spatial expression: no attribute conditions, no second
 * expression, no logical operator to combine them with.
 *
 * There is no "apply" either. A bundle's routable artifact is built from its
 * member layers, so a filter that only changed what the map draws would leave
 * tools routing on the unfiltered network — the map and the answers would
 * disagree with nothing to show it. The filter is therefore the specification
 * for a copy: it produces a new bundle whose layers are clipped and whose
 * artifact is built from them, and leaves this one untouched.
 *
 * Because it never applies to this bundle, it holds no state worth keeping.
 * The expression lives and dies with the panel — cleared once the copy is on
 * its way, and never written back to the bundle or the project.
 */
import { Box, Stack, Typography } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import type { BundleRead } from "@/lib/api/bundles";
import { useProject } from "@/lib/api/projects";
import { setRunningJobIds } from "@/lib/store/jobs/slice";
import { createTheCQLBasedOnExpression } from "@/lib/transformers/filter";
import { creditsErrorMessage } from "@/lib/utils/credits";
import { type Expression as ExpressionType, FilterType } from "@/lib/validations/filter";

import useLayerFields from "@/hooks/map/CommonHooks";
import { useProcessExecution } from "@/hooks/map/useOgcProcesses";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import Expression from "@/components/map/panels/filter/Expression";
import { createExpression, validateExpressions } from "@/components/map/panels/filter/Filter";
import { FilterFoot } from "@/components/map/panels/filter/FilterFoot";
import { AddButton } from "@/components/map/panels/styleEditor/rows";

type BundleFilterProps = {
  bundle: BundleRead;
  projectId: string;
  /** A member layer with geometry. The expression resolves its geometry field
   *  against one member; the same predicate is then applied to all of them. */
  memberLayerId?: string;
};

const BundleFilter = ({ bundle, projectId, memberLayerId }: BundleFilterProps) => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);
  const { execute: executeProcess } = useProcessExecution();
  // The copy lands in the project's folder, like every other tool's output:
  // the source bundle's folder may be one the caller can only read.
  const { project } = useProject(projectId);
  const { layerFields } = useLayerFields(memberLayerId || "");
  // No expression until the user adds one, so the tab opens the way a layer's
  // does. A bundle takes exactly one, so adding is disabled once it exists.
  const [expression, setExpression] = useState<ExpressionType | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Completeness means the same thing here as for a layer's filter, so it is
  // the same check — over the one expression a bundle takes.
  const isComplete = useMemo(() => !!expression && validateExpressions([expression]), [expression]);

  const saveAsNewBundle = async () => {
    if (!expression || !project?.folder_id) return;
    const cql = createTheCQLBasedOnExpression([expression], layerFields, "and");
    if (!cql) return;
    setIsSaving(true);
    try {
      const result = await executeProcess("bundle_create_filtered", {
        source_bundle_id: bundle.id,
        cql_filter: cql,
        folder_id: project.folder_id,
        project_id: projectId,
        result_bundle_name: `${bundle.name} (${t("filtered")})`,
      });
      if (result?.jobID) {
        toast.info(`${t("save_as_new_bundle")} - ${t("job_started")}`);
        dispatch(setRunningJobIds([...runningJobIds, result.jobID]));
        setExpression(null);
      }
    } catch (error) {
      toast.error(creditsErrorMessage(error, t) ?? t("save_as_new_bundle_error"));
    } finally {
      setIsSaving(false);
    }
  };

  // As a layer's Filter tab: the body scrolls, the foot with the actions stays under it.
  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 3, pt: 3, pb: 4 }}>
        {expression ? (
          <Stack spacing={4}>
            <Expression
              expression={expression}
              layerId={memberLayerId}
              onUpdate={setExpression}
              onDelete={() => setExpression(null)}
            />
          </Stack>
        ) : (
          <>
            <Typography variant="caption" component="p" color="text.secondary">
              {t("filter_bundle_message")}
            </Typography>
            {/* A bundle takes exactly one expression, and filtered as a whole the only kind that applies to every
                member's schema is spatial: no menu of kinds, and nothing to add once it is there. */}
            <AddButton
              onClick={() => setExpression(createExpression(FilterType.Spatial))}
              sx={{ ml: -2.5, mt: 2 }}>
              {t("add_expression")}
            </AddButton>
          </>
        )}
      </Box>
      {expression && (
        <FilterFoot
          onClear={() => setExpression(null)}
          action={{
            label: t("save_as_new_bundle"),
            onClick: saveAsNewBundle,
            loading: isSaving,
            disabled: !isComplete || !project?.folder_id,
          }}
        />
      )}
    </Box>
  );
};

export default BundleFilter;

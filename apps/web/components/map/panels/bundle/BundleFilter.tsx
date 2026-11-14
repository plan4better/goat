/**
 * Spatial filter for a whole bundle.
 *
 * A bundle is filtered as one thing, so the filter has to mean something
 * against every member layer's schema, and only a geometry predicate does.
 * Hence a single area, the map extent: no attribute conditions, no second
 * area, no logical operator to combine them with.
 *
 * There is no "apply" either. A bundle's routable artifact is built from its
 * member layers, so a filter that only changed what the map draws would leave
 * tools routing on the unfiltered network: the map and the answers would
 * disagree with nothing to show it. The filter is therefore the specification
 * for a copy: it produces a new bundle whose layers are clipped and whose
 * artifact is built from them, and leaves this one untouched.
 *
 * Because it never applies to this bundle, it holds no state worth keeping.
 * The area lives and dies with the panel: cleared once the copy is on its way,
 * and never written back to the bundle or the project.
 */
import { LoadingButton } from "@mui/lab";
import { Box, Button, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import bboxPolygon from "@turf/bbox-polygon";
import type { BBox } from "@turf/helpers";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { BundleRead } from "@/lib/api/bundles";
import { useProject } from "@/lib/api/projects";
import { setRunningJobIds } from "@/lib/store/jobs/slice";
import { creditsErrorMessage } from "@/lib/utils/credits";

import { useProcessExecution } from "@/hooks/map/useOgcProcesses";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { AddButton } from "@/components/map/panels/styleEditor/rows";

type BundleFilterProps = {
  bundle: BundleRead;
  projectId: string;
};

/** The area: the map extent as a polygon. Its `properties` (no part of GeoJSON geometry, ignored by the server) say
 * what kind of area it is, as the layer filter's areas did. */
type Extent = { bbox: BBox; geometry: { type: "Polygon"; coordinates: number[][][]; properties: object } };

const BundleFilter = ({ bundle, projectId }: BundleFilterProps) => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);
  const { execute: executeProcess } = useProcessExecution();
  const { map } = useMap();
  // The copy lands in the project's folder, like every other tool's output:
  // the source bundle's folder may be one the caller can only read.
  const { project } = useProject(projectId);
  // No area until the user adds one, so the tab opens the way a layer's does.
  const [extent, setExtent] = useState<Extent | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const takeMapExtent = () => {
    const bbox = map?.getBounds().toArray().flat() as BBox | undefined;
    if (!bbox) return;
    const { coordinates } = bboxPolygon(bbox).geometry;
    setExtent({
      bbox,
      geometry: { type: "Polygon", coordinates, properties: { type: "bbox", label: "Map Extent" } },
    });
  };

  const saveAsNewBundle = async () => {
    if (!extent || !project?.folder_id) return;
    setIsSaving(true);
    try {
      const result = await executeProcess("bundle_create_filtered", {
        source_bundle_id: bundle.id,
        // Under one `and`, as the layer filter wrote it.
        cql_filter: {
          op: "and",
          args: [{ op: "s_intersects", args: [{ property: "geom" }, extent.geometry] }],
        },
        folder_id: project.folder_id,
        project_id: projectId,
        result_bundle_name: `${bundle.name} (${t("filtered")})`,
      });
      if (result?.jobID) {
        toast.info(`${t("save_as_new_bundle")} - ${t("job_started")}`);
        dispatch(setRunningJobIds([...runningJobIds, result.jobID]));
        setExtent(null);
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
        {extent ? (
          <Stack direction="row" spacing={2} alignItems="center">
            <Icon iconName={ICON_NAME.MAP} style={{ fontSize: 17 }} htmlColor="inherit" />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" fontWeight="bold">
                {t("map_extent")}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {`SW(${extent.bbox[0].toFixed(3)}, ${extent.bbox[1].toFixed(3)}); NE(${extent.bbox[2].toFixed(3)}, ${extent.bbox[3].toFixed(3)})`}
              </Typography>
            </Box>
            <Tooltip title={t("use_current_map_extent")} arrow>
              <IconButton color="secondary" aria-label={t("use_current_map_extent")} onClick={takeMapExtent}>
                <Icon iconName={ICON_NAME.REFRESH} fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        ) : (
          <>
            <Typography variant="caption" component="p" color="text.secondary">
              {t("filter_bundle_message")}
            </Typography>
            {/* A bundle takes exactly one area, the map extent: nothing to choose, and nothing to add once it is
                there. */}
            <AddButton onClick={takeMapExtent} sx={{ ml: -2.5, mt: 2 }}>
              {t("add_expression")}
            </AddButton>
          </>
        )}
      </Box>
      {extent && (
        // "Clear filter" as a text button, the tab's one primary action at the end.
        <Box
          sx={{
            flex: "none",
            display: "flex",
            justifyContent: "flex-end",
            gap: 2,
            px: 3,
            py: 3,
            borderTop: 1,
            borderColor: "divider",
          }}>
          <Button variant="text" size="small" onClick={() => setExtent(null)}>
            {t("clear_filter")}
          </Button>
          <LoadingButton
            variant="contained"
            size="small"
            disableElevation
            loading={isSaving}
            disabled={!project?.folder_id}
            onClick={saveAsNewBundle}>
            {t("save_as_new_bundle")}
          </LoadingButton>
        </Box>
      )}
    </Box>
  );
};

export default BundleFilter;

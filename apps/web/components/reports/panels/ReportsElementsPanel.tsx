"use client";

import { useDraggable } from "@dnd-kit/core";
import CancelOutlinedIcon from "@mui/icons-material/CancelOutlined";
import DownloadIcon from "@mui/icons-material/Download";
import {
  Box,
  Card,
  CardHeader,
  CircularProgress,
  Divider,
  Grid,
  IconButton,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { Icon } from "@p4b/ui/components/Icon";

import { dismissJob, useJobs } from "@/lib/api/processes";
import type { Project } from "@/lib/validations/project";
import type { ReportElement, ReportElementType, ReportLayout } from "@/lib/validations/reportLayout";

import SettingsGroupHeader from "@/components/builder/widgets/common/SettingsGroupHeader";
import SidePanel, { SidePanelTabPanel, SidePanelTabs } from "@/components/common/SidePanel";
import JobProgressItem from "@/components/jobs/JobProgressItem";
import type { MapLayer } from "@/hooks/map/useMapLayers";
import { useBasemap } from "@/hooks/map/MapHooks";
import { reportElementIconMap } from "@/components/reports/elements/ReportElementIconMap";
import ElementConfiguration from "@/components/reports/elements/config/ElementConfiguration";

interface ReportsElementsPanelProps {
  project?: Project;
  projectLayers?: MapLayer[];
  selectedReport?: ReportLayout | null;
  selectedElementId?: string | null;
  onElementSelect?: (elementId: string | null) => void;
  onElementUpdate?: (elementId: string, updates: Partial<ReportElement>) => void;
  onElementDelete?: (elementId: string) => void;
}

interface ElementConfig {
  type: ReportElementType;
  label: string;
}

// Draggable element item component - styled same as builder's DraggableItem
interface DraggableElementItemProps {
  type: ReportElementType;
  label: string;
}

const DraggableElementItem: React.FC<DraggableElementItemProps> = ({ type, label }) => {
  const theme = useTheme();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `report-element-${type}`,
    data: {
      type: "report-element",
      elementType: type,
    },
  });

  return (
    <Card
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      sx={{
        cursor: isDragging ? "grabbing" : "grab",
        maxWidth: "130px",
        borderRadius: "6px",
        opacity: isDragging ? 0.5 : 1,
        transition: "opacity 0.2s",
      }}>
      <CardHeader
        sx={{
          px: 2,
          py: 4,
          ".MuiCardHeader-content": {
            width: "100%",
            color: isDragging ? theme.palette.primary.main : theme.palette.text.secondary,
          },
        }}
        title={
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            spacing={2}
            style={{
              color: theme.palette.text.secondary,
            }}>
            <Typography variant="body2" fontWeight="bold" noWrap color="inherit">
              {label}
            </Typography>
            <Icon
              iconName={reportElementIconMap[type]}
              style={{
                fontSize: "1.2rem",
                color: isDragging ? theme.palette.primary.main : "inherit",
              }}
            />
          </Stack>
        }
      />
    </Card>
  );
};

// Elements tab content
const ElementsTabContent: React.FC = () => {
  const { t } = useTranslation("common");

  const mapElements: ElementConfig[] = [
    { type: "map", label: t("map") },
    { type: "legend", label: t("legend") },
    { type: "north_arrow", label: t("north_arrow") },
    { type: "scalebar", label: t("scalebar") },
  ];

  const contentElements: ElementConfig[] = [
    { type: "text", label: t("text") },
    { type: "image", label: t("image") },
    { type: "divider", label: t("divider") },
  ];

  return (
    <Stack spacing={4} sx={{ p: 3 }}>
      {/* Map Elements Section */}
      <Box sx={{ mb: 8 }}>
        <SettingsGroupHeader label={t("map_elements")} />
        <Grid container spacing={4}>
          {mapElements.map((element) => (
            <Grid item xs={6} key={element.type}>
              <DraggableElementItem type={element.type} label={element.label} />
            </Grid>
          ))}
        </Grid>
      </Box>

      {/* Content Elements Section */}
      <Box>
        <SettingsGroupHeader label={t("content")} />
        <Grid container spacing={4}>
          {contentElements.map((element) => (
            <Grid item xs={6} key={element.type}>
              <DraggableElementItem type={element.type} label={element.label} />
            </Grid>
          ))}
        </Grid>
      </Box>
    </Stack>
  );
};

// History tab content - shows print jobs for the current layout
interface HistoryTabContentProps {
  projectId?: string;
  layoutId?: string;
}

const HistoryTabContent: React.FC<HistoryTabContentProps> = ({ projectId, layoutId }) => {
  const { t } = useTranslation("common");
  const [cancellingJobs, setCancellingJobs] = useState<Set<string>>(new Set());

  // Fetch all print jobs for this project (don't filter by read status to get history)
  // Note: We fetch all jobs for the project and filter client-side by layout_id
  const { jobs, isLoading, mutate } = useJobs(
    projectId
      ? {
          processID: "print_report",
        }
      : undefined
  );

  // Filter jobs by type and layout_id from inputs
  const printJobs = useMemo(() => {
    if (!jobs?.jobs || !layoutId) return [];
    return jobs.jobs.filter((job) => {
      // Filter by job type first
      if (job.processID !== "print_report") return false;
      // Then filter by layout_id in inputs
      return job.inputs?.layout_id === layoutId;
    });
  }, [jobs?.jobs, layoutId]);

  // Check if there are running jobs
  const hasRunningJobs = useMemo(() => {
    return printJobs.some((job) => job.status === "running" || job.status === "accepted");
  }, [printJobs]);

  // Poll for updates - always poll at a slower rate, faster when jobs are running
  useEffect(() => {
    const intervalId = setInterval(
      () => {
        mutate();
      },
      hasRunningJobs ? 3000 : 10000
    );

    return () => clearInterval(intervalId);
  }, [hasRunningJobs, mutate]);

  const handleDownload = useCallback(
    async (downloadUrl: string, fileName?: string) => {
      try {
        // Fetch the file and create a blob URL for proper download
        // This is needed for cross-origin URLs (like S3) where link.download doesn't work
        const response = await fetch(downloadUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch file: ${response.status}`);
        }
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);

        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = fileName || "report";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // Clean up the blob URL
        URL.revokeObjectURL(blobUrl);
      } catch (error) {
        console.error("Download failed:", error);
        toast.error(t("error_downloading") || "Download failed");
      }
    },
    [t]
  );

  // Handle cancel job
  const handleCancelJob = useCallback(
    async (jobId: string) => {
      setCancellingJobs((prev) => new Set(prev).add(jobId));
      try {
        await dismissJob(jobId);
        mutate();
      } catch (error) {
        console.error("Failed to cancel job:", error);
        toast.error(t("error_cancelling_job") || "Failed to cancel job");
      } finally {
        setCancellingJobs((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    },
    [mutate, t]
  );

  if (isLoading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", height: 200 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  return (
    <Box>
      {printJobs.length === 0 ? (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: 200,
            textAlign: "center",
          }}>
          <Typography variant="body2" color="text.secondary">
            {t("no_print_history")}
          </Typography>
        </Box>
      ) : (
        <Stack direction="column">
          {printJobs.map((job, index) => {
            // Result contains download_url, file_name, format, page_count
            const result = job.result as
              | { download_url?: string; file_name?: string; format?: string }
              | undefined;
            // Show open button for finished jobs that have a download_url
            const canOpen = job.status === "successful" && result?.download_url;
            // Show cancel button for running/accepted jobs
            const canCancel = job.status === "running" || job.status === "accepted";
            const isCancelling = cancellingJobs.has(job.jobID);

            // Create action button based on job status
            let actionButton: React.ReactNode = undefined;
            if (canCancel) {
              actionButton = (
                <Tooltip title={t("cancel")}>
                  <IconButton
                    size="small"
                    onClick={() => handleCancelJob(job.jobID)}
                    disabled={isCancelling}
                    sx={{ fontSize: "1.2rem", color: "error.main" }}>
                    {isCancelling ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <CancelOutlinedIcon fontSize="small" />
                    )}
                  </IconButton>
                </Tooltip>
              );
            } else if (canOpen) {
              actionButton = (
                <Tooltip title={t("download")}>
                  <IconButton
                    size="small"
                    onClick={() => handleDownload(result.download_url!, result.file_name as string)}
                    sx={{ fontSize: "1.2rem", color: "success.main" }}>
                    <DownloadIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              );
            }

            return (
              <Box key={job.jobID} sx={{ overflow: "hidden" }}>
                <JobProgressItem
                  id={job.jobID}
                  type={job.processID}
                  status={job.status}
                  name={job.jobID}
                  date={job.updated || job.created || ""}
                  errorMessage={job.status === "failed" ? job.message : undefined}
                  actionButton={actionButton}
                />
                {index < printJobs.length - 1 && <Divider />}
              </Box>
            );
          })}
        </Stack>
      )}
    </Box>
  );
};

const ReportsElementsPanel: React.FC<ReportsElementsPanelProps> = ({
  project,
  projectLayers,
  selectedReport,
  selectedElementId,
  onElementSelect,
  onElementUpdate,
  onElementDelete,
}) => {
  const { t } = useTranslation("common");
  // Get basemap style from project (synced live). Vector → URL string, raster/solid → synthesized StyleSpecification.
  const { mapStyle: basemapUrl } = useBasemap(project);
  const [activeTab, setActiveTab] = useState(0);

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue);
  };

  // Find the selected element
  const selectedElement = useMemo(() => {
    if (!selectedElementId || !selectedReport?.config?.elements) {
      return null;
    }
    return selectedReport.config.elements.find((el) => el.id === selectedElementId) ?? null;
  }, [selectedElementId, selectedReport?.config?.elements]);

  // Determine if we should show configuration (like builder's showConfiguration)
  const showConfiguration = useMemo(() => {
    return selectedElement !== null;
  }, [selectedElement]);

  // Handle element update
  const handleElementUpdate = (updates: Partial<ReportElement>) => {
    if (selectedElementId && onElementUpdate) {
      onElementUpdate(selectedElementId, updates);
    }
  };

  // Handle element delete
  const handleElementDelete = () => {
    if (selectedElementId && onElementDelete) {
      onElementDelete(selectedElementId);
    }
  };

  // Handle back (deselect element)
  const handleBack = () => {
    if (onElementSelect) {
      onElementSelect(null);
    }
  };

  // If an element is selected, show its configuration
  if (showConfiguration && selectedElement) {
    return (
      <SidePanel sx={{ borderLeft: (theme) => `1px solid ${theme.palette.background.paper}` }}>
        <ElementConfiguration
          element={selectedElement}
          allElements={selectedReport?.config?.elements}
          projectLayers={projectLayers}
          basemapUrl={basemapUrl}
          onChange={handleElementUpdate}
          onDelete={handleElementDelete}
          onBack={handleBack}
        />
      </SidePanel>
    );
  }

  // Otherwise show the elements palette (default view)
  return (
    <SidePanel sx={{ borderLeft: (theme) => `1px solid ${theme.palette.background.paper}` }}>
      <SidePanelTabs
        value={activeTab}
        onChange={handleTabChange}
        tabs={[
          { label: t("elements"), id: "elements" },
          { label: t("history"), id: "history" },
        ]}
        ariaLabel="report panel tabs"
      />
      <SidePanelTabPanel value={activeTab} index={0} id="elements">
        <ElementsTabContent />
      </SidePanelTabPanel>
      <SidePanelTabPanel value={activeTab} index={1} id="history">
        <HistoryTabContent projectId={project?.id} layoutId={selectedReport?.id} />
      </SidePanelTabPanel>
    </SidePanel>
  );
};

export default ReportsElementsPanel;

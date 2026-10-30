"use client";

import CancelOutlinedIcon from "@mui/icons-material/CancelOutlined";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import SearchIcon from "@mui/icons-material/Search";
import SettingsIcon from "@mui/icons-material/Settings";
import {
  Box,
  Card,
  CircularProgress,
  Collapse,
  Divider,
  Grid,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { styled } from "@mui/material/styles";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";
import { type TOOL_ICON_NAME, toolIconMap } from "@p4b/ui/assets/svg/ToolIcons";

import { type JobStatusType, dismissJob, useJobs } from "@/lib/api/processes";
import type { AppDispatch } from "@/lib/store";
import { selectNodes } from "@/lib/store/workflow/selectors";
import { selectNode } from "@/lib/store/workflow/slice";
import type { ProjectLayer } from "@/lib/validations/project";
import type { WorkflowConfig, WorkflowNode } from "@/lib/validations/workflow";
import { INTEGRATE_PROCESS_ID } from "@/lib/workflows/datasetConnection";

import type { SelectorItem } from "@/types/map/common";
import type { ToolCategory } from "@/types/map/ogc-processes";

import { useCategorizedProcesses } from "@/hooks/map/useOgcProcesses";

import SettingsGroupHeader from "@/components/builder/widgets/common/SettingsGroupHeader";
import { addLayerSource } from "@/components/addLayer/sources";
import BetaSectionDivider from "@/components/common/BetaSectionDivider";
import {
  SIDE_PANEL_WIDTH,
  SidePanelContainer,
  SidePanelTabPanel,
  SidePanelTabs,
} from "@/components/common/SidePanel";
import JobProgressItem from "@/components/jobs/JobProgressItem";
import Selector from "@/components/map/panels/common/Selector";
import WorkflowNodeSettings from "@/components/workflows/panels/WorkflowNodeSettings";

const RightPanelContainer = styled(SidePanelContainer)(({ theme }) => ({
  width: SIDE_PANEL_WIDTH,
  height: "100%",
  borderLeft: `1px solid ${theme.palette.divider}`,
  display: "flex",
  flexDirection: "column",
}));

/**
 * Category display configuration
 */
const CATEGORY_CONFIG: Record<ToolCategory, { name: string; icon: ICON_NAME; order: number }> = {
  accessibility_indicators: {
    name: "accessibility_indicators",
    icon: ICON_NAME.BULLSEYE,
    order: 1,
  },
  geoprocessing: {
    name: "geoprocessing",
    icon: ICON_NAME.SETTINGS,
    order: 2,
  },
  geoanalysis: {
    name: "geoanalysis",
    icon: ICON_NAME.CHART,
    order: 3,
  },
  data_management: {
    name: "data_management",
    icon: ICON_NAME.TABLE,
    order: 4,
  },
  other: {
    name: "other",
    icon: ICON_NAME.CIRCLEINFO,
    order: 5,
  },
};

interface ToolItem {
  id: string;
  title: string;
  /** Already translated, for an entry whose id is not a translation key. */
  label?: string;
  description?: string;
  beta?: boolean;
}

// Draggable tool card component - styled same as ReportsElementsPanel
interface DraggableToolCardProps {
  tool: ToolItem;
  onDragStart: (event: React.DragEvent, toolId: string) => void;
}

const DraggableToolCard: React.FC<DraggableToolCardProps> = ({ tool, onDragStart }) => {
  const theme = useTheme();
  const { t } = useTranslation("common");
  const [isDragging, setIsDragging] = useState(false);

  const handleDragStart = (event: React.DragEvent) => {
    setIsDragging(true);
    onDragStart(event, tool.id);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  const ToolIconComponent = toolIconMap[tool.id as TOOL_ICON_NAME];

  const isDark = theme.palette.mode === "dark";

  return (
    <Stack
      direction="column"
      alignItems="center"
      spacing={1}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      sx={{
        cursor: isDragging ? "grabbing" : "grab",
        opacity: isDragging ? 0.5 : 1,
        transition: "opacity 0.2s",
        "--icon-color-1": isDark ? "#FAFAFA" : "#666666",
        "--icon-color-2": "#999999",
        "--icon-color-3": "#BDBDBD",
        "--icon-color-4": "#E3E3E3",
        "--icon-color-5": isDark ? "#666666" : "#FAFAFA",
      }}>
      <Card
        sx={{
          borderRadius: "6px",
          width: 68,
          height: 68,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}>
        {/* Integrate dataset looks like Add layer › Connect service, which it opens. */}
        {tool.id === INTEGRATE_PROCESS_ID ? (
          <Icon iconName={addLayerSource("connect").icon} sx={{ fontSize: 44, color: "text.secondary" }} />
        ) : ToolIconComponent ? <ToolIconComponent sx={{ fontSize: 44 }} /> : <SettingsIcon sx={{ fontSize: 44, color: "text.secondary" }} />}
      </Card>
      <Typography
        variant="caption"
        fontWeight="bold"
        color={isDragging ? "primary.main" : "text.secondary"}
        sx={{ textAlign: "center", lineHeight: 1.2, wordBreak: "break-word", whiteSpace: "normal" }}>
        {tool.label ?? t(tool.id, { defaultValue: tool.title })}
      </Typography>
    </Stack>
  );
};

// Tools tab content
interface ToolsTabContentProps {
  onDragStart: (event: React.DragEvent, nodeType: string, toolId?: string, layerId?: string) => void;
}

const ToolsTabContent: React.FC<ToolsTabContentProps> = ({ onDragStart }) => {
  const { t } = useTranslation("common");
  const [searchTerm, setSearchTerm] = useState("");

  // Fetch all processes from OGC API
  const { processes: ogcProcesses, isLoading, error } = useCategorizedProcesses();

  // Data I/O items (static)
  const dataIoItems: ToolItem[] = useMemo(
    () => [
      { id: "add_dataset", title: t("add_dataset") },
      // A tool node, offered here because it is a source: the fetch tool is hidden from the toolbox.
      { id: INTEGRATE_PROCESS_ID, title: t("fetch_data"), label: t("fetch_data") },
      { id: "export_dataset", title: t("export_dataset") },
    ],
    [t]
  );

  // Control items (static)
  const controlItems: ToolItem[] = useMemo(
    () => [{ id: "if_node", title: t("if_node", { defaultValue: "If" }) }],
    [t]
  );

  // Organize tools by category
  const toolsByCategory = useMemo(() => {
    const categories: Record<ToolCategory, ToolItem[]> = {
      accessibility_indicators: [],
      geoprocessing: [],
      geoanalysis: [],
      data_management: [],
      other: [],
    };

    for (const process of ogcProcesses) {
      const category = process.category || "other";
      categories[category].push({
        id: process.id,
        title: process.title,
        description: process.description,
        beta: process["x-ui-beta"] === true,
      });
    }

    // Add static data management items
    categories.data_management.push({ id: "custom_sql", title: t("custom_sql") });

    return categories;
  }, [ogcProcesses, t]);

  // Filter helper
  const matchesSearch = useCallback(
    (tool: ToolItem) => {
      if (!searchTerm) return true;
      const lower = searchTerm.toLowerCase();
      const translatedName = (tool.label ?? t(tool.id, { defaultValue: tool.title })).toLowerCase();
      return translatedName.includes(lower) || tool.id.toLowerCase().includes(lower);
    },
    [searchTerm, t]
  );

  // Sort categories, apply search filter, and remove empty ones
  const sortedCategories = useMemo(() => {
    return Object.entries(toolsByCategory)
      .map(([category, tools]) => [category, tools.filter(matchesSearch)] as [string, ToolItem[]])
      .filter(([_, tools]) => tools.length > 0)
      .sort(([a], [b]) => {
        const orderA = CATEGORY_CONFIG[a as ToolCategory]?.order ?? 99;
        const orderB = CATEGORY_CONFIG[b as ToolCategory]?.order ?? 99;
        return orderA - orderB;
      });
  }, [toolsByCategory, matchesSearch]);

  // Filtered data I/O items
  const filteredDataIoItems = useMemo(() => dataIoItems.filter(matchesSearch), [dataIoItems, matchesSearch]);

  // Filtered control items
  const filteredControlItems = useMemo(
    () => controlItems.filter(matchesSearch),
    [controlItems, matchesSearch]
  );

  // Handle drag start for tools
  const handleToolDragStart = (event: React.DragEvent, toolId: string) => {
    onDragStart(event, "tool", toolId);
  };

  if (isLoading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", height: 200 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  // Handle drag start for Add Dataset node
  const handleDatasetDragStart = (event: React.DragEvent) => {
    onDragStart(event, "dataset");
  };

  // Handle drag start for Export Dataset node
  const handleExportDragStart = (event: React.DragEvent) => {
    onDragStart(event, "export");
  };

  // Handle drag start for If/Switch branching node
  const handleIfDragStart = (event: React.DragEvent) => {
    onDragStart(event, "if");
  };

  const hasNoResults =
    filteredDataIoItems.length === 0 &&
    filteredControlItems.length === 0 &&
    sortedCategories.length === 0;

  return (
    <Stack direction="column" height="100%" width="100%">
      <TextField
        fullWidth
        placeholder={t("search")}
        sx={{ p: 3 }}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
        }}
        size="small"
      />
      <Box sx={{ flex: 1, overflowY: "auto" }}>
        <Stack spacing={4} sx={{ p: 3 }}>
          {/* Data I/O Section - Dataset input and Export output */}
          {filteredDataIoItems.length > 0 && (
            <Box sx={{ mb: 4 }}>
              <SettingsGroupHeader label={t("data_io")} />
              <Grid container spacing={4}>
                {filteredDataIoItems.map((item) => (
                  <Grid item xs={4} key={item.id}>
                    <DraggableToolCard
                      tool={item}
                      onDragStart={(event) => {
                        if (item.id === "add_dataset") handleDatasetDragStart(event);
                        else if (item.id === INTEGRATE_PROCESS_ID) handleToolDragStart(event, item.id);
                        else if (item.id === "export_dataset") handleExportDragStart(event);
                      }}
                    />
                  </Grid>
                ))}
              </Grid>
            </Box>
          )}

          {error && (
            <Typography color="warning.main" variant="caption" sx={{ display: "block" }}>
              {t("some_tools_unavailable")}
            </Typography>
          )}

          {/* Tool Categories — beta tools sit under a labelled rule at the
              bottom of their category, matching the map toolbox. */}
          {sortedCategories.map(([category, tools]) => {
            const categoryConfig = CATEGORY_CONFIG[category as ToolCategory];
            const betaTools = tools.filter((tool) => tool.beta);
            const mainTools = tools.filter((tool) => !tool.beta);

            return (
              <Box key={category} sx={{ mb: 4 }}>
                <SettingsGroupHeader label={t(categoryConfig?.name ?? category)} />
                <Grid container spacing={4}>
                  {mainTools.map((tool) => (
                    <Grid item xs={4} key={tool.id}>
                      <DraggableToolCard tool={tool} onDragStart={handleToolDragStart} />
                    </Grid>
                  ))}
                </Grid>
                {betaTools.length > 0 && (
                  <Box sx={{ mt: 3 }}>
                    <BetaSectionDivider />
                    <Grid container spacing={4}>
                      {betaTools.map((tool) => (
                        <Grid item xs={4} key={tool.id}>
                          <DraggableToolCard tool={tool} onDragStart={handleToolDragStart} />
                        </Grid>
                      ))}
                    </Grid>
                  </Box>
                )}
              </Box>
            );
          })}

          {/* Control Section - branching/flow-control nodes (rendered last) */}
          {filteredControlItems.length > 0 && (
            <Box sx={{ mb: 4 }}>
              <SettingsGroupHeader label={t("control")} />
              <Grid container spacing={4}>
                {filteredControlItems.map((item) => (
                  <Grid item xs={4} key={item.id}>
                    <DraggableToolCard
                      tool={item}
                      onDragStart={(event) => {
                        if (item.id === "if_node") handleIfDragStart(event);
                      }}
                    />
                  </Grid>
                ))}
              </Grid>
            </Box>
          )}

          {hasNoResults && (
            <Box sx={{ textAlign: "center", py: 4 }}>
              <Typography variant="body2" color="text.secondary">
                {searchTerm ? t("no_results") : t("no_tools_available")}
              </Typography>
            </Box>
          )}
        </Stack>
      </Box>
    </Stack>
  );
};

// History tab content - shows workflow run history
interface HistoryTabContentProps {
  workflowId?: string;
}

type StatusFilter = "all" | JobStatusType;

const HistoryTabContent: React.FC<HistoryTabContentProps> = ({ workflowId }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [cancellingJobs, setCancellingJobs] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  // Fetch all workflow runner jobs
  const { jobs, isLoading, mutate } = useJobs(
    workflowId
      ? {
          processID: "workflow_runner",
        }
      : undefined
  );

  // Filter jobs by workflow_id in inputs
  const workflowJobs = useMemo(() => {
    if (!jobs?.jobs || !workflowId) return [];
    return jobs.jobs.filter((job) => {
      if (job.processID !== "workflow_runner") return false;
      if (!job.inputs?.workflow_id || job.inputs.workflow_id !== workflowId) return false;
      // Apply status filter
      if (statusFilter !== "all" && job.status !== statusFilter) return false;
      return true;
    });
  }, [jobs?.jobs, workflowId, statusFilter]);

  // Check if there are running jobs
  const hasRunningJobs = useMemo(() => {
    return workflowJobs.some((job) => job.status === "running" || job.status === "accepted");
  }, [workflowJobs]);

  // Poll for updates - faster when jobs are running
  useEffect(() => {
    const intervalId = setInterval(
      () => {
        mutate();
      },
      hasRunningJobs ? 3000 : 15000
    );

    return () => clearInterval(intervalId);
  }, [hasRunningJobs, mutate]);

  // Handle cancel job
  const handleCancelJob = useCallback(
    async (jobId: string) => {
      setCancellingJobs((prev) => new Set(prev).add(jobId));
      try {
        await dismissJob(jobId);
        mutate();
      } catch (error) {
        console.error("Failed to cancel job:", error);
      } finally {
        setCancellingJobs((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    },
    [mutate]
  );

  // Calculate duration
  const getDuration = (started?: string, finished?: string) => {
    if (!started) return "-";
    const start = new Date(started);
    const end = finished ? new Date(finished) : new Date();
    const diffMs = end.getTime() - start.getTime();
    if (diffMs < 1000) return "<1s";
    if (diffMs < 60000) return `${Math.round(diffMs / 1000)}s`;
    if (diffMs < 3600000) return `${Math.round(diffMs / 60000)}m`;
    return `${Math.round(diffMs / 3600000)}h`;
  };

  if (isLoading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", height: 200 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  const statusFilterItems: SelectorItem[] = [
    { value: "all", label: t("all_states") },
    { value: "successful", label: t("successful") },
    { value: "failed", label: t("failed") },
    { value: "running", label: t("running") },
    { value: "accepted", label: t("pending") },
    { value: "dismissed", label: t("cancelled") },
  ];

  return (
    <Box>
      {/* Status filter dropdown */}
      <Box sx={{ px: 2, pt: 2, pb: 1 }}>
        <Selector
          selectedItems={statusFilterItems.find((item) => item.value === statusFilter)}
          setSelectedItems={(item) => setStatusFilter((item as SelectorItem)?.value as StatusFilter)}
          items={statusFilterItems}
        />
      </Box>

      {workflowJobs.length === 0 ? (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: 200,
            textAlign: "center",
          }}>
          <Typography variant="body2" color="text.secondary">
            {statusFilter === "all" ? t("no_workflow_runs_yet") : t("no_matching_runs")}
          </Typography>
        </Box>
      ) : (
        <Stack direction="column" divider={<Divider />}>
          {workflowJobs.map((job) => {
            const canCancel = job.status === "running" || job.status === "accepted";
            const isCancelling = cancellingJobs.has(job.jobID);
            const isExpanded = expandedJobId === job.jobID;

            // Create action button
            let actionButton: React.ReactNode = undefined;
            if (canCancel) {
              actionButton = (
                <Tooltip title={t("cancel")}>
                  <IconButton
                    size="small"
                    onClick={() => handleCancelJob(job.jobID)}
                    disabled={isCancelling}
                    sx={{ color: "error.main" }}>
                    {isCancelling ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <CancelOutlinedIcon fontSize="small" />
                    )}
                  </IconButton>
                </Tooltip>
              );
            } else {
              // Expand/collapse button for completed jobs
              actionButton = (
                <IconButton size="small" onClick={() => setExpandedJobId(isExpanded ? null : job.jobID)}>
                  {isExpanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                </IconButton>
              );
            }

            return (
              <Box key={job.jobID}>
                <JobProgressItem
                  id={job.jobID}
                  type={job.processID}
                  status={job.status}
                  name={job.jobID}
                  date={job.updated || job.created || ""}
                  actionButton={actionButton}
                />
                {/* Expandable details */}
                <Collapse in={isExpanded}>
                  <Box
                    sx={{
                      px: 4,
                      py: 2,
                      bgcolor: theme.palette.action.hover,
                      borderTop: `1px solid ${theme.palette.divider}`,
                    }}>
                    <Stack spacing={1.5}>
                      <Stack direction="row" justifyContent="space-between">
                        <Typography variant="caption" color="text.secondary">
                          {t("started_at")}
                        </Typography>
                        <Typography variant="caption" fontWeight={500}>
                          {job.started
                            ? new Date(job.started).toLocaleString(undefined, {
                                day: "2-digit",
                                month: "short",
                                year: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "-"}
                        </Typography>
                      </Stack>
                      <Stack direction="row" justifyContent="space-between">
                        <Typography variant="caption" color="text.secondary">
                          {t("duration")}
                        </Typography>
                        <Typography variant="caption" fontWeight={500}>
                          {getDuration(job.started, job.finished)}
                        </Typography>
                      </Stack>
                      <Stack direction="row" justifyContent="space-between">
                        <Typography variant="caption" color="text.secondary">
                          {t("triggered_by")}
                        </Typography>
                        <Typography variant="caption" fontWeight={500}>
                          {t("manual_run")}
                        </Typography>
                      </Stack>
                    </Stack>
                  </Box>
                </Collapse>
              </Box>
            );
          })}
        </Stack>
      )}
    </Box>
  );
};

interface WorkflowsNodesPanelProps {
  config: WorkflowConfig | null;
  selectedNodeId: string | null;
  projectLayers?: ProjectLayer[];
  workflowId?: string;
  onDragStart: (event: React.DragEvent, nodeType: string, toolId?: string, layerId?: string) => void;
}

const WorkflowsNodesPanel: React.FC<WorkflowsNodesPanelProps> = ({
  config: _config,
  selectedNodeId,
  projectLayers = [],
  workflowId,
  onDragStart,
}) => {
  const { t } = useTranslation("common");
  const dispatch = useDispatch<AppDispatch>();
  const nodes = useSelector(selectNodes);
  const [activeTab, setActiveTab] = useState(0);

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue);
  };

  // Handle back from node settings - deselect all nodes
  const handleBack = () => {
    dispatch(selectNode(null));
  };

  // If a node is selected, show the node settings panel (like LayerSettingsPanel in Layouts)
  // Note: textAnnotation nodes don't show settings panel - they have their own floating toolbar
  // Use Redux nodes (source of truth) instead of stale workflow config to prevent config resets
  if (selectedNodeId) {
    const selectedNode = nodes.find((n) => n.id === selectedNodeId);
    if (selectedNode && selectedNode.type !== "textAnnotation") {
      return (
        <RightPanelContainer>
          <WorkflowNodeSettings key={selectedNodeId} node={selectedNode as WorkflowNode} projectLayers={projectLayers} onBack={handleBack} />
        </RightPanelContainer>
      );
    }
  }

  // Default view: Tools and History tabs
  return (
    <RightPanelContainer>
      <SidePanelTabs
        value={activeTab}
        onChange={handleTabChange}
        tabs={[
          { label: t("tools"), id: "tools" },
          { label: t("history"), id: "history" },
        ]}
        ariaLabel="workflow panel tabs"
      />
      <SidePanelTabPanel value={activeTab} index={0} id="tools">
        <ToolsTabContent onDragStart={onDragStart} />
      </SidePanelTabPanel>
      <SidePanelTabPanel value={activeTab} index={1} id="history">
        <HistoryTabContent workflowId={workflowId} />
      </SidePanelTabPanel>
    </RightPanelContainer>
  );
};

export default WorkflowsNodesPanel;

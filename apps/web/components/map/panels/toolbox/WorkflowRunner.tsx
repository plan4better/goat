/**
 * WorkflowRunner Component
 *
 * Renders a workflow detail view in the map toolbox for running workflows
 * with runtime variable values. Variables are ephemeral (local state only)
 * and never saved back to the workflow definition.
 */
import { LoadingButton } from "@mui/lab";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { dismissJob, useJobs } from "@/lib/api/processes";
import { useProject } from "@/lib/api/projects";
import { type WorkflowExecuteRequest, cleanupWorkflowTemp, executeWorkflow, useWorkflow } from "@/lib/api/workflows";
import { setRunningJobIds } from "@/lib/store/jobs/slice";
import { claimJobAnnouncement } from "@/lib/utils/jobAnnouncement";

import type { NodeExecutionInfo, NodeExecutionStatus } from "@/components/workflows/context/WorkflowExecutionContext";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import FormLabelHelper from "@/components/common/FormLabelHelper";
import Container from "@/components/map/panels/Container";
import SectionHeader from "@/components/map/panels/common/SectionHeader";
import SectionOptions from "@/components/map/panels/common/SectionOptions";
import ToolsHeader from "@/components/map/panels/common/ToolsHeader";

interface WorkflowRunnerProps {
  workflowId: string;
  onBack: () => void;
  onClose: () => void;
}

interface ExecutionState {
  isExecuting: boolean;
  jobId: string | null;
  nodeStatuses: Record<string, NodeExecutionStatus>;
  nodeExecutionInfo: Record<string, NodeExecutionInfo>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export default function WorkflowRunner({ workflowId, onBack, onClose }: WorkflowRunnerProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { projectId } = useParams();
  const dispatch = useAppDispatch();
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);
  const runningJobIdsRef = useRef(runningJobIds);
  runningJobIdsRef.current = runningJobIds;
  const processedJobIdsRef = useRef<Set<string>>(new Set());

  // Fetch workflow and project data
  const { workflow, isLoading } = useWorkflow(projectId as string, workflowId);
  const { project } = useProject(projectId as string);

  // Jobs polling
  const { jobs, mutate: mutateJobs } = useJobs({ read: false });

  // Runtime variable values (local state, never saved)
  const [variableValues, setVariableValues] = useState<Record<string, string | number>>({});

  // Execution state
  const [execState, setExecState] = useState<ExecutionState>({
    isExecuting: false,
    jobId: null,
    nodeStatuses: {},
    nodeExecutionInfo: {},
  });

  // Initialize variable values from workflow defaults when loaded
  useEffect(() => {
    if (workflow?.config?.variables) {
      const defaults: Record<string, string | number> = {};
      for (const variable of workflow.config.variables) {
        defaults[variable.name] = variable.defaultValue ?? (variable.type === "number" ? 0 : "");
      }
      setVariableValues(defaults);
    }
  }, [workflow]);

  // Tool/export nodes for progress display
  const executableNodes = useMemo(() => {
    if (!workflow?.config?.nodes) return [];
    return workflow.config.nodes.filter(
      (node) => node.data.type === "tool" || node.data.type === "export"
    );
  }, [workflow]);

  // Check if workflow can be executed
  const canExecute = useMemo(() => {
    if (!projectId || !workflowId || !project?.folder_id) return false;
    if (execState.isExecuting) return false;
    return executableNodes.some((n) => n.data.type === "tool");
  }, [projectId, workflowId, project?.folder_id, execState.isExecuting, executableNodes]);

  // Execute workflow
  const handleRun = useCallback(async () => {
    if (!projectId || !project?.folder_id || !workflow) return;

    processedJobIdsRef.current.clear();

    // Initialize node statuses
    const initialStatuses: Record<string, NodeExecutionStatus> = {};
    const initialInfo: Record<string, NodeExecutionInfo> = {};
    for (const node of executableNodes) {
      initialStatuses[node.id] = "pending";
      initialInfo[node.id] = { status: "pending" };
    }

    setExecState({
      isExecuting: true,
      jobId: null,
      nodeStatuses: initialStatuses,
      nodeExecutionInfo: initialInfo,
    });

    try {
      await cleanupWorkflowTemp(workflowId);

      // Send original nodes with {{@variable_name}} references intact.
      // The server-side workflow_runner resolves variables with proper type coercion.
      // We pass runtime values as defaultValue so the server uses them.
      const request: WorkflowExecuteRequest = {
        project_id: projectId as string,
        folder_id: project.folder_id,
        nodes: workflow.config.nodes,
        edges: workflow.config.edges,
        ...(workflow.config.variables.length > 0 && {
          variables: workflow.config.variables.map((v) => ({
            name: v.name,
            type: v.type,
            defaultValue: variableValues[v.name] ?? v.defaultValue,
          })),
        }),
      };

      const response = await executeWorkflow(workflowId, request);
      setExecState((s) => ({ ...s, jobId: response.job_id }));

      dispatch(setRunningJobIds([...runningJobIdsRef.current, response.job_id]));
      mutateJobs();

      toast.dismiss();
      toast.success(t("workflow_started"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Execution failed";
      setExecState((s) => ({
        ...s,
        isExecuting: false,
        nodeStatuses: {},
        nodeExecutionInfo: {},
      }));
      toast.dismiss();
      toast.error(`${t("workflow_failed")}: ${message}`);
    }
  }, [projectId, project?.folder_id, workflow, workflowId, executableNodes, variableValues, dispatch, mutateJobs, t]);

  // Cancel workflow
  const handleStop = useCallback(async () => {
    if (!execState.jobId) return;

    try {
      await dismissJob(execState.jobId);

      setExecState((s) => {
        const newStatuses = { ...s.nodeStatuses };
        Object.entries(newStatuses).forEach(([nodeId, status]) => {
          if (status === "running" || status === "pending") {
            newStatuses[nodeId] = "failed";
          }
        });
        return {
          ...s,
          isExecuting: false,
          nodeStatuses: newStatuses,
        };
      });

      dispatch(setRunningJobIds(runningJobIdsRef.current.filter((id) => id !== execState.jobId)));

      toast.dismiss();
      toast.warning(t("workflow_cancelled"));
    } catch (error) {
      console.error("Failed to cancel workflow:", error);
      toast.error(t("workflow_cancel_failed"));
    }
  }, [execState.jobId, dispatch, t]);

  // Reset state
  const handleReset = useCallback(() => {
    // Reset variable values to defaults
    if (workflow?.config?.variables) {
      const defaults: Record<string, string | number> = {};
      for (const variable of workflow.config.variables) {
        defaults[variable.name] = variable.defaultValue ?? (variable.type === "number" ? 0 : "");
      }
      setVariableValues(defaults);
    }
    // Clear execution state
    setExecState({
      isExecuting: false,
      jobId: null,
      nodeStatuses: {},
      nodeExecutionInfo: {},
    });
  }, [workflow]);

  // Job status polling — watch for status changes
  useEffect(() => {
    if (!execState.jobId || !jobs?.jobs) return;

    const job = jobs.jobs.find((j) => j.jobID === execState.jobId);
    if (!job) return;

    if (job.status === "running" || job.status === "accepted") {
      if (job.node_status) {
        setExecState((prev) => {
          const newStatuses = { ...prev.nodeStatuses };
          const newInfo = { ...prev.nodeExecutionInfo };

          Object.entries(job.node_status!).forEach(([nodeId, statusData]) => {
            if (newStatuses[nodeId] !== undefined) {
              if (typeof statusData === "string") {
                newStatuses[nodeId] = statusData as NodeExecutionStatus;
                newInfo[nodeId] = { status: statusData as NodeExecutionStatus };
              } else {
                newStatuses[nodeId] = statusData.status;
                newInfo[nodeId] = {
                  status: statusData.status,
                  startedAt: statusData.started_at,
                  durationMs: statusData.duration_ms,
                };
              }
            }
          });

          return { ...prev, nodeStatuses: newStatuses, nodeExecutionInfo: newInfo };
        });
      }
    }

    if (job.status === "successful") {
      if (processedJobIdsRef.current.has(job.jobID)) return;
      processedJobIdsRef.current.add(job.jobID);

      const results = job.result?.node_results as
        | Record<string, { duration_ms?: number; status?: string }>
        | undefined;
      const resolveStatus = (nodeId: string): NodeExecutionStatus =>
        (results?.[nodeId]?.status === "skipped" ? "skipped" : "completed") as NodeExecutionStatus;
      const finalInfo: Record<string, NodeExecutionInfo> = {};
      if (results) {
        Object.entries(results).forEach(([nodeId, result]) => {
          finalInfo[nodeId] = { status: resolveStatus(nodeId), durationMs: result.duration_ms };
        });
      }

      setExecState((s) => ({
        ...s,
        isExecuting: false,
        jobId: null,
        nodeStatuses: Object.fromEntries(
          Object.entries(s.nodeStatuses).map(([id]) => [id, resolveStatus(id)])
        ),
        nodeExecutionInfo: finalInfo,
      }));

      dispatch(setRunningJobIds(runningJobIdsRef.current.filter((id) => id !== execState.jobId)));
      // The workflow editor in another tab may be watching this run too; only one tab says so
      void claimJobAnnouncement(job.jobID).then((claimed) => {
        if (!claimed) return;
        toast.dismiss();
        toast.success(t("workflow_completed"));
      });
    } else if (job.status === "failed") {
      if (processedJobIdsRef.current.has(job.jobID)) return;
      processedJobIdsRef.current.add(job.jobID);

      setExecState((s) => {
        const newStatuses = { ...s.nodeStatuses };
        for (const [nodeId, status] of Object.entries(newStatuses)) {
          if (status === "running" || status === "pending") {
            newStatuses[nodeId] = "failed";
          }
        }

        return {
          ...s,
          isExecuting: false,
          jobId: null,
          nodeStatuses: newStatuses,
        };
      });

      dispatch(setRunningJobIds(runningJobIdsRef.current.filter((id) => id !== execState.jobId)));
      void claimJobAnnouncement(job.jobID).then((claimed) => {
        if (!claimed) return;
        toast.dismiss();
        toast.error(`${t("workflow_failed")}: ${job.message || "Unknown error"}`);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, execState.jobId, dispatch, t]);

  // Loading state
  if (isLoading || !workflow) {
    return (
      <Container
        header={<ToolsHeader onBack={onBack} title="" />}
        close={onClose}
        body={
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress />
          </Box>
        }
      />
    );
  }

  const variables = workflow.config.variables || [];
  const hasProgress = Object.keys(execState.nodeStatuses).length > 0;
  const completedCount = Object.values(execState.nodeStatuses).filter((s) => s === "completed").length;

  return (
    <Container
      disablePadding={false}
      header={<ToolsHeader onBack={onBack} title={workflow.name} />}
      close={onClose}
      body={
        <Box sx={{ display: "flex", flexDirection: "column" }}>
          {/* Description */}
          {workflow.description && (
            <Typography
              variant="body2"
              sx={{ fontStyle: "italic", mb: theme.spacing(4) }}
              color="text.secondary">
              {workflow.description}
            </Typography>
          )}

          {/* Empty state when no variables and no progress */}
          {variables.length === 0 && !hasProgress && (
            <Stack alignItems="center" spacing={1} sx={{ py: 4 }}>
              <Icon iconName={ICON_NAME.VARIABLE} fontSize="small" htmlColor={theme.palette.text.secondary} />
              <Typography variant="body2" color="text.secondary" textAlign="center">
                {t("workflow_no_variables")}
              </Typography>
            </Stack>
          )}

          {/* Variables Section */}
          {variables.length > 0 && (
            <Box>
              <SectionHeader
                label={t("workflow_variables")}
                icon={ICON_NAME.VARIABLE}
                active={true}
                alwaysActive={true}
                disableAdvanceOptions={true}
              />
              <SectionOptions
                active={true}
                baseOptions={
                  <Stack spacing={2}>
                    {variables
                      .sort((a, b) => a.order - b.order)
                      .map((variable) => (
                        <Stack key={variable.id}>
                          <FormLabelHelper
                            label={variable.name}
                            color="inherit"
                          />
                          <TextField
                            size="small"
                            type={variable.type === "number" ? "number" : "text"}
                            value={variableValues[variable.name] ?? ""}
                            onChange={(e) => {
                              const val =
                                variable.type === "number"
                                  ? e.target.value === ""
                                    ? ""
                                    : Number(e.target.value)
                                  : e.target.value;
                              setVariableValues((prev) => ({ ...prev, [variable.name]: val }));
                            }}
                            disabled={execState.isExecuting}
                            fullWidth
                          />
                        </Stack>
                      ))}
                  </Stack>
                }
              />
            </Box>
          )}

          {/* Progress Section */}
          {hasProgress && (
            <Box>
              <SectionHeader
                label={`${t("workflow_progress")} (${completedCount}/${executableNodes.length})`}
                icon={ICON_NAME.CHART}
                active={true}
                alwaysActive={true}
                disableAdvanceOptions={true}
              />
              <SectionOptions
                active={true}
                baseOptions={
                  <Stack spacing={1}>
                    {executableNodes.map((node) => {
                      const status = execState.nodeStatuses[node.id];
                      const info = execState.nodeExecutionInfo[node.id];
                      const label =
                        node.data.type === "tool"
                          ? t(node.data.processId, { defaultValue: node.data.label })
                          : node.data.type === "export"
                            ? t("export_dataset")
                            : node.id;

                      return (
                        <Stack
                          key={node.id}
                          direction="row"
                          justifyContent="space-between"
                          alignItems="center"
                          sx={{ py: 0.5 }}>
                          <Typography
                            variant="body2"
                            sx={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              flex: 1,
                              mr: 1,
                            }}>
                            {label}
                          </Typography>
                          <Stack direction="row" spacing={1} alignItems="center">
                            {status === "completed" && info?.durationMs && (
                              <Typography variant="caption" color="text.secondary">
                                {formatDuration(info.durationMs)}
                              </Typography>
                            )}
                            <Chip
                              label={t(status || "idle")}
                              size="small"
                              color={
                                status === "completed"
                                  ? "primary"
                                  : status === "failed"
                                    ? "error"
                                    : status === "running"
                                      ? "warning"
                                      : "default"
                              }
                              variant={status ? "filled" : "outlined"}
                              sx={{ minWidth: 70, fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase" }}
                            />
                          </Stack>
                        </Stack>
                      );
                    })}
                  </Stack>
                }
              />
            </Box>
          )}
        </Box>
      }
      action={
        <Stack direction="row" justifyContent="space-between" spacing={2} sx={{ width: "100%" }}>
          {execState.isExecuting ? (
            <Button
              color="error"
              size="small"
              variant="outlined"
              sx={{ flexGrow: "1" }}
              onClick={handleStop}>
              {t("workflow_stop")}
            </Button>
          ) : (
            <Button
              color="error"
              size="small"
              variant="outlined"
              sx={{ flexGrow: "1" }}
              onClick={handleReset}>
              {t("reset")}
            </Button>
          )}
          <LoadingButton
            size="small"
            variant="contained"
            loading={execState.isExecuting}
            sx={{ flexGrow: "1" }}
            onClick={handleRun}
            disabled={!canExecute}>
            <Typography variant="body2" fontWeight="bold" color="inherit">
              {t("run")}
            </Typography>
          </LoadingButton>
        </Stack>
      }
    />
  );
}

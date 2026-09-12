"use client";

import { AccountTree as WorkflowIcon } from "@mui/icons-material";
import {
  Box,
  CircularProgress,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { styled } from "@mui/material/styles";
import React, { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  updateWorkflow,
  useWorkflows,
} from "@/lib/api/workflows";
import type { Project, ProjectLayer, ProjectLayerGroup } from "@/lib/validations/project";
import type { TemplateRead, TemplateUseResult } from "@/lib/validations/template";
import { createEmptyWorkflowConfig } from "@/lib/validations/workflow";
import type { Workflow } from "@/lib/validations/workflow";

import NewMenuButton from "@/components/common/NewMenuButton";
import MoreMenu from "@/components/common/PopperMenu";
import type { PopperMenuItem } from "@/components/common/PopperMenu";
import { SIDE_PANEL_WIDTH, SidePanelContainer } from "@/components/common/SidePanel";
import { AddLayerButton, ProjectLayerTree } from "@/components/map/panels/layer/ProjectLayerTree";
import ConfirmModal from "@/components/modals/Confirm";
import WorkflowRenameModal from "@/components/modals/WorkflowRename";
import SaveTemplateDialog from "@/components/templates/SaveTemplateDialog";
import TemplateBrowser from "@/components/templates/TemplateBrowser";
import UseTemplateFlow from "@/components/templates/UseTemplateFlow";
import ReplaceDatasetsDialog from "@/components/workflows/dialogs/ReplaceDatasetsDialog";

const PanelContainer = styled(SidePanelContainer)(({ theme }) => ({
  width: SIDE_PANEL_WIDTH,
  minWidth: SIDE_PANEL_WIDTH,
  height: "100%",
  maxHeight: "100%",
  boxShadow: "none",
  borderRight: `1px solid ${theme.palette.divider}`,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  position: "relative",
  zIndex: 1,
}));

interface WorkflowsConfigPanelProps {
  project?: Project;
  projectLayers?: ProjectLayer[];
  projectLayerGroups?: ProjectLayerGroup[];
  selectedWorkflow: Workflow | null;
  onSelectWorkflow: (workflow: Workflow | null) => void;
  /** Callback for when a layer is dragged (for workflow canvas integration) */
  onLayerDragStart?: (event: React.DragEvent, layer: ProjectLayer) => void;
}

const WorkflowsConfigPanel: React.FC<WorkflowsConfigPanelProps> = ({
  project,
  projectLayers = [],
  projectLayerGroups = [],
  selectedWorkflow,
  onSelectWorkflow,
  onLayerDragStart,
}) => {
  const { t } = useTranslation("common");

  // Fetch workflows from API
  const { workflows, isLoading, mutate } = useWorkflows(project?.id);

  // Local state
  // The store is the single source of truth for which workflow is open — the
  // map page's `?workflow=` intent, the layout and this list all write it
  // through `onSelectWorkflow`, and the list highlights what it reads back.
  // A workflow this panel just created is selected once the list carries it.
  const selectedWorkflowId = selectedWorkflow?.id ?? null;
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Modal states
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [actionWorkflowId, setActionWorkflowId] = useState<string | null>(null);
  const [actionWorkflowName, setActionWorkflowName] = useState<string>("");

  // Template entry points (T7/T8): "Add workflow"'s split arrow menu opens the
  // browser, whose pick hands off to UseTemplateFlow; the kebab's "Save as
  // template" opens SaveTemplateDialog for the clicked workflow.
  const [templateBrowserOpen, setTemplateBrowserOpen] = useState(false);
  const [templateForFlow, setTemplateForFlow] = useState<TemplateRead | null>(null);
  const [templateSaveWorkflow, setTemplateSaveWorkflow] = useState<Workflow | null>(null);
  // The kebab's "Replace datasets…" works on the store's nodes, so the
  // clicked workflow is opened first and the dialog follows once it is the
  // selected one.
  const [replaceDatasetsWorkflow, setReplaceDatasetsWorkflow] = useState<Workflow | null>(null);
  const replaceDatasetsOpen =
    replaceDatasetsWorkflow !== null && replaceDatasetsWorkflow.id === selectedWorkflowId;

  useEffect(() => {
    if (!workflows) return;
    if (pendingSelectId) {
      const created = workflows.find((w) => w.id === pendingSelectId);
      if (created) {
        setPendingSelectId(null);
        onSelectWorkflow(created);
      }
      return;
    }
    // Nothing open anywhere: the first workflow opens.
    if (workflows.length > 0 && !selectedWorkflowId) {
      onSelectWorkflow(workflows[0]);
    }
  }, [workflows, pendingSelectId, selectedWorkflowId, onSelectWorkflow]);

  // Handle create new workflow
  const handleCreateWorkflow = useCallback(async () => {
    if (!project?.id) return;

    setIsCreating(true);
    try {
      const newWorkflow = await createWorkflow(project.id, {
        name: `${t("workflow")} ${(workflows?.length || 0) + 1}`,
        description: null,
        is_default: false,
        config: createEmptyWorkflowConfig(),
      });

      await mutate();
      setPendingSelectId(newWorkflow.id);
    } catch (error) {
      console.error("Failed to create workflow:", error);
    } finally {
      setIsCreating(false);
    }
  }, [project?.id, t, workflows?.length, mutate]);

  // A template picked from the browser hands off to UseTemplateFlow, which
  // inserts the workflow into this project and marks unresolved inputs on
  // the canvas (T7).
  const handleUseTemplate = useCallback((template: TemplateRead) => {
    setTemplateBrowserOpen(false);
    setTemplateForFlow(template);
  }, []);

  const handleTemplateFlowDone = useCallback(
    async (result: TemplateUseResult) => {
      setTemplateForFlow(null);
      await mutate();
      if (result.workflow_id) setPendingSelectId(result.workflow_id);
    },
    [mutate]
  );

  // Handle duplicate workflow
  const handleDuplicateWorkflow = useCallback(
    async (workflowId: string) => {
      if (!project?.id) return;

      try {
        const duplicated = await duplicateWorkflow(project.id, workflowId);
        await mutate();
        setPendingSelectId(duplicated.id);
      } catch (error) {
        console.error("Failed to duplicate workflow:", error);
      }
    },
    [project?.id, mutate]
  );

  // Handle delete workflow
  const handleDeleteWorkflow = useCallback(async () => {
    if (!project?.id || !actionWorkflowId) return;

    try {
      await deleteWorkflow(project.id, actionWorkflowId);
      await mutate();

      // If deleted workflow was selected, clear selection
      if (selectedWorkflowId === actionWorkflowId) {
        onSelectWorkflow(null);
      }
    } catch (error) {
      console.error("Failed to delete workflow:", error);
    } finally {
      setDeleteModalOpen(false);
      setActionWorkflowId(null);
    }
  }, [project?.id, actionWorkflowId, selectedWorkflowId, mutate, onSelectWorkflow]);

  // Handle rename workflow
  const handleRenameWorkflow = useCallback(
    async (newName: string) => {
      if (!project?.id || !actionWorkflowId) return;

      const workflow = workflows?.find((w) => w.id === actionWorkflowId);
      if (!workflow) return;

      try {
        await updateWorkflow(project.id, actionWorkflowId, {
          name: newName,
          config: workflow.config,
        });
        await mutate();
      } catch (error) {
        console.error("Failed to rename workflow:", error);
      }
    },
    [project?.id, actionWorkflowId, workflows, mutate]
  );

  // Context menu items for workflow
  const getWorkflowMenuItems = useCallback(
    (workflow: Workflow): PopperMenuItem[] => [
      {
        id: "rename",
        label: t("rename"),
        icon: ICON_NAME.EDIT,
        onClick: () => {
          setActionWorkflowId(workflow.id);
          setActionWorkflowName(workflow.name);
          setRenameModalOpen(true);
        },
      },
      {
        id: "duplicate",
        label: t("duplicate"),
        icon: ICON_NAME.COPY,
        onClick: () => handleDuplicateWorkflow(workflow.id),
      },
      {
        id: "replace_datasets",
        label: t("replace_datasets"),
        icon: ICON_NAME.REFRESH,
        onClick: () => {
          if (workflow.id !== selectedWorkflowId) onSelectWorkflow(workflow);
          setReplaceDatasetsWorkflow(workflow);
        },
      },
      {
        id: "save_as_template",
        label: t("save_as_template"),
        icon: ICON_NAME.SAVE,
        onClick: () => setTemplateSaveWorkflow(workflow),
      },
      {
        id: "delete",
        label: t("delete"),
        icon: ICON_NAME.TRASH,
        color: "error.main",
        onClick: () => {
          setActionWorkflowId(workflow.id);
          setActionWorkflowName(workflow.name);
          setDeleteModalOpen(true);
        },
      },
    ],
    [t, handleDuplicateWorkflow, selectedWorkflowId, onSelectWorkflow]
  );

  return (
    <PanelContainer>
      {/* Workflows Section */}
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          flex: "0 0 auto",
          maxHeight: "40%",
        }}>
        {/* Workflows Header */}
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ p: 2, pb: 0, mb: 2, flexShrink: 0 }}>
          <Typography variant="subtitle1" fontWeight={600}>
            {t("workflows")}
          </Typography>
          <NewMenuButton
            disabled={!project?.id}
            loading={isCreating}
            items={[
              {
                key: "blank",
                label: t("from_scratch"),
                icon: ICON_NAME.WORKFLOW,
                onSelect: handleCreateWorkflow,
              },
              {
                key: "template",
                label: t("from_template"),
                icon: ICON_NAME.CLONE,
                onSelect: () => setTemplateBrowserOpen(true),
              },
            ]}
          />
        </Stack>

        {/* Workflows List - Scrollable */}
        <Box
          sx={{
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
            px: 2,
            "&::-webkit-scrollbar": {
              width: "6px",
            },
            "&::-webkit-scrollbar-thumb": {
              background: "#2836484D",
              borderRadius: "3px",
              "&:hover": {
                background: "#28364880",
              },
            },
          }}>
          {isLoading ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={24} />
            </Box>
          ) : (
            <List dense sx={{ mx: -2 }}>
              {workflows?.map((workflow) => (
                <ListItem
                  key={workflow.id}
                  disablePadding
                  secondaryAction={
                    <MoreMenu
                      menuItems={getWorkflowMenuItems(workflow)}
                      disablePortal={false}
                      menuButton={
                        <Tooltip title={t("more_options")} placement="top">
                          <IconButton edge="end" size="small" aria-label={t("more_options")}>
                            <Icon iconName={ICON_NAME.MORE_VERT} style={{ fontSize: "15px" }} />
                          </IconButton>
                        </Tooltip>
                      }
                    />
                  }>
                  <ListItemButton
                    selected={selectedWorkflowId === workflow.id}
                    onClick={() => onSelectWorkflow(workflow)}>
                    <ListItemIcon sx={{ minWidth: 36 }}>
                      <WorkflowIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText primary={workflow.name} primaryTypographyProps={{ fontSize: "0.875rem" }} />
                  </ListItemButton>
                </ListItem>
              ))}
              {(!workflows || workflows.length === 0) && (
                <Box sx={{ py: 2, px: 2, textAlign: "center" }}>
                  <Typography variant="body2" color="text.secondary">
                    {t("no_workflows_yet")}
                  </Typography>
                </Box>
              )}
            </List>
          )}
        </Box>
      </Box>

      <Divider />

      {/* Layers Section - Read-only view */}
      <Box sx={{ display: "flex", flexDirection: "column", overflow: "hidden", flex: 1, minHeight: 0 }}>
        {/* Layers Header */}
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ p: 2, pb: 0, mb: 1, flexShrink: 0 }}>
          <Typography variant="subtitle1" fontWeight={600}>
            {t("layers")}
          </Typography>
          {project?.id && <AddLayerButton projectId={project.id} />}
        </Stack>

        {/* Layers Tree - Read-only */}
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            "&::-webkit-scrollbar": {
              width: "6px",
            },
            "&::-webkit-scrollbar-thumb": {
              background: "#2836484D",
              borderRadius: "3px",
              "&:hover": {
                background: "#28364880",
              },
            },
          }}>
          {project?.id && (
            <ProjectLayerTree
              projectId={project.id}
              projectLayers={projectLayers}
              projectLayerGroups={projectLayerGroups}
              viewMode="view"
              hideActions
              isLoading={false}
              onLayerDragStart={onLayerDragStart}
            />
          )}
        </Box>
      </Box>

      {/* Delete Confirmation Modal */}
      {deleteModalOpen && (
        <ConfirmModal
          open={deleteModalOpen}
          title={t("delete_workflow")}
          body={
            <Trans
              i18nKey="common:delete_workflow_confirmation"
              values={{ name: actionWorkflowName }}
              components={{ b: <b /> }}
            />
          }
          onClose={() => {
            setDeleteModalOpen(false);
            setActionWorkflowId(null);
            setActionWorkflowName("");
          }}
          closeText={t("cancel")}
          confirmText={t("delete")}
          onConfirm={handleDeleteWorkflow}
        />
      )}

      {/* Rename Modal */}
      <WorkflowRenameModal
        open={renameModalOpen}
        workflowName={actionWorkflowName}
        onClose={() => {
          setRenameModalOpen(false);
          setActionWorkflowId(null);
          setActionWorkflowName("");
        }}
        onRename={handleRenameWorkflow}
      />

      {/* Template Browser — "Add workflow"'s split arrow menu. Mounted only
       * while open, so its template/space/pin requests don't run on every
       * panel mount. */}
      {templateBrowserOpen && (
        <TemplateBrowser
          mode="dialog"
          open
          onClose={() => setTemplateBrowserOpen(false)}
          lockedKind="workflow"
          onUse={handleUseTemplate}
        />
      )}

      {/* Inserts the picked template's workflow into this project */}
      {templateForFlow && project?.id && (
        <UseTemplateFlow
          template={templateForFlow}
          context={{ kind: "in_project", projectId: project.id }}
          onClose={() => setTemplateForFlow(null)}
          onDone={handleTemplateFlowDone}
        />
      )}

      {/* Kebab "Replace datasets…" — reads the open workflow's nodes */}
      {replaceDatasetsOpen && project?.id && (
        <ReplaceDatasetsDialog
          projectId={project.id}
          workflowName={replaceDatasetsWorkflow.name}
          onClose={() => setReplaceDatasetsWorkflow(null)}
        />
      )}

      {/* Kebab "Save as template" */}
      {templateSaveWorkflow && project?.id && (
        <SaveTemplateDialog
          source={{ kind: "workflow", project_id: project.id, workflow_id: templateSaveWorkflow.id }}
          defaultName={templateSaveWorkflow.name}
          onClose={() => setTemplateSaveWorkflow(null)}
          onSaved={(savedTemplate) => {
            setTemplateSaveWorkflow(null);
            toast.success(t("template_saved_as", { name: savedTemplate.name }));
          }}
        />
      )}
    </PanelContainer>
  );
};

export default WorkflowsConfigPanel;

"use client";

import WorkflowIcon from "@mui/icons-material/AccountTree";
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

import { ChangedElsewhereError } from "@/lib/api/changedElsewhere";
import { deleteWorkflow, duplicateWorkflow, useWorkflows } from "@/lib/api/workflows";
import type { Project, ProjectLayer, ProjectLayerGroup } from "@/lib/validations/project";
import type { Workflow } from "@/lib/validations/workflow";

import type { WorkflowCreation } from "@/hooks/workflows/useWorkflowCreation";

import NewMenuButton from "@/components/common/NewMenuButton";
import MoreMenu from "@/components/common/PopperMenu";
import type { PopperMenuItem } from "@/components/common/PopperMenu";
import { SIDE_PANEL_WIDTH, SidePanelContainer } from "@/components/common/SidePanel";
import { AddLayerButton, ProjectLayerTree } from "@/components/map/panels/layer/ProjectLayerTree";
import ConfirmModal from "@/components/modals/Confirm";
import WorkflowRenameModal from "@/components/modals/WorkflowRename";
import SaveTemplateDialog from "@/components/templates/SaveTemplateDialog";
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
  /** Renames a workflow in turn with the editor's saves
   * (`useWorkflowAutosave().rename`): a rename moves it to a new revision. */
  onRenameWorkflow: (workflowId: string, name: string) => Promise<void>;
  /** Callback for when a layer is dragged (for workflow canvas integration) */
  onLayerDragStart?: (event: React.DragEvent, layer: ProjectLayer) => void;
  /** New workflow from scratch or from a template, shared with the card a
   * project without workflows shows (`useWorkflowCreation`). */
  creation: WorkflowCreation;
}

const WorkflowsConfigPanel: React.FC<WorkflowsConfigPanelProps> = ({
  project,
  projectLayers = [],
  projectLayerGroups = [],
  selectedWorkflow,
  onSelectWorkflow,
  onRenameWorkflow,
  onLayerDragStart,
  creation,
}) => {
  const { t } = useTranslation("common");
  const { selectWhenListed, pendingSelectId } = creation;

  // Fetch workflows from API
  const { workflows, isLoading, mutate } = useWorkflows(project?.id);

  // Local state
  // The store is the single source of truth for which workflow is open — the
  // map page's `?workflow=` intent, the layout and this list all write it
  // through `onSelectWorkflow`, and the list highlights what it reads back.
  // A workflow just created is selected by `creation` once the list carries it.
  const selectedWorkflowId = selectedWorkflow?.id ?? null;

  // Modal states
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [actionWorkflowId, setActionWorkflowId] = useState<string | null>(null);
  const [actionWorkflowName, setActionWorkflowName] = useState<string>("");

  // The kebab's "Save as template" opens SaveTemplateDialog for the clicked
  // workflow; "From template" in the New menu goes through `creation`.
  const [templateSaveWorkflow, setTemplateSaveWorkflow] = useState<Workflow | null>(null);
  // The kebab's "Replace datasets…" works on the store's nodes, so the
  // clicked workflow is opened first and the dialog follows once it is the
  // selected one.
  const [replaceDatasetsWorkflow, setReplaceDatasetsWorkflow] = useState<Workflow | null>(null);
  const replaceDatasetsOpen =
    replaceDatasetsWorkflow !== null && replaceDatasetsWorkflow.id === selectedWorkflowId;

  // Nothing open anywhere: the first workflow opens, unless a workflow just
  // created is about to.
  useEffect(() => {
    if (!workflows || pendingSelectId) return;
    if (workflows.length > 0 && !selectedWorkflowId) {
      onSelectWorkflow(workflows[0]);
    }
  }, [workflows, pendingSelectId, selectedWorkflowId, onSelectWorkflow]);

  // Handle duplicate workflow
  const handleDuplicateWorkflow = useCallback(
    async (workflowId: string) => {
      if (!project?.id) return;

      try {
        const duplicated = await duplicateWorkflow(project.id, workflowId);
        await mutate();
        selectWhenListed(duplicated.id);
      } catch (error) {
        console.error("Failed to duplicate workflow:", error);
      }
    },
    [project?.id, mutate, selectWhenListed]
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

  // Handle rename workflow. Only the name is sent and core keeps the stored
  // config: the list's copy may be older than the last autosave, and core
  // refuses a damaged config, which would make such a workflow unrenamable.
  const handleRenameWorkflow = useCallback(
    async (newName: string) => {
      if (!project?.id || !actionWorkflowId) return;

      try {
        await onRenameWorkflow(actionWorkflowId, newName);
        await mutate();
      } catch (error) {
        console.error("Failed to rename workflow:", error);
        // Refused on the revision the list read: the list is read again, so
        // the next rename names the stored workflow's revision.
        if (error instanceof ChangedElsewhereError) {
          toast.error(t("workflow_changed_elsewhere"));
          void mutate();
        }
      }
    },
    [project?.id, actionWorkflowId, onRenameWorkflow, mutate, t]
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
            disabled={!creation.canCreate}
            loading={creation.isCreating}
            items={[
              {
                key: "blank",
                label: t("from_scratch"),
                icon: ICON_NAME.WORKFLOW,
                onSelect: () => void creation.createFromScratch(),
              },
              {
                key: "template",
                label: t("from_template"),
                icon: ICON_NAME.CLONE,
                onSelect: creation.openTemplateBrowser,
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

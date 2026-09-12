"use client";

import { Box, Button, ButtonBase, Chip, Skeleton, Typography, alpha, useTheme } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { homeFolderOf, spaceDisplayName } from "@/lib/utils/content";
import { stripMarkdown } from "@/lib/utils/templates";
import type {
  TemplateInput,
  TemplatePayloadKind,
  TemplateRead,
  TemplateUseResult,
} from "@/lib/validations/template";

import {
  type UseTemplateContext,
  type UseTemplateTarget,
  useUseTemplate,
} from "@/hooks/templates/useUseTemplate";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import FolderBrowser from "@/components/dashboard/common/FolderBrowser";
import Selector from "@/components/map/panels/common/Selector";
import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
import { DialogGroupLabel } from "@/components/modals/content/ContentDialogChrome";
import TemplateProjectPicker from "@/components/templates/TemplateProjectPicker";

export interface UseTemplateFlowProps {
  template: TemplateRead;
  /** Panels already sitting inside a project pass `in_project`; Home,
   * Content and Catalog pass `outside_project`. */
  context: UseTemplateContext;
  onClose: () => void;
  /** The caller navigates — this component only reports what got created.
   * Not called on a failed apply (the dialog stays open with the error). */
  onDone: (result: TemplateUseResult) => void;
}

const PAYLOAD_KIND_ICON: Record<TemplatePayloadKind, ICON_NAME> = {
  workflow: ICON_NAME.WORKFLOW,
  layout: ICON_NAME.REPORT,
  project: ICON_NAME.MAP,
};

const GEOMETRY_ICON: Record<string, ICON_NAME> = {
  point: ICON_NAME.POINT_FEATURE,
  line: ICON_NAME.LINE_FEATURE,
  polygon: ICON_NAME.POLYGON_FEATURE,
};

const geometryIconFor = (geometryType: string | null): ICON_NAME =>
  (geometryType && GEOMETRY_ICON[geometryType]) || ICON_NAME.TABLE;

/** "Feature · Point" — the same second line the save dialog's inputs table
 * shows for a declared input; empty when the input declares no type. */
const inputTypeLabel = (input: TemplateInput, t: (key: string) => string): string => {
  if (!input.layer_type) return input.geometry_type ? t(input.geometry_type) : "";
  const kind = t(input.layer_type);
  return input.geometry_type ? `${kind} · ${t(input.geometry_type)}` : kind;
};

/**
 * The "Use template" flow: (1) outside a project, where the payload goes —
 * one of the caller's existing projects, or a fresh one with its name,
 * space and folder; (2) a row per input — a shipped dataset that can be
 * swapped for one of the target project's layers, or an `ask` slot to bind
 * or leave for later; (3) apply; (4) hand the result to the caller. The
 * caller owns navigation — it builds the URL from `templateResultHref`
 * (`useUseTemplate`) — so this component stays a plain dialog with no
 * router dependency of its own. Either step is skipped when it doesn't
 * apply — `in_project` never asks for a location, and a template without
 * inputs has nothing to show on the second step.
 */
const UseTemplateFlow = ({ template, context, onClose, onDone }: UseTemplateFlowProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const flow = useUseTemplate(template, context);
  const [stepIndex, setStepIndex] = useState(0);

  const currentStep = flow.steps[stepIndex] ?? null;
  const isLastStep = stepIndex >= flow.steps.length - 1;
  const canAdvance = currentStep !== "location" || flow.locationValid;
  // The final button says what happens: a new project is created, an
  // existing one gets the payload added.
  const finalLabel = flow.selectedProjectId ? t("add_to_project") : t("create");

  const targetSegment = (id: UseTemplateTarget, icon: ICON_NAME, label: string) => {
    const on = flow.target === id;
    return (
      <ButtonBase
        key={id}
        onClick={() => flow.setTarget(id)}
        disabled={flow.busy}
        aria-pressed={on}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          height: 32,
          px: "13px",
          borderRadius: "999px",
          backgroundColor: on ? alpha(theme.palette.primary.main, 0.12) : "transparent",
          color: on ? theme.palette.primary.main : theme.palette.text.secondary,
          fontSize: 13.5,
          fontWeight: 600,
        }}>
        <Icon iconName={icon} style={{ fontSize: 15, color: "inherit" }} />
        {label}
      </ButtonBase>
    );
  };

  const handlePrimary = async () => {
    if (!isLastStep) {
      setStepIndex((index) => index + 1);
      return;
    }
    const result = await flow.apply();
    if (!result) return;
    toast.success(t("template_created_in", { name: template.name }));
    if (result.unresolved_inputs.length > 0) {
      toast.info(t("unresolved_input_count", { count: result.unresolved_inputs.length }));
    }
    onDone(result);
  };

  // A step the caller can walk back out of keeps its Back button at the left
  // end of the action row.
  const footer = (
    <AppDialogFooter
      onCancel={onClose}
      cancelDisabled={flow.busy}
      primaryLabel={isLastStep ? finalLabel : t("next_step")}
      onPrimary={() => void handlePrimary()}
      primaryDisabled={!canAdvance}
      primaryLoading={flow.busy}
      extra={
        stepIndex > 0 ? (
          <Button variant="text" disabled={flow.busy} onClick={() => setStepIndex((index) => index - 1)}>
            <Typography variant="body2" fontWeight="bold">
              {t("back")}
            </Typography>
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <AppDialog
      open
      onClose={flow.busy ? () => undefined : onClose}
      icon={PAYLOAD_KIND_ICON[template.payload_kind]}
      title={t("use_template")}
      subtitle={template.name}
      maxWidth={480}
      closeLabel={t("cancel")}
      // Always opened from a preview or browser dialog that leaves in the
      // same click, so this one appears in its place without a second fade.
      transitionDuration={{ enter: 0, exit: theme.transitions.duration.leavingScreen }}
      bodySx={{ padding: "22px", maxHeight: "60vh" }}
      footer={footer}>
      <>
        {flow.steps.length > 1 && (
          <Box
            component="ol"
            aria-label={t("steps")}
            sx={{ display: "flex", gap: "18px", listStyle: "none", m: 0, p: 0, mb: "16px" }}>
            {flow.steps.map((step, index) => {
              const current = index === stepIndex;
              const done = index < stepIndex;
              return (
                <Box
                  component="li"
                  key={step}
                  aria-current={current ? "step" : undefined}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: current ? theme.palette.text.primary : theme.palette.text.disabled,
                  }}>
                  <Box
                    aria-hidden
                    sx={{
                      width: 20,
                      height: 20,
                      borderRadius: "50%",
                      display: "grid",
                      placeItems: "center",
                      fontSize: 11,
                      border: `1.5px solid ${current || done ? theme.palette.primary.main : theme.palette.divider}`,
                      backgroundColor: current
                        ? theme.palette.primary.main
                        : done
                          ? alpha(theme.palette.primary.main, 0.14)
                          : "transparent",
                      color: current
                        ? theme.palette.primary.contrastText
                        : done
                          ? theme.palette.primary.main
                          : "inherit",
                    }}>
                    {index + 1}
                  </Box>
                  {t(step === "location" ? "where" : "inputs")}
                </Box>
              );
            })}
          </Box>
        )}

        {currentStep === "location" && flow.targetPending && (
          <Box role="status" aria-label={t("loading")} sx={{ display: "grid", gap: "10px" }}>
            <Skeleton variant="rounded" width={300} height={40} sx={{ borderRadius: "999px", mb: "4px" }} />
            <Skeleton variant="rounded" height={38} sx={{ borderRadius: "999px" }} />
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} variant="rounded" height={46} sx={{ borderRadius: "10px" }} />
            ))}
          </Box>
        )}

        {currentStep === "location" && !flow.targetPending && flow.canPickProject && (
          // The same pill the Content page's Grid/List switch uses
          // (LayoutToggle): two segments, the active one filled with the
          // primary tint.
          <Box
            role="group"
            aria-label={t("add_to_a_project") + " / " + t("create_a_new_project")}
            sx={{
              display: "inline-flex",
              gap: "2px",
              padding: "3px",
              width: "fit-content",
              mb: "14px",
              borderRadius: "999px",
              border: `1px solid ${theme.palette.divider}`,
              backgroundColor: theme.palette.background.paper,
            }}>
            {targetSegment("existing", ICON_NAME.MAP, t("add_to_a_project"))}
            {targetSegment("new", ICON_NAME.PLUS, t("create_a_new_project"))}
          </Box>
        )}

        {currentStep === "location" && !flow.targetPending && flow.target === "existing" && (
          <TemplateProjectPicker
            projects={flow.projects}
            loading={flow.projectsLoading}
            search={flow.projectSearch}
            onSearchChange={flow.setProjectSearch}
            selectedId={flow.selectedProjectId}
            onSelect={flow.setSelectedProjectId}
            spaces={flow.spaces}
            disabled={flow.busy}
          />
        )}

        {currentStep === "location" && !flow.targetPending && flow.target === "new" && (
          <>
            {flow.canPickProject === false &&
              context.kind === "outside_project" &&
              template.payload_kind !== "project" && (
                <Typography sx={{ mb: "12px", fontSize: 12.5, color: theme.palette.text.secondary }}>
                  {t("no_projects_yet_template")}
                </Typography>
              )}
            <DialogGroupLabel first>{t("location")}</DialogGroupLabel>
            {/* TextFieldInput leaves its unfocused label colour to `inherit`,
                so the box around it is what sets the house secondary. */}
            <Box sx={{ color: "text.secondary" }}>
              <TextFieldInput
                label={t("name")}
                value={flow.name}
                onChange={(value) => flow.setName(value)}
                inputProps={{ "aria-label": t("name") }}
              />
            </Box>
            <Box sx={{ mt: "14px" }}>
              <Selector
                label={t("destination")}
                items={flow.spaces.map((space) => ({
                  value: space.id,
                  label: spaceDisplayName(space, t),
                }))}
                selectedItems={
                  flow.selectedSpace
                    ? { value: flow.selectedSpace.id, label: spaceDisplayName(flow.selectedSpace, t) }
                    : undefined
                }
                setSelectedItems={(items) => {
                  const picked = Array.isArray(items) ? items[0] : items;
                  const space = flow.spaces.find((candidate) => candidate.id === picked?.value) ?? null;
                  flow.setSelectedSpace(space);
                }}
              />
            </Box>
            {flow.selectedSpace && (
              <Box sx={{ mt: "14px" }}>
                <FolderBrowser
                  space={flow.selectedSpace}
                  folders={flow.folders}
                  homeFolderId={homeFolderOf(flow.folders, flow.selectedSpace.id)?.id ?? null}
                  value={flow.selectedFolder?.id ?? null}
                  onChange={(folderId) =>
                    flow.setSelectedFolder(
                      folderId ? (flow.folders.find((folder) => folder.id === folderId) ?? null) : null
                    )
                  }
                  label={t("folder")}
                  maxHeight={180}
                />
              </Box>
            )}
          </>
        )}

        {currentStep === "bindings" && (
          <>
            <DialogGroupLabel first>
              {t(flow.askInputs.length > 0 ? "pick_a_layer" : "datasets")}
            </DialogGroupLabel>
            <Box
              sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: "10px", overflow: "hidden" }}>
              {[...flow.askInputs, ...flow.shipInputs].map((input, index) => {
                // A locked project layer (no access of the caller's own to the
                // underlying dataset) can't be bound — it carries none of the
                // real style/metadata fields an actual binding needs. A
                // shipped input can be pointed at a project layer too; its
                // own dataset stays the default.
                const candidates = flow.candidatesFor(input).filter((layer) => !layer.locked);
                const bound = candidates.find((layer) => layer.layer_id === flow.bindings[input.key]);
                const defaultLabel = t(input.mode === "ship" ? "ships_with_template" : "decide_later");
                return (
                  <Box
                    key={input.key}
                    data-testid={`template-use-input-${input.key}`}
                    sx={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1fr) auto",
                      gap: "10px",
                      alignItems: "center",
                      padding: "8px 12px",
                      borderTop: index > 0 ? `1px solid ${theme.palette.divider}` : undefined,
                    }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                      <Icon
                        iconName={geometryIconFor(input.geometry_type)}
                        style={{ fontSize: 15, color: theme.palette.text.secondary, flexShrink: 0 }}
                      />
                      <Box sx={{ minWidth: 0 }}>
                        <Typography noWrap sx={{ fontSize: 13, fontWeight: 600 }}>
                          {input.label}
                        </Typography>
                        {inputTypeLabel(input, t) && (
                          <Typography noWrap sx={{ fontSize: 11.5, color: theme.palette.text.secondary }}>
                            {inputTypeLabel(input, t)}
                          </Typography>
                        )}
                      </Box>
                    </Box>
                    {candidates.length === 0 && input.mode === "ship" ? (
                      <Chip
                        label={t("ships_with_template")}
                        size="small"
                        sx={{ height: 20, fontSize: 11, fontWeight: 700 }}
                      />
                    ) : candidates.length > 0 ? (
                      // The house Select the tool panels pick layers with;
                      // the default sits first so a choice can be undone.
                      <Box sx={{ width: 220 }}>
                        <Selector
                          items={[
                            { value: "", label: defaultLabel },
                            ...candidates.map((layer) => ({
                              value: layer.layer_id,
                              label: layer.name,
                              icon: geometryIconFor(layer.feature_layer_geometry_type ?? null),
                            })),
                          ]}
                          selectedItems={
                            bound
                              ? {
                                  value: bound.layer_id,
                                  label: bound.name,
                                  icon: geometryIconFor(bound.feature_layer_geometry_type ?? null),
                                }
                              : undefined
                          }
                          setSelectedItems={(items) => {
                            const picked = Array.isArray(items) ? items[0] : items;
                            const value = picked?.value;
                            flow.setBinding(input.key, typeof value === "string" && value ? value : null);
                          }}
                          placeholder={defaultLabel}
                          enableSearch={candidates.length > 6}
                        />
                      </Box>
                    ) : (
                      // An ask slot with no fitting layer in the target
                      // project: nothing to pick, so the row says why.
                      <Chip
                        label={t("no_matching_layer")}
                        size="small"
                        variant="outlined"
                        sx={{
                          height: 20,
                          fontSize: 11,
                          fontWeight: 700,
                          color: theme.palette.text.secondary,
                        }}
                      />
                    )}
                  </Box>
                );
              })}
            </Box>
            {context.kind === "in_project" &&
              flow.askInputs.some((input) => flow.candidatesFor(input).every((layer) => layer.locked)) && (
                <Typography sx={{ mt: "8px", fontSize: 12, color: theme.palette.text.secondary }}>
                  {t("template_open_slots_hint")}
                </Typography>
              )}
            {flow.askInputs.length > 0 && context.kind !== "in_project" && (
              <Typography sx={{ mt: "8px", fontSize: 12, color: theme.palette.text.secondary }}>
                {flow.selectedProject
                  ? t("template_inputs_from_project", { project: flow.selectedProject.name })
                  : t("template_inputs_new_project")}
              </Typography>
            )}
            {context.kind !== "in_project" && (
              <Typography
                sx={{
                  mt: "14px",
                  padding: "10px 12px",
                  fontSize: 12.5,
                  color: theme.palette.text.secondary,
                  borderRadius: "10px",
                  border: `1px solid ${theme.palette.divider}`,
                  backgroundColor: alpha(theme.palette.text.primary, 0.02),
                }}>
                {flow.selectedProject
                  ? t("template_adds_to_project", { name: template.name, project: flow.selectedProject.name })
                  : t("template_creates_project", {
                      name: template.name,
                      project: flow.name.trim() || template.name,
                      space: spaceDisplayName(flow.selectedSpace ?? undefined, t),
                    })}
              </Typography>
            )}
          </>
        )}

        {currentStep === null && (
          <Typography sx={{ fontSize: 13.5, color: theme.palette.text.secondary }}>
            {template.description ? stripMarkdown(template.description) : template.name}
          </Typography>
        )}

        {flow.error && (
          <Typography role="alert" sx={{ mt: "14px", fontSize: 12.5, color: theme.palette.error.main }}>
            {flow.error}
          </Typography>
        )}
      </>
    </AppDialog>
  );
};

export default UseTemplateFlow;

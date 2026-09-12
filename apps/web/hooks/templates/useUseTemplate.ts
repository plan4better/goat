import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { mutate } from "swr";

import { refreshContentFeed, useContent, useSpaces } from "@/lib/api/content";
import { useFolders } from "@/lib/api/folders";
import { useProjectLayers } from "@/lib/api/projects";
import { applyTemplate, refreshTemplates } from "@/lib/api/templates";
import { USERS_API_BASE_URL } from "@/lib/api/users";
import { homeFolderOf } from "@/lib/utils/content";
import type { ContentItem, Space } from "@/lib/validations/content";
import type { Folder } from "@/lib/validations/folder";
import type { ProjectLayer } from "@/lib/validations/project";
import type {
  TemplateInput,
  TemplateRead,
  TemplateUseRequest,
  TemplateUseResult,
} from "@/lib/validations/template";

/** Where "Use template" was opened from: a panel already sitting inside a
 * project passes `in_project` and the payload is inserted there; Home,
 * Content and Catalog pass `outside_project`, which lets the caller add a
 * workflow or layout to one of their existing projects or create a new
 * one (a project payload always creates one). */
export type UseTemplateContext = { kind: "in_project"; projectId: string } | { kind: "outside_project" };

/** The flow's own steps, in order — `location` exists outside a project,
 * `bindings` when there are inputs to show: a workflow's shipped datasets
 * and any `ask` slot to fill in. Either, both, or neither can apply to a
 * given template and context. */
export type UseTemplateStep = "location" | "bindings";

/** What the location step resolves to: a project the caller already has, or
 * a new one at the chosen folder. */
export type UseTemplateTarget = "existing" | "new";

/** How many projects the picker fetches per search; the list is ordered by
 * last opened, so the ones the caller works in come first. */
const PROJECT_PICKER_PAGE_SIZE = 50;

/** A project the payload can be added to — the caller edits it. */
export const canAddToProject = (project: ContentItem): boolean =>
  project.my_role === "owner" || project.my_role === "editor";

/** `POST /template/{id}/use`'s target, once resolved by this hook's state —
 * exactly one of `project_id`/`target_folder_id`, matching what
 * `crud_template.use` requires. */
const buildRequest = (
  template: TemplateRead,
  projectId: string | null,
  name: string,
  targetFolderId: string | undefined,
  bindings: Record<string, string>
): TemplateUseRequest =>
  projectId
    ? { project_id: projectId, bindings }
    : { target_folder_id: targetFolderId, name: name.trim() || template.name, bindings };

/** Same SWR key `useOnboardingFacts` reads (see `useHomeCreate`) — using a
 * template can complete "Run your first analysis"/"Build a workflow" (T10),
 * so the checklist should not wait for its own poll. */
const revalidateOnboardingFacts = () => mutate(`${USERS_API_BASE_URL}/me/onboarding`);

/**
 * Drives `UseTemplateFlow`'s state machine: the location step's target
 * (an existing project, or a new one with its space/folder/name), the
 * bindings step's per-input layer choice (only a project that already
 * exists has layers to offer — a fresh one's ask inputs can only be left
 * for later), and the final apply call. Steps that don't apply to this
 * template/context (no location needed, no ask inputs) simply aren't part
 * of `steps`; the component reads that to size its step indicator.
 */
export const useUseTemplate = (template: TemplateRead, context: UseTemplateContext) => {
  const { t } = useTranslation("common");
  const { spaces } = useSpaces();
  const { folders } = useFolders({});

  // A project payload is a project: it can only ever start a new one.
  const canPickProject = context.kind === "outside_project" && template.payload_kind !== "project";
  const [projectSearch, setProjectSearch] = useState("");
  const { page: projectPage, isLoading: projectsLoading } = useContent(
    canPickProject
      ? {
          view: "recent",
          types: "project",
          order_by: "last_opened_at",
          search: projectSearch.trim() || undefined,
          size: PROJECT_PICKER_PAGE_SIZE,
        }
      : null
  );
  const projects = useMemo(() => projectPage?.items ?? [], [projectPage]);
  // Whether the caller has any project at all decides the default target
  // and whether the choice is offered; a search that matches nothing must
  // not flip either, so the unfiltered answer is remembered once known.
  const [hasProjects, setHasProjects] = useState<boolean | null>(null);
  const unfilteredTotal = projectSearch.trim() ? null : (projectPage?.total ?? null);
  useEffect(() => {
    if (hasProjects === null && unfilteredTotal !== null) setHasProjects(unfilteredTotal > 0);
  }, [hasProjects, unfilteredTotal]);

  // Until the first page answers, nothing about the location step is known
  // — neither which half to show nor what the button does — so the step
  // waits rather than flashing the new-project form.
  const targetPending = canPickProject && hasProjects === null;

  const [targetOverride, setTargetOverride] = useState<UseTemplateTarget | null>(null);
  const target: UseTemplateTarget = canPickProject && hasProjects ? (targetOverride ?? "existing") : "new";

  const [projectOverride, setProjectOverride] = useState<string | null>(null);
  // The list arrives last-opened first, so its first editable row is the
  // project the caller most likely means. A pick that a search has filtered
  // out of view is not what the button would act on, so it yields to that
  // default until the list shows it again.
  const defaultProjectId = projects.find(canAddToProject)?.id ?? null;
  const visiblePick = projects.some((project) => project.id === projectOverride) ? projectOverride : null;
  const selectedProjectId =
    context.kind === "in_project"
      ? context.projectId
      : target === "existing"
        ? (visiblePick ?? defaultProjectId)
        : null;

  const { layers: projectLayers } = useProjectLayers(selectedProjectId ?? undefined);

  const [name, setName] = useState(template.name);
  const [spaceOverride, setSpaceOverride] = useState<Space | null>(null);
  const [folderOverride, setFolderOverride] = useState<Folder | null>(null);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const personalSpace = spaces.find((space) => space.kind === "personal") ?? null;
  const selectedSpace = spaceOverride ?? personalSpace;

  // Picking a different space invalidates any folder pick made under the
  // previous one.
  const setSelectedSpace = (space: Space | null) => {
    setSpaceOverride(space);
    setFolderOverride(null);
  };

  const spaceFolders = useMemo(
    () => (folders ?? []).filter((folder) => folder.space_id === selectedSpace?.id),
    [folders, selectedSpace]
  );
  const defaultFolder = selectedSpace ? (homeFolderOf(folders ?? [], selectedSpace.id) ?? null) : null;
  const selectedFolder = folderOverride ?? defaultFolder;
  const setSelectedFolder = (folder: Folder | null) => setFolderOverride(folder);

  const askInputs = useMemo(() => template.inputs.filter((input) => input.mode === "ask"), [template.inputs]);
  const shipInputs = useMemo(
    () => template.inputs.filter((input) => input.mode === "ship"),
    [template.inputs]
  );
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;

  const setBinding = (key: string, layerId: string | null) => {
    setBindings((prev) => {
      if (layerId === null) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: layerId };
    });
  };

  /** The project layers a given input can be bound to — a shipped input's
   * own dataset stays the default — filtered by the input's `layer_type`/
   * `geometry_type` when it declares one. Empty when the target is a new
   * project (there is no project yet), so the row offers no choice. */
  const candidatesFor = (input: TemplateInput): ProjectLayer[] => {
    if (!selectedProjectId) return [];
    // A binding names a dataset, not a link, so a dataset the project links
    // more than once is offered once.
    const seen = new Set<string>();
    return (projectLayers ?? []).filter((layer) => {
      if (
        (input.layer_type && layer.type !== input.layer_type) ||
        (input.geometry_type && layer.feature_layer_geometry_type !== input.geometry_type) ||
        seen.has(layer.layer_id)
      ) {
        return false;
      }
      seen.add(layer.layer_id);
      return true;
    });
  };

  // A workflow's inputs step lists every dataset the workflow refers to —
  // the shipped ones so the caller sees what lands in the project, the ask
  // ones to bind — so it exists whenever there is anything to list. A
  // project payload's inputs all ship inside the project it creates, so it
  // gets no such step.
  const hasInputsStep =
    askInputs.length > 0 || (template.payload_kind === "workflow" && template.inputs.length > 0);
  const steps = useMemo(() => {
    const list: UseTemplateStep[] = [];
    if (context.kind !== "in_project") list.push("location");
    if (hasInputsStep) list.push("bindings");
    return list;
  }, [context.kind, hasInputsStep]);

  const locationValid =
    context.kind === "in_project" ||
    (!targetPending &&
      (target === "existing" ? !!selectedProjectId : !!selectedFolder && name.trim().length > 0));

  const apply = async (): Promise<TemplateUseResult | null> => {
    setBusy(true);
    setError(null);
    try {
      const body = buildRequest(template, selectedProjectId, name, selectedFolder?.id, bindings);
      const result = await applyTemplate(template.id, body);
      refreshTemplates();
      refreshContentFeed();
      void revalidateOnboardingFacts();
      return result;
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : t("error_using_template"));
      return null;
    } finally {
      setBusy(false);
    }
  };

  return {
    steps,
    /** Offer "add to a project" at all — false inside a project, for a
     * project payload, and while the caller has no project yet. Null until
     * the first project page has answered. */
    canPickProject: canPickProject ? hasProjects : false,
    targetPending,
    target,
    setTarget: setTargetOverride,
    projects,
    projectsLoading,
    projectSearch,
    setProjectSearch,
    selectedProjectId,
    setSelectedProjectId: setProjectOverride,
    name,
    setName,
    spaces,
    selectedSpace,
    setSelectedSpace,
    folders: spaceFolders,
    selectedFolder,
    setSelectedFolder,
    askInputs,
    shipInputs,
    /** The picked existing project's row, for wording; null for a new
     * project and inside a project (the caller is already looking at it). */
    selectedProject,
    candidatesFor,
    bindings,
    setBinding,
    locationValid,
    busy,
    error,
    apply,
  };
};

/**
 * Where a caller should navigate once `onDone` fires. `map/[projectId]/page`
 * reads `?mode=`/`?workflow=`/`?layout=` on mount via `useMapUrlIntent`
 * (hooks/map/useMapUrlIntent.ts), which dispatches the matching mapMode and,
 * for a workflow, selects it once the project's workflow list contains the
 * id, then strips the params. A layout id is handed back to the map page,
 * which threads it down to the Reports panel (that panel keeps its selection
 * in local component state, not Redux). A project payload has no workflow/
 * layout of its own to open, so it lands on the plain project route.
 */
export const templateResultHref = (_template: TemplateRead, result: TemplateUseResult): string => {
  if (result.workflow_id) {
    return `/map/${result.project_id}?mode=workflows&workflow=${result.workflow_id}`;
  }
  if (result.layout_id) {
    return `/map/${result.project_id}?mode=reports&layout=${result.layout_id}`;
  }
  return `/map/${result.project_id}`;
};

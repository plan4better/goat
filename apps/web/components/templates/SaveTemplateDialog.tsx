"use client";

import {
  Alert,
  Autocomplete,
  Box,
  ButtonBase,
  Checkbox,
  Chip,
  FormControl,
  Skeleton,
  Stack,
  TextField,
  Typography,
  alpha,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { uploadAsset } from "@/lib/api/assets";
import { refreshContentFeed, useSpaces } from "@/lib/api/content";
import { useFolders } from "@/lib/api/folders";
import { useReportLayout } from "@/lib/api/reportLayouts";
import {
  TemplateApiError,
  createTemplate,
  previewTemplate,
  publishTemplateWithDetail,
  refreshTemplate,
  refreshTemplates,
  unpublishTemplate,
  updateTemplate,
  useTemplateCategories,
  useTemplatesFromSource,
} from "@/lib/api/templates";
import { useUserProfile } from "@/lib/api/users";
import { useWorkflow } from "@/lib/api/workflows";
import {
  descriptorFromLayoutConfig,
  descriptorFromWorkflowConfig,
  layoutPageFromConfig,
} from "@/lib/templates/previewGeometry";
import { renderSnapshotFor, snapshotFileName } from "@/lib/templates/thumbnailSnapshot";
import { homeFolderOf, spaceDisplayName, spaceIconFor } from "@/lib/utils/content";
import { tagColor } from "@/lib/utils/tagColor";
import type { Space } from "@/lib/validations/content";
import { blockedShipInputs } from "@/lib/utils/templates";
import type {
  TemplateKind,
  TemplatePreview,
  TemplatePreviewDescriptor,
  TemplateRead,
  TemplateSource,
} from "@/lib/validations/template";

import MarkdownContentEditor from "@/components/builder/widgets/common/MarkdownContentEditor";
import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import FormLabelHelper from "@/components/common/FormLabelHelper";
import FolderBrowser from "@/components/dashboard/common/FolderBrowser";
import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
import TemplateInputsTable from "@/components/templates/TemplateInputsTable";
import type { TemplateInputMode } from "@/components/templates/TemplateInputsTable";
import TemplateCatalogSwitch from "@/components/templates/TemplateCatalogSwitch";
import TemplatePreviewPanel from "@/components/templates/TemplatePreviewPanel";
import TemplateSourceChoice from "@/components/templates/TemplateSourceChoice";
import type { TemplateSaveMode } from "@/components/templates/TemplateSourceChoice";
import TemplateTag from "@/components/templates/TemplateTag";

export interface SaveTemplateDialogProps {
  source: TemplateSource;
  defaultName: string;
  defaultThumbnailUrl?: string | null;
  onClose: () => void;
  onSaved: (template: TemplateRead) => void;
}

/** The label a destination space reads as in the consequence sentence — an
 * organization always reads as "Organization" (T6's audience wording never
 * spells out its own name), a team reads as its own name. */
const audienceLabel = (space: Space | undefined, t: (key: string) => string): string => {
  if (!space) return "";
  return space.kind === "organization" ? t("organization") : space.name;
};

/**
 * T8's save-a-template dialog: name/description/categories, a location
 * picker (space + folder, default My Content), the inputs table for
 * workflow/project payloads (T5), the cross-space share consequence block
 * (T6), and — superuser only — the "Publish to GOAT catalog" switch (T4;
 * "Propose" is never rendered in v1). `previewTemplate` re-runs on mount and
 * on every folder change, since the destination folder is what decides
 * which datasets need sharing.
 */
const SaveTemplateDialog = ({
  source,
  defaultName,
  defaultThumbnailUrl,
  onClose,
  onSaved,
}: SaveTemplateDialogProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  // Below md the dialog is the whole viewport, which is too narrow to carry
  // the form and the preview side by side — the form is what the author
  // came for.
  const compact = useMediaQuery(theme.breakpoints.down("md"));

  const { spaces } = useSpaces();
  const { folders: allFolders } = useFolders();
  const { userProfile } = useUserProfile();
  // The categories already in use on templates this author can read, with a
  // count each — what the field offers rather than a fresh spelling of an
  // existing tag.
  const { categories: categoryFacets } = useTemplateCategories();

  const isSuperuser = Boolean(userProfile?.is_superuser);
  const isLayout = source.kind === "layout";

  const [selectedSpace, setSelectedSpace] = useState<Space | undefined>(undefined);
  /** The folder browsed to inside the selected space; `null` is the space
   * root, which saves into that space's own `home` folder. */
  const [browsedFolderId, setBrowsedFolderId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedSpace) return;
    const personal = spaces.find((space) => space.kind === "personal");
    if (personal) setSelectedSpace(personal);
  }, [spaces, selectedSpace]);

  const foldersInSpace = useMemo(
    () => (selectedSpace ? (allFolders ?? []).filter((folder) => folder.space_id === selectedSpace.id) : []),
    [allFolders, selectedSpace]
  );

  const homeFolderId = selectedSpace ? (homeFolderOf(allFolders ?? [], selectedSpace.id)?.id ?? null) : null;
  /** What the save and the preview actually write to — the browsed folder,
   * or the space's `home` folder at the root. */
  const targetFolderId = browsedFolderId ?? homeFolderId;

  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  // Whether the author has edited name/description/categories: prefilling
  // from a chosen template never overwrites what they typed.
  const metadataTouched = useRef(false);

  // Templates already saved from this same source, newest first. A second
  // "Save as template" on the same workflow almost always means "update the
  // one I have", so the first time there are any the dialog switches to
  // updating the newest — once, and never over the author's own choice.
  const { templates: candidates } = useTemplatesFromSource(source);
  const [saveMode, setSaveMode] = useState<TemplateSaveMode>("new");
  const [updateTargetId, setUpdateTargetId] = useState<string | null>(null);
  const updateTarget =
    saveMode === "update"
      ? (candidates.find((candidate) => candidate.id === updateTargetId) ?? candidates[0])
      : undefined;
  const updating = updateTarget !== undefined;
  const candidatesSeen = useRef(false);
  useEffect(() => {
    if (candidatesSeen.current || candidates.length === 0) return;
    candidatesSeen.current = true;
    setSaveMode("update");
    setUpdateTargetId(candidates[0].id);
  }, [candidates]);
  useEffect(() => {
    if (!updateTarget || metadataTouched.current) return;
    setName(updateTarget.name);
    setDescription(updateTarget.description ?? "");
    setCategories(updateTarget.categories);
  }, [updateTarget]);

  const categoryOptions = useMemo(() => (categoryFacets ?? []).map((facet) => facet.name), [categoryFacets]);
  const categoryCounts = useMemo(
    () => new Map((categoryFacets ?? []).map((facet) => [facet.name, facet.count])),
    [categoryFacets]
  );

  /** The spelling the shelf already uses for a typed tag: the backend groups
   * categories case-insensitively, so typing "mobility" where "Mobility"
   * exists has to join that tag rather than open a second spelling of it. A
   * name nothing matches is kept as typed — a new category. A comma becomes
   * a space first: it is the separator the browser's `?categories=` filter
   * splits on, so a tag carrying one could never be filtered by. */
  const canonicalCategory = (value: string): string => {
    const cleaned = value.replace(/,/g, " ").replace(/\s+/g, " ").trim();
    return categoryOptions.find((option) => option.toLowerCase() === cleaned.toLowerCase()) ?? cleaned;
  };

  const changeCategories = (values: string[]) => {
    const next: string[] = [];
    for (const value of values) {
      const name = canonicalCategory(value);
      if (name && !next.some((entry) => entry.toLowerCase() === name.toLowerCase())) next.push(name);
    }
    metadataTouched.current = true;
    setCategories(next);
  };

  // The categories field's own focus, which is what its label above it is
  // coloured by.
  const [categoriesFocused, setCategoriesFocused] = useState(false);

  const isWorkflow = source.kind === "workflow";
  /** A workflow and a layout are both drawn and stored as a picture, each
   * when the caller named which one; a project payload gets none. */
  const wantsSnapshot =
    (isWorkflow && Boolean(source.workflow_id)) || (isLayout && Boolean(source.layout_id));

  // The picture is drawn from the payload's stored config, which is what the
  // backend freezes into the template — the dialog is handed a source, not a
  // config, so it reads the workflow (or the layout) itself.
  const {
    workflow,
    isLoading: workflowLoading,
    isError: workflowError,
  } = useWorkflow(
    isWorkflow ? source.project_id : undefined,
    isWorkflow ? (source.workflow_id ?? undefined) : undefined
  );
  const {
    reportLayout,
    isLoading: layoutLoading,
    isError: layoutError,
  } = useReportLayout(
    isLayout ? source.project_id : undefined,
    isLayout ? (source.layout_id ?? undefined) : undefined
  );

  /** The structure descriptors the saved template will carry, built here
   * because the template does not exist yet: the snapshot is drawn from
   * whichever the payload has, and so is the draft's scaffold. */
  const workflowDescriptor = useMemo(
    () => (isWorkflow ? descriptorFromWorkflowConfig(workflow?.config as Record<string, unknown>) : null),
    [isWorkflow, workflow]
  );
  const layoutDescriptor = useMemo(
    () => (isLayout ? descriptorFromLayoutConfig(reportLayout?.config as Record<string, unknown>) : null),
    [isLayout, reportLayout]
  );

  /** The page a layout prints on, as the template will store it: the card's
   * "A3 · Landscape" tag and the millimetres under its picture, for readers
   * who never see the config. Both null for a workflow or project payload. */
  const layoutPage = useMemo(
    () => layoutPageFromConfig(isLayout ? (reportLayout?.config as Record<string, unknown>) : null),
    [isLayout, reportLayout]
  );

  /** The generated snapshot of the payload being saved, and a picture the
   * author picked instead. The picked one wins while it is there — resetting
   * it puts the snapshot (or the caller's default) back. */
  const [snapshotBlob, setSnapshotBlob] = useState<Blob | null>(null);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  // A workflow's and a layout's box holds its place from the moment the
  // dialog opens; a project never gets a snapshot.
  const [snapshotPending, setSnapshotPending] = useState(wantsSnapshot);

  // What the snapshot depends on as a value: SWR hands back a fresh object on
  // every revalidation, and depending on it would redraw the snapshot each
  // time.
  const payload = isLayout ? reportLayout : workflow;
  const payloadLoading = isLayout ? layoutLoading : workflowLoading;
  const payloadError = isLayout ? layoutError : workflowError;
  const snapshotKey = wantsSnapshot && payload ? `${payload.id}:${payload.updated_at ?? ""}` : "";
  const descriptorRef = useRef<TemplatePreviewDescriptor | null>(null);
  descriptorRef.current = isLayout ? layoutDescriptor : workflowDescriptor;
  // A workflow snapshot writes the titles the canvas writes, which are
  // translated where they are drawn — the descriptor itself stays
  // language-neutral. A layout carries no text at all.
  const translateRef = useRef(t);
  translateRef.current = t;

  useEffect(() => {
    if (!snapshotKey) return;
    // A workflow with nothing placeable on its canvas has no picture to
    // take: the scaffold is what it reads as.
    const drawn = renderSnapshotFor(descriptorRef.current, translateRef.current);
    if (!drawn) {
      setSnapshotPending(false);
      return;
    }
    let cancelled = false;
    setSnapshotPending(true);
    drawn
      .then((blob) => {
        if (!cancelled) setSnapshotBlob(blob);
      })
      .catch(() => {
        // A snapshot that could not be drawn leaves the template without a
        // thumbnail, which is the scaffold every reader already sees.
        if (!cancelled) setSnapshotBlob(null);
      })
      .finally(() => {
        if (!cancelled) setSnapshotPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshotKey]);

  // A payload there is no snapshot coming for — the read failed, or it
  // settled without one — stops waiting and shows its scaffold.
  useEffect(() => {
    if (!wantsSnapshot) return;
    if (payloadError || (!payloadLoading && !payload)) setSnapshotPending(false);
  }, [wantsSnapshot, payload, payloadLoading, payloadError]);

  /** The object URLs the two blobs are shown as. Both are made and given
   * back here, so a replaced blob's URL goes at once and the last one goes
   * when the dialog does. */
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [pickedUrl, setPickedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshotBlob) {
      setSnapshotUrl(null);
      return;
    }
    const url = URL.createObjectURL(snapshotBlob);
    setSnapshotUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [snapshotBlob]);

  useEffect(() => {
    if (!pickedFile) {
      setPickedUrl(null);
      return;
    }
    const url = URL.createObjectURL(pickedFile);
    setPickedUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pickedFile]);

  /** The bytes the template would be saved with right now, and what they are
   * shown as. */
  const draftThumbnailBlob: Blob | null = pickedFile ?? snapshotBlob;
  const thumbnailUrl = (pickedFile ? pickedUrl : snapshotUrl) ?? defaultThumbnailUrl ?? null;
  // Only the picked picture stands in for something else, so it is the only
  // one that can be taken back.
  const thumbnailLoading = snapshotPending && !pickedFile;

  const pickThumbnail = (file: File) => setPickedFile(file);
  const resetThumbnail = () => setPickedFile(null);

  /** The picture already stored, and the bytes it was stored from. An upload
   * outlives the save that failed after it — the asset is on the server
   * either way — so a retry with the same bytes reuses it instead of leaving
   * the first copy orphaned and adding another. Different bytes (a picture
   * picked after the failure) upload as usual. */
  const uploadedThumbnail = useRef<{ blob: Blob; url: string } | null>(null);

  const [preview, setPreview] = useState<TemplatePreview | undefined>(undefined);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErrorMessage, setPreviewErrorMessage] = useState<string | undefined>(undefined);
  const [inputModes, setInputModes] = useState<Record<string, TemplateInputMode>>({});

  // What the preview actually depends on, as a value: callers build the
  // `source` prop inline, so a new object arrives on every parent render and
  // depending on it would re-fetch the preview and reset the author's
  // ship/ask and share choices under them.
  const sourceKey = `${source.kind}:${source.project_id}:${source.workflow_id ?? ""}:${source.layout_id ?? ""}`;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    if (!targetFolderId) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreview(undefined);
    setPreviewErrorMessage(undefined);
    previewTemplate({ source: sourceRef.current, folder_id: targetFolderId })
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        const modes: Record<string, TemplateInputMode> = {};
        result.detected_inputs.forEach((input) => {
          modes[input.key] = input.mode;
        });
        setInputModes(modes);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPreview(undefined);
        setPreviewErrorMessage(error instanceof Error && error.message ? error.message : "");
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceKey, targetFolderId]);

  const modeFor = (key: string): TemplateInputMode => inputModes[key] ?? "ask";

  const keysForLayer = (layerId: string): string[] =>
    (preview?.detected_inputs ?? []).filter((input) => input.layer_id === layerId).map((input) => input.key);

  const layerIncluded = (layerId: string): boolean => {
    const keys = keysForLayer(layerId);
    return keys.length > 0 && keys.every((key) => modeFor(key) === "ship");
  };

  const toggleLayerShare = (layerId: string, included: boolean) => {
    const keys = keysForLayer(layerId);
    setInputModes((prev) => {
      const next = { ...prev };
      keys.forEach((key) => {
        next[key] = included ? "ship" : "ask";
      });
      return next;
    });
  };

  const shareRows = preview?.datasets_needing_share ?? [];
  const sharedCount = shareRows.filter((row) => layerIncluded(row.layer_id)).length;

  const [publishSwitchOn, setPublishSwitchOn] = useState(false);
  // A chosen template's catalog state is where its switch starts.
  const publishTargetId = updateTarget?.id;
  const publishTargetPublished = updateTarget?.catalog_status === "published";
  useEffect(() => {
    setPublishSwitchOn(publishTargetId ? publishTargetPublished : false);
  }, [publishTargetId, publishTargetPublished]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  // Set only when the template was saved but publishing it was refused: the
  // dialog then stays open on that outcome alone, and the caller learns
  // about the saved template when the author closes it.
  const [publishBlocked, setPublishBlocked] = useState<
    { template: TemplateRead; names: string[] } | undefined
  >(undefined);

  const submitDisabled =
    submitting ||
    !name.trim() ||
    (!targetFolderId && !updating) ||
    previewLoading ||
    previewErrorMessage !== undefined ||
    // The picture is still being drawn, or the payload it is drawn from has
    // not arrived yet. Saving now stores the generic scaffold instead of the
    // snapshot that is about to render, and — for a layout — drops the
    // `page_size`/`page_orientation` read from that same config.
    thumbnailLoading ||
    (wantsSnapshot && payloadLoading);

  /** The message a structured backend failure reads as — the create 422
   * names the shipped input the author cannot read on its own, which is the
   * one thing that tells them which row to switch to "ask". */
  const errorMessage = (error: unknown): string => {
    if (error instanceof TemplateApiError && error.detail?.code === "template_input_not_readable") {
      const layerId = error.detail.layer_id;
      const input = (preview?.detected_inputs ?? []).find((candidate) => candidate.layer_id === layerId);
      return t("template_input_not_readable", { name: input?.label ?? t("dataset") });
    }
    return error instanceof Error ? error.message : String(error);
  };

  const handleSubmit = async () => {
    if (!targetFolderId && !updateTarget) return;
    setSubmitting(true);
    setSubmitError(undefined);
    setPublishBlocked(undefined);
    try {
      if (updateTarget) {
        // Updating an existing template: the payload is re-snapshotted from
        // the source, then the metadata is written; location and shares
        // stay as they are. The thumbnail keeps the template's own picture.
        const refreshed = await refreshTemplate(updateTarget.id);
        const patched = await updateTemplate(updateTarget.id, {
          name: name.trim(),
          description: description.trim() || null,
          categories,
        });
        if (isSuperuser) {
          const wasPublished = updateTarget.catalog_status === "published";
          if (publishSwitchOn && !wasPublished) {
            const blocked = blockedShipInputs(refreshed.inputs);
            if (blocked.length > 0) {
              setPublishBlocked({ template: patched, names: blocked.map((input) => input.label) });
              return;
            }
            const result = await publishTemplateWithDetail(patched.id);
            if (!result.ok) {
              setPublishBlocked({ template: patched, names: result.layers.map((layer) => layer.name) });
              return;
            }
          } else if (!publishSwitchOn && wasPublished) {
            await unpublishTemplate(patched.id);
          }
        }
        refreshTemplates();
        refreshContentFeed();
        if (refreshed.datasets_needing_share.length > 0) {
          toast.info(t("template_datasets_need_sharing", { count: refreshed.datasets_needing_share.length }));
        }
        onSaved(patched);
        onClose();
        return;
      }
      if (!targetFolderId) return;
      const inputs = (preview?.detected_inputs ?? []).map((input) => ({
        ...input,
        mode: modeFor(input.key),
      }));
      const shareDatasets = shareRows.filter((row) => layerIncluded(row.layer_id)).map((row) => row.layer_id);

      // The picture is only bytes until here: a picked file keeps its own
      // name, a generated snapshot is named after the template.
      let savedThumbnailUrl = defaultThumbnailUrl ?? null;
      const alreadyUploaded = uploadedThumbnail.current;
      if (draftThumbnailBlob && alreadyUploaded?.blob === draftThumbnailBlob) {
        savedThumbnailUrl = alreadyUploaded.url;
      } else if (draftThumbnailBlob) {
        try {
          const file =
            draftThumbnailBlob instanceof File
              ? draftThumbnailBlob
              : new File([draftThumbnailBlob], snapshotFileName(name), { type: "image/png" });
          const asset = await uploadAsset(file, "image", {
            displayName: file.name,
            category: "template_thumbnail",
          });
          uploadedThumbnail.current = { blob: draftThumbnailBlob, url: asset.url };
          savedThumbnailUrl = asset.url;
        } catch {
          // The template is worth more than its picture: the save goes
          // through with whatever picture the caller already had.
          toast.error(t("image_upload_failed"));
          savedThumbnailUrl = defaultThumbnailUrl ?? null;
        }
      }

      const created = await createTemplate({
        name: name.trim(),
        description: description.trim() || null,
        categories,
        folder_id: targetFolderId,
        source,
        inputs,
        share_datasets: shareDatasets,
        thumbnail_url: savedThumbnailUrl,
        page_size: layoutPage.page_size,
        page_orientation: layoutPage.page_orientation,
      });
      refreshTemplates();
      refreshContentFeed();

      // Publishing runs before the caller hears about the save: every caller
      // closes this dialog from `onSaved`, so a refusal reported afterwards
      // would land on an unmounted dialog and never reach the author.
      if (isSuperuser && publishSwitchOn) {
        // The same rule the backend applies, checked first so a refusal
        // names the dataset before a round trip that would fail anyway.
        const blocked = blockedShipInputs(inputs);
        if (blocked.length > 0) {
          setPublishBlocked({ template: created, names: blocked.map((input) => input.label) });
          return;
        }
        const result = await publishTemplateWithDetail(created.id);
        if (!result.ok) {
          setPublishBlocked({ template: created, names: result.layers.map((layer) => layer.name) });
          return;
        }
        refreshTemplates();
        refreshContentFeed();
      }
      onSaved(created);
      onClose();
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  // Closing after a refused publish still reports the saved template: the
  // template exists, only the catalog step did not happen.
  const handleClose = () => {
    if (publishBlocked) onSaved(publishBlocked.template);
    onClose();
  };

  // The preview draws a template that does not exist yet, so its timestamps
  // are the moment the dialog opened.
  const openedAt = useRef(new Date().toISOString()).current;

  /** The kinds the preview badges: the ones the backend derived for this
   * source, and the source's own kind until the preview comes back. */
  const previewKinds = useMemo<TemplateKind[]>(() => {
    const derived = (preview?.kinds ?? []).filter(
      (kind): kind is TemplateKind => kind === "workflow" || kind === "dashboard" || kind === "layout"
    );
    if (derived.length > 0) return derived;
    return [source.kind === "project" ? "dashboard" : source.kind];
  }, [preview, source.kind]);

  const authorName = [userProfile?.firstname, userProfile?.lastname].filter(Boolean).join(" ");

  /** The structure the preview column draws, and the structure the generated
   * picture is written from: a workflow's and a layout's from their stored
   * configs, a project's from how many layers the preview found on it. */
  const draftPreview = useMemo<TemplatePreviewDescriptor | null>(() => {
    if (source.kind === "workflow") return workflowDescriptor;
    if (source.kind === "layout") return layoutDescriptor;
    const layers = new Set((preview?.detected_inputs ?? []).map((input) => input.layer_id));
    return { kind: "project", layers: layers.size };
  }, [source.kind, workflowDescriptor, layoutDescriptor, preview]);

  /** The form's own state as the template it would save — what the right
   * column draws, so the author reads their own words in the shape the
   * browser will show them in. The declared inputs are left off: they have
   * their own section in the form itself. */
  const draft: TemplateRead = useMemo(
    () => ({
      datasets_needing_share: [],
      id: "draft",
      name: name.trim() || t("untitled_template"),
      description: description.trim() || null,
      categories,
      thumbnail_url: thumbnailUrl,
      page_size: layoutPage.page_size,
      page_orientation: layoutPage.page_orientation,
      space_id: selectedSpace?.id ?? "",
      folder_id: targetFolderId ?? "",
      created_by: userProfile ? { id: userProfile.id, name: authorName || t("you") } : null,
      payload_kind: source.kind,
      kinds: previewKinds,
      inputs: [],
      ships_sample_data: false,
      catalog_status: "none",
      source_ref: {},
      my_role: "owner",
      created_at: openedAt,
      updated_at: openedAt,
    }),
    [
      t,
      name,
      description,
      categories,
      thumbnailUrl,
      layoutPage,
      selectedSpace,
      targetFolderId,
      userProfile,
      authorName,
      source.kind,
      previewKinds,
      openedAt,
    ]
  );

  const title = source.kind === "project" ? t("save_project_as_template") : t("save_as_template");

  // A refused publish leaves the template saved, so the only thing left to do
  // is read the refusal and close.
  const footer = publishBlocked ? (
    <AppDialogFooter primaryLabel={t("close")} onPrimary={handleClose} />
  ) : (
    <AppDialogFooter
      onCancel={onClose}
      primaryLabel={updating ? t("update_template") : t("save")}
      onPrimary={() => void handleSubmit()}
      primaryDisabled={submitDisabled}
      primaryLoading={submitting}
    />
  );

  const previewColumn = (
    <Box
      data-testid="template-preview-column"
      sx={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderLeft: `1px solid ${theme.palette.divider}`,
        backgroundColor: alpha(theme.palette.text.primary, 0.02),
      }}>
      <TemplatePreviewPanel
        template={draft}
        descriptor={draftPreview}
        namePlaceholder={!name.trim()}
        sourceLabel={spaceDisplayName(selectedSpace, t)}
        // The picture is frozen once the save starts; a change now would not
        // reach the template being written.
        thumbnailActions={
          submitting
            ? undefined
            : { onUpload: pickThumbnail, onReset: pickedFile ? resetThumbnail : undefined }
        }
        thumbnailLoading={thumbnailLoading}
      />
    </Box>
  );

  return (
    <AppDialog
      open
      onClose={handleClose}
      icon={ICON_NAME.SAVE}
      title={title}
      maxWidth={1320}
      fullScreenBelow="md"
      bleed
      bodySx={{ display: "flex", overflow: "hidden" }}
      closeDisabled={submitting}
      footer={footer}>
      <>
        <Box
          sx={{
            flex: compact ? 1 : "0 0 560px",
            minWidth: 0,
            overflowY: "auto",
            padding: "2px 22px 16px",
          }}>
          {/* One rhythm for the whole form: every block — the three fields,
            the space choice and the folder browser — sits 32px from the next. */}
          <Stack spacing={4} sx={{ mt: "10px" }}>
            <TemplateSourceChoice
              kindLabel={t(`template_kind_${source.kind}`)}
              candidates={candidates}
              mode={saveMode}
              onModeChange={(next) => {
                setSaveMode(next);
                if (next === "new" && !metadataTouched.current) {
                  setName(defaultName);
                  setDescription("");
                  setCategories([]);
                }
              }}
              selectedId={updateTarget?.id ?? null}
              onSelect={setUpdateTargetId}
              spaces={spaces}
              disabled={submitting}
            />

            {/* TextFieldInput leaves its unfocused label colour to `inherit`,
              so the box around it is what sets the house secondary. */}
            <Box sx={{ color: "text.secondary" }}>
              <TextFieldInput
                label={t("name")}
                value={name}
                onChange={(value) => {
                  metadataTouched.current = true;
                  setName(value);
                }}
                inputProps={{ "aria-label": t("name") }}
              />
            </Box>

            {/* The description is markdown wherever it is shown, so it is
              written in the markdown editor rather than a plain text area.
              The preview column beside the form already renders it, so the
              editor's own Write/Preview tabs stay off. `MarkdownProse` draws
              no video, so that hint stays off too. */}
            <FormControl size="small" fullWidth>
              <FormLabelHelper label={t("description")} color={theme.palette.text.secondary} />
              <MarkdownContentEditor
                value={description}
                onChange={(value) => {
                  metadataTouched.current = true;
                  setDescription(value);
                }}
                minRows={4}
                placeholder={t("template_description_placeholder")}
                ariaLabel={t("description")}
                videoHint={false}
                showPreview={false}
              />
            </FormControl>

            <FormControl size="small" fullWidth>
              <FormLabelHelper
                label={t("categories")}
                color={categoriesFocused ? theme.palette.primary.main : theme.palette.text.secondary}
              />
              <Autocomplete
                freeSolo
                multiple
                // The natural flow is to type a tag and press Save, whose
                // mousedown blurs the field: `autoSelect` commits what was typed
                // instead of dropping it silently.
                autoSelect
                // A tag already on the template leaves the option list, so
                // clicking it cannot toggle it back off.
                filterSelectedOptions
                size="small"
                options={categoryOptions}
                value={categories}
                onChange={(_event, newValue) => changeCategories(newValue as string[])}
                // Each option names the tag and how many templates already carry
                // it, so a shared tag is the obvious pick over a new one.
                renderOption={(props, option) => {
                  const { key, ...optionProps } = props as typeof props & { key?: string };
                  return (
                    <Box component="li" key={key ?? option} {...optionProps} sx={{ gap: "2px" }}>
                      <TemplateTag label={option} tone="category" />
                      <Typography component="span" sx={{ fontSize: 12, color: "text.secondary" }}>
                        {` · ${categoryCounts.get(option) ?? 0}`}
                      </Typography>
                    </Box>
                  );
                }}
                renderTags={(value, getTagProps) =>
                  value.map((option, index) => {
                    const { key, ...tagProps } = getTagProps({ index });
                    const { fg, bg } = tagColor(option, theme.palette.mode);
                    return (
                      <Chip
                        key={key}
                        size="small"
                        label={option}
                        {...tagProps}
                        sx={{
                          color: fg,
                          backgroundColor: bg,
                          fontWeight: 600,
                          "& .MuiChip-deleteIcon": { color: fg, opacity: 0.7 },
                        }}
                      />
                    );
                  })
                }
                onFocus={() => setCategoriesFocused(true)}
                onBlur={() => setCategoriesFocused(false)}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    placeholder={categories.length === 0 ? t("add_category") : ""}
                    inputProps={{ ...params.inputProps, "aria-label": t("categories") }}
                    sx={{
                      "& .MuiAutocomplete-inputRoot": { minHeight: "40px", fontSize: "0.875rem" },
                      "& input": { fontSize: "0.875rem" },
                      "& input::placeholder": { fontSize: "0.875rem" },
                    }}
                  />
                )}
              />
            </FormControl>

            {/* The location is a choice between spaces, not a field, so it
              keeps its group heading — one block in the same rhythm. Hidden
              while updating: the template stays where it is. */}
            {!updating && (
              <>
            <Box>
              <FormLabelHelper label={t("location")} color={theme.palette.text.secondary} />
              <Box sx={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {spaces.map((space) => {
                  const on = space.id === selectedSpace?.id;
                  return (
                    <ButtonBase
                      key={space.id}
                      onClick={() => {
                        setSelectedSpace(space);
                        setBrowsedFolderId(null);
                      }}
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: "7px",
                        padding: "6px 11px",
                        borderRadius: "999px",
                        border: `1.5px solid ${on ? theme.palette.primary.main : theme.palette.divider}`,
                        backgroundColor: on
                          ? alpha(theme.palette.primary.main, 0.12)
                          : theme.palette.background.paper,
                      }}>
                      <Icon
                        iconName={spaceIconFor(space)}
                        style={{
                          fontSize: 13,
                          color: on ? theme.palette.primary.main : theme.palette.text.secondary,
                        }}
                      />
                      <Typography
                        sx={{ fontSize: 12.5, fontWeight: 700, color: on ? "primary.main" : "text.primary" }}>
                        {space.kind === "personal"
                          ? t("my_content")
                          : space.kind === "organization"
                            ? t("organization")
                            : space.name}
                      </Typography>
                    </ButtonBase>
                  );
                })}
              </Box>
            </Box>

            {selectedSpace && (
              <FolderBrowser
                space={selectedSpace}
                folders={foldersInSpace}
                homeFolderId={homeFolderId}
                value={browsedFolderId}
                onChange={setBrowsedFolderId}
                label={t("folder")}
                helperText={t("template_folder_hint")}
                maxHeight={180}
              />
            )}
              </>
            )}
          </Stack>

          {previewLoading && (
            <Stack spacing={1} sx={{ mt: 2 }}>
              <Skeleton variant="rectangular" height={20} />
              <Skeleton variant="rectangular" height={20} />
            </Stack>
          )}

          {previewErrorMessage !== undefined && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {previewErrorMessage || t("template_preview_failed")}
            </Alert>
          )}

          {isLayout ? (
            <Typography sx={{ mt: 2, fontSize: 12.5, color: "text.secondary", lineHeight: 1.45 }}>
              {t("layouts_carry_no_datasets")}
            </Typography>
          ) : (
            preview &&
            preview.detected_inputs.length > 0 && (
              <>
                <FormLabelHelper label={t("template_inputs")} color={theme.palette.text.secondary} />
                <TemplateInputsTable
                  inputs={preview.detected_inputs}
                  modeFor={modeFor}
                  onModeChange={(key, mode) => setInputModes((prev) => ({ ...prev, [key]: mode }))}
                  allowAsk={source.kind !== "project"}
                />
              </>
            )
          )}

          {preview && shareRows.length > 0 && (
            <>
              <FormLabelHelper label={t("what_happens")} color={theme.palette.text.secondary} />
              <Box
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "7px",
                  padding: "11px 13px",
                  borderRadius: "10px",
                  backgroundColor: alpha(theme.palette.warning.main, 0.07),
                  border: `1px solid ${alpha(theme.palette.warning.main, 0.25)}`,
                }}>
                <Box sx={{ display: "flex", alignItems: "flex-start", gap: "9px" }}>
                  <Icon
                    iconName={ICON_NAME.SHARE}
                    style={{ fontSize: 13, marginTop: 2, color: theme.palette.text.secondary }}
                  />
                  <Typography component="span" sx={{ fontSize: 12.8, lineHeight: 1.45 }}>
                    {t("datasets_will_be_shared_viewer", {
                      n: sharedCount,
                      audience: audienceLabel(selectedSpace, t),
                    })}
                  </Typography>
                </Box>
                {shareRows.map((row) => (
                  <Box
                    key={row.layer_id}
                    data-testid={`share-row-${row.layer_id}`}
                    sx={{ display: "flex", alignItems: "center", gap: "9px", pl: "22px" }}>
                    <Checkbox
                      size="small"
                      checked={layerIncluded(row.layer_id)}
                      onChange={(_event, checked) => toggleLayerShare(row.layer_id, checked)}
                      inputProps={{ "aria-label": row.name }}
                      sx={{ padding: 0 }}
                    />
                    <Typography component="span" sx={{ fontSize: 12.8 }}>
                      {row.name}
                    </Typography>
                  </Box>
                ))}
              </Box>
            </>
          )}

          {isSuperuser && (
            <TemplateCatalogSwitch
              published={updateTarget?.catalog_status === "published"}
              updating={updating}
              checked={publishSwitchOn}
              onChange={setPublishSwitchOn}
              blocked={blockedShipInputs(
                (preview?.detected_inputs ?? []).map((input) => ({ ...input, mode: modeFor(input.key) }))
              )}
              disabled={submitting}
            />
          )}

          {publishBlocked && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              {t("template_saved_not_published")}{" "}
              {t("template_dataset_not_public", { names: publishBlocked.names.join(", ") })}
            </Alert>
          )}

          {submitError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {submitError}
            </Alert>
          )}
        </Box>

        {!compact && previewColumn}
      </>
    </AppDialog>
  );
};

export default SaveTemplateDialog;

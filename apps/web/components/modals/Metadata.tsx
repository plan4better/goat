import { Autocomplete, Box, Chip, FormControl, Stack, TextField, Typography, useTheme } from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { mutate } from "swr";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { type BundleDatasetMetadata, isBundleTile, updateBundle, useBundle } from "@/lib/api/bundles";
import { matchesContentListKey } from "@/lib/api/datasets";
import { updateDataset } from "@/lib/api/layers";
import { PROJECTS_API_BASE_URL, updateProject } from "@/lib/api/projects";
import { bundleMetadataSchema } from "@/lib/validations/bundle";
import { layerMetadataSchema } from "@/lib/validations/layer";

import type { ContentDialogBaseProps } from "@/types/dashboard/content";
import type { SelectorItem } from "@/types/map/common";

import { useContentMetadataHooks } from "@/hooks/map/ContentMetadataHooks";

import MarkdownContentEditor from "@/components/builder/widgets/common/MarkdownContentEditor";
import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import FormLabelHelper from "@/components/common/FormLabelHelper";
import Selector from "@/components/map/panels/common/Selector";
import TextFieldInput from "@/components/map/panels/common/TextFieldInput";

interface MetadataDialogProps extends ContentDialogBaseProps {}

/** A group heading inside the form: the same 12px secondary label as a field,
 * set apart by the space above it. */
const GroupLabel = ({ children }: { children: string }) => (
  <Typography sx={{ fontSize: 12, fontWeight: 600, color: "text.secondary", pt: 2 }}>{children}</Typography>
);

/** The provenance a bundle states about its data, as the form holds it: every
 * field a string, so an emptied one is simply "". */
type Provenance = {
  geographical_code: string;
  data_reference_year: string;
  lineage: string;
  license: string;
  attribution: string;
  distributor_name: string;
  distributor_email: string;
  distribution_url: string;
};

const EMPTY_PROVENANCE: Provenance = {
  geographical_code: "",
  data_reference_year: "",
  lineage: "",
  license: "",
  attribution: "",
  distributor_name: "",
  distributor_email: "",
  distribution_url: "",
};

/** Trimmed, without blanks, and without a tag already present in another case. */
const cleanTags = (raw: string[]): string[] => {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of raw) {
    const tag = entry.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags;
};

const Metadata: React.FC<MetadataDialogProps> = ({ open, onClose, content, type }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [isBusy, setIsBusy] = useState(false);
  // A layer, a project and a bundle all edit name and description here; only a
  // bundle also states where its data came from, so the provenance inputs
  // render for bundles alone.
  const isBundle = isBundleTile(content);
  const tile = content as { name: string; description?: string | null; tags?: string[] | null };

  const [name, setName] = useState(tile.name);
  const [description, setDescription] = useState(tile.description ?? "");
  const [tags, setTags] = useState<string[]>(tile.tags ?? []);
  const [tagsFocused, setTagsFocused] = useState(false);
  const [provenance, setProvenance] = useState<Provenance>(EMPTY_PROVENANCE);
  const setField = (key: keyof Provenance) => (value: string) =>
    setProvenance((current) => ({ ...current, [key]: value }));

  // Callers pass whatever they hold, and a content tile carries no provenance
  // (the grid listing omits it), so the authoritative row is fetched and the
  // form re-seeded.
  const { bundle } = useBundle(isBundle ? content.id : null);
  useEffect(() => {
    if (!bundle) return;
    const stored = bundle.dataset_metadata ?? {};
    setName(bundle.name);
    setDescription(bundle.description ?? "");
    setProvenance({
      geographical_code: stored.geographical_code ?? "",
      data_reference_year: stored.data_reference_year != null ? String(stored.data_reference_year) : "",
      lineage: stored.lineage ?? "",
      license: stored.license ?? "",
      attribution: stored.attribution ?? "",
      distributor_name: stored.distributor_name ?? "",
      distributor_email: stored.distributor_email ?? "",
      distribution_url: stored.distribution_url ?? "",
    });
  }, [bundle]);

  const { geographicalCodeOptions } = useContentMetadataHooks();
  const regionItems = useMemo<SelectorItem[]>(
    () =>
      geographicalCodeOptions.map((option) => ({
        value: option.value,
        label: option.label,
        iconNode: <span aria-hidden>{option.icon}</span>,
      })),
    [geographicalCodeOptions]
  );
  const regionItem = regionItems.find((item) => item.value === provenance.geographical_code);

  /** The form as the API wants it: empty strings dropped, so the schema's
   * optional fields (an email, a URL, a two-letter region) only get checked
   * when something was actually typed. */
  const values = useMemo(() => {
    const identity = { name: name.trim(), description: description.trim() || undefined };
    if (!isBundle) return { ...identity, tags };
    const filled = Object.fromEntries(
      Object.entries(provenance).filter(([, value]) => value.trim() !== "")
    ) as Partial<Provenance>;
    return { ...identity, ...filled };
  }, [name, description, tags, provenance, isBundle]);

  const valid = useMemo(
    () => (isBundle ? bundleMetadataSchema : layerMetadataSchema).safeParse(values).success,
    [values, isBundle]
  );
  const canSubmit = !!name.trim() && valid && !isBusy;

  const onSubmit = async () => {
    if (!canSubmit) return;
    try {
      setIsBusy(true);
      const identity = { name: name.trim(), description: description.trim() };
      if (isBundle) {
        // Every provenance field the form owns, with an emptied one sent as
        // null: the API merges the document, so a key that is simply absent
        // keeps its old value and there would be no way to clear one.
        const document = Object.fromEntries(
          Object.entries(provenance).map(([key, value]) => {
            if (value.trim() === "") return [key, null];
            return [key, key === "data_reference_year" ? Number(value) : value.trim()];
          })
        );
        await updateBundle(content.id, {
          ...identity,
          dataset_metadata: document as BundleDatasetMetadata,
        });
        mutate(matchesContentListKey);
      } else if (type === "layer") {
        await updateDataset(content.id, { folder_id: content.folder_id, ...identity, tags });
        mutate(matchesContentListKey);
      } else {
        await updateProject(content.id, { folder_id: content.folder_id, ...identity, tags });
        mutate((key) => Array.isArray(key) && key[0] === PROJECTS_API_BASE_URL);
      }
      toast.success(t("metadata_updated_success"));
    } catch (error) {
      toast.error(t("metadata_updated_error"));
    } finally {
      setIsBusy(false);
      onClose && onClose();
    }
  };

  return (
    <AppDialog
      open={open}
      onClose={() => onClose?.()}
      icon={ICON_NAME.EDITPEN}
      title={t("edit_metadata")}
      maxWidth={600}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          primaryLabel={t("update")}
          onPrimary={() => void onSubmit()}
          primaryDisabled={!canSubmit}
          primaryLoading={isBusy}
        />
      }>
      {/* TextFieldInput leaves its unfocused label colour to `inherit`, so the
          box around the form is what sets the house secondary. */}
      <Box sx={{ pt: 1, color: "text.secondary" }}>
        <Stack spacing={4}>
          <TextFieldInput
            label={t("name")}
            value={name}
            onChange={setName}
            autoFocus
            disabled={isBusy}
            inputProps={{ "aria-label": t("name") }}
          />

          {/* The description is markdown wherever it is shown, so it is
              written in the markdown editor rather than a plain text area. */}
          <FormControl size="small" fullWidth>
            <FormLabelHelper label={t("description")} color={theme.palette.text.secondary} />
            <MarkdownContentEditor
              value={description}
              onChange={setDescription}
              minRows={4}
              placeholder={t("description")}
              ariaLabel={t("description")}
              videoHint={false}
            />
          </FormControl>

          {/* Free-text tags as chips, the same field the template dialog uses
              for its categories. Enter or a blur commits what was typed. */}
          {!isBundle && (
            <FormControl size="small" fullWidth>
              <FormLabelHelper
                label={t("tags")}
                color={tagsFocused ? theme.palette.primary.main : theme.palette.text.secondary}
              />
              <Autocomplete
                freeSolo
                multiple
                autoSelect
                filterSelectedOptions
                disabled={isBusy}
                size="small"
                options={[] as string[]}
                value={tags}
                onChange={(_event, next) => setTags(cleanTags(next as string[]))}
                onFocus={() => setTagsFocused(true)}
                onBlur={() => setTagsFocused(false)}
                renderTags={(value, getTagProps) =>
                  value.map((tag, index) => {
                    const { key, ...tagProps } = getTagProps({ index });
                    return <Chip key={key} size="small" label={tag} {...tagProps} />;
                  })
                }
                renderInput={(params) => (
                  <TextField
                    {...params}
                    placeholder={tags.length === 0 ? t("add_tag") : ""}
                    inputProps={{ ...params.inputProps, "aria-label": t("tags") }}
                    sx={{
                      "& .MuiAutocomplete-inputRoot": { minHeight: "40px", fontSize: "0.875rem" },
                      "& input": { fontSize: "0.875rem" },
                      "& input::placeholder": { fontSize: "0.875rem" },
                    }}
                  />
                )}
              />
            </FormControl>
          )}

          {isBundle && (
            <>
              <GroupLabel>{t("metadata.heading_titles.data_quality")}</GroupLabel>
              <Selector
                label={t("metadata.headings.geographical_code")}
                items={regionItems}
                selectedItems={regionItem}
                enableSearch
                disabled={isBusy}
                setSelectedItems={(items) => {
                  const picked = Array.isArray(items) ? items[0] : items;
                  setField("geographical_code")(picked ? String(picked.value) : "");
                }}
              />
              <TextFieldInput
                label={t("metadata.headings.data_reference_year")}
                type="number"
                value={provenance.data_reference_year}
                onChange={setField("data_reference_year")}
                disabled={isBusy}
              />
              <TextFieldInput
                label={t("metadata.headings.lineage")}
                value={provenance.lineage}
                onChange={setField("lineage")}
                multiline
                rows={4}
                disabled={isBusy}
              />

              <GroupLabel>{t("metadata.heading_titles.distribution")}</GroupLabel>
              <TextFieldInput
                label={t("metadata.headings.distributor_name")}
                value={provenance.distributor_name}
                onChange={setField("distributor_name")}
                disabled={isBusy}
              />
              <TextFieldInput
                label={t("metadata.headings.distributor_email")}
                value={provenance.distributor_email}
                onChange={setField("distributor_email")}
                disabled={isBusy}
              />
              <TextFieldInput
                label={t("metadata.headings.distribution_url")}
                value={provenance.distribution_url}
                onChange={setField("distribution_url")}
                disabled={isBusy}
              />
              <TextFieldInput
                label={t("metadata.headings.license")}
                value={provenance.license}
                onChange={setField("license")}
                placeholder="DL-DE-BY-2.0"
                disabled={isBusy}
              />
              <TextFieldInput
                label={t("metadata.headings.attribution")}
                value={provenance.attribution}
                onChange={setField("attribution")}
                disabled={isBusy}
              />
            </>
          )}
        </Stack>
      </Box>
    </AppDialog>
  );
};

export default Metadata;

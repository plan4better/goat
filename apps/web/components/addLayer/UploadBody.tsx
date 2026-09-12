"use client";

import { ErrorOutlineOutlined } from "@mui/icons-material";
import {
  Box,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { BUNDLE_TYPES } from "@/lib/api/bundles";

import type { SelectorItem } from "@/types/map/common";

import { DEFAULT_STREET_NETWORK, type UploadFlow } from "@/hooks/addLayer/useUploadFlow";

import LayerSetupDialog from "@/components/addLayer/LayerSetupDialog";
import UploadDropzone from "@/components/addLayer/UploadDropzone";
import UploadFileRow from "@/components/addLayer/UploadFileRow";
import CatalogFeatureTable from "@/components/dashboard/catalog/CatalogFeatureTable";
import Selector from "@/components/map/panels/common/Selector";

/**
 * The Upload tab: a drop zone, and what was dropped.
 *
 * One screen. The drop zone is the empty state: one file is taken at a time, so once one
 * is queued the zone gives way to the row describing it, and removing the file brings the
 * zone back. A file's own settings open in `LayerSetupDialog`, on top of this screen
 * rather than inside it.
 *
 * The row is written as one of a list, so taking several files later adds rows beside a
 * zone that stays, rather than a second design.
 */
const UploadBody = ({
  controller,
  autoOpenSetup,
}: {
  controller: UploadFlow;
  /** Set when the file arrived from elsewhere and its settings are the only thing left. */
  autoOpenSetup?: boolean;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { upload } = controller;
  const [setUpOpen, setSetUpOpen] = useState(false);

  /**
   * Open the settings as soon as there is something to show in them.
   *
   * Waits for the preview: opening on mount gives an empty dialog for as long as the file
   * takes to parse. Fires once, so closing it does not reopen it.
   */
  const opened = useRef(false);
  useEffect(() => {
    if (!autoOpenSetup || opened.current) return;
    if (!upload.isTabular || !upload.preview) return;
    opened.current = true;
    setSetUpOpen(true);
  }, [autoOpenSetup, upload.isTabular, upload.preview]);

  /**
   * The parsed head, in the shape the catalog's own preview table reads.
   *
   * `CatalogFeatureTable` rather than the `FeatureTable` under it: the header colour, the
   * band painted beside the sticky header and the max height all live in that wrapper, so
   * re-deriving them here would be the same table with a different header — which is
   * exactly the mismatch worth avoiding.
   */
  /**
   * Header labels made unique before anything keys off them.
   *
   * A CSV may repeat a column name — two "Billing Contact" columns is ordinary in an
   * export — and the table keys its columns by name. Left as they came, React warned about
   * duplicate keys and, worse, the row objects were built with `Object.fromEntries`, so the
   * second column's values silently overwrote the first and both columns showed the same
   * data. The suffix is for this preview only; what the import calls them is its own
   * business.
   */
  const previewLabels = useMemo(() => {
    const seen = new Map<string, number>();
    return (upload.preview?.headers ?? []).map((header, index) => {
      const base = header?.trim() || `column${index + 1}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return count === 1 ? base : `${base} (${count})`;
    });
  }, [upload.preview]);

  const previewColumns = useMemo(
    () => previewLabels.map((name) => ({ name, type: "string" })),
    [previewLabels]
  );
  const previewFeatures = useMemo(
    () =>
      (upload.preview?.rows ?? []).map((row, index) => ({
        type: "Feature" as const,
        id: index,
        geometry: null,
        properties: Object.fromEntries(previewLabels.map((label, column) => [label, row[column]])),
      })),
    [upload.preview, previewLabels]
  );

  /**
   * The street networks this file may link to, and the one it does.
   *
   * The network GOAT ships leads the list, as the answer most uploads want —
   * but it is not preselected: picking it is still a choice someone makes.
   */
  const streetNetworkItems: SelectorItem[] = useMemo(
    () => [
      {
        value: DEFAULT_STREET_NETWORK,
        label: t("default_street_network"),
        // The same glyph as the bundles below it: the row stands in the same
        // list for the same decision, and a second icon made the field's
        // appearance depend on which was chosen.
        icon: ICON_NAME.CUBE,
      },
      ...upload.streetNetworks.map((bundle) => ({
        value: bundle.id,
        label: bundle.name,
        icon: ICON_NAME.CUBE,
      })),
    ],
    [upload.streetNetworks, t]
  );
  const streetNetworkItem = useMemo(
    () => streetNetworkItems.find((item) => item.value === upload.streetNetworkId),
    [streetNetworkItems, upload.streetNetworkId]
  );

  /** What the client genuinely knows about a workbook, from the head it already parsed. */
  const detail =
    upload.preview && upload.preview.headers.length > 0
      ? t("upload_rows_columns", {
          rows: upload.preview.totalRows,
          columns: upload.preview.headers.length,
        })
      : undefined;

  return (
    <Stack spacing={4}>
      <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.6 }}>
        {t("supported")} <b>GeoPackage</b>, <b>GeoJSON</b>, <b>Shapefile (.zip)</b>, <b>KML</b>, <b>CSV</b>,{" "}
        <b>XLSX</b>, <b>Parquet</b>,{" "}
        {BUNDLE_TYPES.map((type, index) => (
          <span key={type.type}>
            <b>{type.uploadHint}</b>
            {index < BUNDLE_TYPES.length - 1 ? ", " : ""}
          </span>
        ))}
        . {t("upload_multi_dataset_hint")}
      </Typography>

      {/* One file at a time, so the zone is the empty state and nothing more: once a file
          is queued there is nothing to drop it next to, and a second zone would only
          invite something the upload cannot take. Removing the file brings it back. */}
      {upload.file ? (
        <Stack spacing={2}>
          <Typography variant="caption" color="text.secondary" fontWeight="bold">
            {t("file")}
          </Typography>
          <UploadFileRow
            file={upload.file}
            name={upload.values.name ?? upload.suggestedName}
            nameError={upload.errors.name?.message}
            onRename={upload.setName}
            detail={detail}
            folders={upload.folders}
            selectedFolder={upload.selectedFolder}
            onSelectFolder={upload.setSelectedFolder}
            description={upload.values.description ?? ""}
            onDescriptionChange={upload.setDescription}
            onSetUp={upload.isTabular ? () => setSetUpOpen(true) : undefined}
            onRemove={() => upload.setFile(null)}
          />
          {/* The short form, for a type with nothing more to explain. A type
              that has its own note says all of this and more, so both would be
              the same fact twice. */}
          {upload.bundleType && !upload.bundleType.uploadNoteKey && (
            <Typography variant="caption" color="text.secondary">
              {t("bundle_detected_note", { type: t(upload.bundleType.labelKey) })}
            </Typography>
          )}
          {/* Between the two sections it belongs to: what the file becomes,
              and therefore why the field below asks what it asks. Space on
              both sides so it reads as its own beat rather than as a caption
              on either neighbour. Same card language as the file row — 1px
              divider, the same radius and padding — tinted rather than white
              so it reads as an explanation, not as another file. */}
          {upload.bundleType?.uploadNoteKey && (
            // The gap lives on this wrapper, not on the card: `margin-top` in
            // `sx` loses to the parent Stack's own spacing selector, and
            // padding on the card itself would grow the box inside its border.
            <Box sx={{ pt: 3 }}>
              <Stack
                direction="row"
                spacing={3}
                alignItems="center"
                sx={{
                  p: 3,
                  borderRadius: 1.5,
                  // Darker than the file row's divider: this one is asking for
                  // a decision, not describing what was dropped.
                  border: `1px solid ${theme.palette.text.disabled}`,
                  backgroundColor: theme.palette.action.hover,
                }}>
                {/* From `@mui/icons-material`, as the workflow nodes do: the
                    shared `ICON_NAME` set has no warning glyph, and adding one
                    to it is a change to a package every app here shares. */}
                <ErrorOutlineOutlined
                  sx={{ fontSize: 18, color: theme.palette.text.secondary, flexShrink: 0 }}
                />
                <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>
                  <Trans i18nKey={`common:${upload.bundleType.uploadNoteKey}`} components={{ b: <b /> }} />
                </Typography>
              </Stack>
            </Box>
          )}
          {/* Required, not optional: the bundle's stop-to-street linkage is
              computed against this network, so it is chosen before the upload
              starts rather than attached afterwards. Restricted to networks
              whose routing graph is ready — see the flow. */}
          {upload.requiresStreetNetwork && (
            // Padding, matching the note's wrapper above, so both boundaries
            // are the Stack's own gap plus the same amount.
            <Stack spacing={2} sx={{ pt: 3 }}>
              {/* Titled like "File" above rather than as a form label: the two
                  are the same kind of heading over the same kind of block, and
                  the selector's own label styling is the map panels'. */}
              <Typography variant="caption" color="text.secondary" fontWeight="bold">
                {t("street_network_bundle")}
              </Typography>
              <Box
                sx={{
                  // The selector is the map panels' own, where fields are square
                  // to their container. Here it sits under the file row, so it
                  // takes that card's radius and border colour instead.
                  "& .MuiOutlinedInput-notchedOutline": {
                    borderRadius: 1.5,
                    borderColor: theme.palette.divider,
                  },
                }}>
                <Selector
                  selectedItems={streetNetworkItem}
                  setSelectedItems={(item) => {
                    const selected = Array.isArray(item) ? item[0] : item;
                    upload.setStreetNetworkId((selected?.value as string) ?? null);
                  }}
                  items={streetNetworkItems}
                  placeholder={t("select_a_street_network")}
                />
              </Box>
            </Stack>
          )}
        </Stack>
      ) : (
        <UploadDropzone
          accept={upload.acceptedFileTypes}
          error={upload.fileError}
          onChange={upload.setFile}
        />
      )}

      <LayerSetupDialog
        open={setUpOpen && upload.isTabular}
        fileName={upload.file?.name ?? ""}
        onClose={() => setSetUpOpen(false)}
        onSave={() => setSetUpOpen(false)}>
        <Stack direction="row" spacing={5} alignItems="flex-start">
          {/* The settings in a rail of their own, as a column of decisions, with the
              consequence stated under them rather than left to be inferred. */}
          <Stack spacing={4} sx={{ width: 280, flexShrink: 0 }}>
            {upload.preview && upload.preview.sheetNames.length > 1 && (
              <TextField
                select
                fullWidth
                size="small"
                label={t("worksheet")}
                value={upload.sheet}
                onChange={(event) => upload.setSheet(event.target.value)}>
                {upload.preview.sheetNames.map((name) => (
                  <MenuItem key={name} value={name}>
                    {name}
                  </MenuItem>
                ))}
              </TextField>
            )}

            <FormControlLabel
              control={
                <Switch
                  checked={upload.hasHeader}
                  onChange={(event) => upload.setHasHeader(event.target.checked)}
                  color="primary"
                  size="small"
                />
              }
              label={
                <Typography variant="body2" fontWeight="bold">
                  {t("first_row_is_header")}
                </Typography>
              }
            />
          </Stack>

          <Stack spacing={2} sx={{ flex: 1, minWidth: 0 }}>
            {upload.preview && upload.preview.headers.length > 0 && (
              <>
                <Typography variant="body2" fontWeight="bold">
                  {t("upload_preview_of_rows", { count: upload.preview.rows.length })}
                </Typography>
                <CatalogFeatureTable features={previewFeatures as never} columns={previewColumns as never} />
              </>
            )}
          </Stack>
        </Stack>
      </LayerSetupDialog>
    </Stack>
  );
};

export default UploadBody;

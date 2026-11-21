"use client";

// The user's own icons in the icon picker: the uploaded icons to pick, and a list to rename or delete them. A file
// chosen, or dropped anywhere on the pane (also while managing), uploads at once under its name and is picked; the
// Upload button beside Manage chooses one, a drop zone while there are no icons. Uploads keep their own colors
// (spec 1).
import {
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  IconButton,
  OutlinedInput,
  Stack,
  Typography,
} from "@mui/material";
import type { TFunction } from "i18next";
import { type DragEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { AssetUploadError, deleteAsset, updateAsset, uploadAsset, useAssets } from "@/lib/api/assets";
import { defaultResolveIcon } from "@/lib/style/compile/images";
import { carriesFiles } from "@/lib/utils/dataFiles";
import {
  ASSETS_MAX_FILE_SIZE_MB,
  ICON_ACCEPT_LIST,
  type UploadedAsset,
  assetTypeEnum,
  isIconFile,
} from "@/lib/validations/assets";

import { useStyleData } from "@/components/map/panels/styleEditor/context";
import { IconImage } from "@/components/map/panels/styleEditor/pickers/IconGlyph";
import {
  IconTile,
  PANE_LIST,
  PaneEmpty,
  PaneHeading,
  PaneSearch,
  TileGrid,
} from "@/components/map/panels/styleEditor/pickers/iconTiles";
import { fieldSx } from "@/components/map/panels/styleEditor/rows/fieldBox";

const nameOf = (asset: UploadedAsset) => asset.display_name || asset.file_name;
/** An upload's image through core's file route, as the map loads it. */
const srcOf = (asset: UploadedAsset) => defaultResolveIcon(`asset:${asset.id}`)?.url ?? asset.url;

/** Why core refused an upload, in words: the types it takes for icons or its size limit, else the generic message. */
function refusal(error: unknown, t: TFunction): string {
  // A proxy in front of core refuses a large body itself.
  if (error instanceof AssetUploadError && error.status === 413)
    return t("style_editor.icon_upload_size", { size: ASSETS_MAX_FILE_SIZE_MB });
  if (error instanceof AssetUploadError && error.status === 400) {
    if (error.detail.startsWith("Invalid file type")) return t("style_editor.icon_upload_type");
    const size = /Maximum allowed size is (\d+)/.exec(error.detail);
    if (size) return t("style_editor.icon_upload_size", { size: size[1] });
  }
  return t("icon_upload_failed");
}

/** The empty pane's upload field; while a file is dragged over, the pane shows that it takes it. */
function DropZone({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation("common");
  return (
    <Box sx={{ pt: 3 }}>
      <ButtonBase
        onClick={onClick}
        sx={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 1,
          py: 3,
          px: 3,
          borderRadius: 1,
          border: "1px dashed",
          borderColor: "divider",
        }}>
        <Icon iconName={ICON_NAME.UPLOAD} sx={{ fontSize: 16, color: "text.secondary" }} />
        <Typography variant="body2">{t("style_editor.icon_upload_drop")}</Typography>
        <Typography variant="caption" color="text.secondary">
          {t("style_editor.icon_upload_hint", { size: ASSETS_MAX_FILE_SIZE_MB })}
        </Typography>
      </ButtonBase>
    </Box>
  );
}

function ManageRow({ asset, onChanged }: { asset: UploadedAsset; onChanged: () => void }) {
  const { t } = useTranslation("common");
  const [name, setName] = useState(nameOf(asset));
  // Deleting asks first, in place of the row.
  const [asking, setAsking] = useState(false);
  const save = async () => {
    const next = name.trim();
    if (!asset.id || !next || next === nameOf(asset)) return setName(nameOf(asset));
    try {
      await updateAsset(asset.id, { display_name: next });
      onChanged();
    } catch {
      toast.error(t("error_updating_icon"));
    }
  };
  const remove = async () => {
    if (!asset.id) return;
    try {
      await deleteAsset(asset.id);
      onChanged();
    } catch {
      toast.error(t("error_deleting_icon"));
    } finally {
      setAsking(false);
    }
  };
  if (asking)
    return (
      <Box role="alert" sx={{ my: 1, px: 2.5, py: 2, borderRadius: 2, border: 1, borderColor: "divider" }}>
        <Typography variant="caption" sx={{ display: "block", lineHeight: 1.5 }}>
          {t("style_editor.icon_delete_confirm", { name: nameOf(asset) })}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <Button variant="text" size="small" color="inherit" onClick={() => setAsking(false)}>
            {t("cancel")}
          </Button>
          <Button variant="text" size="small" color="error" onClick={() => void remove()}>
            {t("delete")}
          </Button>
        </Stack>
      </Box>
    );
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 2, py: 1 }}>
      <IconImage src={srcOf(asset)} size={24} />
      <OutlinedInput
        size="small"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
        inputProps={{ "aria-label": t("rename") }}
        sx={{ ...fieldSx, flex: 1 }}
      />
      <IconButton
        size="small"
        aria-label={t("style_editor.icon_delete", { name: nameOf(asset) })}
        onClick={() => setAsking(true)}>
        <Icon iconName={ICON_NAME.TRASH} sx={{ fontSize: 14 }} />
      </IconButton>
    </Box>
  );
}

export function CustomIconPane({ value, onPick }: { value?: string; onPick: (ref: string) => void }) {
  const { t } = useTranslation("common");
  const { uploads } = useStyleData();
  const { mutate } = useAssets({ asset_type: assetTypeEnum.Enum.icon });
  const input = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [managing, setManaging] = useState(false);
  /** Whether a file is uploading, one at a time. */
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const q = query.trim().toLowerCase();
  const shown = uploads.filter((asset) => asset.id && (!q || nameOf(asset).toLowerCase().includes(q)));
  const refresh = () => void mutate();
  const choose = () => input.current?.click();

  const upload = async (file: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!file || uploading) return;
    // Checked here too: a dropped file skips the input's `accept`.
    if (!isIconFile(file)) return void toast.error(t("style_editor.icon_upload_type"));
    if (file.size > ASSETS_MAX_FILE_SIZE_MB * 1024 * 1024)
      return void toast.error(t("style_editor.icon_upload_size", { size: ASSETS_MAX_FILE_SIZE_MB }));
    const name = file.name.replace(/\.[^.]+$/, "") || file.name;
    setUploading(true);
    try {
      const asset = await uploadAsset(file, assetTypeEnum.Enum.icon, { displayName: name });
      await mutate();
      if (asset.id) onPick(`asset:${asset.id}`);
    } catch (error) {
      toast.error(refusal(error, t));
    } finally {
      setUploading(false);
    }
  };
  // Only files: dragging a tile or text over the pane does nothing.
  const dropProps = {
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setDragging(true);
    },
    // Leaving for a child of the pane is still over it.
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      void upload(event.dataTransfer.files?.[0]);
    },
  };
  // The first upload shows on the Upload button too.
  const hasIcons = uploads.length > 0 || uploading;

  return (
    <Box
      data-drop-target
      data-dragging={dragging || undefined}
      {...dropProps}
      sx={{
        flex: "1 1 0",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        borderRadius: 1,
        outline: dragging ? "2px dashed" : "none",
        outlineColor: "primary.main",
        outlineOffset: -4,
        bgcolor: dragging ? "action.hover" : "transparent",
      }}>
      <input
        ref={input}
        type="file"
        accept={ICON_ACCEPT_LIST}
        hidden
        aria-label={t("upload")}
        onChange={(event) => void upload(event.target.files?.[0])}
      />
      <PaneSearch label={t("style_editor.icon_custom_search")} value={query} onChange={setQuery} />
      <Box sx={{ ...PANE_LIST, px: 3, pb: 2 }}>
        {!hasIcons && <DropZone onClick={choose} />}
        {hasIcons && (
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <PaneHeading>{t("style_editor.icon_custom_yours")}</PaneHeading>
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              <Button
                size="small"
                variant="text"
                disabled={uploading}
                onClick={choose}
                startIcon={
                  uploading ? (
                    <CircularProgress size={12} color="inherit" />
                  ) : (
                    <Icon iconName={ICON_NAME.UPLOAD} style={{ fontSize: 14 }} htmlColor="inherit" />
                  )
                }>
                {t(uploading ? "style_editor.icon_uploading" : "upload")}
              </Button>
              {uploads.length > 0 && (
                <Button size="small" variant="text" onClick={() => setManaging((on) => !on)}>
                  {t(managing ? "style_editor.icon_manage_done" : "style_editor.icon_manage")}
                </Button>
              )}
            </Stack>
          </Box>
        )}
        {managing
          ? shown.map((asset) => <ManageRow key={asset.id} asset={asset} onChanged={refresh} />)
          : hasIcons && (
              <TileGrid>
                {shown.map((asset) => (
                  <IconTile
                    key={asset.id}
                    label={nameOf(asset)}
                    selected={value === `asset:${asset.id}`}
                    onClick={() => onPick(`asset:${asset.id}`)}>
                    <IconImage src={srcOf(asset)} size={24} />
                  </IconTile>
                ))}
              </TileGrid>
            )}
        {!hasIcons && <PaneEmpty>{t("style_editor.icon_custom_empty")}</PaneEmpty>}
        {uploads.length > 0 && !shown.length && (
          <PaneEmpty>{t("no_results_for", { q: query.trim() })}</PaneEmpty>
        )}
      </Box>
    </Box>
  );
}

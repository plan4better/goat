"use client";

// The user's own icons in the icon picker: a drop zone that uploads an image under a name, the uploaded icons to
// pick, and a list to rename or delete them. Uploads keep their own colors (spec 1).
import { Box, Button, ButtonBase, IconButton, OutlinedInput, Typography } from "@mui/material";
import { type DragEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { deleteAsset, updateAsset, uploadAsset, useAssets } from "@/lib/api/assets";
import { defaultResolveIcon } from "@/lib/style/compile/images";
import { ASSETS_MAX_FILE_SIZE_MB, type UploadedAsset, assetTypeEnum } from "@/lib/validations/assets";

import { useStyleData } from "@/components/map/panels/styleEditor/context";
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

function UploadZone({ onUploaded }: { onUploaded: (asset: UploadedAsset) => void }) {
  const { t } = useTranslation("common");
  const input = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setName("");
    if (input.current) input.current.value = "";
  };
  const choose = (next: File | undefined) => {
    if (!next) return;
    if (next.size > ASSETS_MAX_FILE_SIZE_MB * 1024 * 1024) {
      toast.error(`${t("maximum_image_size_is")} ${ASSETS_MAX_FILE_SIZE_MB}MB`);
      return;
    }
    setFile(next);
    setName(next.name.replace(/\.[^.]+$/, ""));
    const reader = new FileReader();
    reader.onloadend = () => setPreview(reader.result as string);
    reader.readAsDataURL(next);
  };
  const upload = async () => {
    if (!file || !name.trim()) return;
    setBusy(true);
    try {
      const asset = await uploadAsset(file, assetTypeEnum.Enum.icon, { displayName: name.trim() });
      reset();
      onUploaded(asset);
    } catch {
      toast.error(t("icon_upload_failed"));
    } finally {
      setBusy(false);
    }
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files?.[0]);
  };

  return (
    <Box sx={{ pt: 3 }}>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        aria-label={t("style_editor.icon_upload_drop")}
        onChange={(event) => choose(event.target.files?.[0])}
      />
      {file ? (
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            p: 3,
            borderRadius: 1,
            border: 1,
            borderColor: "divider",
          }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 3 }}>
            {preview && (
              <Box
                component="img"
                src={preview}
                alt=""
                sx={{ width: 40, height: 40, objectFit: "contain", flex: "none" }}
              />
            )}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary" component="label" htmlFor="goat-icon-name">
                {t("style_editor.icon_upload_name")}
              </Typography>
              <OutlinedInput
                id="goat-icon-name"
                size="small"
                fullWidth
                value={name}
                onChange={(event) => setName(event.target.value)}
                sx={fieldSx}
              />
            </Box>
          </Box>
          <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 2 }}>
            <Button size="small" variant="text" onClick={reset} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => void upload()}
              disabled={busy || !name.trim()}>
              {t("style_editor.icon_upload_button")}
            </Button>
          </Box>
        </Box>
      ) : (
        <ButtonBase
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
          sx={{
            width: "100%",
            display: "flex",
            flexDirection: "column",
            gap: 1,
            py: 3,
            px: 3,
            borderRadius: 1,
            border: "1px dashed",
            borderColor: dragging ? "primary.main" : "divider",
            bgcolor: dragging ? "action.hover" : "transparent",
          }}>
          <Icon iconName={ICON_NAME.UPLOAD} sx={{ fontSize: 16, color: "text.secondary" }} />
          <Typography variant="body2">{t("style_editor.icon_upload_drop")}</Typography>
          <Typography variant="caption" color="text.secondary">
            {t("style_editor.icon_upload_hint", { size: ASSETS_MAX_FILE_SIZE_MB })}
          </Typography>
        </ButtonBase>
      )}
    </Box>
  );
}

function ManageRow({ asset, onChanged }: { asset: UploadedAsset; onChanged: () => void }) {
  const { t } = useTranslation("common");
  const [name, setName] = useState(nameOf(asset));
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
    }
  };
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 2, py: 1 }}>
      <Box
        component="img"
        src={srcOf(asset)}
        alt=""
        sx={{ width: 24, height: 24, objectFit: "contain", flex: "none" }}
      />
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
        onClick={() => void remove()}>
        <Icon iconName={ICON_NAME.TRASH} sx={{ fontSize: 14 }} />
      </IconButton>
    </Box>
  );
}

export function CustomIconPane({ value, onPick }: { value?: string; onPick: (ref: string) => void }) {
  const { t } = useTranslation("common");
  const { uploads } = useStyleData();
  const { mutate } = useAssets({ asset_type: assetTypeEnum.Enum.icon });
  const [query, setQuery] = useState("");
  const [managing, setManaging] = useState(false);
  const q = query.trim().toLowerCase();
  const shown = uploads.filter((asset) => asset.id && (!q || nameOf(asset).toLowerCase().includes(q)));
  const refresh = () => void mutate();

  return (
    <>
      <PaneSearch label={t("style_editor.icon_custom_search")} value={query} onChange={setQuery} />
      <Box sx={{ ...PANE_LIST, px: 3, pb: 2 }}>
        {!managing && (
          <UploadZone
            onUploaded={(asset) => {
              refresh();
              if (asset.id) onPick(`asset:${asset.id}`);
            }}
          />
        )}
        {uploads.length > 0 && (
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <PaneHeading>{t("style_editor.icon_custom_yours")}</PaneHeading>
            <Button size="small" variant="text" onClick={() => setManaging((on) => !on)} sx={{ mt: 2 }}>
              {t(managing ? "style_editor.icon_manage_done" : "style_editor.icon_manage")}
            </Button>
          </Box>
        )}
        {managing
          ? shown.map((asset) => <ManageRow key={asset.id} asset={asset} onChanged={refresh} />)
          : shown.length > 0 && (
              <TileGrid>
                {shown.map((asset) => (
                  <IconTile
                    key={asset.id}
                    label={nameOf(asset)}
                    selected={value === `asset:${asset.id}`}
                    onClick={() => onPick(`asset:${asset.id}`)}>
                    <Box
                      component="img"
                      src={srcOf(asset)}
                      alt=""
                      sx={{ width: 24, height: 24, objectFit: "contain" }}
                    />
                  </IconTile>
                ))}
              </TileGrid>
            )}
        {!uploads.length && <PaneEmpty>{t("style_editor.icon_custom_empty")}</PaneEmpty>}
        {uploads.length > 0 && !shown.length && (
          <PaneEmpty>{t("no_results_for", { q: query.trim() })}</PaneEmpty>
        )}
      </Box>
    </>
  );
}

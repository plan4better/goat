"use client";

// The marker's icon as a row, in a field like the other values: the icon and its name (an emoji alone, its name on
// hover); a click opens the icon picker beside the editor ("no icon" where the base marker may go without one).
import { Box } from "@mui/material";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";

import { setMarkerIcon } from "@/lib/style/editor/parts";
import type { Path } from "@/lib/style/editor/store";

import {
  useEditor,
  useMapZoom,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import {
  ShapeField,
  ShapedIcon,
  markerRecordOf,
} from "@/components/map/panels/styleEditor/editors/ShapeField";
import { IconPicker } from "@/components/map/panels/styleEditor/pickers/IconPicker";
import { iconLabel, loadSymbols, useEmojiNames } from "@/components/map/panels/styleEditor/pickers/iconRefs";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { GroupRow } from "@/components/map/panels/styleEditor/rows";

/** The picker writing the icon at `path`, with the marker's shape at its top (the class's for a class's icon). */
export function PathIconPicker({ path }: { path: Path }) {
  const store = useEditor();
  const mapZoom = useMapZoom();
  const { geometry } = useStyleData();
  const value = useStyleValue<unknown>(path);
  return (
    <>
      <ShapeField iconPath={path} />
      <IconPicker
        value={typeof value === "string" ? value : undefined}
        onChange={(ref) => store.update((doc) => setMarkerIcon(doc, path, ref, { mapZoom, geometry }))}
      />
    </>
  );
}

export function IconRow({
  label,
  path,
  fallback,
  mode,
}: {
  label: string;
  path: Path;
  /** The icon shown while the path is unset (in class scope: the base's). */
  fallback?: unknown;
  mode?: ReactNode;
}) {
  const { t } = useTranslation("common");
  const popover = usePopover();
  const data = useStyleData();
  const value = useStyleValue<unknown>(path) ?? fallback;
  const isEmoji = typeof value === "string" && value.startsWith("emoji:");
  const emoji = useEmojiNames(isEmoji);
  const name =
    typeof value === "string" ? iconLabel(value, data.uploads, emoji) : t("style_editor.icon_none");
  // The picker's symbols load while the editor is open, so its tiles show at once.
  useEffect(() => void loadSymbols(), []);
  return (
    <GroupRow
      label={label}
      mode={mode}
      value={isEmoji ? null : name}
      ariaLabel={isEmoji ? `${label}: ${name}` : undefined}
      // As the panel's Icon row draws it.
      glyph={
        typeof value === "string" && (
          <Box component="span" title={isEmoji ? name : undefined} sx={{ display: "flex", flex: "none" }}>
            <ShapedIcon iconRef={value} size={16} record={markerRecordOf(path)} />
          </Box>
        )
      }
      onOpen={(anchor) =>
        popover.open("picker", {
          key: `icon:${path}`,
          title: label,
          anchorTop: anchorTopOf(anchor),
          anchorEl: anchor,
          render: () => <PathIconPicker path={path} />,
        })
      }
    />
  );
}

"use client";

// The marker's icon as a row, in a field like the other values: the icon and its name (an emoji alone, its name on
// hover); a click opens the icon picker beside the editor ("no icon" where the base marker may go without one). The
// arrows' icon (spec 3.2) is a row of the same kind: the icon alone, and GOAT's arrow as a choice above the picker.
import { Box } from "@mui/material";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";

import { keyOf } from "@/lib/style/editor/forms";
import { setArrowsIcon, setMarkerIcon } from "@/lib/style/editor/parts";
import type { Path } from "@/lib/style/editor/store";
import { DEFAULTS } from "@/lib/style/generated/defaults";

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
import { IconGlyph } from "@/components/map/panels/styleEditor/pickers/IconGlyph";
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

/** GOAT's arrow: the arrows' icon until another is picked (spec 3.2). */
const ARROW = DEFAULTS["arrows.icon"] as string;

/** Whether the icon at `path` is the arrows' (one for the layer, no shape) rather than a marker's. */
const isArrowsIcon = (path: Path) => keyOf(path) === "arrows.icon";

/** The picker writing the arrows' icon: the marker's icons, with GOAT's arrow as a choice above them that takes the
 * picked icon off. The arrow turns with the line, another icon stays upright until the user turns it. */
function ArrowsIconPicker({ path }: { path: Path }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const value = useStyleValue<unknown>(path);
  const shown = typeof value === "string" ? value : ARROW;
  return (
    <IconPicker
      value={shown}
      onChange={(ref) => store.update((doc) => setArrowsIcon(doc, path, ref))}
      sentinel={{
        label: t("style_editor.goat_arrow"),
        selected: shown === ARROW,
        onPick: () => store.update((doc) => setArrowsIcon(doc, path, undefined)),
        glyph: <IconGlyph iconRef={ARROW} size={16} color="currentColor" />,
      }}
    />
  );
}

export function IconRow({
  label,
  path,
  fallback,
  mode,
  note,
}: {
  label: string;
  path: Path;
  /** The icon shown while the path is unset (in class scope: the base's). */
  fallback?: unknown;
  mode?: ReactNode;
  note?: ReactNode;
}) {
  const { t } = useTranslation("common");
  const popover = usePopover();
  const data = useStyleData();
  const value = useStyleValue<unknown>(path) ?? fallback;
  const arrows = isArrowsIcon(path);
  const isEmoji = typeof value === "string" && value.startsWith("emoji:");
  const emoji = useEmojiNames(isEmoji);
  const name =
    typeof value !== "string"
      ? t("style_editor.icon_none")
      : arrows && value === ARROW
        ? t("style_editor.goat_arrow")
        : iconLabel(value, data.uploads, emoji);
  // The picker's symbols load while the editor is open, so its tiles show at once.
  useEffect(() => void loadSymbols(), []);
  return (
    <GroupRow
      label={label}
      mode={mode}
      note={note}
      value={isEmoji ? null : name}
      ariaLabel={isEmoji ? `${label}: ${name}` : undefined}
      // As the panel's Icon row draws it.
      glyph={
        typeof value === "string" && (
          <Box component="span" title={isEmoji ? name : undefined} sx={{ display: "flex", flex: "none" }}>
            {arrows ? (
              <IconGlyph iconRef={value} size={16} />
            ) : (
              <ShapedIcon iconRef={value} size={16} record={markerRecordOf(path)} />
            )}
          </Box>
        )
      }
      onOpen={(anchor) =>
        popover.open("picker", {
          key: `icon:${path}`,
          title: label,
          anchorTop: anchorTopOf(anchor),
          anchorEl: anchor,
          render: () => (arrows ? <ArrowsIconPicker path={path} /> : <PathIconPicker path={path} />),
        })
      }
    />
  );
}

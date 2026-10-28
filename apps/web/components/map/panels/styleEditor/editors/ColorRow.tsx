"use client";

// A color row: its field opens the color picker. Both read the store, so they follow edits made elsewhere (undo, the
// picker, the map).
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { keyOf } from "@/lib/style/editor/forms";
import type { Path } from "@/lib/style/editor/store";
import { colorsIn, swatchOf } from "@/lib/style/editor/summaries";
import { DEFAULTS } from "@/lib/style/generated/defaults";

import { useEditor, useStyleData, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { ColorPicker } from "@/components/map/panels/styleEditor/pickers/ColorPicker";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ColorField, Row } from "@/components/map/panels/styleEditor/rows";

const HEX = /^#[0-9a-f]{6}/i;

export interface ColorRowProps {
  label: string;
  path: Path;
  /** The color shown while the path is unset (default: the reference default of its key). */
  fallback?: string;
  /** A choice that takes the color from another part: writes `value` (undefined deletes the key). */
  sentinel?: { label: string; value: "fill" | undefined };
  note?: string;
  mode?: ReactNode;
  /** Writes a color (default: sets the path). */
  write?: (value: string | undefined) => void;
}

/** The color picker of one path; it reads the store, so it follows edits made elsewhere. */
export function PathColorPicker({
  path,
  fallback,
  sentinel,
  write,
}: Pick<ColorRowProps, "path" | "fallback" | "sentinel"> & { write: (v?: string) => void }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { geometry } = useStyleData();
  const value = useStyleValue<unknown>(path);
  // A color taken from another part starts the picker at that color.
  const resolved = swatchOf(store.document, path, geometry);
  const shown =
    typeof value === "string" && value !== "fill"
      ? value
      : value === undefined && fallback
        ? fallback
        : HEX.test(resolved)
          ? resolved
          : fallback;
  return (
    <ColorPicker
      value={shown}
      onChange={write}
      sentinel={
        sentinel
          ? {
              label: t(sentinel.label),
              selected: value === sentinel.value,
              onPick: () => write(sentinel.value),
            }
          : undefined
      }
      docColors={colorsIn(store.document)}
    />
  );
}

export function ColorRow(props: ColorRowProps) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const { label, path, sentinel, note, mode } = props;
  const value = useStyleValue<unknown>(path);
  const write = props.write ?? ((next?: string) => store.set(path, next));
  const fallback = props.fallback ?? (DEFAULTS[keyOf(path)] as string | undefined);
  const sentinelShown = sentinel !== undefined && value === sentinel.value;
  const shown = sentinelShown ? value : (value ?? fallback);
  return (
    <Row label={label} actions={mode} note={note}>
      <ColorField
        value={typeof shown === "string" ? shown : undefined}
        sentinel={sentinel ? { label: t(sentinel.label), shown: sentinelShown } : undefined}
        onOpenPicker={(anchor) =>
          popover.open("picker", {
            key: `color:${path}`,
            title: label,
            anchorTop: anchorTopOf(anchor),
            anchorEl: anchor,
            render: () => <PathColorPicker {...props} fallback={fallback} write={write} />,
          })
        }
      />
    </Row>
  );
}

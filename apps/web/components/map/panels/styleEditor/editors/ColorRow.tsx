"use client";

// A color row: its field opens the color picker. Both read the store, so they follow edits made elsewhere (undo, the
// picker, the map), and both ask the resolver for the color a choice draws.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { isNone } from "@/lib/style/colors";
import { isDerivedWord } from "@/lib/style/compile/derived";
import { keyOf } from "@/lib/style/editor/forms";
import type { Path } from "@/lib/style/editor/store";
import { colorsIn, swatchOf, wordLabel } from "@/lib/style/editor/summaries";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { withAlpha } from "@/lib/utils/colorFormats";

import {
  useBasemapTone,
  useEditor,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { colorChoices, takesTransparency } from "@/components/map/panels/styleEditor/editors/partRows";
import { ColorPicker } from "@/components/map/panels/styleEditor/pickers/ColorPicker";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ColorField, Row } from "@/components/map/panels/styleEditor/rows";

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

/** A choice in front of the picker's swatches: a word the key takes in place of a color (`"auto"`, `"fill"`), the key
 * unset (`value` undefined: the color follows another part), or None (`none`: the row's color at 0 %, spec 4.6). */
export type ColorSentinel =
  | { label: string; value: "fill" | "auto" | undefined; none?: undefined }
  | { label: string; none: true; value?: undefined };

export interface ColorRowProps {
  label: string;
  path: Path;
  /** The color shown while the path is unset (default: the reference default of its key, or the color the resolver
   * gives a key that follows another part while unset). */
  fallback?: string;
  /** The choices in front of the picker's swatches, in their order (default: those of the path's key). */
  sentinels?: ColorSentinel[];
  note?: string;
  mode?: ReactNode;
  /** Writes a color (default: sets the path). */
  write?: (value: string | undefined) => void;
}

const isHex = (value: unknown): value is string => typeof value === "string" && HEX.test(value);

/** What a color row shows for `path`: its choices, the one it reads now (its own, else the one its explicit
 * `fallback` holds, as a class takes the base's "auto"), its color, and the swatch of the color the map draws. */
function useColorState(path: Path, fallback: string | undefined, sentinels: ColorSentinel[] | undefined) {
  const store = useEditor();
  const { geometry } = useStyleData();
  const tone = useBasemapTone();
  const value = useStyleValue<unknown>(path);
  const key = keyOf(path);
  const choices = sentinels ?? colorChoices(key);
  const inherited = value === undefined ? fallback : value;
  // A word or the key unset: the choice that says so. None reads from the color itself.
  const choice = choices.find((c) => !c.none && c.value === inherited);
  // The color the map draws for the row, the hue it follows where unset ("Same as line").
  const drawn = swatchOf(store.document, path, geometry, { tone, follow: true });
  const color = isHex(inherited)
    ? inherited
    : isHex(drawn)
      ? drawn
      : isHex(fallback)
        ? fallback
        : (DEFAULTS[key] as string | undefined);
  return { store, value, key, choices, inherited, choice, drawn, color };
}

/** The color picker of one path; it reads the store, so it follows edits made elsewhere. It starts at the path's
 * color, or at the color a choice draws (Auto, Same as fill); None writes that color at 0 %. */
export function PathColorPicker({
  path,
  fallback,
  sentinels,
  write,
}: Pick<ColorRowProps, "path" | "fallback" | "sentinels"> & { write: (v?: string) => void }) {
  const { t } = useTranslation("common");
  const { store, key, value, inherited, choices, color } = useColorState(path, fallback, sentinels);
  return (
    <ColorPicker
      value={color}
      onChange={write}
      transparency={takesTransparency(key)}
      sentinels={choices.map((choice) =>
        choice.none
          ? {
              label: t(choice.label),
              none: true,
              selected: isNone(value),
              onPick: () => write(withAlpha(color ?? "#ffffff", 0)),
            }
          : {
              label: t(choice.label),
              // A word ("Auto", "Same as fill") is pressed also where a class takes it from the layer, as its row
              // reads it; the choice that unsets the key only where neither the path nor its fallback holds a value.
              selected:
                choice.value === undefined
                  ? value === undefined && fallback === undefined
                  : inherited === choice.value,
              onPick: () => write(choice.value),
            }
      )}
      docColors={colorsIn(store.document)}
    />
  );
}

/** The color field of a path, as a row shows it: "Auto" or "Same as fill" over the color the map draws, "None" over the
 * checkerboard, or six digits and the color's percent. */
export function PathColorField({
  path,
  fallback,
  sentinels,
  onOpenPicker,
}: Pick<ColorRowProps, "path" | "fallback" | "sentinels"> & { onOpenPicker: (anchor: HTMLElement) => void }) {
  const { t } = useTranslation("common");
  const { key, inherited, choice, drawn, color } = useColorState(path, fallback, sentinels);
  // A word the row offers no choice for: its name over the color the map draws for it.
  const word = !choice && isDerivedWord(key, inherited) ? inherited : undefined;
  return (
    <ColorField
      value={isHex(inherited) ? inherited : color}
      sentinel={
        choice
          ? { label: t(choice.label), shown: true, swatch: drawn }
          : word
            ? { label: wordLabel(t, word), shown: true, swatch: drawn }
            : undefined
      }
      onOpenPicker={onOpenPicker}
    />
  );
}

export function ColorRow(props: ColorRowProps) {
  const store = useEditor();
  const popover = usePopover();
  const { label, path, sentinels, note, mode } = props;
  const write = props.write ?? ((next?: string) => store.set(path, next));
  return (
    <Row label={label} actions={mode} note={note}>
      <PathColorField
        path={path}
        fallback={props.fallback}
        sentinels={sentinels}
        onOpenPicker={(anchor) =>
          popover.open("picker", {
            key: `color:${path}`,
            title: label,
            anchorTop: anchorTopOf(anchor),
            anchorEl: anchor,
            render: () => <PathColorPicker {...props} write={write} />,
          })
        }
      />
    </Row>
  );
}

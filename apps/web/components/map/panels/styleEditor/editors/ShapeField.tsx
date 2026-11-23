"use client";

// The marker's shape at the top of the icon picker (spec 3.3 `shape`): the marker's picture and the shape's name,
// opening the shape tiles in a popover left of the picker, as the panel's popovers open. In a class's picker it sets
// the class's shape (a class showing the layer's shape inherits it); the icon alone is the layer's only. The picture
// shows the marker's color and icon only while each is one value; varying, the shape alone in gray. A hollow marker
// shows its outline, the icon in the marker color unless it has its own.
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Geometry } from "@/lib/style/compile/types";
import { modeOf } from "@/lib/style/editor/forms";
import { type MarkerShape, markerShape, setMarkerShape } from "@/lib/style/editor/parts";
import { type Path, getIn, setIn } from "@/lib/style/editor/store";
import { choiceLabel } from "@/lib/style/editor/summaries";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";
import { markerShapeOf } from "@/lib/style/markerShapes";

import { useEditor, useStyleData, useStyleSelector } from "@/components/map/panels/styleEditor/context";
import { IconGlyph } from "@/components/map/panels/styleEditor/pickers/IconGlyph";
import {
  MarkerPicture,
  type ShapePreview,
  ShapeTiles,
} from "@/components/map/panels/styleEditor/pickers/ShapeTiles";
import { SidePopover } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { FormButton, Row } from "@/components/map/panels/styleEditor/rows";

const MARKER = "symbol.marker";

interface ShapeState {
  shape: MarkerShape;
  /** The layer's shape: what a class without its own draws. */
  layer: MarkerShape;
  preview: ShapePreview;
}

/** The shape the marker at `record` draws, and what its picture shows: the record's own color and icon, else the
 * layer's where each is one value (the reference default where the style leaves it out; the icon has none). */
function shapeState(doc: LayerStyle, record: Path, geometry?: Geometry): ShapeState {
  const layer = markerShape(doc);
  const own = getIn(doc, `${record}.shape`);
  const base = (key: string) => {
    const value = getIn(doc, `${MARKER}.${key}`) ?? DEFAULTS[`marker.${key}`];
    return modeOf(doc, `${MARKER}.${key}`, geometry) === "fixed" && typeof value === "string"
      ? value
      : undefined;
  };
  const pick = (key: string) => {
    const value = record === MARKER ? undefined : getIn(doc, `${record}.${key}`);
    return typeof value === "string" ? value : base(key);
  };
  const ownFill = record === MARKER ? undefined : getIn(doc, `${record}.fill`);
  const hollow = (typeof ownFill === "boolean" ? ownFill : getIn(doc, `${MARKER}.fill`)) === false;
  const fill = pick("color");
  const tinted =
    (record !== MARKER && getIn(doc, `${record}.icon_color`) !== undefined) ||
    getIn(doc, `${MARKER}.icon_color`) !== undefined;
  return {
    shape: record === MARKER ? layer : typeof own === "string" ? markerShapeOf(own) : layer,
    layer,
    preview: {
      fill,
      icon: pick("icon"),
      iconColor: hollow && !tinted ? fill : pick("icon_color"),
      ...(hollow ? { hollow } : {}),
    },
  };
}

/** The shape and picture of the marker at `record` (`symbol.marker`, or a class's or rule's `…marker`). */
export function useShapeState(record: Path): ShapeState {
  const { geometry } = useStyleData();
  return JSON.parse(
    useStyleSelector((doc) => JSON.stringify(shapeState(doc, record, geometry)))
  ) as ShapeState;
}

/** The marker record an icon path belongs to: `symbol.marker.icon` and its zoom stops are `symbol.marker`'s. */
export const markerRecordOf = (iconPath: Path): Path => iconPath.replace(/\.icon(\.zoom\.\d+\.1)?$/, "");

/** An icon as the marker at `record` draws it: in its shape, with the marker's color where that is one value (gray
 * where it varies), or the icon alone. `size` is the icon's; a shape is a little larger around it. */
export function ShapedIcon({ iconRef, size, record }: { iconRef: string; size: number; record: Path }) {
  const look = useShapeState(record);
  if (look.shape === "icon") return <IconGlyph iconRef={iconRef} size={size} />;
  return (
    <MarkerPicture
      shape={look.shape}
      size={Math.round(size * 1.25)}
      preview={{ ...look.preview, icon: iconRef }}
    />
  );
}

/** The shape field for the icon at `iconPath` (the layer's `symbol.marker.icon`, or a class's or rule's). */
export function ShapeField({ iconPath }: { iconPath: Path }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const record = markerRecordOf(iconPath);
  const layerRecord = record === MARKER;
  const state = useShapeState(record);
  // The icon alone draws in a layer of its own: its classes take no shape.
  if (!layerRecord && state.layer === "icon") return null;
  const write = (next: MarkerShape) =>
    store.update((doc) =>
      layerRecord
        ? setMarkerShape(doc, next)
        : setIn(doc, `${record}.shape`, next === state.layer ? undefined : next)
    );
  return (
    <>
      <Row label={t("style_editor.shape")}>
        <FormButton
          start={<MarkerPicture shape={state.shape} size={20} preview={state.preview} />}
          text={choiceLabel(t, "marker.shape", state.shape)}
          onOpen={(element) => setAnchor(anchor ? null : element)}
        />
      </Row>
      {anchor && (
        <SidePopover anchorEl={anchor} title={t("style_editor.shape")} onClose={() => setAnchor(null)}>
          <ShapeTiles
            value={state.shape}
            preview={state.preview}
            allowIcon={layerRecord}
            onChange={(next) => {
              write(next);
              setAnchor(null);
            }}
          />
        </SidePopover>
      )}
    </>
  );
}

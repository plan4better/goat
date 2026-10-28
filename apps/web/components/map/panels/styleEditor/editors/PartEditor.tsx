"use client";

// The editor of one group of the symbol section (level 1): the part's rows and the zooms it shows at. A part that
// can be switched off has its switch in the popover header; off writes `false` and keeps the part's last settings
// for this layer, so switching it on brings them back. The points' Fill switch draws hollow markers instead
// (`marker.fill`); a marker left with nothing to draw gets a note, not a block.
import { Switch, Typography } from "@mui/material";
import { memo } from "react";
import { useTranslation } from "react-i18next";

import { setValues } from "@/lib/style/compile/cascade";
import type { Geometry } from "@/lib/style/compile/types";
import { recordPathOf, scopedPart } from "@/lib/style/editor/classify";
import {
  type IconSettings,
  iconSettings,
  markerFilled,
  markerOn,
  partOn,
  restoreIcon,
  setMarkerIcon,
} from "@/lib/style/editor/parts";
import { type EditorStore, type Path, type Scope, getIn, setIn } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";

import { IssueNotice } from "@/components/map/panels/styleEditor/IssueNotice";
import {
  useEditor,
  useLiveMapZoom,
  useMapZoom,
  useScope,
  useScoped,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { LabelEditor } from "@/components/map/panels/styleEditor/editors/LabelEditor";
import { PatternRow } from "@/components/map/panels/styleEditor/editors/PatternEditor";
import { PropertyRow } from "@/components/map/panels/styleEditor/editors/PropertyRow";
import { type PartGroup, groupOf } from "@/components/map/panels/styleEditor/editors/partRows";
import { usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ZoomRangeRow } from "@/components/map/panels/styleEditor/rows";

/** The last settings of each switched-off part, per open layer. */
const switchedOff = new WeakMap<EditorStore, Map<Path, unknown>>();
const OFF = "\u0000off";
const ICON_OFF = "\u0000icon-off";
const FILL_OFF = "\u0000fill-off";
const INVISIBLE = "\u0000invisible";

function memoryOf(store: EditorStore): Map<Path, unknown> {
  let memory = switchedOff.get(store);
  if (!memory) {
    memory = new Map();
    switchedOff.set(store, memory);
  }
  return memory;
}

export const partPath = (group: PartGroup): Path => `symbol.${group.part}`;

/** Switches a part off (remembering it) or on (restoring it, else `{}`). */
export function togglePart(store: EditorStore, path: Path, on: boolean): void {
  const memory = memoryOf(store);
  if (on) {
    store.set(path, memory.get(path) ?? {});
    memory.delete(path);
  } else {
    const value = store.get(path);
    memory.set(path, isObject(value) ? value : {});
    store.set(path, false);
  }
}

/** Draws the markers of the layer or of the scoped class hollow (`fill: false`) or filled again; the outline stays as
 * the user set it. On, a class on a hollow layer writes `fill: true`, anything else drops the key. */
export function toggleFill(store: EditorStore, scope: Scope | null, on: boolean): void {
  const fillPath = `${scope ? recordPathOf(scope) : "symbol"}.marker.fill`;
  store.set(
    fillPath,
    on ? (scope && getIn(store.document, "symbol.marker.fill") === false ? true : undefined) : false
  );
}

/** Whether the markers of the layer or the scoped class draw nothing: no fill, no outline and no icon (a label is not
 * the marker). The panel says so and allows it. */
export function markerInvisible(doc: LayerStyle, scope: Scope | null): boolean {
  const marker = scopedPart(doc, scope, "marker");
  if (!partOn(marker, "marker", "point") || markerFilled(marker)) return false;
  if (partOn(scopedPart(doc, scope, "outline"), "outline", "point")) return false;
  const icons = scope
    ? isObject(marker) && marker.icon !== undefined
      ? [marker.icon]
      : []
    : setValues(doc as unknown as JsonObject, "marker.icon");
  return icons.length === 0;
}

/** The Fill switch of points, for the Fill editor's header; none on the icon alone, which has no fill. */
function FillSwitch({ name }: { name: string }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const scope = useScope();
  const state = useStyleSelector((doc) => {
    const marker = scopedPart(doc, scope, "marker");
    if (!partOn(marker, "marker", "point") || (isObject(marker) && marker.shape === "icon")) return "none";
    return markerFilled(marker) ? "on" : "off";
  });
  if (state === "none") return null;
  const on = state === "on";
  return (
    <Switch
      size="small"
      checked={on}
      onChange={() => toggleFill(store, scope, !on)}
      inputProps={{
        "aria-label": t(on ? "style_editor.turn_part_off" : "style_editor.turn_part_on", { part: name }),
      }}
    />
  );
}

const ICON_PATH = "symbol.marker.icon";

/** Switches the layer's icon off (remembering it, its shape, color, anchor and classifications), which draws plain
 * circles, or on (restoring them, else the default marker icon). */
export function toggleIcon(
  store: EditorStore,
  on: boolean,
  ctx: { mapZoom: number; geometry?: Geometry }
): void {
  const memory = memoryOf(store);
  if (on) {
    store.update((doc) => restoreIcon(doc, memory.get(ICON_PATH) as IconSettings | undefined));
    memory.delete(ICON_PATH);
  } else {
    memory.set(ICON_PATH, iconSettings(store.document, ctx.geometry));
    store.update((doc) =>
      setIn(setMarkerIcon(doc, ICON_PATH, undefined, ctx), "symbol.marker.shape", undefined)
    );
  }
}

/** The icon's on/off switch, for the Icon editor's header (the layer's icon; a class takes its icon in the editor). */
export function IconSwitch() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const mapZoom = useMapZoom();
  const { geometry } = useStyleData();
  const scope = useScope();
  const popover = usePopover();
  const on = useStyleSelector((doc) => markerOn(doc));
  if (scope) return null;
  const name = t("style_editor.part_name_icon");
  return (
    <Switch
      size="small"
      checked={on}
      onChange={() => {
        // Off, the icon row goes, and the icon picker with it.
        if (on) popover.close("picker");
        toggleIcon(store, !on, { mapZoom, geometry });
      }}
      inputProps={{
        "aria-label": t(on ? "style_editor.turn_part_off" : "style_editor.turn_part_on", { part: name }),
      }}
    />
  );
}

/** The on/off switch of a part, for the popover header. */
export function PartSwitch({ part }: { part: string }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { geometry } = useStyleData();
  const group = geometry ? groupOf(geometry, part) : undefined;
  // In class scope the switch reads the class's part and writes `false` or an object into its record (spec 3). It
  // follows only whether the part is on, not every value in it.
  const scope = useScope();
  const on = useStyleSelector((doc) =>
    group && geometry ? partOn(scopedPart(doc, scope, group.part), group.part, geometry) : false
  );
  if (!group || !geometry) return null;
  const name = t(`style_editor.part_name_${group.id}`);
  if (group.switchKey) return <FillSwitch name={name} />;
  const writePath = scope ? `${recordPathOf(scope)}.${group.part}` : partPath(group);
  return (
    <Switch
      size="small"
      checked={on}
      onChange={() => togglePart(store, writePath, !on)}
      inputProps={{
        "aria-label": t(on ? "style_editor.turn_part_off" : "style_editor.turn_part_on", { part: name }),
      }}
    />
  );
}

function PartRows({ group, geometry, shown }: { group: PartGroup; geometry: Geometry; shown: Set<string> }) {
  const base = partPath(group);
  // A class gets its own icon through the icon row, so in scope it shows without an icon on the base.
  const scoped = useScope() !== null;
  return (
    <>
      {group.rows
        .filter(
          (row) =>
            (!row.only || row.only.includes(geometry)) &&
            (shown.has(row.key) || (scoped && row.type === "icon"))
        )
        .map((row) =>
          row.type === "pattern" ? (
            <PatternRow key={row.key} row={row} base={base} />
          ) : (
            <PropertyRow key={row.key} row={row} base={base} />
          )
        )}
    </>
  );
}

const PartZooms = memo(function PartZooms({ base }: { base: Path }) {
  const store = useEditor();
  const mapZoom = useLiveMapZoom();
  const from = useScoped(`${base}.min_zoom`);
  const until = useScoped(`${base}.max_zoom`);
  const layerFrom = useStyleValue<number | undefined>("min_zoom");
  const layerUntil = useStyleValue<number | undefined>("max_zoom");
  return (
    <ZoomRangeRow
      from={from.value as number | undefined}
      until={until.value as number | undefined}
      mapZoom={mapZoom}
      layerRange={[layerFrom ?? 0, layerUntil ?? 24]}
      onChange={(min, max) =>
        store.update(
          (doc) => setIn(setIn(doc, from.writePath, min), until.writePath, max),
          `${from.writePath}.zooms`
        )
      }
    />
  );
});

export function PartEditor({ part }: { part: string }) {
  const { t } = useTranslation("common");
  const { geometry } = useStyleData();
  const group = geometry ? groupOf(geometry, part) : undefined;
  const base = group ? partPath(group) : "";
  const scope = useScope();
  // Which rows show (the part on, rows that depend on other values): one string, so a value changing inside the part
  // renders only its own row.
  const rows = useStyleSelector((doc) => {
    if (!group || !geometry) return "";
    const value = scopedPart(doc, scope, group.part);
    if (!partOn(value, group.part, geometry)) return OFF;
    if (group.switchKey && !markerFilled(value)) return markerInvisible(doc, scope) ? INVISIBLE : FILL_OFF;
    // The Icon group is off while the marker is a plain circle (its own switch, not the part's).
    if (group.id === "icon" && !scope && !markerOn(doc)) return ICON_OFF;
    const part = isObject(value) ? value : {};
    return group.rows
      .filter((row) => !row.when || row.when(part))
      .map((row) => row.key)
      .join(",");
  });
  if (!group || !geometry) return null;
  if (rows === OFF || rows === ICON_OFF || rows === FILL_OFF || rows === INVISIBLE)
    return (
      <>
        <Typography variant="body2" color="text.secondary" sx={{ px: 3, py: 2 }}>
          {t(
            rows === OFF
              ? "style_editor.part_off_note"
              : rows === ICON_OFF
                ? "style_editor.icon_off_note"
                : "style_editor.fill_off_note"
          )}
        </Typography>
        {rows === INVISIBLE && (
          <IssueNotice
            issue={{
              level: "warning",
              code: "marker_invisible",
              path: base,
              message: t("style_editor.marker_invisible"),
            }}
          />
        )}
      </>
    );
  return (
    <>
      {group.id === "label" ? (
        <LabelEditor base={base} />
      ) : (
        <PartRows group={group} geometry={geometry} shown={new Set(rows.split(","))} />
      )}
      <PartZooms base={base} />
    </>
  );
}

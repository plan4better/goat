"use client";

// Popup (prototype 2.9, spec 7.4): when it opens, its content and its appearance. Today's popup editors are used
// unchanged: they edit today's configuration (toPopupConfig), and every change goes back into the style with
// fromPopupConfig. Switching the popup off keeps its last content for this layer, so switching it on brings it back.
// A raster file's popup (spec 9.7) is this popup over the cell's fields (the panel's data give them): it opens on
// hover only where the map draws values (not for an image), its default content is the value and its class, and it
// has no feature to highlight or preview.
import dynamic from "next/dynamic";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { useLoadedRasterValues } from "@/lib/api/rasters";
import { drawsValueTiles } from "@/lib/style/compile/rasters";
import { symbolShown } from "@/lib/style/editor/parts";
import type { EditorStore } from "@/lib/style/editor/store";
import { colorsIn } from "@/lib/style/editor/summaries";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { coverageUrl } from "@/lib/style/layerSource";
import { fromPopupConfig, toPopupConfig } from "@/lib/style/popup";
import { bandFactsOf } from "@/lib/style/raster/metadata";
import {
  type RasterTexts,
  imagePixels,
  rasterPopupFrom,
  rasterPopupProperties,
  rasterPopupRuleOf,
} from "@/lib/style/raster/popup";
import { valueQuery, valuesUrl } from "@/lib/style/raster/values";
import type { PopupBlock, PopupProperties } from "@/lib/validations/layer";

import { HtmlModeCard } from "@/components/map/panels/style/popup/HtmlModeCard";
import { PopupAppearanceSettings } from "@/components/map/panels/style/popup/PopupAppearanceSettings";
import { PopupBlockList } from "@/components/map/panels/style/popup/PopupBlockList";
import { PopupPreviewController } from "@/components/map/panels/style/popup/PopupPreviewController";
import { BadgeBlockEditor } from "@/components/map/panels/style/popup/blocks/BadgeBlockEditor";
import { ButtonBlockEditor } from "@/components/map/panels/style/popup/blocks/ButtonBlockEditor";
import { DividerBlockEditor } from "@/components/map/panels/style/popup/blocks/DividerBlockEditor";
import { FieldListBlockEditor } from "@/components/map/panels/style/popup/blocks/FieldListBlockEditor";
import { ImageBlockEditor } from "@/components/map/panels/style/popup/blocks/ImageBlockEditor";
import type { OpenBlockColor } from "@/components/map/panels/style/popup/blocks/_shared";
import { blocksToHtml } from "@/components/map/panels/style/popup/blocksToHtml";
import {
  useEditor,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { ColorPicker } from "@/components/map/panels/styleEditor/pickers/ColorPicker";
import { ResetToDataset } from "@/components/map/panels/styleEditor/popovers/ResetToDataset";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import {
  ChoiceRow,
  NavRow,
  PanelSection,
  SegmentedRow,
  SwitchRow,
} from "@/components/map/panels/styleEditor/rows";
import type { LayerField } from "@/components/map/popover/formatFeatureProperties";

const TextBlockEditor = dynamic(
  () => import("@/components/map/panels/style/popup/blocks/TextBlockEditor").then((m) => m.TextBlockEditor),
  { ssr: false }
);

/** Today's block names (the "Add block" menu's keys). */
const BLOCK_LABEL_KEYS: Record<PopupBlock["type"], string> = {
  text: "text_block",
  fieldList: "field_list",
  image: "image",
  button: "button_block",
  badge: "badge_block",
  divider: "divider_block",
};
const SHOW_ON = ["off", "click", "hover", "click_and_hover"] as const;
const SHOW_ON_KEYS: Record<(typeof SHOW_ON)[number], string> = {
  off: "popup_off",
  click: "popup_on_click",
  hover: "popup_on_hover",
  click_and_hover: "popup_on_click_and_hover",
};

/** The last popup of each layer whose popup was switched off. */
const switchedOff = new WeakMap<EditorStore, unknown>();

/** How a layer's popup reads and writes: a vector layer's over its dataset's fields, a raster file's (`raster`) over
 * its cell's, with the default content of its render. */
interface PopupKind {
  raster: boolean;
  texts: RasterTexts;
  fieldTypes: Parameters<typeof toPopupConfig>[1];
}

/** Today's configuration of a style's popup (`popup`, in `doc`); null while it is off. */
function configOf(doc: LayerStyle, popup: unknown, kind: PopupKind): PopupProperties | null {
  if (!kind.raster) return toPopupConfig(popup, kind.fieldTypes);
  const style = { ...(doc as unknown as JsonObject), popup } as JsonObject;
  const rule = rasterPopupRuleOf(style);
  return rule ? rasterPopupProperties(style, rule, undefined, kind.texts) : null;
}

/** A style's `popup` from today's configuration; `original` is the popup as it was. */
function popupFrom(
  doc: LayerStyle,
  config: PopupProperties,
  original: unknown,
  kind: PopupKind
): JsonObject | false {
  if (!kind.raster) return fromPopupConfig(config, original);
  return rasterPopupFrom(config, { ...(doc as unknown as JsonObject), popup: original }, kind.texts);
}

/** The bands a popup's blocks or template name (`band_<n>`). */
function bandsNamed(config: PopupProperties): number[] {
  const text = config.mode === "html" ? config.html : JSON.stringify(config.blocks);
  return [...text.matchAll(/\bband_(\d+)\b/g)].map((m) => Number(m[1]));
}

/** The bands an image's pixels are the values of (`imagePixels`): a hover shows them without the raster service. */
const pixelBands = (doc: LayerStyle, kind: PopupKind): readonly number[] =>
  imagePixels(doc as unknown as JsonObject, bandFactsOf(kind.texts.info))?.bands ?? [];

/** How this panel's layer reads its popup; renders again when the render or the legend (a raster's default content)
 * changes. */
function usePopupKind(): PopupKind {
  const { t, i18n } = useTranslation("common");
  const data = useStyleData();
  useStyleValue("render");
  useStyleValue("legend");
  return {
    raster: !!data.raster,
    texts: { t, locale: i18n.language, info: data.raster?.info },
    fieldTypes: data.fieldTypes,
  };
}

/** Today's configuration of the style's popup and a way to change it; null while the popup is off. */
function usePopupConfig() {
  const store = useEditor();
  const data = useStyleData();
  const popup = useStyleValue<unknown>("popup");
  const kind = usePopupKind();
  const config = configOf(store.document, popup, kind);
  const update = (patch: Partial<PopupProperties>) => {
    if (!config) return;
    const next = popupFrom(store.document, { ...config, ...patch }, store.get("popup"), kind);
    store.set("popup", next === false || Object.keys(next).length ? next : undefined);
  };
  // Today's editors read fields as the layer API gives them.
  const fields: LayerField[] = data.fields.map((f) => ({
    name: f.name,
    type: f.type === "integer" ? "number" : f.type,
    ...(f.label !== f.name ? { display_config: { label: f.label } } : {}),
  }));
  // A file has no features: its editors ask no sample feature and no values of its dataset.
  const layerId = kind.raster ? "" : data.layerId;
  return { config, update, fields, layerId, layerName: data.layerName ?? "", raster: kind.raster, kind };
}

/** Whether a raster file's popup can open on hover: the map has its values to read (spec 9.7), on its value tiles or
 * in an image's pixels that are its values (`imagePixels`: 8 bit bands drawn as they are, or codes whose colors tell
 * them apart); not for other images or colors the raster service paints. Before the values' description has loaded,
 * as for any color scale. */
function useRasterHover(): boolean {
  const store = useEditor();
  const { raster } = useStyleData();
  const address = useStyleSelector((doc) => {
    const query = raster ? valueQuery(doc as unknown as JsonObject) : null;
    return raster && query ? valuesUrl(coverageUrl(raster.dataset), query) : undefined;
  });
  const described = useLoadedRasterValues(address);
  useStyleValue("render.bands");
  if (!raster) return true;
  const style = store.document as unknown as JsonObject;
  if (!address) return imagePixels(style, bandFactsOf(raster.info)) !== null;
  return !described || drawsValueTiles(style, described);
}

/** The editor's color picker for one color of a block, reading the block as stored now (it renders apart from the
 * block's editor), writing it back in the block. */
function BlockColorPicker<B extends PopupBlock>({
  id,
  read,
  write,
}: {
  id: string;
  read: (block: B) => string | undefined;
  write: (block: B, hex: string) => B;
}) {
  const store = useEditor();
  const { config, update } = usePopupConfig();
  const block = config?.blocks.find((b) => b.id === id) as B | undefined;
  if (!config || !block) return null;
  return (
    <ColorPicker
      value={read(block)}
      onChange={(hex) => update({ blocks: config.blocks.map((b) => (b.id === id ? write(b as B, hex) : b)) })}
      docColors={colorsIn(store.document)}
    />
  );
}

function PopupBlockEditor({ id }: { id: string }) {
  const popover = usePopover();
  const { config, update, fields, layerId } = usePopupConfig();
  const block = config?.blocks.find((b) => b.id === id);
  if (!config || !block) return null;
  const onChange = (next: PopupBlock) =>
    update({ blocks: config.blocks.map((b) => (b.id === id ? next : b)) });
  const openColor: OpenBlockColor = (anchor, title, read, write) =>
    popover.open("picker", {
      key: `popup-color:${id}:${title}`,
      title,
      anchorTop: anchorTopOf(anchor),
      anchorEl: anchor,
      render: () => (
        <BlockColorPicker
          id={id}
          read={read as (b: PopupBlock) => string}
          write={write as (b: PopupBlock, hex: string) => PopupBlock}
        />
      ),
    });
  switch (block.type) {
    case "text":
      return <TextBlockEditor block={block} onChange={onChange} />;
    case "fieldList":
      return <FieldListBlockEditor block={block} fields={fields} layerId={layerId} onChange={onChange} />;
    case "image":
      return <ImageBlockEditor block={block} onChange={onChange} />;
    case "button":
      return <ButtonBlockEditor block={block} onChange={onChange} openColor={openColor} />;
    case "badge":
      return <BadgeBlockEditor block={block} layerId={layerId} onChange={onChange} openColor={openColor} />;
    case "divider":
      return <DividerBlockEditor block={block} onChange={onChange} openColor={openColor} />;
  }
}

function PopupContentEditor() {
  const { t } = useTranslation("common");
  const popover = usePopover();
  const next = useNextLevel();
  const { config, update, fields, layerId, layerName, raster } = usePopupConfig();
  if (!config) return null;
  return (
    <>
      <SegmentedRow<PopupProperties["mode"]>
        label={t("style_editor.popup_mode")}
        value={config.mode}
        options={[
          { value: "simple", label: t("popup_mode_simple") },
          { value: "html", label: t("popup_mode_html") },
        ]}
        onChange={(mode) =>
          // HTML is seeded once from the blocks; after that it is its own source.
          update(
            mode === "html" && !config.html ? { mode, html: blocksToHtml(config.blocks, fields) } : { mode }
          )
        }
      />
      {config.mode === "simple" ? (
        <PopupBlockList
          blocks={config.blocks}
          onChange={(blocks) => update({ blocks })}
          onEdit={(block, anchorEl) =>
            popover.open(next, {
              key: `popup-block:${block.id}`,
              title: t(BLOCK_LABEL_KEYS[block.type]),
              anchorTop: anchorTopOf(anchorEl),
              render: () => <PopupBlockEditor id={block.id} />,
              onDelete: {
                label: t("style_editor.remove_block"),
                onClick: () => {
                  update({ blocks: config.blocks.filter((b) => b.id !== block.id) });
                  popover.close(next);
                },
              },
            })
          }
        />
      ) : (
        <HtmlModeCard
          layerId={layerId}
          layerName={layerName}
          popup={config}
          onChange={update}
          // A file's fields are its cell's, which the dataset API does not know.
          fields={raster ? fields : undefined}
        />
      )}
    </>
  );
}

function PopupAppearanceEditor() {
  const { t } = useTranslation("common");
  const { config, update, raster } = usePopupConfig();
  if (!config) return null;
  return (
    <>
      <PopupAppearanceSettings popup={config} onChange={update} />
      {/* A file's cell is no feature to mark. */}
      {!raster && (
        <SwitchRow
          label={t("style_editor.popup_highlight")}
          note={t("style_editor.popup_highlight_note")}
          on={config.highlight_active_feature}
          onToggle={() => update({ highlight_active_feature: !config.highlight_active_feature })}
        />
      )}
    </>
  );
}

/** The popup section; `children`: rows of a raster file's popup, under Show on. */
export function PopupSection({ children }: { children?: ReactNode }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  // A sample feature's popup pinned on the map while the section is being edited.
  const [preview, setPreview] = useState(false);
  const popover = usePopover();
  const next = useNextLevel();
  const { config, layerId, raster, kind } = usePopupConfig();
  const hoverable = useRasterHover();
  // A popup belongs to features that are drawn: not under a heatmap without points.
  if (!symbolShown(store.document)) return null;

  const showOn = (value: (typeof SHOW_ON)[number]) => {
    if (value === "off") {
      switchedOff.set(store, store.get("popup"));
      store.set("popup", false);
      return;
    }
    // A popup object is on: its keys, or none for the defaults.
    const stored = config ? store.get("popup") : switchedOff.get(store);
    const before = isObject(stored) ? stored : {};
    const base = configOf(store.document, before, kind);
    if (!base) return;
    const popup = popupFrom(store.document, { ...base, enabled: true, trigger: value }, before, kind);
    store.set("popup", popup === false || Object.keys(popup).length ? popup : undefined);
    switchedOff.delete(store);
  };
  // Where the map draws no values (an image, colors the raster service paints) the popup opens on click only (spec
  // 9.7); a hover trigger stored there still shows as set.
  const trigger = config ? config.trigger : "off";
  const options = hoverable ? SHOW_ON : SHOW_ON.filter((v) => !v.includes("hover") || v === trigger);
  // Band values are the raster service's, which a hover does not ask.
  const bandsOnClick =
    raster &&
    !!config &&
    config.trigger !== "click" &&
    bandsNamed(config).some((band) => !pixelBands(store.document, kind).includes(band));

  const label = t("style_editor.popup_show_on");
  const content = !config
    ? ""
    : config.mode === "html"
      ? t("style_editor.popup_html_lines", { count: config.html.split("\n").length })
      : config.blocks.map((b) => t(BLOCK_LABEL_KEYS[b.type])).join(", ");
  return (
    <PanelSection title={t("style_editor.section_popup")}>
      <ChoiceRow<(typeof SHOW_ON)[number]>
        label={label}
        value={trigger}
        options={options.map((v) => ({
          value: v,
          label: t(`style_editor.${SHOW_ON_KEYS[v]}`),
          sub: t(`style_editor.${raster ? "raster_" : ""}${SHOW_ON_KEYS[v]}_sub`),
        }))}
        onChange={showOn}
        note={bandsOnClick ? t("style_editor.popup_bands_on_click") : undefined}
      />
      {children}
      {config && (
        <NavRow
          label={t("style_editor.popup_content")}
          value={content}
          onOpen={(anchor) =>
            popover.open(next, {
              key: "popup:content",
              title: t("style_editor.popup_content"),
              anchorTop: anchorTopOf(anchor),
              actions: <ResetToDataset paths={["popup"]} />,
              render: () => <PopupContentEditor />,
            })
          }
        />
      )}
      {config && (
        <NavRow
          label={t("style_editor.popup_appearance")}
          value={t("style_editor.popup_appearance_summary", {
            layout: t(`style_editor.popup_layout_${config.layout}`),
            header: t(`style_editor.popup_header_${config.header}`),
          })}
          onOpen={(anchor) =>
            popover.open(next, {
              key: "popup:appearance",
              title: t("style_editor.popup_appearance"),
              anchorTop: anchorTopOf(anchor),
              actions: <ResetToDataset paths={["popup"]} />,
              render: () => <PopupAppearanceEditor />,
            })
          }
        />
      )}
      {config && layerId && (
        <SwitchRow
          label={t("style_editor.preview")}
          valueText={t("style_editor.popup_preview_value")}
          on={preview}
          onToggle={() => setPreview(!preview)}
        />
      )}
      {config && layerId && preview && <PopupPreviewController layerId={layerId} enabled />}
    </PanelSection>
  );
}

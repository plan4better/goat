"use client";

// Popup (prototype 2.9, spec 7.4): when it opens, its content and its appearance. Today's popup editors are used
// unchanged: they edit today's configuration (toPopupConfig), and every change goes back into the style with
// fromPopupConfig. Switching the popup off keeps its last content for this layer, so switching it on brings it back.
import dynamic from "next/dynamic";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { symbolShown } from "@/lib/style/editor/parts";
import type { EditorStore } from "@/lib/style/editor/store";
import { fromPopupConfig, toPopupConfig } from "@/lib/style/popup";
import type { PopupBlock, PopupProperties } from "@/lib/validations/layer";

import { HtmlModeCard } from "@/components/map/panels/style/popup/HtmlModeCard";
import { PopupAppearanceSettings } from "@/components/map/panels/style/popup/PopupAppearanceSettings";
import { PopupBlockList } from "@/components/map/panels/style/popup/PopupBlockList";
import { PopupModeToggle } from "@/components/map/panels/style/popup/PopupModeToggle";
import { PopupPreviewController } from "@/components/map/panels/style/popup/PopupPreviewController";
import { BadgeBlockEditor } from "@/components/map/panels/style/popup/blocks/BadgeBlockEditor";
import { ButtonBlockEditor } from "@/components/map/panels/style/popup/blocks/ButtonBlockEditor";
import { DividerBlockEditor } from "@/components/map/panels/style/popup/blocks/DividerBlockEditor";
import { FieldListBlockEditor } from "@/components/map/panels/style/popup/blocks/FieldListBlockEditor";
import { ImageBlockEditor } from "@/components/map/panels/style/popup/blocks/ImageBlockEditor";
import { blocksToHtml } from "@/components/map/panels/style/popup/blocksToHtml";
import { useEditor, useStyleData, useStyleValue } from "@/components/map/panels/styleEditor/context";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ChoiceRow, NavRow, PanelSection, Row, SwitchRow } from "@/components/map/panels/styleEditor/rows";
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

/** Today's configuration of the style's popup and a way to change it; null while the popup is off. */
function usePopupConfig() {
  const store = useEditor();
  const data = useStyleData();
  const popup = useStyleValue<unknown>("popup");
  const config = toPopupConfig(popup, data.fieldTypes);
  const update = (patch: Partial<PopupProperties>) => {
    if (!config) return;
    const next = fromPopupConfig({ ...config, ...patch }, store.get("popup"));
    store.set("popup", next === false || Object.keys(next).length ? next : undefined);
  };
  // Today's editors read fields as the layer API gives them.
  const fields: LayerField[] = data.fields.map((f) => ({
    name: f.name,
    type: f.type === "integer" ? "number" : f.type,
    ...(f.label !== f.name ? { display_config: { label: f.label } } : {}),
  }));
  return { config, update, fields, layerId: data.layerId, layerName: data.layerName ?? "" };
}

function PopupBlockEditor({ id }: { id: string }) {
  const { config, update, fields, layerId } = usePopupConfig();
  const block = config?.blocks.find((b) => b.id === id);
  if (!config || !block) return null;
  const onChange = (next: PopupBlock) =>
    update({ blocks: config.blocks.map((b) => (b.id === id ? next : b)) });
  switch (block.type) {
    case "text":
      return <TextBlockEditor block={block} fields={fields} onChange={onChange} />;
    case "fieldList":
      return <FieldListBlockEditor block={block} fields={fields} layerId={layerId} onChange={onChange} />;
    case "image":
      return <ImageBlockEditor block={block} fields={fields} onChange={onChange} />;
    case "button":
      return <ButtonBlockEditor block={block} onChange={onChange} />;
    case "badge":
      return <BadgeBlockEditor block={block} fields={fields} layerId={layerId} onChange={onChange} />;
    case "divider":
      return <DividerBlockEditor block={block} onChange={onChange} />;
  }
}

function PopupContentEditor() {
  const { t } = useTranslation("common");
  const popover = usePopover();
  const next = useNextLevel();
  const { config, update, fields, layerId, layerName } = usePopupConfig();
  if (!config) return null;
  return (
    <>
      <Row label={t("style_editor.popup_mode")}>
        <PopupModeToggle
          value={config.mode}
          onChange={(mode) =>
            // HTML is seeded once from the blocks; after that it is its own source.
            update(
              mode === "html" && !config.html ? { mode, html: blocksToHtml(config.blocks, fields) } : { mode }
            )
          }
        />
      </Row>
      {config.mode === "simple" ? (
        <PopupBlockList
          blocks={config.blocks}
          editingId={null}
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
        <HtmlModeCard layerId={layerId} layerName={layerName} popup={config} onChange={update} />
      )}
    </>
  );
}

function PopupAppearanceEditor() {
  const { t } = useTranslation("common");
  const { config, update } = usePopupConfig();
  if (!config) return null;
  return (
    <>
      <PopupAppearanceSettings popup={config} onChange={update} />
      <SwitchRow
        label={t("style_editor.popup_highlight")}
        note={t("style_editor.popup_highlight_note")}
        on={config.highlight_active_feature}
        onToggle={() => update({ highlight_active_feature: !config.highlight_active_feature })}
      />
    </>
  );
}

export function PopupSection() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { layerId } = useStyleData();
  // A sample feature's popup pinned on the map while the section is being edited.
  const [preview, setPreview] = useState(false);
  const popover = usePopover();
  const next = useNextLevel();
  const { config } = usePopupConfig();
  useStyleValue("render");
  // A popup belongs to features that are drawn: not under a heatmap without points.
  if (!symbolShown(store.document)) return null;

  const showOn = (value: (typeof SHOW_ON)[number]) => {
    if (value === "off") {
      switchedOff.set(store, store.get("popup"));
      store.set("popup", false);
      return;
    }
    const before = config ? store.get("popup") : switchedOff.get(store);
    const base = toPopupConfig(before);
    if (!base) return;
    const popup = fromPopupConfig({ ...base, enabled: true, trigger: value }, before);
    store.set("popup", popup === false || Object.keys(popup).length ? popup : undefined);
    switchedOff.delete(store);
  };

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
        value={config ? config.trigger : "off"}
        options={SHOW_ON.map((v) => ({
          value: v,
          label: t(`style_editor.${SHOW_ON_KEYS[v]}`),
          sub: t(`style_editor.${SHOW_ON_KEYS[v]}_sub`),
        }))}
        onChange={showOn}
      />
      {config && (
        <NavRow
          label={t("style_editor.popup_content")}
          value={content}
          onOpen={(anchor) =>
            popover.open(next, {
              key: "popup:content",
              title: t("style_editor.popup_content"),
              anchorTop: anchorTopOf(anchor),
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
              render: () => <PopupAppearanceEditor />,
            })
          }
        />
      )}
      {config && layerId && (
        <SwitchRow label={t("show_preview")} on={preview} onToggle={() => setPreview(!preview)} />
      )}
      {config && layerId && preview && <PopupPreviewController layerId={layerId} enabled />}
    </PanelSection>
  );
}

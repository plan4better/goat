"use client";

// Categories of a raster (prototype 3.5, spec 9.5): one color per cell value on the class grid, hidden ones
// transparent, values without a class in gray or not drawn. A class's name opens its editor (name, value and color);
// "Add a class" offers the codes the band holds that no class has, each in its color and with its share.
import { Typography } from "@mui/material";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { categoriesOf } from "@/lib/style/editor/raster";
import { getIn } from "@/lib/style/editor/store";
import { type JsonObject, isObject } from "@/lib/style/json";
import { codeShare } from "@/lib/style/raster/metadata";

import {
  useEditor,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { CATEGORY_GRAY } from "@/components/map/panels/styleEditor/editors/ClassGrid";
import {
  RasterClassList,
  renderBand,
  shareText,
  useCategoryOpener,
  useCodeLabel,
} from "@/components/map/panels/styleEditor/editors/RasterClassList";
import { DropdownMenu } from "@/components/map/panels/styleEditor/popovers/DropdownMenu";
import { anchorTopOf } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ChoiceRow } from "@/components/map/panels/styleEditor/rows";

const OTHER_GRAY = "#cccccc";

const classesOf = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** "Add a class": a menu of the codes the band holds that no class has, in the color the file's table (else the
 * palette) gives them, with their share of the cells; where the codes are not known, a class for the next value, its
 * editor open. `menu` is drawn by the caller. */
export function useCategoryAdder(): { open: (anchor: HTMLElement) => void; menu: ReactNode } {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const { raster } = useStyleData();
  const openCategory = useCategoryOpener();
  const codeLabel = useCodeLabel();
  const value = useStyleValue<unknown>("render");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const render: JsonObject = isObject(value) ? value : {};
  const info = raster?.info;
  const band = renderBand(render) ?? 1;
  const codes = categoriesOf(info, band, Infinity) ?? [];
  const used = new Set(classesOf(render.classes).map((c) => c.value));
  const add = (record: { value: number; color: string }) =>
    store.set("render.classes", [...classesOf(store.get("render.classes")), record]);
  const open = (el: HTMLElement) => {
    if (codes.length) {
      setAnchor(el);
      return;
    }
    const classes = classesOf(store.get("render.classes"));
    const numbers = classes.map((c) => c.value).filter((v): v is number => typeof v === "number");
    const next = numbers.length ? Math.max(...numbers) + 1 : 1;
    add({ value: next, color: info?.tableColors?.[next] ?? CATEGORY_GRAY });
    openCategory(classes.length, codeLabel(next), anchorTopOf(el));
  };
  const menu = (
    <DropdownMenu
      anchorEl={anchor}
      title={t("style_editor.add_category")}
      emptyText={t("style_editor.all_values_classed")}
      items={codes
        .filter((c) => !used.has(c.value))
        .map((c) => ({
          label: String(c.value),
          swatch: c.color,
          trailing: shareText(codeShare(info, band, c.value), i18n.language),
          onClick: () => add(c),
        }))}
      onClose={() => setAnchor(null)}
    />
  );
  return { open, menu };
}

export function CategoriesEditor() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const count = useStyleSelector((doc) => classesOf(getIn(doc, "render.classes")).length);
  const other = useStyleValue<unknown>("render.other_color");
  return (
    <>
      {count ? (
        <RasterClassList kind="categories" />
      ) : (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 3, py: 1 }}>
          {t("style_editor.categories_as_stored")}
        </Typography>
      )}
      <ChoiceRow<string>
        label={t("style_editor.other_values")}
        value={typeof other === "string" ? "gray" : "transparent"}
        options={["transparent", "gray"].map((v) => ({
          value: v,
          label: t(`style_editor.other_values_${v}`),
          sub: t(`style_editor.other_values_${v}_sub`),
        }))}
        onChange={(v) => store.set("render.other_color", v === "gray" ? OTHER_GRAY : undefined)}
      />
    </>
  );
}

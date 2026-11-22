"use client";

// Categories of a raster (prototype 3.5, spec 9.5), edited as a classification's classes: a Colors row in the panel
// sums them up and opens their editor in a popover. There, Classes shows every code the band holds or the 10, 20, 30
// or 50 most common, and Order sorts them most common first, by value or by name (or drag a row); then one color per
// cell value on the class grid, hidden ones transparent, values without a class in the Other values row (gray, or not
// drawn). A class's name opens its editor (name, value and color); "Add class" offers the codes the band holds that
// no class has, each in its color and with its share.
import { Box, Typography } from "@mui/material";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { MAX_CLASS_COUNT } from "@/lib/style/editor/classify";
import {
  CATEGORY_TOPS,
  type CategorySort,
  categoriesOf,
  categoryOrder,
  shownCount,
  sortCategories,
  topCategories,
} from "@/lib/style/editor/raster";
import { getIn, setIn } from "@/lib/style/editor/store";
import { type JsonObject, isObject } from "@/lib/style/json";
import { codeShare } from "@/lib/style/raster/metadata";

import {
  useEditor,
  useRasterWaiting,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { CATEGORY_GRAY } from "@/components/map/panels/styleEditor/editors/ClassGrid";
import { CLASS_LIST_MIN } from "@/components/map/panels/styleEditor/editors/ClassificationEditor";
import {
  RasterClassList,
  paletteStrip,
  renderBand,
  shareText,
  useCategoryOpener,
  useCodeLabel,
} from "@/components/map/panels/styleEditor/editors/RasterClassList";
import { DropdownMenu } from "@/components/map/panels/styleEditor/popovers/DropdownMenu";
import { ResetToDataset } from "@/components/map/panels/styleEditor/popovers/ResetToDataset";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { AddButton, ChoiceRow, NavRow } from "@/components/map/panels/styleEditor/rows";

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
      title={t("style_editor.add_class")}
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

/** "Add class" under the list, with its menu: on its own, so opening the menu does not draw the list again. */
function AddCategoryButton() {
  const { t } = useTranslation("common");
  const adder = useCategoryAdder();
  return (
    <>
      <AddButton onClick={(event) => adder.open(event.currentTarget)} sx={{ mt: 1, ml: 2 }}>
        {t("style_editor.add_class")}
      </AddButton>
      {adder.menu}
    </>
  );
}

/** What the categories show, as their row in the panel sums them up: all the band's codes, the most common ones, or
 * the classes picked by hand. */
function categoriesSummary(
  render: JsonObject,
  info: Parameters<typeof shownCount>[1],
  band: number,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const classes = classesOf(render.classes);
  if (!classes.length) return t("style_editor.raster_categories_as_stored");
  const shown = shownCount(render, info, band);
  if (shown === "all") return t("style_editor.raster_categories_all", { count: classes.length });
  if (typeof shown === "number") return t("style_editor.count_top", { count: shown });
  return t("style_editor.raster_categories_n", { count: classes.length });
}

/** The categories' row in the panel (as a color range's Colors row and a classification's row): what they show and
 * their colors; it opens their editor. */
export function CategoriesRow() {
  const { t } = useTranslation("common");
  const { raster } = useStyleData();
  const popover = usePopover();
  const next = useNextLevel();
  const waiting = useRasterWaiting();
  const value = useStyleValue<unknown>("render");
  const render: JsonObject = isObject(value) ? value : {};
  const colors = classesOf(render.classes).map((c) =>
    typeof c.color === "string" ? c.color : CATEGORY_GRAY
  );
  const strip = paletteStrip(colors, true);
  return (
    <NavRow
      label={t("style_editor.colors")}
      value={categoriesSummary(render, raster?.info, renderBand(render) ?? 1, t)}
      disabled={waiting}
      swatch={strip ? { background: strip, wide: true } : undefined}
      onOpen={(anchor) =>
        popover.open(next, {
          key: "raster:categories",
          title: t("style_editor.raster_type_categorical"),
          anchorTop: anchorTopOf(anchor),
          // The class list scrolls on its own below the settings, as a classification's.
          fill: true,
          actions: <ResetToDataset paths={["render"]} />,
          render: () => <CategoriesEditor />,
        })
      }
    />
  );
}

/** The categories' editor (in a popover, laid out as a classification's): how many and in which order above, the
 * class list below with Other values and "Add class". */
export function CategoriesEditor() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { raster } = useStyleData();
  const value = useStyleValue<unknown>("render");
  const render: JsonObject = isObject(value) ? value : {};
  const info = raster?.info;
  const band = renderBand(render) ?? 1;
  const classes = classesOf(render.classes);
  const stats = info?.stats.find((b) => b.index === band);
  const codes = stats?.values ?? null;
  // How many of the most common codes: for a file without a color table (a table defines its codes, all of them show).
  const tops = codes && !info?.colorTable ? CATEGORY_TOPS.filter((n) => n < codes.length) : [];
  const shown = shownCount(render, info, band);
  const counts = [
    ...(shown === "by_hand" ? ["by_hand"] : []),
    ...(codes && codes.length <= MAX_CLASS_COUNT ? ["all"] : []),
    ...tops.map(String),
  ];
  const order = categoryOrder(classes, info, band);
  const sorts: Array<CategorySort | "custom"> = [
    ...(stats?.counts ? (["share"] as const) : []),
    "value",
    "name",
    ...(order === "custom" ? (["custom"] as const) : []),
  ];
  const showCount = (n: string) =>
    store.update((doc) => {
      const now = getIn(doc, "render");
      return setIn(
        doc,
        "render",
        topCategories(isObject(now) ? now : render, info, band, n === "all" ? "all" : Number(n))
      );
    }, "render.classes");
  return (
    <>
      {/* The settings stay in view; a long class list scrolls on its own below them (the popover's `fill`). */}
      <Box sx={{ flex: "none" }}>
        {tops.length > 0 && (
          <ChoiceRow<string>
            label={t("style_editor.classes")}
            value={String(shown)}
            options={counts.map((n) => ({
              value: n,
              label:
                n === "by_hand"
                  ? t("style_editor.count_by_hand")
                  : n === "all"
                    ? t("style_editor.count_all")
                    : t("style_editor.count_top", { count: Number(n) }),
            }))}
            onChange={(n) => {
              if (n !== "by_hand") showCount(n);
            }}
          />
        )}
        {classes.length > 1 && (
          <ChoiceRow<CategorySort | "custom">
            label={t("style_editor.category_order")}
            value={order}
            options={sorts.map((by) => ({ value: by, label: t(`style_editor.category_order_${by}`) }))}
            onChange={(by) => {
              if (by !== "custom") store.set("render.classes", sortCategories(classes, by, info, band));
            }}
          />
        )}
      </Box>
      <Box
        data-popover-scroll
        sx={{
          flex: "0 1 auto",
          overflowY: "auto",
          minHeight: Math.min(CLASS_LIST_MIN, (Math.min(classes.length, 10) + 2) * 32),
        }}>
        <Box sx={{ py: 1 }}>
          {classes.length ? (
            <RasterClassList kind="categories" />
          ) : (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 3, py: 1 }}>
              {t("style_editor.categories_as_stored")}
            </Typography>
          )}
          <AddCategoryButton />
        </Box>
      </Box>
    </>
  );
}

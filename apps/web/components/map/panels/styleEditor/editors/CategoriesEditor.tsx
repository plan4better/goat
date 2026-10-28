"use client";

// Categories of a raster (prototype 3.5, spec 9.5): one color per cell value, hidden ones transparent, values without
// a class in gray or not drawn. A class's popover holds its name, value and color.
import { ButtonBase, IconButton, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { getIn } from "@/lib/style/editor/store";
import { type JsonObject, isObject } from "@/lib/style/json";

import {
  useEditor,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { ColorRow, PathColorPicker } from "@/components/map/panels/styleEditor/editors/ColorRow";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ChoiceRow, ColorField, NumberInput, Row, TextRow } from "@/components/map/panels/styleEditor/rows";

/** The panel's color for a new category, and for values without a class when they are drawn. */
export const CATEGORY_GRAY = "#9aa3ad";
const OTHER_GRAY = "#cccccc";

const classesOf = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);

function CategoryEditor({ index }: { index: number }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const record = useStyleValue<unknown>(`render.classes.${index}`);
  if (!isObject(record)) return null;
  const path = `render.classes.${index}`;
  return (
    <>
      <TextRow
        label={t("style_editor.category_name")}
        value={typeof record.name === "string" ? record.name : ""}
        placeholder={t("style_editor.value_n", { value: record.value })}
        onChange={(v) => store.set(`${path}.name`, v || undefined)}
      />
      <Row label={t("style_editor.cell_value")}>
        <NumberInput
          value={record.value as number}
          ariaLabel={t("style_editor.cell_value")}
          onChange={(v) => store.set(`${path}.value`, Math.round(v))}
        />
      </Row>
      <ColorRow label={t("style_editor.color")} path={`${path}.color`} fallback={CATEGORY_GRAY} />
    </>
  );
}

export function useCategoryAdder(): (anchorTop: number) => void {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { raster } = useStyleData();
  const popover = usePopover();
  const next = useNextLevel();
  return (anchorTop) => {
    const classes = classesOf(store.get("render.classes"));
    const values = classes.map((c) => c.value).filter((v): v is number => typeof v === "number");
    const value = values.length ? Math.max(...values) + 1 : 1;
    const color = raster?.info?.tableColors?.[value] ?? CATEGORY_GRAY;
    store.set("render.classes", [...classes, { value, color }]);
    const index = classes.length;
    popover.open(next, {
      key: `category:${index}`,
      title: t("style_editor.value_n", { value }),
      anchorTop,
      render: () => <CategoryEditor index={index} />,
      onDelete: {
        label: t("style_editor.remove_class"),
        onClick: () => {
          store.set(
            "render.classes",
            classesOf(store.get("render.classes")).filter((_, i) => i !== index)
          );
          popover.close(next);
        },
      },
    });
  };
}

/** One category's row: it reads its own class, so an edit of another class does not render it. */
function CategoryRow({ index }: { index: number }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const next = useNextLevel();
  const value = useStyleValue<unknown>(`render.classes.${index}`);
  if (!isObject(value)) return null;
  const c = value;
  const label = typeof c.name === "string" && c.name ? c.name : t("style_editor.value_n", { value: c.value });
  const hidden = c.visible === false;
  const path = `render.classes.${index}`;
  return (
    <Row
      actions={
        <IconButton
          size="small"
          aria-label={t(hidden ? "style_editor.show_class" : "style_editor.hide_class")}
          onClick={() => store.set(`${path}.visible`, hidden ? undefined : false)}>
          <Icon iconName={hidden ? ICON_NAME.EYE_SLASH : ICON_NAME.EYE} sx={{ fontSize: 12 }} />
        </IconButton>
      }>
      <ButtonBase
        onClick={(event) =>
          popover.open(next, {
            key: `category:${index}`,
            title: label,
            anchorTop: anchorTopOf(event.currentTarget),
            render: () => <CategoryEditor index={index} />,
            onDelete: {
              label: t("style_editor.remove_class"),
              onClick: () => {
                store.set(
                  "render.classes",
                  classesOf(store.get("render.classes")).filter((_, j) => j !== index)
                );
                popover.close(next);
              },
            },
          })
        }
        sx={{
          flex: 1,
          minWidth: 0,
          justifyContent: "flex-start",
          textAlign: "left",
          borderRadius: 0.5,
          py: 1,
        }}>
        <Typography variant="body2" noWrap>
          {label}
        </Typography>
      </ButtonBase>
      <ColorField
        value={typeof c.color === "string" ? c.color : CATEGORY_GRAY}
        onOpenPicker={(anchor) =>
          popover.open("picker", {
            key: `category-color:${index}`,
            title: label,
            anchorTop: anchorTopOf(anchor),
            anchorEl: anchor,
            render: () => (
              <PathColorPicker
                path={`${path}.color`}
                fallback={CATEGORY_GRAY}
                write={(color) => store.set(`${path}.color`, color)}
              />
            ),
          })
        }
      />
    </Row>
  );
}

export function CategoriesEditor() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const count = useStyleSelector((doc) => classesOf(getIn(doc, "render.classes")).length);
  const other = useStyleValue<unknown>("render.other_color");
  return (
    <>
      {!count && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 3, py: 1 }}>
          {t("style_editor.categories_as_stored")}
        </Typography>
      )}
      {Array.from({ length: count }, (_, i) => (
        <CategoryRow key={i} index={i} />
      ))}
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

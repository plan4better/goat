"use client";

// The lines of a label template styled one by one (spec 3.4 `lines`): size, color and font per line; a line without
// an entry keeps the label's style. A line's font (a weight, upright or italic, as the label's Font row offers) replaces
// the label's for that line. `lines` holds one value for the whole layer.
import { Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import {
  LABEL_FONT_CHOICE,
  classificationFor,
  compoundKeys,
  fixedChoice,
  writeCompound,
} from "@/lib/style/editor/forms";
import { perLayerPath } from "@/lib/style/editor/sources";
import { setIn } from "@/lib/style/editor/store";
import { compoundOptions } from "@/lib/style/editor/summaries";
import { type JsonObject, isObject } from "@/lib/style/json";

import {
  useEditor,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { PathColorPicker } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ChoiceRow, ColorField, NumberInput, Row } from "@/components/map/panels/styleEditor/rows";

/** `lines` without the entries at the end that set nothing; undefined when none is left. */
function trimmed(lines: JsonObject[]): JsonObject[] | undefined {
  const out = [...lines];
  while (out.length && !Object.keys(out[out.length - 1]).length) out.pop();
  return out.length ? out : undefined;
}

export function LabelLinesEditor({ base, count }: { base: string; count: number }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const { geometry } = useStyleData();
  // The lines' styles are one for the layer, wherever they are set (spec 6.1).
  const linesPath = useStyleSelector((doc) => perLayerPath(doc, `${base}.lines`));
  const value = useStyleValue<unknown>(linesPath);
  const labelValue = useStyleValue<unknown>(base);
  const classified = useStyleSelector((doc) =>
    compoundKeys(LABEL_FONT_CHOICE).some((key) => classificationFor(doc, key, geometry) !== undefined)
  );
  const lines = (Array.isArray(value) ? value : []).map((line) => (isObject(line) ? line : {}));
  // The label's font as one choice while it is fixed; none while it varies by zoom or by classes.
  const labelFont = classified ? undefined : fixedChoice(LABEL_FONT_CHOICE, labelValue);
  const update = (i: number, key: string, change: (line: JsonObject) => JsonObject) =>
    store.update((doc) => {
      const all = Array.from({ length: Math.max(lines.length, i + 1) }, (_, j) => lines[j] ?? {});
      all[i] = change(all[i]);
      return setIn(doc, linesPath, trimmed(all));
    }, `${linesPath}.${i}.${key}`);
  const write = (i: number, key: string, next: unknown) =>
    update(i, key, (line) => setIn(line, key, next) as JsonObject);
  // The label's own font leaves the line to the label; another font is the line's, both keys written.
  const writeFont = (i: number, choice: string) =>
    update(i, "font", (line) =>
      choice === labelFont
        ? (setIn(line, "font", undefined) as JsonObject)
        : writeCompound(line, LABEL_FONT_CHOICE, "", choice, true)
    );
  return (
    <>
      {Array.from({ length: count }, (_, i) => {
        const line = lines[i] ?? {};
        // A line without a font of its own draws the label's: shown while it is one font, none while it varies.
        const font = isObject(line.font) ? LABEL_FONT_CHOICE.read(line) : (labelFont ?? "");
        return (
          <div key={i}>
            <Typography
              variant="caption"
              color="text.secondary"
              fontWeight="bold"
              sx={{ display: "block", px: 3, pt: 2 }}>
              {t("style_editor.line_n", { n: i + 1 })}
            </Typography>
            <Row label={t("style_editor.size")}>
              <NumberInput
                value={typeof line.size === "number" ? line.size : undefined}
                unit="px"
                ariaLabel={t("style_editor.line_size")}
                onChange={(v) => write(i, "size", v)}
              />
            </Row>
            <Row label={t("style_editor.color")}>
              <ColorField
                value={typeof line.color === "string" ? line.color : undefined}
                onOpenPicker={(anchor) =>
                  popover.open("picker", {
                    key: `label-line-color:${i}`,
                    title: t("style_editor.line_n", { n: i + 1 }),
                    anchorTop: anchorTopOf(anchor),
                    anchorEl: anchor,
                    render: () => (
                      <PathColorPicker
                        path={`${linesPath}.${i}.color`}
                        write={(color) => write(i, "color", color)}
                      />
                    ),
                  })
                }
              />
            </Row>
            <ChoiceRow<string>
              label={t("style_editor.font")}
              value={font}
              options={compoundOptions(t, LABEL_FONT_CHOICE)}
              onChange={(choice) => writeFont(i, choice)}
            />
          </div>
        );
      })}
    </>
  );
}

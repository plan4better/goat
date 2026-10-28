"use client";

// The lines of a label template styled one by one (spec 3.4 `lines`): size, color and bold per line; a line without
// an entry keeps the label's style. `lines` holds one value for the whole layer.
import { Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { setIn } from "@/lib/style/editor/store";
import { type JsonObject, isObject } from "@/lib/style/json";

import { useEditor, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { PathColorPicker } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ColorField, NumberInput, Row, SwitchRow } from "@/components/map/panels/styleEditor/rows";

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
  const value = useStyleValue<unknown>(`${base}.lines`);
  const lines = (Array.isArray(value) ? value : []).map((line) => (isObject(line) ? line : {}));
  const write = (i: number, key: string, next: unknown) =>
    store.update((doc) => {
      const all = Array.from({ length: Math.max(lines.length, i + 1) }, (_, j) => lines[j] ?? {});
      all[i] = setIn(all[i], key, next) as JsonObject;
      return setIn(doc, `${base}.lines`, trimmed(all));
    }, `${base}.lines.${i}.${key}`);
  return (
    <>
      {Array.from({ length: count }, (_, i) => {
        const line = lines[i] ?? {};
        const bold = isObject(line.font) && line.font.weight === "bold";
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
                        path={`${base}.lines.${i}.color`}
                        write={(color) => write(i, "color", color)}
                      />
                    ),
                  })
                }
              />
            </Row>
            <SwitchRow
              label={t("style_editor.line_bold")}
              on={bold}
              onToggle={() => write(i, "font.weight", bold ? undefined : "bold")}
            />
          </div>
        );
      })}
    </>
  );
}

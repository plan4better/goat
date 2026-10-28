"use client";

// Rules (spec 6, prototype 2.6): conditions on any field and what they change, applied after the classifications in
// list order, so their order is their precedence.
import { Box, ButtonBase, IconButton, Typography } from "@mui/material";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { symbolShown } from "@/lib/style/editor/parts";
import { type JsonObject, isObject } from "@/lib/style/json";

import { useEditor, useStyleSelector, useStyleValue } from "@/components/map/panels/styleEditor/context";
import {
  NewRuleEditor,
  RuleEditor,
  useRuleLabel,
} from "@/components/map/panels/styleEditor/editors/RuleEditor";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { PanelSection, Row } from "@/components/map/panels/styleEditor/rows";
import { zoomText } from "@/components/map/panels/styleEditor/sections/LayerSection";

const PARTS = ["fill", "outline", "line", "casing", "arrows", "marker", "label"];

const effectsOf = (rule: JsonObject, t: TFunction) => {
  const out: string[] = [];
  if (rule.visible === false) out.push(t("style_editor.effect_hidden"));
  if (rule.min_zoom !== undefined || rule.max_zoom !== undefined)
    out.push(zoomText(t, rule.min_zoom, rule.max_zoom));
  for (const part of PARTS)
    if (part in rule) out.push(t(`style_editor.part_${part === "marker" ? "fill" : part}`));
  return out.length ? out.join(" · ") : t("style_editor.effect_none");
};

/** The rules' ids in order, as one string: the section renders again only when rules come, go or move. */
const ruleIds = (doc: unknown): string => {
  const rules = isObject(doc) ? doc.rules : undefined;
  return (Array.isArray(rules) ? rules : [])
    .map((rule, i) => (isObject(rule) && typeof rule.id === "string" ? rule.id : `#${i}`))
    .join("\n");
};

/** One rule's row: it reads its own rule, so an edit of another rule does not render it. */
function RuleRow({
  index,
  count,
  onOpen,
  onMove,
}: {
  index: number;
  count: number;
  onOpen: (id: string, anchorTop: number) => void;
  onMove: (from: number, to: number) => void;
}) {
  const { t } = useTranslation("common");
  const label = useRuleLabel();
  const value = useStyleValue<unknown>(`rules.${index}`);
  if (!isObject(value)) return null;
  const rule = value;
  const id = typeof rule.id === "string" ? rule.id : String(index);
  return (
    <Box data-rule-row>
      <Row
        label={label(rule)}
        actions={
          <>
            {index > 0 && (
              <IconButton
                size="small"
                aria-label={t("style_editor.move_rule_up")}
                onClick={() => onMove(index, index - 1)}>
                <Icon iconName={ICON_NAME.CHEVRON_UP} sx={{ fontSize: 10 }} />
              </IconButton>
            )}
            {index < count - 1 && (
              <IconButton
                size="small"
                aria-label={t("style_editor.move_rule_down")}
                onClick={() => onMove(index, index + 1)}>
                <Icon iconName={ICON_NAME.CHEVRON_DOWN} sx={{ fontSize: 10 }} />
              </IconButton>
            )}
          </>
        }>
        <ButtonBase
          onClick={(event) => onOpen(id, anchorTopOf(event.currentTarget))}
          sx={{
            flex: 1,
            minWidth: 0,
            justifyContent: "flex-start",
            textAlign: "left",
            py: 1,
            borderRadius: 0.5,
          }}>
          <Typography variant="body2" noWrap>
            {effectsOf(rule, t)}
          </Typography>
        </ButtonBase>
      </Row>
    </Box>
  );
}

export function RulesSection() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const next = useNextLevel();
  const ids = useStyleSelector(ruleIds);
  const shown = useStyleSelector(symbolShown);
  if (!shown) return null;
  const keys = ids ? ids.split("\n") : [];

  const open = (id: string, anchorTop: number) =>
    popover.open(next, {
      key: `rule:${id}`,
      title: t("style_editor.rule"),
      anchorTop,
      render: () => <RuleEditor id={id} />,
      onDelete: {
        label: t("style_editor.remove_rule"),
        onClick: () => {
          const current = store.get("rules");
          const kept = (Array.isArray(current) ? current : []).filter((r) => !(isObject(r) && r.id === id));
          store.set("rules", kept.length ? kept : undefined);
          popover.close(next);
        },
      },
    });
  const move = (from: number, to: number) => {
    const current = store.get("rules");
    const list = [...(Array.isArray(current) ? current : [])];
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    store.set("rules", list);
  };
  return (
    <PanelSection
      title={t("style_editor.section_rules")}
      add={{
        label: t("style_editor.add_rule"),
        onClick: () =>
          popover.open(next, {
            key: "rule:new",
            title: t("style_editor.new_rule"),
            anchorTop: 120,
            render: () => <NewRuleEditor onAdded={(id) => open(id, 120)} />,
          }),
      }}
      empty={keys.length ? undefined : t("style_editor.rules_empty")}>
      {keys.map((key, i) => (
        <RuleRow key={key} index={i} count={keys.length} onOpen={open} onMove={move} />
      ))}
    </PanelSection>
  );
}

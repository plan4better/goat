"use client";

// One rule (spec 6, prototype 4.8): its name, the condition, and what it does to the matching features: hide them,
// show them at fewer zooms, leave them out of the legend, or style them (the symbol section edits the rule then).
import { Box, Button, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { type ConditionRows, conditionSentence, fromRows, toRows } from "@/lib/style/editor/conditions";
import { setIn } from "@/lib/style/editor/store";
import { existingIds, freshId } from "@/lib/style/ids";
import { type JsonObject, deepEqual, isObject } from "@/lib/style/json";

import {
  useEditor,
  useLiveMapZoom,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { ConditionBuilder, EMPTY_ROW } from "@/components/map/panels/styleEditor/editors/ConditionBuilder";
import { SwitchRow, TextRow, ZoomRangeRow } from "@/components/map/panels/styleEditor/rows";

/** A rule's name, else its condition as a sentence. */
export function useRuleLabel(): (rule: unknown) => string {
  const { t } = useTranslation("common");
  const { fields, fieldTypes } = useStyleData();
  const label = (name: string) => fields.find((f) => f.name === name)?.label ?? name;
  return (rule) =>
    isObject(rule) && typeof rule.name === "string" && rule.name
      ? rule.name
      : conditionSentence(isObject(rule) ? rule.when : undefined, label, t, fieldTypes);
}

function Heading({ children }: { children: string }) {
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      fontWeight="bold"
      sx={{ display: "block", px: 3, pt: 2 }}>
      {children}
    </Typography>
  );
}

/** The condition of the rule at `index`: rows while they can show it, else its CQL2 as text to edit. */
function RuleCondition({ index }: { index: number }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { fieldTypes } = useStyleData();
  const when = useStyleValue<unknown>(`rules.${index}.when`);
  const [rows, setRows] = useState<ConditionRows | null>(() => toRows(when, fieldTypes));
  const [text, setText] = useState(() => JSON.stringify(when, null, 2));
  // An edit elsewhere (undo, the text editor) replaces the rows unless they already say the same.
  useEffect(() => {
    setRows((current) =>
      current && deepEqual(fromRows(current, fieldTypes), when) ? current : toRows(when, fieldTypes)
    );
  }, [when, fieldTypes]);
  if (!rows)
    return (
      <>
        <Typography variant="body2" color="text.secondary" sx={{ px: 3, py: 1 }}>
          {t("style_editor.condition_custom")}
        </Typography>
        <TextRow
          label={t("style_editor.edit_cql")}
          multiline
          value={text}
          onChange={(value) => {
            setText(value);
            try {
              const parsed = JSON.parse(value);
              if (isObject(parsed)) store.set(`rules.${index}.when`, parsed);
            } catch {
              // Written once it reads as JSON; its issues come back with the save.
            }
          }}
        />
      </>
    );
  return (
    <ConditionBuilder
      rows={rows}
      onChange={(next) => {
        setRows(next);
        const cql = fromRows(next, fieldTypes);
        if (cql) store.set(`rules.${index}.when`, cql);
      }}
    />
  );
}

export function RuleEditor({ id }: { id: string }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const mapZoom = useLiveMapZoom();
  const label = useRuleLabel();
  // Its own rule only: where it is now, then that rule.
  const index = useStyleSelector((doc) => {
    const rules = (doc as unknown as JsonObject).rules;
    return Array.isArray(rules) ? rules.findIndex((r) => isObject(r) && r.id === id) : -1;
  });
  const value = useStyleValue<unknown>(`rules.${index}`);
  const rule = index >= 0 && isObject(value) ? value : null;
  if (!rule) return null;
  const path = `rules.${index}`;
  return (
    <>
      <TextRow
        label={t("style_editor.rule_name")}
        value={typeof rule.name === "string" ? rule.name : ""}
        placeholder={label({ when: rule.when })}
        onChange={(value) => store.set(`${path}.name`, value || undefined)}
      />
      <Heading>{t("style_editor.when")}</Heading>
      <RuleCondition key={id} index={index} />
      <Heading>{t("style_editor.then")}</Heading>
      <SwitchRow
        label={t("style_editor.rule_visible")}
        on={rule.visible !== false}
        onToggle={() => store.set(`${path}.visible`, rule.visible === false ? undefined : false)}
      />
      <ZoomRangeRow
        from={rule.min_zoom as number | undefined}
        until={rule.max_zoom as number | undefined}
        mapZoom={mapZoom}
        onChange={(min, max) =>
          store.update(
            (doc) => setIn(setIn(doc, `${path}.min_zoom`, min), `${path}.max_zoom`, max),
            `${path}.zooms`
          )
        }
      />
      <SwitchRow
        label={t("style_editor.rule_legend")}
        on={rule.legend !== false}
        onToggle={() => store.set(`${path}.legend`, rule.legend === false ? undefined : false)}
      />
      <Box sx={{ px: 3, pt: 2 }}>
        <Button size="small" variant="outlined" onClick={() => store.setScope({ rule: id, index })}>
          {t("style_editor.style_matching")}
        </Button>
      </Box>
    </>
  );
}

/** A new rule: written once its condition is complete and confirmed. */
export function NewRuleEditor({ onAdded }: { onAdded: (id: string) => void }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { fieldTypes } = useStyleData();
  const [rows, setRows] = useState<ConditionRows>({ match: "all", rows: [EMPTY_ROW] });
  const when = fromRows(rows, fieldTypes);
  return (
    <>
      <Heading>{t("style_editor.when")}</Heading>
      <ConditionBuilder rows={rows} onChange={setRows} />
      <Box sx={{ px: 3, pt: 2 }}>
        <Button
          size="small"
          variant="contained"
          disabled={!when}
          onClick={() => {
            if (!when) return;
            const id = freshId("r", existingIds(store.document));
            const rules = store.get("rules");
            store.set("rules", [...(Array.isArray(rules) ? rules : []), { id, when }]);
            onAdded(id);
          }}>
          {t("style_editor.add_rule_confirm")}
        </Button>
      </Box>
    </>
  );
}

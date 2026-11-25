"use client";

// The "Classes" row of a value only classes set where no property row shows them (a part only classes turn on, hollow
// markers only classes fill, icons or shapes only classes give, label texts classes set): "By <field>", opening that
// classification's editor. `rowsOpening` (lib/style/editor/sources.ts) counts these rows. None while only rules do.
import { useTranslation } from "react-i18next";

import type { Setter } from "@/lib/style/editor/sources";
import { getIn } from "@/lib/style/editor/store";
import { setterSummary } from "@/lib/style/editor/summaries";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";

import { useEditor, useStyleData, useStyleSelector } from "@/components/map/panels/styleEditor/context";
import { useClassificationOpener } from "@/components/map/panels/styleEditor/editors/ClassificationEditor";
import { anchorTopOf } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { GroupRow } from "@/components/map/panels/styleEditor/rows";

export function SetByRow({ setterOf }: { setterOf: (doc: LayerStyle) => Setter | JsonObject | undefined }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { fields } = useStyleData();
  const openClassification = useClassificationOpener();
  const ci = useStyleSelector((doc) => {
    const setter = setterOf(doc);
    const all = getIn(doc, "classify");
    return setter && setter !== "rules" && Array.isArray(all) ? all.indexOf(setter) : -1;
  });
  if (ci < 0) return null;
  const c = getIn(store.document, `classify.${ci}`);
  return (
    <GroupRow
      label={t("style_editor.classes")}
      value={setterSummary(t, String(isObject(c) ? c.field : ""), fields)}
      onOpen={(anchor) => openClassification(ci, anchorTopOf(anchor))}
    />
  );
}

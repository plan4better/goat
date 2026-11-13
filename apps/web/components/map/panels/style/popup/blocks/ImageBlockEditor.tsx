import { useTranslation } from "react-i18next";

import type { PopupImageBlock } from "@/lib/validations/layer";

import { useStyleData } from "@/components/map/panels/styleEditor/context";
import { FieldPickerButton } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import { ChoiceRow, Row, SliderRow, TextRow } from "@/components/map/panels/styleEditor/rows";

interface Props {
  block: PopupImageBlock;
  onChange: (next: PopupImageBlock) => void;
}

const ASPECTS: PopupImageBlock["aspect"][] = ["16/9", "4/3", "3/2", "1/1", "2/3"];

export function ImageBlockEditor({ block, onChange }: Props) {
  const { t } = useTranslation("common");
  const { fields } = useStyleData();
  const field = fields.find((f) => f.name === block.field);

  return (
    <>
      <ChoiceRow<PopupImageBlock["source"]>
        label={t("image_source")}
        value={block.source}
        onChange={(source) => onChange({ ...block, source })}
        options={[
          { value: "field", label: t("from_field") },
          { value: "static", label: t("static_url") },
        ]}
      />
      {block.source === "field" ? (
        // Only text fields are reasonable URL holders.
        <Row label={t("image_field")}>
          <FieldPickerButton
            ariaLabel={t("image_field")}
            text={field?.label ?? t("style_editor.pick_field")}
            fields={fields}
            filter="text"
            value={block.field}
            onChange={(name) => onChange({ ...block, field: name })}
          />
        </Row>
      ) : (
        <TextRow
          label={t("image_url")}
          placeholder="https://…"
          value={block.url ?? ""}
          onChange={(url) => onChange({ ...block, url })}
        />
      )}
      <ChoiceRow<PopupImageBlock["sizing"]>
        label={t("image_sizing")}
        value={block.sizing}
        onChange={(sizing) => onChange({ ...block, sizing })}
        options={[
          { value: "fit", label: t("image_fit") },
          { value: "fixed", label: t("image_fixed_height") },
          { value: "aspect", label: t("image_aspect") },
        ]}
      />
      {block.sizing === "fixed" && (
        <SliderRow
          label={t("height")}
          min={40}
          max={400}
          step={10}
          unit="px"
          value={block.height}
          note={t("image_fixed_height_help")}
          onChange={(height) => onChange({ ...block, height })}
        />
      )}
      {block.sizing === "aspect" && (
        <ChoiceRow<PopupImageBlock["aspect"]>
          label={t("aspect_ratio")}
          value={block.aspect}
          onChange={(aspect) => onChange({ ...block, aspect })}
          options={ASPECTS.map((value) => ({ value, label: value.replace("/", ":") }))}
        />
      )}
    </>
  );
}

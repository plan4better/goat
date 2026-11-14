/**
 * Serial numbers and UUIDs: values the server assigns on create and never lets
 * a write change. Everything outside the editors treats a serial as a number
 * and a UUID as text; the editors show both read-only.
 */
import { describe, expect, it } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import { fieldEditability } from "@/lib/utils/allowedValues";
import { formatFieldValue } from "@/lib/utils/formatFieldValue";
import {
  ALLOWED_KINDS_BY_GEOM_TYPE,
  COMPUTED_KINDS,
  fieldDefinitionSchema,
  fieldKindSchema,
  isCreatableKind,
  isGeneratedKind,
  resolveDisplayKind,
} from "@/lib/validations/layer";

import { FIELD_KIND_LABEL_KEYS, fieldIndicatorKind } from "@/components/common/FieldKindIcon";

describe("generated kinds", () => {
  it("are offered on every geometry and when creating a layer", () => {
    for (const kinds of Object.values(ALLOWED_KINDS_BY_GEOM_TYPE)) {
      expect(kinds).toContain("serial");
      expect(kinds).toContain("uuid");
    }
    expect(isCreatableKind("serial")).toBe(true);
    expect(isCreatableKind("uuid")).toBe(true);
    // Not computed: the create dialog hides computed kinds, and these must stay.
    expect(COMPUTED_KINDS.has("serial")).toBe(false);
    expect(COMPUTED_KINDS.has("uuid")).toBe(false);
    expect(isGeneratedKind("serial") && isGeneratedKind("uuid")).toBe(true);
    expect(isGeneratedKind("number")).toBe(false);
  });

  it("validates a serial start as a whole number from 0", () => {
    const base = { id: "1", name: "nr", kind: "serial" as const };
    expect(fieldDefinitionSchema.safeParse({ ...base, start: 100 }).success).toBe(true);
    expect(fieldDefinitionSchema.safeParse({ ...base }).success).toBe(true);
    expect(fieldDefinitionSchema.safeParse({ ...base, start: -1 }).success).toBe(false);
    expect(fieldDefinitionSchema.safeParse({ ...base, start: 1.5 }).success).toBe(false);
  });

  it("are read-only in every editor, whether flagged or only declared", () => {
    for (const field of [{ kind: "serial" }, { kind: "uuid" }, { is_generated: true }]) {
      const editability = fieldEditability(field);
      expect(editability.generated).toBe(true);
      expect(editability.readOnly).toBe(true);
      expect(editability.computed).toBe(false);
      expect(editability.locked).toBe(false);
    }
    expect(fieldEditability({ kind: "number" }).readOnly).toBe(false);
  });

  it("format as identifiers: digits as stored, UUID verbatim", () => {
    expect(formatFieldValue(1234567, "serial", { thousands_separator: true, abbreviate: true })).toBe(
      "1234567"
    );
    const uid = "0625b5a7-50e1-4cfa-8392-7b0852e0d980";
    expect(formatFieldValue(uid, "uuid", {})).toBe(uid);
    expect(formatFieldValue(null, "serial", {})).toBe("");
  });

  it("style as a number and as text", () => {
    expect(resolveDisplayKind({ kind: "serial" })).toBe("number");
    expect(resolveDisplayKind({ kind: "uuid" })).toBe("string");
  });

  it("keep their own indicator", () => {
    expect(fieldIndicatorKind({ kind: "serial", type: "number" })).toBe("serial");
    expect(fieldIndicatorKind({ kind: "uuid", type: "string" })).toBe("uuid");
  });
});

describe("field kind labels", () => {
  const enStrings = en as Record<string, unknown>;
  const deStrings = de as Record<string, unknown>;

  it("exist in English and German for every kind", () => {
    for (const kind of fieldKindSchema.options) {
      const key = FIELD_KIND_LABEL_KEYS[kind];
      expect(typeof enStrings[key], `en ${key}`).toBe("string");
      expect(typeof deStrings[key], `de ${key}`).toBe("string");
    }
  });

  it("name the generated kinds as agreed", () => {
    expect(enStrings.field_kind_serial).toBe("Serial");
    expect(deStrings.field_kind_serial).toBe("Laufende Nummer");
    expect(enStrings.field_kind_uuid).toBe("UUID");
    expect(deStrings.field_kind_uuid).toBe("UUID (eindeutige Kennung)");
    expect(enStrings.assigned_automatically).toBe("Assigned automatically");
    expect(deStrings.assigned_automatically).toBe("Wird automatisch vergeben");
  });

  it("have every generated-field string in both languages", () => {
    for (const key of [
      "assigned_automatically",
      "generated_field_tooltip",
      "serial_field_hint",
      "uuid_field_hint",
      "serial_start",
      "serial_start_help",
      "serial_start_fixed",
      "convert_field_title",
      "convert_to_serial_confirm",
      "convert_to_number_confirm",
      "convert_field",
      "convert_field_failed",
    ]) {
      expect(typeof enStrings[key], `en ${key}`).toBe("string");
      expect(typeof deStrings[key], `de ${key}`).toBe("string");
      expect(deStrings[key], `de ${key} is translated`).not.toBe(enStrings[key]);
    }
  });
});

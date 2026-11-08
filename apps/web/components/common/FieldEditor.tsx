import type { DragEndEvent } from "@dnd-kit/core";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  FormControlLabel,
  IconButton,
  Input,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { v4 as uuidv4 } from "uuid";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { formatFieldValue } from "@/lib/utils/formatFieldValue";
import type { FieldDefinition, FieldKind } from "@/lib/validations/layer";
import {
  ALLOWED_KINDS_BY_GEOM_TYPE,
  COMPUTED_KINDS,
  RESERVED_FIELD_NAMES,
  isGeneratedKind,
} from "@/lib/validations/layer";

import type { SelectorItem } from "@/types/map/common";

import FieldKindIcon, { FIELD_KIND_LABEL_KEYS } from "@/components/common/FieldKindIcon";
import FormLabelHelper from "@/components/common/FormLabelHelper";
import Selector from "@/components/map/panels/common/Selector";
import { type FormulaField } from "@/components/modals/FormulaBuilder";

const FormulaBuilder = dynamic(() => import("@/components/modals/FormulaBuilder"), { ssr: false });

const DECIMALS_OPTIONS: ("auto" | number)[] = ["auto", 0, 1, 2, 3, 4, 5];

const UNIT_OPTIONS_BY_KIND: Record<FieldKind, string[]> = {
  string: [],
  number: [],
  area: ["auto", "mm²", "cm²", "m²", "ha", "km²"],
  perimeter: ["auto", "mm", "cm", "m", "km"],
  length: ["auto", "mm", "cm", "m", "km"],
  datetime: [],
  boolean: [],
  formula: [],
  serial: [],
  uuid: [],
};

const PREVIEW_VALUES_BY_KIND: Record<FieldKind, number[]> = {
  string: [],
  number: [1234.567, 12.35],
  area: [42500, 12.35],
  perimeter: [4250, 12.35],
  length: [4250, 12.35],
  datetime: [],
  boolean: [],
  formula: [],
  serial: [],
  uuid: [],
};

interface FieldEditorProps {
  fields: FieldDefinition[];
  onChange: (fields: FieldDefinition[]) => void;
  selectedFieldId: string | null;
  onSelectField: (id: string | null) => void;
  /** Optional override for remove — e.g. to show a confirmation dialog for existing fields */
  onRemoveOverride?: (id: string) => void;
  /** IDs of fields whose type cannot be changed (existing DB columns) */
  lockedFieldIds?: Set<string>;
  /**
   * Kinds a locked (existing) field may still be switched between, by field id
   * — e.g. an existing number column to "serial" and back. The type selector
   * of such a field offers only these instead of being disabled.
   */
  kindChoicesByField?: Record<string, FieldKind[]>;
  /** Fields whose serial start may still be set although they are locked: an
   * existing column about to become a serial. */
  startEditableFieldIds?: Set<string>;
  /** Layer geometry type — controls which computed kinds are offered. */
  geometryType?: "point" | "multipoint" | "line" | "multiline" | "polygon" | "multipolygon" | null;
  /**
   * When provided, clicking "Add field" calls this instead of creating an
   * in-place stub. Use this to open an AddFieldDialog from the parent.
   */
  onAddField?: () => void;
  /**
   * Dataset/layer id — enables formula fields (the formula builder validates
   * and previews expressions against this collection).
   */
  layerId?: string;
}

const ALL_FIELD_KINDS: FieldKind[] = [
  "string",
  "number",
  "area",
  "perimeter",
  "length",
  "datetime",
  "boolean",
  "serial",
  "uuid",
  "formula",
];

const NUMERIC_KINDS: FieldKind[] = ["number", "area", "perimeter", "length"];

/** Kinds a layer without geometry can carry: no geometry-derived ones. */
const TABLE_KINDS: FieldKind[] = ["string", "number", "datetime", "boolean", "serial", "uuid", "formula"];

// --- Sortable field row ---

interface SortableFieldRowProps {
  field: FieldDefinition;
  isSelected: boolean;
  error?: string;
  warning?: string;
  onSelect: () => void;
  onRename: (newName: string) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

const SortableFieldRow = ({
  field,
  isSelected,
  error,
  warning,
  onSelect,
  onRename,
  onDuplicate,
  onRemove,
}: SortableFieldRowProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: field.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <Box ref={setNodeRef} style={style}>
      <Stack
        direction="row"
        alignItems="center"
        onClick={onSelect}
        sx={{
          px: 0.5,
          py: 1.25,
          cursor: "pointer",
          borderLeft: isSelected
            ? `3px solid ${error ? theme.palette.error.main : theme.palette.primary.main}`
            : "3px solid transparent",
          backgroundColor: isSelected ? alpha(theme.palette.primary.main, 0.08) : "transparent",
          "&:hover": {
            backgroundColor: isSelected
              ? alpha(theme.palette.primary.main, 0.12)
              : theme.palette.action.hover,
            "& .field-actions": { opacity: 1 },
            "& .field-drag-handle": { opacity: 1 },
          },
        }}>
        {/* Drag handle */}
        <Box
          {...attributes}
          {...listeners}
          className="field-drag-handle"
          onClick={(e) => e.stopPropagation()}
          sx={{ cursor: "grab", display: "flex", alignItems: "center", mr: 0.5, opacity: 0 }}>
          <DragIndicatorIcon sx={{ fontSize: 16, color: theme.palette.text.secondary }} />
        </Box>

        {/* Type indicator */}
        <FieldKindIcon kind={field.kind} error={!!error} />

        {/* Always-visible input */}
        <Input
          value={field.name}
          onChange={(e) => onRename(e.target.value)}
          onFocus={onSelect}
          disableUnderline
          placeholder={t("field_name")}
          autoFocus={isSelected}
          error={!!error}
          // A bundle's own column is looked up by name by every tool that
          // reads the layer, so the name is not the user's to change.
          readOnly={field.is_protected}
          inputProps={{ maxLength: 128 }}
          sx={{
            flex: 1,
            ml: 0.5,
            "& .MuiInputBase-input": {
              py: 0.5,
              fontSize: "0.875rem",
            },
          }}
        />

        {/* Action buttons — visible on hover */}
        <Stack className="field-actions" direction="row" spacing={0} sx={{ flexShrink: 0, opacity: 0 }}>
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate();
            }}>
            <Icon
              iconName={ICON_NAME.COPY}
              style={{ fontSize: 14 }}
              htmlColor={theme.palette.text.secondary}
            />
          </IconButton>
          {/* Not offered for a column the bundle brought: the server refuses
              it, so the button could only produce an error. */}
          <IconButton
            size="small"
            disabled={field.is_protected}
            sx={{ display: field.is_protected ? "none" : undefined }}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}>
            <Icon
              iconName={ICON_NAME.MINUS}
              style={{ fontSize: 14 }}
              htmlColor={theme.palette.text.secondary}
            />
          </IconButton>
        </Stack>
      </Stack>
      {/* Error or warning message */}
      {error && (
        <Typography variant="caption" color="error" sx={{ pl: 6, pb: 0.5, display: "block" }}>
          {error}
        </Typography>
      )}
      {!error && warning && (
        <Typography variant="caption" color="warning.main" sx={{ pl: 6, pb: 0.5, display: "block" }}>
          {warning}
        </Typography>
      )}
    </Box>
  );
};

// --- Main FieldEditor ---

/**
 * The vocabulary editor for a column.
 *
 * Matches the chips input the tool forms use (`toolbox/generic/inputs/
 * ChipsInput`): a value is committed on Enter *or* on blur, so typing one and
 * clicking away does not silently discard it. That component is bound to the
 * OGC-processes form model and is numbers-only, so the interaction is mirrored
 * here rather than shared.
 */
const AllowedValuesInput = ({
  values,
  onChange,
  label,
  placeholder,
  helperText,
  numeric,
  invalidMessage,
}: {
  values: (string | number)[];
  onChange: (values: (string | number)[]) => void;
  label: string;
  placeholder: string;
  helperText: string;
  numeric: boolean;
  invalidMessage: string;
}) => {
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: (string | number)[]) => {
    // Trimmed and de-duplicated: a stray duplicate or a trailing space would
    // look identical in the dropdown while never matching what is stored.
    const cleaned = next.map((v) => String(v).trim()).filter(Boolean);
    // A number column holding the string "30" would never match the 30 a write
    // sends, so the value is stored as the column's own type — and a value that
    // cannot be one is refused rather than dropped without a word.
    const rejected = numeric ? cleaned.filter((v) => !Number.isFinite(Number(v))) : [];
    setError(rejected.length > 0 ? invalidMessage : null);
    const kept = cleaned.filter((v) => !rejected.includes(v)).map((v) => (numeric ? Number(v) : v));
    const deduped = Array.from(new Set(kept));
    setInputValue("");
    // A value that is already in the vocabulary changes nothing, so the field
    // is not reported as edited either.
    const unchanged = deduped.length === values.length && deduped.every((v, i) => v === values[i]);
    if (!unchanged) onChange(deduped);
  };

  return (
    <Stack>
      <FormLabelHelper label={label} color="inherit" />
      <Autocomplete
        multiple
        freeSolo
        size="small"
        options={[] as string[]}
        value={values.map(String)}
        inputValue={inputValue}
        onInputChange={(_event, next) => setInputValue(next)}
        onChange={(_event, next) => commit(next as string[])}
        // Both commit paths — Enter and blur — are the `commit` above, which
        // de-duplicates, so entering a value that is already a chip is a no-op.
        // Without this, MUI matches the typed value against the chips itself
        // and treats an already-selected option as a toggle; the two paths
        // would then disagree about what entering a duplicate means.
        isOptionEqualToValue={() => false}
        inputMode={numeric ? "numeric" : "text"}
        onBlur={() => {
          if (inputValue.trim()) commit([...values, inputValue]);
        }}
        renderTags={(tagValues, getTagProps) =>
          tagValues.map((option, index) => {
            const { key, ...tagProps } = getTagProps({ index });
            return <Chip key={key} size="small" label={option} {...tagProps} />;
          })
        }
        renderInput={(params) => (
          <TextField {...params} error={!!error} placeholder={placeholder} helperText={error ?? helperText} />
        )}
      />
    </Stack>
  );
};

const FieldEditor: React.FC<FieldEditorProps> = ({
  fields,
  onChange,
  selectedFieldId,
  onSelectField,
  onRemoveOverride,
  lockedFieldIds,
  kindChoicesByField,
  startEditableFieldIds,
  geometryType,
  onAddField,
  layerId,
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [formulaBuilderOpen, setFormulaBuilderOpen] = useState(false);

  const selectedField = fields.find((f) => f.id === selectedFieldId) ?? null;

  // Columns the formula builder can reference: every other field, typed for
  // its client-side validation (formula fields count as their result kind).
  const formulaFields: FormulaField[] = useMemo(
    () =>
      fields
        .filter((f) => f.id !== selectedFieldId)
        .map((f) => {
          const kind = f.kind === "formula" ? (f.output_kind ?? "string") : f.kind;
          const type =
            kind === "number" ||
            kind === "area" ||
            kind === "perimeter" ||
            kind === "length" ||
            kind === "serial"
              ? "number"
              : kind === "boolean"
                ? "boolean"
                : "string";
          return { name: f.name, type };
        }),
    [fields, selectedFieldId]
  );

  const handleFormulaChange = (id: string, expression: string) => {
    onChange(fields.map((f) => (f.id === id ? { ...f, formula: expression } : f)));
  };

  // Derived values need a table to derive them from, so every computed kind —
  // formula included — is offered only when editing an existing dataset (layerId
  // present). At creation there is no `field_config` yet to carry the expression
  // or the compute SQL, so such a column would be made and never filled.
  const baseKinds: FieldKind[] = geometryType
    ? (ALLOWED_KINDS_BY_GEOM_TYPE[geometryType] ?? TABLE_KINDS)
    : TABLE_KINDS;
  const availableKinds: FieldKind[] = baseKinds.filter((k) => !COMPUTED_KINDS.has(k) || !!layerId);

  const allFieldTypeItems = useMemo(
    () =>
      Object.fromEntries(
        ALL_FIELD_KINDS.map((k) => [
          k,
          { value: k, label: t(FIELD_KIND_LABEL_KEYS[k]), iconNode: <FieldKindIcon kind={k} /> },
        ])
      ) as Record<FieldKind, SelectorItem>,
    [t]
  );
  const fieldTypeItems: SelectorItem[] = availableKinds.map((k) => allFieldTypeItems[k]);
  const hasFields = fields.length > 0;

  // Compute per-field validation errors
  // Simple identifier check — names that are safe for all export formats
  const SAFE_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

  const { fieldErrors, fieldWarnings } = useMemo(() => {
    const errors: Record<string, string> = {};
    const warnings: Record<string, string> = {};
    const nameCounts = new Map<string, number>();

    // Count occurrences of each name (case-insensitive)
    for (const field of fields) {
      const lower = field.name.toLowerCase();
      nameCounts.set(lower, (nameCounts.get(lower) || 0) + 1);
    }

    for (const field of fields) {
      const name = field.name;
      if (!name || name.trim().length === 0) {
        errors[field.id] = t("field_name_required");
      } else if (RESERVED_FIELD_NAMES.includes(name.toLowerCase())) {
        errors[field.id] = t("field_name_reserved");
      } else if ((nameCounts.get(name.toLowerCase()) || 0) > 1) {
        errors[field.id] = t("field_name_unique");
      } else if (!SAFE_NAME_REGEX.test(name)) {
        warnings[field.id] = t("field_name_special_chars_warning");
      }
      if (!errors[field.id] && field.kind === "formula" && !field.formula?.trim()) {
        errors[field.id] = t("formula_required");
      }
    }
    return { fieldErrors: errors, fieldWarnings: warnings };
  }, [fields, t]);

  const handleAddField = () => {
    // If caller provides an onAddField handler, delegate to it (e.g. to open
    // an AddFieldDialog) rather than creating an in-place stub.
    if (onAddField) {
      onAddField();
      return;
    }

    // Fallback: create an in-place stub (used by CreateLayer and other
    // consumers that don't have a dedicated add-field dialog).
    // Auto-increment name: new_field, new_field_2, new_field_3, ...
    const baseName = t("field_name_default");
    const existingNames = new Set(fields.map((f) => f.name.toLowerCase()));
    let fieldName = baseName;
    let counter = 2;
    while (existingNames.has(fieldName.toLowerCase())) {
      fieldName = `${baseName}_${counter}`;
      counter++;
    }
    const newField: FieldDefinition = {
      id: uuidv4(),
      name: fieldName,
      kind: "string",
      is_computed: false,
      display_config: {},
    };
    onChange([...fields, newField]);
    onSelectField(newField.id);
  };

  const handleDuplicate = (field: FieldDefinition) => {
    const copySuffix = t("field_name_copy_suffix");
    const existingNames = new Set(fields.map((f) => f.name.toLowerCase()));
    let copyName = `${field.name}_${copySuffix}`;
    let counter = 2;
    while (existingNames.has(copyName.toLowerCase())) {
      copyName = `${field.name}_${copySuffix}_${counter}`;
      counter++;
    }
    const copy: FieldDefinition = {
      id: uuidv4(),
      name: copyName,
      kind: field.kind,
      is_computed: field.is_computed,
      display_config: field.display_config,
      ...(field.kind === "serial" && field.start !== undefined ? { start: field.start } : {}),
    };
    const idx = fields.findIndex((f) => f.id === field.id);
    const next = [...fields];
    next.splice(idx + 1, 0, copy);
    onChange(next);
    onSelectField(copy.id);
  };

  const handleRemove = (id: string) => {
    if (onRemoveOverride) {
      onRemoveOverride(id);
      return;
    }
    const next = fields.filter((f) => f.id !== id);
    onChange(next);
    if (selectedFieldId === id) {
      onSelectField(next.length > 0 ? next[0].id : null);
    }
  };

  const handleRenameField = (id: string, newName: string) => {
    onChange(fields.map((f) => (f.id === id ? { ...f, name: newName } : f)));
  };

  const handleAllowedValuesChange = (id: string, values: (string | number)[]) => {
    // Already trimmed, de-duplicated and typed by the input.
    onChange(
      fields.map((f) => (f.id === id ? { ...f, allowed_values: values.length > 0 ? values : undefined } : f))
    );
  };

  const handleAllowOtherChange = (id: string, allowOther: boolean) => {
    onChange(fields.map((f) => (f.id === id ? { ...f, allow_other: allowOther } : f)));
  };

  const handleTypeChange = (id: string, item: SelectorItem | SelectorItem[] | undefined) => {
    if (!item || Array.isArray(item)) return;
    const kind = item.value as FieldKind;
    onChange(
      fields.map((f) => {
        if (f.id !== id) return f;
        // A vocabulary belongs to the type it was written for. Values that
        // still fit the new one are kept — "30" is a fine number — and the
        // rest go, rather than being stored as something that can never match
        // what a write sends. Only these two kinds carry one at all.
        const allowed =
          kind === "number"
            ? f.allowed_values?.map(Number).filter((v) => Number.isFinite(v))
            : kind === "string"
              ? f.allowed_values?.map(String)
              : undefined;
        return {
          ...f,
          kind,
          allowed_values: allowed?.length ? allowed : undefined,
          allow_other: allowed?.length ? f.allow_other : undefined,
          // Only a serial counts from somewhere.
          start: kind === "serial" ? f.start : undefined,
        };
      })
    );
  };

  const handleStartChange = (id: string, raw: string) => {
    // Blank means the default (1); anything else must be a whole number >= 0.
    const value = raw.trim() === "" ? undefined : Number(raw);
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) return;
    onChange(fields.map((f) => (f.id === id ? { ...f, start: value } : f)));
  };

  const handleDisplayConfigChange = (id: string, partial: Record<string, unknown>) => {
    onChange(
      fields.map((f) =>
        f.id === id ? { ...f, display_config: { ...(f.display_config ?? {}), ...partial } } : f
      )
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = fields.findIndex((f) => f.id === active.id);
      const newIndex = fields.findIndex((f) => f.id === over.id);
      const reordered = [...fields];
      const [removed] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, removed);
      onChange(reordered);
    }
  };

  // Empty state — no fields defined yet
  if (!hasFields) {
    return (
      <Stack sx={{ height: 340 }} alignItems="center" justifyContent="center" spacing={2}>
        <Icon iconName={ICON_NAME.TABLE} fontSize="small" htmlColor={theme.palette.text.secondary} />
        <Typography variant="body2" color="text.secondary">
          {t("no_fields")}
        </Typography>
        <Button
          variant="text"
          size="small"
          startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 11 }} />}
          onClick={handleAddField}
          sx={{ textTransform: "none" }}>
          {t("add_field")}
        </Button>
      </Stack>
    );
  }

  return (
    <Stack direction="row" sx={{ height: 340 }} spacing={0}>
      {/* Left column — field list */}
      <Box
        sx={{
          width: "55%",
          borderRight: `1px solid ${theme.palette.divider}`,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}>
        <Box sx={{ flexGrow: 1, overflowY: "auto" }}>
          <DndContext
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleDragEnd}>
            <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
              {fields.map((field) => (
                <SortableFieldRow
                  key={field.id}
                  field={field}
                  isSelected={field.id === selectedFieldId}
                  error={fieldErrors[field.id]}
                  warning={fieldWarnings[field.id]}
                  onSelect={() => onSelectField(field.id)}
                  onRename={(newName) => handleRenameField(field.id, newName)}
                  onDuplicate={() => handleDuplicate(field)}
                  onRemove={() => handleRemove(field.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </Box>

        {/* Add field button */}
        <Box
          sx={{
            px: 1,
            py: 1.5,
            borderTop: `1px solid ${theme.palette.divider}`,
          }}>
          <Button
            variant="text"
            size="small"
            startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 11 }} />}
            onClick={handleAddField}
            sx={{ textTransform: "none" }}>
            {t("add_field")}
          </Button>
        </Box>
      </Box>

      {/* Right column — settings */}
      <Box
        sx={{
          width: "45%",
          p: 2,
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
        }}>
        {selectedField ? (
          (() => {
            const cfg = (selectedField.display_config ?? {}) as {
              decimals?: "auto" | number;
              unit?: string;
              thousands_separator?: boolean;
              abbreviate?: boolean;
              always_show_sign?: boolean;
            };
            // Formula fields format as their inferred result kind; unknown
            // until first saved (the backend infers it), so no formatting
            // options are offered for a brand-new formula field.
            const isFormula = selectedField.kind === "formula";
            const formatKind = (isFormula ? selectedField.output_kind : selectedField.kind) as
              | FieldKind
              | undefined;
            const showFormat = !!formatKind && NUMERIC_KINDS.includes(formatKind);
            const unitOptions = formatKind ? UNIT_OPTIONS_BY_KIND[formatKind] : [];
            const previewValues = formatKind ? PREVIEW_VALUES_BY_KIND[formatKind] : [];
            return (
              <Stack spacing={2}>
                <Typography variant="subtitle2" fontWeight="bold">
                  {selectedField.name}
                </Typography>
                {COMPUTED_KINDS.has(selectedField.kind) && (
                  <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
                    <Icon iconName={ICON_NAME.LOCK} style={{ fontSize: 12 }} />
                    <Typography variant="caption" color="text.secondary">
                      {t("computed_read_only")}
                    </Typography>
                  </Box>
                )}
                {isGeneratedKind(selectedField.kind) && (
                  <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
                    <Icon iconName={ICON_NAME.LOCK} style={{ fontSize: 12 }} />
                    <Typography variant="caption" color="text.secondary">
                      {t(selectedField.kind === "serial" ? "serial_field_hint" : "uuid_field_hint")}
                    </Typography>
                  </Box>
                )}
                <Selector
                  label={t("field_type")}
                  selectedItems={
                    allFieldTypeItems[selectedField.kind] ??
                    fieldTypeItems.find((i) => i.value === selectedField.kind)
                  }
                  setSelectedItems={(item) => handleTypeChange(selectedField.id, item)}
                  items={
                    kindChoicesByField?.[selectedField.id]?.map((k) => allFieldTypeItems[k]) ?? fieldTypeItems
                  }
                  disabled={lockedFieldIds?.has(selectedField.id) && !kindChoicesByField?.[selectedField.id]}
                />

                {selectedField.kind === "serial" &&
                  (() => {
                    // Existing rows were numbered from it when the column was
                    // added; changing it afterwards would not renumber them.
                    // An existing column about to become a serial still takes
                    // one, for its blank rows.
                    const startFixed =
                      !!lockedFieldIds?.has(selectedField.id) &&
                      !startEditableFieldIds?.has(selectedField.id);
                    return (
                      <TextField
                        size="small"
                        type="number"
                        label={t("serial_start")}
                        helperText={t(startFixed ? "serial_start_fixed" : "serial_start_help")}
                        value={selectedField.start ?? ""}
                        placeholder="1"
                        inputProps={{ min: 0, step: 1, "data-testid": "serial-start" }}
                        disabled={startFixed}
                        onChange={(e) => handleStartChange(selectedField.id, e.target.value)}
                      />
                    );
                  })()}

                {(selectedField.kind === "string" || selectedField.kind === "number") && (
                  <Stack spacing={1}>
                    <AllowedValuesInput
                      key={selectedField.id}
                      label={t("allowed_values")}
                      placeholder={t("type_value_enter")}
                      helperText={t("allowed_values_help")}
                      numeric={selectedField.kind === "number"}
                      invalidMessage={t("allowed_values_must_be_numbers")}
                      values={selectedField.allowed_values ?? []}
                      onChange={(values) => handleAllowedValuesChange(selectedField.id, values)}
                    />
                    {(selectedField.allowed_values?.length ?? 0) > 0 && (
                      <FormControlLabel
                        control={
                          <Switch
                            size="small"
                            checked={!!selectedField.allow_other}
                            onChange={(e) => handleAllowOtherChange(selectedField.id, e.target.checked)}
                          />
                        }
                        label={<Typography variant="caption">{t("allow_other_values")}</Typography>}
                      />
                    )}
                  </Stack>
                )}

                {isFormula && (
                  <Stack spacing={1}>
                    <Typography variant="caption" color="text.secondary">
                      {t("formula")}
                    </Typography>
                    {selectedField.formula ? (
                      <Box
                        sx={{
                          px: 1.5,
                          py: 1,
                          bgcolor: "action.hover",
                          borderRadius: 1,
                          fontFamily: "monospace",
                          fontSize: "0.75rem",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          maxHeight: 120,
                          overflowY: "auto",
                        }}>
                        {selectedField.formula}
                      </Box>
                    ) : (
                      <Typography variant="caption" color="text.disabled">
                        {t("no_formula_yet")}
                      </Typography>
                    )}
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<Icon iconName={ICON_NAME.CODE} style={{ fontSize: 14 }} />}
                      onClick={() => setFormulaBuilderOpen(true)}
                      sx={{ alignSelf: "flex-start", textTransform: "none" }}>
                      {selectedField.formula ? t("edit_formula") : t("add_formula")}
                    </Button>
                  </Stack>
                )}

                {showFormat && (
                  <>
                    <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                      <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="caption" color="text.secondary">
                          {t("decimals")}
                        </Typography>
                        <Select
                          size="small"
                          fullWidth
                          value={String(cfg.decimals ?? "auto")}
                          onChange={(e) => {
                            const v = e.target.value;
                            handleDisplayConfigChange(selectedField.id, {
                              decimals: v === "auto" ? "auto" : Number(v),
                            });
                          }}>
                          {DECIMALS_OPTIONS.map((o) => (
                            <MenuItem key={String(o)} value={String(o)}>
                              {o === "auto" ? t("auto") : o}
                            </MenuItem>
                          ))}
                        </Select>
                      </Stack>
                      {unitOptions.length > 0 && (
                        <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                          <Typography variant="caption" color="text.secondary">
                            {t("unit")}
                          </Typography>
                          <Select
                            size="small"
                            fullWidth
                            value={cfg.unit ?? "auto"}
                            onChange={(e) =>
                              handleDisplayConfigChange(selectedField.id, {
                                unit: e.target.value,
                              })
                            }>
                            {unitOptions.map((u) => (
                              <MenuItem key={u} value={u}>
                                {u === "auto" ? t("auto") : u}
                              </MenuItem>
                            ))}
                          </Select>
                        </Stack>
                      )}
                    </Stack>
                    <FormControlLabel
                      control={
                        <Switch
                          size="small"
                          checked={cfg.thousands_separator ?? false}
                          onChange={(e) =>
                            handleDisplayConfigChange(selectedField.id, {
                              thousands_separator: e.target.checked,
                            })
                          }
                        />
                      }
                      label={<Typography variant="caption">{t("show_thousands_separator")}</Typography>}
                    />
                    <FormControlLabel
                      control={
                        <Switch
                          size="small"
                          checked={cfg.abbreviate ?? false}
                          onChange={(e) =>
                            handleDisplayConfigChange(selectedField.id, {
                              abbreviate: e.target.checked,
                            })
                          }
                        />
                      }
                      label={<Typography variant="caption">{t("abbreviate_large_numbers")}</Typography>}
                    />
                    <FormControlLabel
                      control={
                        <Switch
                          size="small"
                          checked={cfg.always_show_sign ?? false}
                          onChange={(e) =>
                            handleDisplayConfigChange(selectedField.id, {
                              always_show_sign: e.target.checked,
                            })
                          }
                        />
                      }
                      label={<Typography variant="caption">{t("always_show_sign")}</Typography>}
                    />

                    {previewValues.length > 0 && (
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          {t("examples")}
                        </Typography>
                        <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                          {previewValues.map((v) => (
                            <Box
                              key={v}
                              sx={{
                                px: 1,
                                py: 0.5,
                                bgcolor: "action.hover",
                                borderRadius: 1,
                                fontFamily: "monospace",
                                fontSize: "0.75rem",
                              }}>
                              {formatFieldValue(v, formatKind ?? selectedField.kind, cfg)}
                            </Box>
                          ))}
                        </Stack>
                      </Box>
                    )}
                  </>
                )}
              </Stack>
            );
          })()
        ) : (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
            }}>
            <Typography variant="body2" color="text.secondary">
              {t("select_field_to_edit")}
            </Typography>
          </Box>
        )}
      </Box>
      {selectedField?.kind === "formula" && (
        <FormulaBuilder
          open={formulaBuilderOpen}
          onClose={() => setFormulaBuilderOpen(false)}
          onApply={(expression) => {
            handleFormulaChange(selectedField.id, expression);
            setFormulaBuilderOpen(false);
          }}
          initialExpression={selectedField.formula ?? ""}
          fields={formulaFields}
          collectionId={layerId}
          showGroupBy={false}
          title={t("formula")}
        />
      )}
    </Stack>
  );
};

export default FieldEditor;

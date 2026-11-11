import ClearIcon from "@mui/icons-material/Clear";
import {
  Box,
  FormControl,
  IconButton,
  Link,
  MenuItem,
  Select,
  Stack,
  Typography,
  useTheme,
} from "@mui/material";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LayerFieldType } from "@/lib/validations/layer";

import FieldKindIcon, { fieldIndicatorKind } from "@/components/common/FieldKindIcon";
import FieldMenu from "@/components/common/FieldMenu";
import FormLabelHelper from "@/components/common/FormLabelHelper";

export type SelectorProps<T extends boolean = false> = {
  selectedField: T extends true ? LayerFieldType[] | undefined : LayerFieldType | undefined;
  setSelectedField: (
    field: T extends true ? LayerFieldType[] | undefined : LayerFieldType | undefined
  ) => void;
  fields: LayerFieldType[];
  label?: string;
  tooltip?: string;
  /** The field must be filled in: its label carries the required marker. */
  required?: boolean;
  disabled?: boolean;
  multiple?: T;
  onFocus?: () => void;
  onClose?: () => void;
};

export const containsText = (text: string, searchText: string) =>
  text.toLowerCase().indexOf(searchText.toLowerCase()) > -1;

// Empty array constant to avoid creating new references
const EMPTY_FIELDS: LayerFieldType[] = [];

const LayerFieldSelector = <T extends boolean = false>(props: SelectorProps<T>) => {
  const theme = useTheme();
  const { selectedField, fields, setSelectedField } = props;
  const [focused, setFocused] = useState(false);
  // The field list opens under the select (the app's FieldMenu); the select itself only shows the value.
  const root = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  // Ensure fields is always an array (defensive check) - use stable reference
  const safeFields = fields && fields.length > 0 ? fields : EMPTY_FIELDS;

  const { t } = useTranslation("common");
  const selectedValue = useMemo(() => {
    if (!props.multiple && !Array.isArray(selectedField)) {
      if (!selectedField) return "";
      // Match by name and emit the stringified LIVE option: a saved field whose
      // type/kind has since drifted (e.g. a column re-imported as number) would
      // otherwise stringify differently from every option and trigger MUI's
      // out-of-range warning.
      const match = safeFields.find((f) => f.name === selectedField.name);
      return match ? JSON.stringify(match) : "";
    } else {
      return selectedField && Array.isArray(selectedField) && selectedField.length > 0
        ? selectedField
            .map((field) => safeFields.find((f) => f.name === field.name))
            .filter((field): field is (typeof safeFields)[number] => !!field)
            .map((field) => JSON.stringify(field))
        : EMPTY_FIELDS;
    }
  }, [props.multiple, selectedField, safeFields]);

  return (
    <FormControl size="small" fullWidth>
      {props.label && (
        <FormLabelHelper
          label={props.label}
          color={
            props.disabled ? theme.palette.secondary.main : focused ? theme.palette.primary.main : "inherit"
          }
          tooltip={props.tooltip}
          required={props.required}
        />
      )}
      <Select
        ref={root}
        fullWidth
        open={false}
        onOpen={() => {
          if (!props.disabled) setAnchor(root.current);
        }}
        multiple={props.multiple ? true : false}
        disabled={props.disabled}
        IconComponent={() => null}
        sx={{
          pr: 1,
          // Let the value area shrink and truncate instead of pushing the
          // clear button out of the box when many fields are selected.
          "& .MuiSelect-select": {
            minWidth: "0 !important",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          },
        }}
        displayEmpty
        value={selectedValue as unknown}
        defaultValue={props.multiple ? EMPTY_FIELDS : ""}
        onChange={(e) => {
          try {
            if (!props.multiple) {
              const value = e.target.value as string;
              if (!value) return;
              const field = JSON.parse(value) as LayerFieldType;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              setSelectedField(field as any);
            } else if (props.multiple) {
              const fields = e.target.value as string[];
              const selectedFields = fields
                .filter((f) => f) // Filter out empty strings
                .map((field) => JSON.parse(field) as LayerFieldType);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              setSelectedField(selectedFields as any);
            }
          } catch (error) {
            console.error("Failed to parse field selection:", error);
          }
        }}
        onFocus={() => {
          setFocused(true);
          if (props.onFocus) {
            props.onFocus();
          }
        }}
        onBlur={() => setFocused(false)}
        startAdornment={
          <>
            {/* Only show field type indicator for single select mode */}
            {!props.multiple && selectedField && !Array.isArray(selectedField) && (
              <Box component="span" sx={{ mr: 1.5, display: "inline-flex" }}>
                <FieldKindIcon kind={fieldIndicatorKind(selectedField)} />
              </Box>
            )}
          </>
        }
        endAdornment={
          <IconButton
            size="small"
            sx={{
              visibility:
                !selectedField ||
                (props.multiple && Array.isArray(selectedField) && selectedField.length === 0)
                  ? "hidden"
                  : "visible",
            }}
            onClick={() => {
              if (props.multiple) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                setSelectedField([] as any);
              } else {
                setSelectedField(undefined);
              }
            }}>
            <ClearIcon />
          </IconButton>
        }
        renderValue={() => {
          if (!selectedField && !props.multiple)
            return <Typography variant="body2">{t("select_field")}</Typography>;
          if (props.multiple && Array.isArray(selectedField) && selectedField.length === 0)
            return <Typography variant="body2">{t("select_fields")}</Typography>;
          let displayText: string | undefined;
          if (props.multiple && Array.isArray(selectedField)) {
            const [first, ...rest] = selectedField;
            displayText = rest.length > 0 ? `${first.name}, ...` : first.name;
          } else if (selectedField && !Array.isArray(selectedField)) {
            displayText = selectedField.name;
          }
          return displayText ? (
            <Typography variant="body2" fontWeight="bold" noWrap>
              {displayText}
            </Typography>
          ) : null;
        }}>
        {/* The options the select checks its value against; the list itself is the FieldMenu below. */}
        {safeFields.map((field) => (
          <MenuItem key={field.name} value={JSON.stringify(field)} />
        ))}
      </Select>
      <FieldMenu
        anchorEl={anchor}
        fields={safeFields}
        multiple={!!props.multiple}
        isSelected={(field) =>
          Array.isArray(selectedField)
            ? selectedField.some((f) => f.name === field.name)
            : selectedField?.name === field.name
        }
        onPick={(field) => {
          if (!props.multiple) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            setSelectedField(field as any);
            return;
          }
          const current: LayerFieldType[] = Array.isArray(selectedField) ? selectedField : [];
          const next = current.some((f) => f.name === field.name)
            ? current.filter((f) => f.name !== field.name)
            : [...current, field];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setSelectedField(next as any);
        }}
        header={
          props.multiple ? (
            <Box sx={{ px: "16px", py: 1.5 }}>
              <Stack direction="row" spacing={2}>
                <Link
                  component="button"
                  variant="caption"
                  underline="hover"
                  disabled={Array.isArray(selectedField) && selectedField.length === safeFields.length}
                  onClick={(e) => {
                    e.stopPropagation();
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    setSelectedField(safeFields as any);
                  }}
                  sx={{
                    color:
                      Array.isArray(selectedField) && selectedField.length === safeFields.length
                        ? theme.palette.text.disabled
                        : theme.palette.primary.main,
                    cursor:
                      Array.isArray(selectedField) && selectedField.length === safeFields.length
                        ? "default"
                        : "pointer",
                  }}>
                  {t("select_all")}
                </Link>
                <Typography variant="caption" color="text.secondary">
                  |
                </Typography>
                <Link
                  component="button"
                  variant="caption"
                  underline="hover"
                  disabled={!Array.isArray(selectedField) || selectedField.length === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    setSelectedField([] as any);
                  }}
                  sx={{
                    color:
                      !Array.isArray(selectedField) || selectedField.length === 0
                        ? theme.palette.text.disabled
                        : theme.palette.primary.main,
                    cursor:
                      !Array.isArray(selectedField) || selectedField.length === 0 ? "default" : "pointer",
                  }}>
                  {t("deselect_all")}
                </Link>
              </Stack>
            </Box>
          ) : undefined
        }
        searchLabel={t("search_fields")}
        focusOnClose={root.current?.querySelector<HTMLElement>("[role='combobox']") ?? null}
        onClose={() => {
          setAnchor(null);
          setFocused(false);
          props.onClose?.();
        }}
      />
    </FormControl>
  );
};

export default LayerFieldSelector;

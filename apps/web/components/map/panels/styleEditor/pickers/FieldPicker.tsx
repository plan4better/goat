// The field picker (prototype 5.4): each field with its kind, display name and a short profile, searched by name and
// display name.
import { Box, InputBase, ListItemIcon, ListItemText, MenuItem, MenuList, Typography } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import FieldKindIcon, { fieldIndicatorKind } from "@/components/common/FieldKindIcon";
import {
  type FieldInfo,
  type FieldProfile,
  useFieldProfile,
} from "@/components/map/panels/styleEditor/context";

const NUMBER_TYPES = new Set(["number", "integer"]);
/** Profiles load only for a list this short: a search narrows a long one first (a profile is a query on the data). */
const PROFILE_LIMIT = 20;

export interface FieldPickerProps {
  fields: FieldInfo[];
  value?: string;
  onChange: (name: string) => void;
  filter?: "number" | "text";
  exclude?: string[];
  hint?: string;
  /** A short profile under the name ("12 to 9,800") from the number field's profile, loaded for the fields shown. */
  profile?: (field: FieldInfo, loaded: FieldProfile | undefined) => string | undefined;
}

function FieldItem({
  field,
  selected,
  load,
  profile,
  onPick,
}: {
  field: FieldInfo;
  selected: boolean;
  load: boolean;
  profile?: FieldPickerProps["profile"];
  onPick: (name: string) => void;
}) {
  const numeric = NUMBER_TYPES.has(field.type);
  const loaded = useFieldProfile(profile && numeric ? field.name : undefined, { load });
  const sub = [field.label !== field.name ? field.name : undefined, profile?.(field, loaded)]
    .filter(Boolean)
    .join(" · ");
  return (
    <MenuItem selected={selected} onClick={() => onPick(field.name)}>
      <ListItemIcon>
        <FieldKindIcon kind={fieldIndicatorKind({ type: field.type })} />
      </ListItemIcon>
      <ListItemText
        primary={field.label}
        secondary={sub || undefined}
        secondaryTypographyProps={{ variant: "caption" }}
      />
    </MenuItem>
  );
}

export function FieldPicker({ fields, value, onChange, filter, exclude, hint, profile }: FieldPickerProps) {
  const { t } = useTranslation("common");
  const [search, setSearch] = useState("");
  const shown = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return fields.filter(
      (f) =>
        !exclude?.includes(f.name) &&
        (filter === undefined || (filter === "number") === NUMBER_TYPES.has(f.type)) &&
        (filter !== "text" || f.type === "string") &&
        (!needle ||
          f.name.toLocaleLowerCase().includes(needle) ||
          f.label.toLocaleLowerCase().includes(needle))
    );
  }, [fields, filter, exclude, search]);

  return (
    <Box>
      <InputBase
        value={search}
        autoFocus
        placeholder={t("style_editor.search_fields")}
        inputProps={{ "aria-label": t("style_editor.search_fields") }}
        onChange={(event) => setSearch(event.target.value)}
        sx={{ px: 3, py: 1, width: "100%", typography: "body2" }}
      />
      <MenuList dense sx={{ maxHeight: 320, overflowY: "auto" }}>
        {shown.map((field) => (
          <FieldItem
            key={field.name}
            field={field}
            selected={field.name === value}
            load={shown.length <= PROFILE_LIMIT}
            profile={profile}
            onPick={onChange}
          />
        ))}
      </MenuList>
      {hint && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 3, pb: 2 }}>
          {hint}
        </Typography>
      )}
    </Box>
  );
}

// The field picker (prototype 5.4): the app's field list (FieldMenu) at the control that picks a field, each field
// with its kind, display name and a short profile. Fields the use cannot take (a number where only numbers work) are
// left out, as the panel's other choices leave out what does not apply.
import { Typography } from "@mui/material";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import FieldMenu from "@/components/common/FieldMenu";
import {
  type FieldInfo,
  type FieldProfile,
  useFieldProfile,
} from "@/components/map/panels/styleEditor/context";
import type { DropdownItem, MenuPlacement } from "@/components/map/panels/styleEditor/popovers/DropdownMenu";
import { FormButton } from "@/components/map/panels/styleEditor/rows/FormButton";

const NUMBER_TYPES = new Set(["number", "integer"]);
/** Profiles load only for a list this short: a search narrows a long one first (a profile is a query on the data). */
const PROFILE_LIMIT = 20;

export interface FieldPickerProps {
  /** The control it opens at; closed while null. */
  anchorEl: HTMLElement | null;
  onClose: () => void;
  fields: FieldInfo[];
  value?: string;
  onChange: (name: string) => void;
  /** The menu's heading (what the field is for). */
  title?: string;
  filter?: "number" | "text";
  exclude?: string[];
  hint?: string;
  /** A short profile under the name ("12 to 9,800") from the number field's profile, loaded for the fields shown. */
  profile?: (field: FieldInfo, loaded: FieldProfile | undefined) => string | undefined;
  /** Fields listed first under their own heading (fields named for the property, such as `height`), lower-case. */
  suggested?: { names: readonly string[]; title: string; othersTitle: string };
  /** Rows before the fields (a label's "Custom text"). */
  before?: DropdownItem[];
  placement?: MenuPlacement;
}

/** The line under a field: its name where the display name differs, and its profile once loaded. */
function FieldSub({
  field,
  load,
  profile,
}: {
  field: FieldInfo;
  load: boolean;
  profile?: FieldPickerProps["profile"];
}) {
  const loaded = useFieldProfile(profile && NUMBER_TYPES.has(field.type) ? field.name : undefined, { load });
  const sub = [field.label !== field.name ? field.name : undefined, profile?.(field, loaded)]
    .filter(Boolean)
    .join(" · ");
  return sub ? (
    <Typography component="span" variant="inherit">
      {sub}
    </Typography>
  ) : null;
}

export function FieldPicker({
  anchorEl,
  onClose,
  fields,
  value,
  onChange,
  title,
  filter,
  exclude,
  hint,
  profile,
  suggested,
  before = [],
  placement,
}: FieldPickerProps) {
  const { t } = useTranslation("common");
  const usable = fields.filter(
    (f) =>
      !exclude?.includes(f.name) &&
      (filter === undefined || (filter === "number") === NUMBER_TYPES.has(f.type)) &&
      (filter !== "text" || f.type === "string")
  );
  return (
    <FieldMenu
      anchorEl={anchorEl}
      onClose={onClose}
      fields={usable}
      isSelected={(field) => field.name === value}
      onPick={(field) => onChange(field.name)}
      // Only where there is something to say: an empty line would set the row on two lines.
      sub={(field, shown) =>
        field.label !== field.name || (profile && NUMBER_TYPES.has(field.type)) ? (
          <FieldSub field={field} load={shown <= PROFILE_LIMIT} profile={profile} />
        ) : undefined
      }
      suggested={suggested}
      before={before}
      title={title}
      hint={hint}
      placement={placement}
      searchLabel={t("style_editor.search_fields")}
    />
  );
}

/** A field's value in a row: the field it holds, opening the field picker under it. */
export function FieldPickerButton({
  text,
  start,
  ariaLabel,
  ...picker
}: Omit<FieldPickerProps, "anchorEl" | "onClose"> & {
  text: ReactNode;
  start?: ReactNode;
  ariaLabel?: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <FormButton
        popup="listbox"
        open={anchor !== null}
        ariaLabel={ariaLabel}
        start={start}
        text={text}
        onOpen={(el) => setAnchor(anchor ? null : el)}
      />
      <FieldPicker anchorEl={anchor} onClose={() => setAnchor(null)} {...picker} />
    </>
  );
}

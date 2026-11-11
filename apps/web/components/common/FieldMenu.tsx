"use client";

// The app's one field list: a layer's fields on the shared menu (SearchableMenu), each with its kind (FieldKindIcon in
// one column, so the names line up) and the chosen one marked. Searched by name and display name once the list is
// long; "No fields match" when nothing does. A field the use cannot take is either left out by the caller or shown
// disabled with why (`disabledReason`).
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import FieldKindIcon, { fieldIndicatorKind } from "@/components/common/FieldKindIcon";
import SearchableMenu, {
  type MenuPlacement,
  SEARCH_FROM_FIELDS,
  type SearchableMenuItem,
} from "@/components/common/SearchableMenu";

export interface FieldMenuField {
  name: string;
  /** The display name, where it differs from the name. */
  label?: string;
  type?: string;
  kind?: string;
}

export interface FieldMenuProps<F extends FieldMenuField> {
  /** The control it opens at; closed while null. */
  anchorEl: HTMLElement | null;
  onClose: () => void;
  fields: F[];
  isSelected: (field: F) => boolean;
  onPick: (field: F) => void;
  /** Several fields: checkboxes, and a pick keeps the list open. */
  multiple?: boolean;
  /** Why a field cannot be picked here; it shows disabled with this on hover. */
  disabledReason?: (field: F) => string | undefined;
  /** A line under a field's name; `shown` counts the fields the search leaves (a profile loads for a short list). */
  sub?: (field: F, shown: number) => ReactNode;
  /** Fields listed first under their own heading (fields named for the use, such as `height`), lower-case. */
  suggested?: { names: readonly string[]; title: string; othersTitle: string };
  /** Rows before the fields (a label's "Custom text"). */
  before?: SearchableMenuItem[];
  /** Under the search, above the fields (a multiple pick's "Select all"). */
  header?: ReactNode;
  title?: string;
  hint?: string;
  placement?: MenuPlacement;
  width?: number;
  searchLabel?: string;
  focusOnClose?: HTMLElement | null;
}

export default function FieldMenu<F extends FieldMenuField>({
  fields,
  isSelected,
  onPick,
  disabledReason,
  sub,
  suggested,
  before = [],
  searchLabel,
  ...menu
}: FieldMenuProps<F>) {
  const { t } = useTranslation("common");
  const items = (needle: string): SearchableMenuItem[] => {
    const shown = fields.filter(
      (f) =>
        !needle ||
        f.name.toLocaleLowerCase().includes(needle) ||
        (f.label ?? "").toLocaleLowerCase().includes(needle)
    );
    const row = (field: F): SearchableMenuItem => {
      const reason = disabledReason?.(field);
      return {
        label: field.label ?? field.name,
        keywords: field.name,
        icon: <FieldKindIcon kind={fieldIndicatorKind(field)} />,
        sub: sub?.(field, shown.length),
        selected: isSelected(field),
        disabled: !!reason,
        tooltip: reason,
        onClick: () => onPick(field),
      };
    };
    const first = !needle ? before : before.filter((item) => item.label.toLocaleLowerCase().includes(needle));
    const isSuggested = (f: F) => !!suggested?.names.includes(f.name.toLowerCase());
    const top = suggested ? shown.filter(isSuggested) : [];
    if (!suggested || !top.length) return [...first, ...shown.map(row)];
    const others = shown.filter((f) => !isSuggested(f));
    return [
      ...first,
      { label: suggested.title, heading: true },
      ...top.map(row),
      ...(others.length ? [{ label: suggested.othersTitle, heading: true }, ...others.map(row)] : []),
    ];
  };
  return (
    <SearchableMenu
      {...menu}
      role="listbox"
      items={items}
      searchLabel={searchLabel ?? t("search_fields")}
      emptyText={t("no_fields_match")}
      searchFrom={SEARCH_FROM_FIELDS}
    />
  );
}

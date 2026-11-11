// The style editor's one menu: picking one value or action from a list opens it at its control, on the app's shared
// list (SearchableMenu: the menu card, MenuRow rows, a search row from SEARCH_FROM_CHOICES rows on). It closes on a pointer-down
// outside it, so the rest of the panel stays usable.
import SearchableMenu, {
  type MenuPlacement,
  SEARCH_FROM_CHOICES,
  type SearchableMenuItem,
} from "@/components/common/SearchableMenu";

export { SEARCH_FROM_CHOICES, type MenuPlacement };

export type DropdownItem = SearchableMenuItem;

export interface DropdownMenuProps {
  anchorEl: HTMLElement | null;
  title?: string;
  /** The rows, or the rows matching a search (the caller filters; '' for all). */
  items: DropdownItem[] | ((needle: string) => DropdownItem[]);
  onClose: () => void;
  width?: number;
  placement?: MenuPlacement;
  /** A line under the items saying what the menu is for. */
  hint?: string;
  /** "menu" for actions and modes, "listbox" for the value of a field (its options). */
  role?: "menu" | "listbox";
  searchLabel?: string;
  emptyText?: string;
}

export function DropdownMenu(props: DropdownMenuProps) {
  return <SearchableMenu {...props} />;
}

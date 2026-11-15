"use client";

import { Box, Checkbox, FormControlLabel, Typography, debounce, useTheme } from "@mui/material";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { ContentType } from "@/lib/validations/content";

import type {
  ContentLayout,
  ContentOrder,
  ContentOrderBy,
} from "@/hooks/dashboard/content/useContentPageState";

import { ArrowPopper } from "@/components/ArrowPoper";
import PopoverPaper from "@/components/common/PopoverPaper";
import LayoutToggle from "@/components/dashboard/common/LayoutToggle";
import SearchInput from "@/components/dashboard/common/SearchInput";
import SortMenu from "@/components/dashboard/common/SortMenu";
import ToolPill from "@/components/dashboard/common/ToolPill";

const FILTER_TYPES: { type: ContentType; labelKey: string }[] = [
  { type: "project", labelKey: "projects" },
  { type: "template", labelKey: "templates" },
  { type: "layer", labelKey: "datasets" },
  { type: "bundle", labelKey: "bundles" },
  { type: "folder", labelKey: "folders" },
];

interface ContentToolbarProps {
  search: string;
  onSearch: (search: string) => void;
  layout: ContentLayout;
  onLayout: (layout: ContentLayout) => void;
  types: ContentType[];
  onTypes: (types: ContentType[]) => void;
  orderBy: ContentOrderBy;
  order: ContentOrder;
  onSort: (by: ContentOrderBy, dir: ContentOrder) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  addMenu: ReactNode;
  canAdd: boolean;
  /** The scope being searched (the active space or view), named in the search
   * field's placeholder; a bare "Search…" placeholder when unset. */
  scopeName?: string;
  /** The "you are here" trail, rendered left of the tool pills — the same row
   * the action bar takes over once something is selected. */
  breadcrumb?: ReactNode;
  /** Rendered in place of every control right of the breadcrumb — the
   * page passes the selection action bar here once something is selected,
   * so "N selected" and its actions take over exactly where layout/filter/
   * details/add normally sit. */
  actionBar?: ReactNode;
  /** Below `md`: the breadcrumb takes a row of its own above the controls,
   * and every pill drops its label (desktop keeps labels and one row). */
  mobile?: boolean;
}

export const SORT_ITEMS: {
  id: string;
  labelKey: string;
  icon: ICON_NAME;
  by: ContentOrderBy;
  dir: ContentOrder;
}[] = [
  { id: "updated", labelKey: "last_updated", icon: ICON_NAME.REFRESH, by: "updated_at", dir: "descendent" },
  {
    id: "created",
    labelKey: "last_created",
    icon: ICON_NAME.CALENDAR,
    by: "created_at",
    dir: "descendent",
  },
  { id: "name", labelKey: "name", icon: ICON_NAME.SORT_ALPHA_ASC, by: "name", dir: "ascendent" },
];

/** The feed's search pill and the tool row under it (breadcrumb, layout
 * segments, Filter, Sort, Details, Add new). Search debounces 300ms before it
 * reaches the (server-side) `onSearch` so every keystroke doesn't fire a
 * request; everything else — filter, sort, layout, details — takes effect
 * immediately since each is a discrete click rather than free text. */
const ContentToolbar = ({
  search,
  onSearch,
  layout,
  onLayout,
  types,
  onTypes,
  orderBy,
  order,
  onSort,
  detailsOpen,
  onToggleDetails,
  addMenu,
  canAdd,
  scopeName,
  breadcrumb,
  actionBar,
  mobile,
}: ContentToolbarProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [filterOpen, setFilterOpen] = useState(false);

  // The typed text, so the field answers every keystroke while the query it
  // stands for is debounced below; the URL is the source of truth and pushes
  // back in whenever it changes from outside (back/forward, a pasted link).
  const [searchText, setSearchText] = useState(search);
  useEffect(() => setSearchText(search), [search]);

  const debouncedSearch = useMemo(() => debounce((next: string) => onSearch(next), 300), [onSearch]);

  const clearSearch = () => {
    setSearchText("");
    debouncedSearch.clear();
    onSearch("");
  };

  const allTypesSelected = types.length === FILTER_TYPES.length;
  const activeFilterCount = allTypesSelected ? 0 : types.length;

  const selectedSort =
    SORT_ITEMS.find((option) => option.by === orderBy && option.dir === order) ?? SORT_ITEMS[0];

  const toggleType = (type: ContentType) => {
    onTypes(types.includes(type) ? types.filter((t2) => t2 !== type) : [...types, type]);
  };

  const groupLabelSx = {
    px: "10px",
    pt: "6px",
    pb: "4px",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.5px",
    textTransform: "uppercase" as const,
    color: theme.palette.text.secondary,
  };

  const controls = actionBar ?? (
    <Box sx={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
      <LayoutToggle value={layout} onChange={onLayout} compact={mobile} />

      <ArrowPopper
        open={filterOpen}
        placement="bottom-end"
        onClose={() => setFilterOpen(false)}
        arrow={false}
        content={
          <PopoverPaper sx={{ minWidth: 230, py: 1 }}>
            <Typography component="div" sx={groupLabelSx}>
              {t("type")}
            </Typography>
            {FILTER_TYPES.map(({ type, labelKey }) => (
              <FormControlLabel
                key={type}
                sx={{ display: "flex", mx: 0, px: "6px" }}
                control={
                  <Checkbox size="small" checked={types.includes(type)} onChange={() => toggleType(type)} />
                }
                label={<Typography variant="body2">{t(labelKey)}</Typography>}
              />
            ))}
          </PopoverPaper>
        }>
        <ToolPill
          icon={ICON_NAME.FILTER}
          label={t("filter")}
          chevron
          active={filterOpen || activeFilterCount > 0}
          badge={activeFilterCount > 0 ? activeFilterCount : undefined}
          iconOnly={mobile}
          onClick={() => setFilterOpen((prev) => !prev)}
        />
      </ArrowPopper>

      <SortMenu
        value={selectedSort.id}
        options={SORT_ITEMS.map((option) => ({
          value: option.id,
          label: t(option.labelKey),
          icon: option.icon,
        }))}
        onChange={(id) => {
          const picked = SORT_ITEMS.find((option) => option.id === id);
          if (picked) onSort(picked.by, picked.dir);
        }}
        compact={mobile}
        label={t("sort")}
      />

      <ToolPill
        icon={ICON_NAME.INFO}
        label={t("details")}
        active={detailsOpen}
        iconOnly={mobile}
        onClick={onToggleDetails}
      />

      {canAdd && addMenu}
    </Box>
  );

  return (
    <Box>
      <Box sx={{ padding: mobile ? "10px 14px 0" : "18px 40px 0", display: "flex" }}>
        <SearchInput
          value={searchText}
          onChange={(next) => {
            setSearchText(next);
            // A cleared field takes effect at once: waiting 300ms to show the
            // whole feed again reads as a stuck page.
            if (next) debouncedSearch(next);
            else {
              debouncedSearch.clear();
              onSearch("");
            }
          }}
          onClear={clearSearch}
          placeholder={scopeName ? t("search_in", { name: scopeName }) : t("search_items")}
          fullWidth
        />
      </Box>
      <Box
        sx={{
          padding: mobile ? "12px 14px 10px" : "20px 40px 16px",
          display: "flex",
          alignItems: "center",
          gap: mobile ? "8px" : "16px",
          flexWrap: "wrap",
        }}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flex: mobile ? "1 0 100%" : 1,
            minWidth: mobile ? 0 : 220,
          }}>
          {breadcrumb}
        </Box>
        {controls}
      </Box>
    </Box>
  );
};

export default ContentToolbar;

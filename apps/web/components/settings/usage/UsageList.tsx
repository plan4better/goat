"use client";

import CancelIcon from "@mui/icons-material/Cancel";
import {
  Box,
  ButtonBase,
  Chip,
  Link,
  Pagination,
  Skeleton,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { visuallyHidden } from "@mui/utils";
import NextLink from "next/link";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { PAGE_SIZE, type SortDir } from "@/lib/api/usage";

import { accentText, focusRing } from "@/components/assistant/styles";
import EmptyState from "@/components/dashboard/common/EmptyState";
import SurfaceCard from "@/components/dashboard/common/SurfaceCard";
import UserAvatar from "@/components/dashboard/common/UserAvatar";

export interface UsageColumn<T> {
  key: string;
  label: string;
  /** Its track in the rows' grid ("minmax(0, 1fr)", "100px"). */
  width: string;
  align?: "left" | "right";
  sortable?: boolean;
  /** The figure a phone keeps beside the first column. */
  main?: boolean;
  /** The label is read out but not shown (a column of row menus). */
  hideLabel?: boolean;
  render: (row: T) => ReactNode;
}

/** A filter in force, shown beside the range text with a button to drop it. */
export interface UsageChip {
  label: string;
  /** Its value is still loading (a member's name): a short placeholder
   * follows the label. */
  pending?: boolean;
  onRemove: () => void;
}

export interface UsageListProps<T> {
  /** Names the table for assistive tech. */
  label: string;
  /** What the rows are, for a count ("workflows"). */
  noun: (count: number) => string;
  columns: UsageColumn<T>[];
  /** The rows of the page shown; while the next page loads, the last one's. */
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  /** The rows of every page. */
  total: number;
  /** 1-based. */
  page: number;
  onPage: (page: number) => void;
  sort: { key: string; dir: SortDir };
  onSort: (key: string) => void;
  chips?: UsageChip[];
  onClearAll?: () => void;
  /** A request is under way: the skeleton shows only while there are no
   * rows yet, the rows of the last page stay in sight otherwise. */
  isLoading?: boolean;
  emptyTitle: string;
  emptyHint?: string;
}

/** A row's `minHeight`: the loading rows hold the place of the real ones. */
const SKELETON_ROW_HEIGHT = 57;

/**
 * One list of the usage page, as the catalog and content pages draw theirs:
 * the range text with the filters in force, a header bar whose columns sort,
 * a card per row, and pages of {@link PAGE_SIZE}. A phone keeps the first
 * column and the main figure.
 */
export function UsageList<T>({
  label,
  noun,
  columns,
  rows,
  rowKey,
  total,
  page,
  onPage,
  sort,
  onSort,
  chips = [],
  onClearAll,
  isLoading,
  emptyTitle,
  emptyHint,
}: UsageListProps<T>) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down("sm"));
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pageCount);

  // A filter can leave fewer pages than the one asked for: the list moves to
  // its last page instead of showing an empty one.
  useEffect(() => {
    if (!isLoading && total > 0 && page > pageCount) onPage(pageCount);
  }, [isLoading, total, page, pageCount, onPage]);

  const main = columns.find((column) => column.main) ?? columns[columns.length - 1];
  const shown =
    isPhone && columns.length > 1 ? [columns[0], ...(main === columns[0] ? [] : [main])] : columns;
  const gridTemplateColumns = isPhone ? "minmax(0, 1fr) auto" : shown.map((column) => column.width).join(" ");
  const number = (value: number) => value.toLocaleString(i18n.language);
  // Only the first load has nothing to show: a later one keeps the rows it
  // had (the server-paged lists keep their last page), so the list does not
  // blink on every page, sort or search.
  const waiting = !!isLoading && !rows?.length;

  const rangeText = waiting
    ? null
    : total === 0
      ? t("usage_none", { noun: noun(0) })
      : t("usage_range_text", {
          from: number((current - 1) * PAGE_SIZE + 1),
          to: number(Math.min(current * PAGE_SIZE, total)),
          total: number(total),
          noun: noun(total),
        });

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" useFlexGap flexWrap="wrap" gap={2} sx={{ minHeight: 32 }}>
        {rangeText && (
          <Typography variant="body2" fontWeight="bold" sx={{ mr: 1 }}>
            {rangeText}
          </Typography>
        )}
        {chips.map((chip) => (
          <Chip
            key={chip.label}
            size="small"
            label={
              chip.pending ? (
                <Stack direction="row" alignItems="center" gap={1} component="span">
                  {chip.label}
                  <Skeleton variant="text" width={56} sx={{ display: "inline-block" }} />
                </Stack>
              ) : (
                chip.label
              )
            }
            onDelete={chip.onRemove}
            deleteIcon={
              <CancelIcon
                // React escapes the title it renders; i18next must not escape
                // a typed search or a name a second time.
                titleAccess={t("usage_remove_filter", {
                  label: chip.label,
                  interpolation: { escapeValue: false },
                })}
              />
            }
          />
        ))}
        {chips.length > 1 && onClearAll && (
          <ButtonBase
            onClick={onClearAll}
            sx={{
              // The app's font: a bare button would fall back to the browser's.
              fontFamily: "inherit",
              px: 1,
              borderRadius: "4px",
              typography: "caption",
              fontWeight: 600,
              color: accentText(theme),
              ...focusRing(theme),
            }}>
            {t("remove_all")}
          </ButtonBase>
        )}
      </Stack>

      {waiting ? (
        <Box>
          <Skeleton variant="rounded" height={36} sx={{ borderRadius: "8px", mb: "8px" }} />
          <Box sx={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton
                key={index}
                variant="rounded"
                height={SKELETON_ROW_HEIGHT}
                sx={{ borderRadius: "8px" }}
              />
            ))}
          </Box>
        </Box>
      ) : total === 0 ? (
        <EmptyState icon={ICON_NAME.SEARCH} title={emptyTitle} hint={emptyHint} />
      ) : (
        <>
          <Box
            role="table"
            aria-label={label}
            aria-busy={isLoading || undefined}
            sx={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <Box
              role="row"
              sx={{
                display: "grid",
                gridTemplateColumns,
                gap: 3,
                alignItems: "center",
                height: 36,
                // The rows' padding and their 1.5px border, so the labels sit
                // over the cells.
                px: 3.875,
                fontSize: 12,
                fontWeight: 700,
                color: "text.secondary",
              }}>
              {shown.map((column) => {
                const active = sort.key === column.key;
                const justifyContent = column.align === "right" ? "flex-end" : "flex-start";
                return (
                  <Box
                    key={column.key}
                    role="columnheader"
                    aria-sort={
                      column.sortable
                        ? active
                          ? sort.dir === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                        : undefined
                    }
                    sx={{ display: "flex", justifyContent, minWidth: 0 }}>
                    {column.sortable ? (
                      <ButtonBase
                        onClick={() => onSort(column.key)}
                        sx={{
                          fontFamily: "inherit",
                          gap: "4px",
                          borderRadius: "4px",
                          whiteSpace: "nowrap",
                          fontSize: 12,
                          fontWeight: 700,
                          color: active ? "text.primary" : "text.secondary",
                          ...focusRing(theme),
                        }}>
                        {column.label}
                        <Box component="span" aria-hidden sx={{ fontSize: 10, opacity: active ? 1 : 0.3 }}>
                          {active && sort.dir === "asc" ? "▲" : "▼"}
                        </Box>
                      </ButtonBase>
                    ) : (
                      <Box
                        component="span"
                        sx={
                          column.hideLabel
                            ? visuallyHidden
                            : { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }
                        }>
                        {column.label}
                      </Box>
                    )}
                  </Box>
                );
              })}
            </Box>
            {(rows ?? []).map((row) => (
              <SurfaceCard
                key={rowKey(row)}
                role="row"
                hoverable={false}
                sx={{
                  display: "grid",
                  gridTemplateColumns,
                  gap: 3,
                  alignItems: "center",
                  minHeight: 57,
                  px: 3.5,
                  py: 2.75,
                }}>
                {shown.map((column) => (
                  <Box
                    key={column.key}
                    role="cell"
                    sx={{
                      minWidth: 0,
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      justifyContent: column.align === "right" ? "flex-end" : "flex-start",
                    }}>
                    {column.render(row)}
                  </Box>
                ))}
              </SurfaceCard>
            ))}
          </Box>
          {pageCount > 1 && (
            <Stack direction="row" justifyContent="center" sx={{ p: 4 }}>
              <Pagination
                count={pageCount}
                page={current}
                size="large"
                siblingCount={isPhone ? 0 : 1}
                onChange={(_event, next) => onPage(next)}
              />
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}

const ellipsis = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

/**
 * A row's first cell: its mark (a `MarkBlock` or a `UserAvatar` of 32px), its
 * name and a line below. The name is a link with `href`, narrows the page with
 * `onClick` (`hint` says to what), or plain text.
 */
export const UsageTitleCell = ({
  title,
  sub,
  mark,
  href,
  onClick,
  hint,
}: {
  title: string;
  sub?: string;
  mark?: ReactNode;
  href?: string;
  onClick?: () => void;
  hint?: string;
}) => {
  const theme = useTheme();
  const name = {
    ...ellipsis,
    fontSize: 13.5,
    fontWeight: 700,
    color: "text.primary",
    textAlign: "left",
  } as const;
  return (
    <>
      {mark}
      <Box sx={{ minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" }}>
        {href ? (
          <Link component={NextLink} href={href} underline="hover" sx={{ ...name, display: "block" }}>
            {title}
          </Link>
        ) : onClick ? (
          <ButtonBase
            onClick={onClick}
            title={hint}
            sx={{
              ...name,
              fontFamily: "inherit",
              display: "block",
              borderRadius: "4px",
              "&:hover": { textDecoration: "underline" },
              ...focusRing(theme),
            }}>
            {title}
          </ButtonBase>
        ) : (
          <Box component="span" sx={name}>
            {title}
          </Box>
        )}
        {sub && (
          <Box component="span" sx={{ ...ellipsis, fontSize: 11.5, color: "text.secondary" }}>
            {sub}
          </Box>
        )}
      </Box>
    </>
  );
};

/** A person in a row: a 22px avatar and the name, a button that narrows the
 * page to them with `onClick` (`hint` says how). */
export const UsagePersonCell = ({
  id,
  name,
  onClick,
  hint,
}: {
  id: string;
  name: string;
  onClick?: () => void;
  hint?: string;
}) => {
  const theme = useTheme();
  const text = { ...ellipsis, fontSize: 12.5, color: "text.secondary", textAlign: "left" } as const;
  return (
    <>
      <UserAvatar id={id} name={name} size={22} />
      {onClick ? (
        <ButtonBase
          onClick={onClick}
          title={hint}
          sx={{
            ...text,
            fontFamily: "inherit",
            display: "block",
            borderRadius: "4px",
            "&:hover": { textDecoration: "underline" },
            ...focusRing(theme),
          }}>
          {name}
        </ButtonBase>
      ) : (
        <Box component="span" sx={text}>
          {name}
        </Box>
      )}
    </>
  );
};

/** A figure of a row: the main one in bold, the others in the secondary ink. */
export const UsageNumberCell = ({ value, main }: { value: string; main?: boolean }) => (
  <Box
    component="span"
    sx={{
      fontSize: main ? 13.5 : 12.5,
      fontWeight: main ? 700 : 400,
      color: main ? "text.primary" : "text.secondary",
      fontVariantNumeric: "tabular-nums",
      whiteSpace: "nowrap",
    }}>
    {value}
  </Box>
);

/** In its own module, so pages that need only the mark do not load this list. */
export { UsageMark } from "@/components/settings/usage/UsageMark";

"use client";

import { Alert, Box } from "@mui/material";
import { type Locale, formatDistance } from "date-fns";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { parseApiDate } from "@/lib/utils/credits";

import {
  UsageDetailHeader,
  type UsageDetailHeaderProps,
} from "@/components/settings/usage/UsageDetailHeader";
import { DetailBody, DetailHeaderSkeleton, PLAIN } from "@/components/settings/usage/UsageDetailParts";
import {
  type UsageColumn,
  UsageList,
  type UsageListProps,
  UsageNumberCell,
  UsagePersonCell,
} from "@/components/settings/usage/UsageList";
import { UsageToolbar } from "@/components/settings/usage/UsageToolbar";

/**
 * What every quota detail is made of, in its order: the header (a skeleton
 * while its figures load; nothing when they failed, as the failure shows in
 * the part that reads them), what sits between the header and the toolbar (a
 * split card), the toolbar, and the rest (a chart, Group by, the list).
 */
export const DetailFrame = ({
  header,
  headerFailed,
  above,
  toolbar,
  children,
}: {
  /** The header's texts; undefined while its figures load. */
  header?: UsageDetailHeaderProps;
  headerFailed?: boolean;
  above?: ReactNode;
  /** The search and the pills. */
  toolbar: ReactNode;
  children: ReactNode;
}) => (
  <DetailBody>
    {header ? <UsageDetailHeader {...header} /> : headerFailed ? null : <DetailHeaderSkeleton />}
    {above}
    <UsageToolbar>{toolbar}</UsageToolbar>
    {children}
  </DetailBody>
);

/** The place of a part whose data could not be read. */
export const LoadError = () => {
  const { t } = useTranslation("common");
  return <Alert severity="error">{t("usage_load_error")}</Alert>;
};

/**
 * A detail's list, or the error in its place when its query failed. A search
 * that finds nothing is named; any other empty list says `emptyTitle`.
 */
export function DetailList<T>({
  failed,
  searched,
  emptyTitle,
  emptyHint,
  ...list
}: Omit<UsageListProps<T>, "emptyTitle" | "emptyHint"> & {
  failed?: boolean;
  /** The search the rows shown were found by. */
  searched?: string;
  emptyTitle: string;
  emptyHint?: string;
}) {
  const { t } = useTranslation("common");
  if (failed) return <LoadError />;
  return (
    <UsageList<T>
      {...list}
      emptyTitle={
        searched ? t("usage_empty_search", { noun: list.noun(0), q: searched, ...PLAIN }) : emptyTitle
      }
      emptyHint={searched ? t("usage_empty_search_hint") : emptyHint}
    />
  );
}

/** A plain text of a row (a project, a date), in the secondary ink. */
export const TextCell = ({ children }: { children: string }) => (
  <Box
    component="span"
    sx={{
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontSize: 12.5,
      color: "text.secondary",
    }}>
    {children}
  </Box>
);

/** A figure column, sortable unless said otherwise: right-aligned, in bold
 * when it is the `main` one a phone keeps. */
export const figureColumn = <T,>({
  key,
  label,
  width = "100px",
  sortable = true,
  main,
  value,
}: {
  key: string;
  label: string;
  width?: string;
  sortable?: boolean;
  main?: boolean;
  value: (row: T) => string;
}): UsageColumn<T> => ({
  key,
  label,
  width,
  align: "right",
  sortable,
  main,
  render: (row) => <UsageNumberCell value={value(row)} main={main} />,
});

/** A sortable column of when something last happened, from now ("2 days
 * ago"), as the content page writes it. */
export const sinceColumn = <T,>({
  key,
  label,
  date,
  locale,
  main,
}: {
  key: string;
  label: string;
  /** An ISO instant from the API; naive ones are UTC. */
  date: (row: T) => string | null | undefined;
  locale: Locale;
  main?: boolean;
}): UsageColumn<T> => ({
  key,
  label,
  width: "130px",
  sortable: true,
  main,
  render: (row) => {
    const value = date(row);
    return value ? (
      <TextCell>{formatDistance(parseApiDate(value), new Date(), { addSuffix: true, locale })}</TextCell>
    ) : null;
  },
});

/** The column of the person a row belongs to. With `onPick`, a click on a
 * person `canPick` allows narrows the detail to them; `hint` says how. A row
 * without a person shows `absent` ("Owner removed") as plain text, or
 * nothing. */
export const personColumn = <T,>({
  label,
  person,
  onPick,
  canPick,
  hint,
  absent,
}: {
  label: string;
  person: (row: T) => { id: string; name: string } | null;
  onPick?: (who: { id: string; name: string }) => void;
  canPick?: (id: string) => boolean;
  hint: (name: string) => string;
  absent?: string;
}): UsageColumn<T> => ({
  key: "owner",
  label,
  width: "170px",
  render: (row) => {
    const who = person(row);
    if (!who) return absent ? <TextCell>{absent}</TextCell> : null;
    const pick = onPick && (canPick?.(who.id) ?? true) ? onPick : undefined;
    return (
      <UsagePersonCell
        id={who.id}
        name={who.name}
        {...(pick ? { onClick: () => pick(who), hint: hint(who.name) } : {})}
      />
    );
  },
});

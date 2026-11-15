"use client";

import { Chip, Skeleton, useMediaQuery, useTheme } from "@mui/material";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import {
  type CreditBalance,
  PAGE_SIZE,
  type StorageByLayer,
  type StorageLayer,
  type StorageType,
  downloadStorageCsv,
  useStorageLayers,
} from "@/lib/api/usage";
import { formatMegabytes } from "@/lib/utils/credits";

import MarkBlock from "@/components/dashboard/common/MarkBlock";
import PillMenu from "@/components/dashboard/common/PillMenu";
import SearchInput from "@/components/dashboard/common/SearchInput";
import ToolPill from "@/components/dashboard/common/ToolPill";
import {
  DetailFrame,
  DetailList,
  figureColumn,
  personColumn,
  sinceColumn,
} from "@/components/settings/usage/UsageDetailFrame";
import {
  PLAIN,
  type SortState,
  SplitCard,
  searchChips,
  useListControls,
  useMemberDirectory,
} from "@/components/settings/usage/UsageDetailParts";
import { type UsageColumn, UsageNumberCell, UsageTitleCell } from "@/components/settings/usage/UsageList";
import { ExportPill, MemberPill } from "@/components/settings/usage/UsageToolbar";

/** Largest first; a name sorts from A, a figure or a date from the top. */
const DEFAULT_SORT: SortState = { key: "size", dir: "desc" };
const TYPES: StorageType[] = ["polygon", "point", "line", "table", "raster"];

interface Person {
  id: string;
  name: string;
}

/** A layer type as the type menu and a row name it. */
const typeLabel = (type: StorageType, t: TFunction): string =>
  type === "table" || type === "raster" ? t(type) : t(`usage_type_${type}`);

/** A row's type in words: a feature layer by its geometry. */
const rowType = (row: StorageLayer, t: TFunction): string => {
  if (row.type !== "feature") return t(row.type);
  const geometry = TYPES.find((type) => type === row.geometry_type);
  return geometry ? typeLabel(geometry, t) : t("layer");
};

/**
 * The organization's storage: the amount against the limit (an error callout
 * over it), the storage split into layers in a project, in none and in the
 * trash, and its live layers, largest first, filtered and paged on the
 * server. The filters are this tile's own: the address keeps only the member
 * of the credit tiles. `balance` is undefined until `/credits/balance`
 * answers: the layers are there before it, the amount fills in with it.
 */
export const StorageDetail = ({ balance }: { balance?: CreditBalance }) => {
  const { t, i18n } = useTranslation("common");
  const language = i18n.language;
  const theme = useTheme();
  // A phone gives the search a row of its own above the pills.
  const isPhone = useMediaQuery(theme.breakpoints.down("sm"));
  const dateLocale = useDateFnsLocale();
  const list = useListControls();
  const [owner, setOwner] = useState<Person | null>(null);
  const [type, setType] = useState<StorageType | null>(null);
  const [unused, setUnused] = useState(false);
  const directory = useMemberDirectory();
  const sort = list.sort ?? DEFAULT_SORT;
  const filters = {
    q: list.q || undefined,
    owner: owner?.id,
    type: type ?? undefined,
    unused: unused || undefined,
    sort: sort.key,
    dir: sort.dir,
  };
  const layers = useStorageLayers({ ...filters, limit: PAGE_SIZE, offset: (list.page - 1) * PAGE_SIZE });

  // The split and the trash do not follow the filters: the last ones read
  // stay while a new page loads.
  const [summary, setSummary] = useState<Pick<StorageByLayer, "split" | "trash"> | null>(null);
  if (layers.storage && layers.storage.split !== summary?.split) {
    setSummary({ split: layers.storage.split, trash: layers.storage.trash });
  }

  /** A filter of this detail: the list starts on page 1 again. */
  const filtered =
    <V,>(set: (value: V) => void) =>
    (value: V) => {
      set(value);
      list.restart();
    };
  const pickOwner = filtered(setOwner);
  const pickType = filtered(setType);
  const toggleUnused = filtered(setUnused);
  const size = (mb: number) => formatMegabytes(mb, language);
  const people = [...directory.people.entries()].map(([id, person]) => ({ id, name: person.name }));

  const used = balance?.used_storage ?? 0;
  const limit = balance?.total_storage ?? null;
  const over = limit !== null && used > limit;
  const trash = summary?.trash;
  const columns: UsageColumn<StorageLayer>[] = [
    {
      key: "name",
      label: t("layer"),
      width: "minmax(0, 1fr)",
      sortable: true,
      render: (row) => (
        <UsageTitleCell
          title={row.name}
          sub={rowType(row, t)}
          mark={
            <MarkBlock kind={row.type === "feature" ? "vector" : row.type} geometryType={row.geometry_type} />
          }
        />
      ),
    },
    personColumn({
      label: t("owner"),
      // A creator whose account was removed leaves no owner: the row stays
      // the organization's through its space, and there is no one to filter by.
      person: (row) =>
        row.owner_id === null
          ? null
          : {
              id: row.owner_id,
              name: row.owner ?? directory.people.get(row.owner_id)?.name ?? t("unknown"),
            },
      absent: t("usage_owner_removed"),
      onPick: pickOwner,
      hint: (name) => t("usage_show_layers_of", { name, ...PLAIN }),
    }),
    {
      key: "projects",
      label: t("projects"),
      width: "90px",
      align: "right",
      sortable: true,
      render: (row) =>
        row.projects === 0 ? (
          <Chip size="small" variant="outlined" color="warning" label={t("usage_unused")} />
        ) : (
          <UsageNumberCell value={row.projects.toLocaleString(language)} />
        ),
    },
    sinceColumn({
      key: "updated",
      label: t("usage_col_updated"),
      date: (row) => row.updated_at,
      locale: dateLocale,
    }),
    figureColumn({ key: "size", label: t("size"), main: true, value: (row) => size(row.size_mb) }),
  ];

  const chips = [
    ...(owner
      ? [{ label: t("usage_owner_chip", { name: owner.name, ...PLAIN }), onRemove: () => pickOwner(null) }]
      : []),
    ...(type
      ? [{ label: t("usage_type_chip", { type: typeLabel(type, t) }), onRemove: () => pickType(null) }]
      : []),
    ...(unused ? [{ label: t("usage_not_in_project"), onRemove: () => toggleUnused(false) }] : []),
    ...searchChips(t, list.query, () => list.setQuery("")),
  ];
  const noun = (count: number) => t("usage_noun_layers", { count });
  const anyFilter = !!owner || !!type || unused;

  const splitTotal = summary
    ? summary.split.in_projects_mb + summary.split.unused_mb + summary.split.trash_mb
    : 0;
  const above = summary ? (
    splitTotal > 0 && (
      <SplitCard
        parts={[
          {
            key: "projects",
            label: t("usage_split_in_projects", { amount: size(summary.split.in_projects_mb) }),
            value: summary.split.in_projects_mb,
            color: theme.palette.primary.main,
          },
          {
            key: "unused",
            label: t("usage_split_unused", { amount: size(summary.split.unused_mb) }),
            value: summary.split.unused_mb,
            color: theme.palette.warning.main,
          },
          {
            key: "trash",
            label: t("usage_split_trash", {
              count: summary.trash.count,
              amount: size(summary.split.trash_mb),
              layers: summary.trash.count.toLocaleString(language),
            }),
            value: summary.split.trash_mb,
            color: theme.palette.grey[500],
          },
        ]}
      />
    )
  ) : layers.isError ? null : (
    <Skeleton variant="rounded" height={78} sx={{ borderRadius: "12px" }} />
  );

  return (
    <DetailFrame
      // The amount is the balance's: the header waits for it. Over the limit,
      // the callout names what the trash holds: it waits for the layers' first
      // answer too (or says less when that fails).
      header={
        !balance || (over && !trash && !layers.isError)
          ? undefined
          : {
              title: t("usage_tile_storage"),
              amount: size(used),
              amountRest:
                limit === null
                  ? t("usage_amount_used_no_limit")
                  : over
                    ? t("usage_amount_over", { limit: size(limit), over: size(used - limit) })
                    : t("usage_amount_of", { limit: size(limit) }),
              amountTone: over ? "error" : undefined,
              explain: t("usage_storage_explain"),
              limitLine: limit !== null && !over ? t("usage_storage_limit") : undefined,
              callout: over
                ? trash && trash.count > 0
                  ? t("usage_storage_over", { trash: size(trash.size_mb) })
                  : t("usage_storage_over_no_trash")
                : undefined,
            }
      }
      above={above}
      toolbar={
        <>
          <SearchInput
            size="toolbar"
            fullWidth={isPhone}
            value={list.query}
            onChange={list.setQuery}
            placeholder={t("usage_search_layers")}
          />
          <MemberPill
            value={owner?.id ?? null}
            options={people}
            onChange={(id) => pickOwner(id ? (people.find((person) => person.id === id) ?? null) : null)}
            allLabel={t("usage_all_owners")}
            valueLabel={owner?.name}
          />
          <PillMenu<StorageType | "all">
            value={type ?? "all"}
            options={[
              { value: "all", label: t("usage_all_types") },
              ...TYPES.map((value) => ({ value, label: typeLabel(value, t) })),
            ]}
            onChange={(value) => pickType(value === "all" ? null : value)}
            icon={ICON_NAME.LAYERS}
            active={type !== null}
            label={t("type")}
          />
          <ToolPill
            icon={ICON_NAME.FOLDER}
            label={t("usage_not_in_project")}
            active={unused}
            pressed={unused}
            onClick={() => toggleUnused(!unused)}
          />
          <ExportPill onExport={() => downloadStorageCsv(filters)} />
        </>
      }>
      <DetailList
        label={t("usage_tile_storage")}
        noun={noun}
        columns={columns}
        rows={layers.storage?.rows}
        rowKey={(row) => row.layer_id}
        total={layers.storage?.total ?? 0}
        page={list.page}
        onPage={list.setPage}
        sort={sort}
        onSort={(key) => list.sortBy(key, sort, key === "name" ? "asc" : "desc")}
        chips={chips}
        onClearAll={() => {
          setOwner(null);
          setType(null);
          setUnused(false);
          list.setQuery("");
        }}
        isLoading={layers.isLoading}
        failed={!!layers.isError}
        searched={list.q}
        emptyTitle={anyFilter ? t("usage_empty_filters", { noun: noun(0) }) : t("usage_storage_empty")}
        emptyHint={anyFilter ? t("usage_empty_filters_hint") : t("usage_storage_empty_hint")}
      />
    </DetailFrame>
  );
};

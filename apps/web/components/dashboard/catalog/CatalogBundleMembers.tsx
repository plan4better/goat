"use client";

import { Box, Checkbox, Skeleton, Stack, Typography, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import { Icon } from "@p4b/ui/components/Icon";

import { useCatalogCollectionItems } from "@/lib/api/catalog";
import { catalogKindOf, markFor } from "@/lib/catalog/kind";
import type { CatalogItem } from "@/lib/validations/catalog";

import { useCatalogLabels } from "@/hooks/catalog/useCatalogLabels";

/** The layers inside a dataset, listed under its card. */

/** A map service's server, which says more in a row than a geometry the service does not publish. */
const serviceHost = (item: CatalogItem): string | undefined => {
  const href = item.links?.find((link) => link.rel === "wms" || link.rel === "wmts")?.href;
  if (!href) return undefined;
  try {
    return new URL(href).host;
  } catch {
    return undefined;
  }
};

/**
 * Rows a bundle shows before the list starts scrolling.
 *
 * 75% of the catalog's multi-layer datasets have five layers or fewer, so most
 * bundles keep rendering exactly as they did, with no scrollbar. The tail is
 * what this is for: the largest has 429 layers (50 of which are fetched), and
 * inline that is a card several screens tall which pushes every other result out
 * of view. A height cap rather than a row cap, because a picker must not hide
 * layers the user can tick.
 */
const MAX_VISIBLE_MEMBERS = 5;

const CatalogBundleMembers = ({
  collectionId,
  onOpenMember,
  selection,
  dense,
}: {
  collectionId: string;
  onOpenMember?: (memberId: string) => void;
  /**
   * Tile width: the geometry column goes, since the row's glyph already says what
   * the geometry is, and the row sits closer to the card's edges. Its fixed tracks
   * need about 410px, which a tile in a three-column grid does not have.
   */
  dense?: boolean;
  /** Present in the Add Layer picker: each layer is chosen individually. */
  selection?: {
    isSelected: (memberId: string) => boolean;
    onToggle: (memberId: string) => void;
  };
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const labels = useCatalogLabels();
  const { items, isLoading, isError } = useCatalogCollectionItems(collectionId, {
    limit: 50,
  });

  const pad = dense ? 3 : 5;
  // The row's vertical padding, in theme spacing units — used both by the rows
  // and by the height the list scrolls at, so the two cannot drift apart.
  const padY = dense ? 2 : 2.5;
  // A row is its padding plus one `body2` line and the divider beneath it.
  // Built as a calc from `theme.spacing` rather than parsed out of it: this
  // theme returns rem ("0.25rem"), so arithmetic on the string yields NaN and
  // the cap silently disappears.
  const rowHeight = `calc(${theme.spacing(padY * 2)} + 21px)`;
  const scrolls = items.length > MAX_VISIBLE_MEMBERS;

  if (isLoading) {
    return (
      <Stack spacing={1} sx={{ px: pad, py: 3 }}>
        <Skeleton variant="text" width="60%" />
        <Skeleton variant="text" width="45%" />
      </Stack>
    );
  }

  if (isError || items.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: pad, py: 3 }}>
        {t("catalog_bundle_members_unavailable")}
      </Typography>
    );
  }

  return (
    <Stack
      divider={<Box sx={{ borderTop: `1px solid ${theme.palette.divider}` }} />}
      sx={
        scrolls
          ? {
              maxHeight: `calc(${MAX_VISIBLE_MEMBERS} * (${rowHeight}))`,
              overflowY: "auto",
              overscrollBehavior: "contain",
            }
          : undefined
      }>
      {items.map((member) => {
        const rows = member.properties["table:row_count"];
        const kind = catalogKindOf(member, true);
        const service = kind === "wms" || kind === "wmts";
        const picked = selection?.isSelected(member.id) ?? false;
        return (
          <Box
            key={member.id}
            onClick={(event) => {
              // The card behind this row acts on the whole dataset; a member row
              // must act on the member instead.
              event.stopPropagation();
              if (selection) {
                selection.onToggle(member.id);
                return;
              }
              onOpenMember?.(member.id);
            }}
            sx={{
              display: "grid",
              // Fixed tracks, right-aligned: ragged `flex` columns put each row's geometry and count at a different x, so the numbers could not be read down the list.
              gridTemplateColumns: dense
                ? selection
                  ? "28px 16px minmax(0, 1fr) auto"
                  : "16px minmax(0, 1fr) auto"
                : selection
                  ? "28px 16px minmax(0, 1fr) 88px 96px"
                  : "16px minmax(0, 1fr) 88px 96px",
              alignItems: "center",
              columnGap: dense ? 2 : 3,
              px: pad,
              py: padY,
              cursor: onOpenMember || selection ? "pointer" : "default",
              backgroundColor: picked ? theme.palette.action.selected : undefined,
              "&:hover": onOpenMember || selection
                ? { backgroundColor: theme.palette.action.hover }
                : undefined,
            }}>
            {selection && (
              <Checkbox
                size="small"
                checked={picked}
                onClick={(event) => event.stopPropagation()}
                onChange={() => selection.onToggle(member.id)}
                sx={{ p: 0.5 }}
              />
            )}
            <Icon
              iconName={markFor({ kind, geometryType: member.properties["goat:geometryType"] })}
              style={{ fontSize: 13 }}
              htmlColor={theme.palette.text.secondary}
            />
            <Typography variant="body2" noWrap title={member.properties.title}>
              {member.properties.title}
            </Typography>
            {!dense && (
              <Typography variant="caption" color="text.secondary" noWrap>
                {service ? labels.kindLabel(kind) : labels.geometryLabel(member.properties["goat:geometryType"])}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" align="right" noWrap>
              {service
                ? serviceHost(member)
                : typeof rows === "number"
                  ? t("catalog_row_count_short", { count: rows })
                  : ""}
            </Typography>
          </Box>
        );
      })}
    </Stack>
  );
};

export default CatalogBundleMembers;

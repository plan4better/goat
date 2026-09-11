"use client";

import { Box, Chip, IconButton, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import { formatDistanceToNowStrict } from "date-fns";
import type { DragEvent } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { audienceOf, markKindOf, typeLabelKey } from "@/lib/utils/content";
import type { ContentItem, Space } from "@/lib/validations/content";

import type { PopperMenuItem } from "@/components/common/PopperMenu";
import ContentThumbnail from "@/components/dashboard/common/ContentThumbnail";
import KindBadges from "@/components/dashboard/common/KindBadges";
import SurfaceCard from "@/components/dashboard/common/SurfaceCard";
import TypeTag from "@/components/dashboard/common/TypeTag";
import AudienceChip from "@/components/dashboard/content/AudienceChip";
import ContentCreatorCell from "@/components/dashboard/content/ContentCreatorCell";
import ContentKebab from "@/components/dashboard/content/ContentKebab";
import ContentSelectCircle from "@/components/dashboard/content/ContentSelectCircle";

const THUMBNAIL_HEIGHT = 132;

interface ContentCardProps {
  item: ContentItem;
  space: Space | undefined;
  selected: boolean;
  anySelected: boolean;
  onToggleSelect: (id: string) => void;
  onOpen: (item: ContentItem) => void;
  menuItems: PopperMenuItem[];
  onMenuSelect: (item: PopperMenuItem) => void;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (event: DragEvent<HTMLDivElement>) => void;
  /** Below `md`: a shorter 96px thumbnail and a larger 28px select circle
   * in place of the desktop 132px/22px sizing. */
  mobile?: boolean;
  /** Renders the hover select circle. Off on Home (H14), where a card is
   * never part of a multi-select. */
  selectable?: boolean;
  /** Pinned to Home (H4/H14) — the bookmark glyph stays visible and filled. */
  pinned?: boolean;
  /** Given, a 26px bookmark button renders beside (or, unselectable, in
   * place of) the select circle, visible on hover or while pinned. */
  onTogglePin?: () => void;
  /** Where the item lives, shown under its name while a search lists
   * results from anywhere beneath the browsed folder. */
  location?: string;
}

/** One grid tile for a project, layer, or bundle. The picture carries only
 * what has to sit on it: the type tag and the hover-revealed select circle.
 * Everything that must stay legible over any thumbnail lives on paper — the
 * kebab beside the title, and a meta row of the creator's avatar (name in
 * the tooltip), the last-updated time and, in the bottom-right corner, who
 * else can see the item; an item private to its space shows no chip at all. Clicking the card selects it while anything
 * else on the page is already selected, and opens it otherwise — the same
 * click never does both, so a multi-select in progress can't be broken by a
 * stray open. */
const ContentCard = ({
  item,
  space,
  selected,
  anySelected,
  onToggleSelect,
  onOpen,
  location,
  menuItems,
  onMenuSelect,
  draggable,
  onDragStart,
  onDragEnd,
  mobile,
  selectable = true,
  pinned,
  onTogglePin,
}: ContentCardProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dateLocale = useDateFnsLocale();

  const audience = audienceOf(item, space);
  const showAudience =
    audience.kind === "public" ||
    audience.kind === "restricted" ||
    audience.kind === "shared" ||
    audience.kind === "org";
  const thumbnailHeight = mobile ? 96 : THUMBNAIL_HEIGHT;

  return (
    <SurfaceCard
      selected={selected}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={(event) => {
        event.stopPropagation();
        if (anySelected) onToggleSelect(item.id);
        else onOpen(item);
      }}
      className="content-card"
      sx={{
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        "&:hover .content-card-select, &:hover .content-card-pin": { opacity: 1 },
      }}>
      <Box
        sx={{
          position: "relative",
          height: thumbnailHeight,
          borderBottom: `1px solid ${theme.palette.divider}`,
          borderRadius: "11px 11px 0 0",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // `ContentThumbnail` rounds its own frame; here the card's clipped
          // top corners already do that, so the inner rounding is dropped.
          "& > div:first-of-type": { borderRadius: 0 },
        }}>
        <ContentThumbnail
          kind={markKindOf(item)}
          geometryType={item.feature_layer_geometry_type}
          href={item.thumbnail_url ?? undefined}
          variant="card"
          height={thumbnailHeight}
        />

        <Box
          sx={{
            position: "absolute",
            top: 10,
            left: 10,
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
          }}>
          <TypeTag label={t(typeLabelKey(item))} locked={item.restricted || item.restricted_inherited} />
          {item.type === "template" && (item.template_kinds ?? []).length > 0 && (
            <KindBadges kinds={item.template_kinds ?? []} size={20} />
          )}
        </Box>
      </Box>

      <Box sx={{ position: "absolute", top: 8, right: 8, display: "flex", alignItems: "center", gap: "4px" }}>
        {selectable && (
          <ContentSelectCircle
            className="content-card-select"
            checked={selected}
            onToggle={() => onToggleSelect(item.id)}
            mobile={mobile}
          />
        )}
        {onTogglePin && (
          <Tooltip title={t(pinned ? "unpin_from_home" : "pin_to_home")} placement="top" disableInteractive>
            <IconButton
              className="content-card-pin"
              aria-label={t(pinned ? "unpin_from_home" : "pin_to_home")}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin();
              }}
              sx={{
                width: 26,
                height: 26,
                p: 0,
                flexShrink: 0,
                borderRadius: "50%",
                backgroundColor: theme.palette.background.paper,
                opacity: pinned ? 1 : 0,
                transition: "opacity 120ms",
                "&:hover": { backgroundColor: theme.palette.background.paper },
              }}>
              <Icon
                iconName={ICON_NAME.BOOKMARK}
                style={{
                  fontSize: 14,
                  color: pinned ? theme.palette.primary.main : theme.palette.text.secondary,
                }}
              />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      <Box sx={{ padding: "9px 9px 12px 13px" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <Typography
            component="div"
            noWrap
            sx={{
              flex: 1,
              minWidth: 0,
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: "-0.1px",
              lineHeight: 1.3,
            }}>
            {item.name}
          </Typography>
          <ContentKebab items={menuItems} onSelect={onMenuSelect} mobile={mobile} />
        </Box>
        {location && (
          <Typography
            component="div"
            noWrap
            sx={{ fontSize: 11.5, color: theme.palette.text.secondary, mt: "2px", pr: "4px" }}>
            {location}
          </Typography>
        )}
        <Box sx={{ display: "flex", alignItems: "center", gap: "8px", mt: "4px", pr: "4px" }}>
          {/* The avatar never shrinks — the time and the audience chip give
           * way (and truncate) when the row runs out of width. */}
          <ContentCreatorCell creator={item.created_by} sx={{ flexShrink: 0 }} />
          <Tooltip title={t("last_updated")} placement="top" disableInteractive>
            <Typography
              component="span"
              noWrap
              sx={{ fontSize: 12, color: theme.palette.text.secondary, minWidth: 0 }}>
              {/* The strict, floored distance ("3 hours ago", not "about 3
               * hours ago") — the meta row is one line at the card's 232px
               * minimum. Rows and the details panel keep the full form. */}
              {formatDistanceToNowStrict(new Date(item.updated_at), {
                addSuffix: true,
                roundingMethod: "floor",
                locale: dateLocale,
              })}
            </Typography>
          </Tooltip>
          {item.type === "template" && item.template_catalog_status === "published" && (
            <Chip
              label={t("goat_catalog")}
              size="small"
              sx={{
                height: 18,
                fontSize: 10,
                fontWeight: 700,
                flexShrink: 0,
                ml: pinned || showAudience ? 0 : "auto",
                // Same primary colour the details panel gives the shelf
                // state, so one template reads the same in both places.
                color: theme.palette.primary.main,
                backgroundColor: alpha(theme.palette.primary.main, 0.12),
                "& .MuiChip-label": { px: 1 },
              }}
            />
          )}
          {showAudience && (
            <Box sx={{ display: "flex", minWidth: 0, ml: pinned ? 0 : "auto" }}>
              <AudienceChip audience={audience} />
            </Box>
          )}
        </Box>
      </Box>
    </SurfaceCard>
  );
};

export default ContentCard;

"use client";

import { Box, Button, Chip, IconButton, Paper, Stack, Typography, alpha, useTheme } from "@mui/material";
import { formatDistance } from "date-fns";
import { Trans, useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { useUserProfile } from "@/lib/api/users";
import {
  folderPath,
  iconFor,
  lastRoleSegment,
  markKindOf,
  restrictedAncestorName,
  spaceDisplayName,
  spaceIconFor,
  typeLabelKey,
} from "@/lib/utils/content";
import type { ContentItem, ShareEntry, Space } from "@/lib/validations/content";
import type { Folder } from "@/lib/validations/folder";

import { canActOn, canMoveAll } from "@/hooks/dashboard/content/useContentActions";

import ContentThumbnail from "@/components/dashboard/common/ContentThumbnail";
import KindBadges from "@/components/dashboard/common/KindBadges";
import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";

/** The card plus the 40px inset that keeps it on the page's right edge. */
export const DETAILS_PANEL_WIDTH = 334;

/** The picture at the top of a single item's details, shorter than a card's
 * band so the metadata below it stays in view without scrolling. */
const DETAILS_THUMBNAIL_HEIGHT = 120;

/** The "current location" summary the no-selection body renders — built by
 * the page from whatever space/folder/view is currently browsed. `rows` is
 * a generic label/value list (e.g. how many folders/projects/datasets sit
 * here) rendered under the name; empty when there's nothing worth showing. */
export interface ContentDetailsLocation {
  icon: ICON_NAME;
  name: string;
  subKey?: string;
  rows: [string, string][];
}

interface ContentDetailsPanelProps {
  selected: ContentItem[];
  space: Space | undefined;
  spaces: Space[];
  folders: Folder[];
  location: ContentDetailsLocation;
  onClose: () => void;
  onShare: () => void;
  onMove: () => void;
  onDelete: () => void;
  isPublic?: boolean;
  /** Below `md` this renders full-bleed inside a bottom sheet rather than
   * the desktop's fixed-width right column. */
  mobile?: boolean;
}

/** Every team/organization/user grant on an item, flattened into one list —
 * the "Who has access" section renders one row per entry regardless of
 * which of the three buckets it came from. */
const shareEntries = (item: ContentItem): ShareEntry[] => [
  ...(item.shared_with?.teams ?? []),
  ...(item.shared_with?.organizations ?? []),
  ...(item.shared_with?.users ?? []),
];

/** The feed's right-hand details column: nothing selected shows the current
 * space/folder; one item shows its full metadata and access list; more than
 * one shows the selected names and the bulk actions every one of them
 * allows. Share/Move/Delete call back into the page, which is the one place
 * that knows how to open their dialogs — this component only decides
 * whether each button should show, from `canActOn` (owner, and not a
 * shortcut — a shortcut's row carries its target's id and role), plus
 * `canMoveAll` for Move, which also needs the selection to be in one
 * space. */
const ContentDetailsPanel = ({
  selected,
  space,
  spaces,
  folders,
  location,
  onClose,
  onShare,
  onMove,
  onDelete,
  isPublic,
  mobile,
}: ContentDetailsPanelProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dateLocale = useDateFnsLocale();
  const { userProfile } = useUserProfile();

  const item = selected.length === 1 ? selected[0] : undefined;
  // Move needs one space to browse for a destination; Delete does not.
  const canMoveSelection = canMoveAll(selected);
  const canDeleteSelection = selected.every(canActOn);
  const itemSpace = item ? (spaces.find((s) => s.id === item.space_id) ?? space) : undefined;
  const isActionable = item ? canActOn(item) : false;
  const grants = item ? shareEntries(item) : [];
  const isRestricted = !!item && (item.restricted || item.restricted_inherited);

  // The labelled metadata rows, in the same treatment the catalog's own
  // detail sidebar uses. "Owner" stays a sentence below them, since it names
  // its own subject rather than being a value in a column.
  const metaRows: { icon: ICON_NAME; label: string; value: string }[] = item
    ? [
        { icon: iconFor(item), label: t("type"), value: t(typeLabelKey(item)) },
        {
          icon: ICON_NAME.FOLDER,
          label: t("location"),
          value: [
            spaceDisplayName(itemSpace, t),
            ...folderPath(folders, item.folder_id)
              .filter((folder) => folder.name !== "home")
              .map((folder) => folder.name),
          ].join(" › "),
        },
        {
          icon: ICON_NAME.CLOCK,
          label: t("modified"),
          value: formatDistance(new Date(item.updated_at), new Date(), {
            addSuffix: true,
            locale: dateLocale,
          }),
        },
        ...(item.created_by
          ? [
              {
                icon: ICON_NAME.USER,
                label: t("creator"),
                value: item.created_by.id === userProfile?.id ? t("you") : item.created_by.name,
              },
            ]
          : []),
      ]
    : [];

  const accessCircleSx = {
    width: 20,
    height: 20,
    borderRadius: "50%",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.palette.action.hover,
  } as const;

  const roleChipSx = { height: 19, fontSize: 11, fontWeight: 700, "& .MuiChip-label": { px: 1 } } as const;

  const actionPillSx = {
    flex: 1,
    borderRadius: "999px",
    // Side padding so a longer label ("Verschieben zu") does not touch the
    // pill's edge in the narrow details column.
    padding: "8px 14px",
    whiteSpace: "nowrap",
    fontSize: 13,
    fontWeight: 700,
    textTransform: "none",
  } as const;

  return (
    <Box
      component="aside"
      sx={{
        width: mobile ? "100%" : DETAILS_PANEL_WIDTH,
        height: mobile ? "100%" : undefined,
        flexShrink: 0,
        padding: mobile ? 0 : "18px 40px 18px 0",
        boxSizing: "border-box",
        display: "flex",
      }}>
      <Paper
        elevation={0}
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: mobile ? 0 : "12px",
          boxShadow: mobile ? "none" : surfaceShadows(theme).rest,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: "9px",
            padding: "13px 14px",
            borderBottom: `1px solid ${theme.palette.divider}`,
          }}>
          <Icon iconName={ICON_NAME.INFO} style={{ fontSize: 15, color: theme.palette.text.secondary }} />
          <Typography component="span" sx={{ flex: 1, fontSize: 13.5, fontWeight: 700 }}>
            {t("details")}
          </Typography>
          <IconButton size="small" onClick={onClose} aria-label={t("close")}>
            <Icon iconName={ICON_NAME.CLOSE} style={{ fontSize: 15 }} />
          </IconButton>
        </Box>
        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", padding: "16px" }}>
          {selected.length === 0 && (
            <Box>
              <Box sx={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
                <Box
                  sx={{
                    width: 36,
                    height: 36,
                    borderRadius: "9px",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: alpha(theme.palette.primary.main, 0.12),
                  }}>
                  <Icon
                    iconName={location.icon}
                    style={{ fontSize: 16, color: theme.palette.primary.main }}
                  />
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Typography component="div" noWrap sx={{ fontSize: 14.5, fontWeight: 800 }}>
                    {location.name}
                  </Typography>
                  {location.subKey && (
                    <Typography component="div" sx={{ fontSize: 11.5, color: "text.secondary" }}>
                      {t(location.subKey)}
                    </Typography>
                  )}
                </Box>
              </Box>
              {location.rows.map(([labelKey, value]) => (
                <Box key={labelKey} sx={{ display: "flex", gap: "10px", padding: "5px 0", fontSize: 12.5 }}>
                  <Box
                    component="span"
                    sx={{ flex: 1, minWidth: 0, color: "text.secondary", fontWeight: 600 }}>
                    {t(labelKey)}
                  </Box>
                  <Box component="span" sx={{ fontWeight: 600 }}>
                    {value}
                  </Box>
                </Box>
              ))}
              <Typography sx={{ marginTop: "12px", fontSize: 12, color: "text.disabled", lineHeight: 1.5 }}>
                {t("select_items_hint")}
              </Typography>
            </Box>
          )}

          {item && itemSpace && (
            <Box>
              <Box
                sx={{
                  height: DETAILS_THUMBNAIL_HEIGHT,
                  borderRadius: "10px",
                  border: `1px solid ${theme.palette.divider}`,
                  overflow: "hidden",
                  marginBottom: "14px",
                  display: "flex",
                  // `ContentThumbnail` rounds its own frame; this block's border
                  // already carries the rounding, so the inner one is dropped.
                  "& > div:first-of-type": { borderRadius: 0 },
                }}>
                <ContentThumbnail
                  kind={markKindOf(item)}
                  geometryType={item.feature_layer_geometry_type}
                  href={item.thumbnail_url ?? undefined}
                  variant="card"
                  height={DETAILS_THUMBNAIL_HEIGHT}
                />
              </Box>
              <Typography component="div" noWrap sx={{ fontSize: 15, fontWeight: 700, marginBottom: "6px" }}>
                {item.name}
              </Typography>

              {item.type === "template" && (item.template_kinds ?? []).length > 0 && (
                <Box sx={{ marginBottom: "10px" }}>
                  <KindBadges kinds={item.template_kinds ?? []} size={20} />
                </Box>
              )}

              <Box>
                {metaRows.map((row, index) => (
                  <Stack
                    key={row.label}
                    direction="row"
                    spacing="12px"
                    alignItems="flex-start"
                    sx={{
                      paddingY: "10px",
                      borderBottom:
                        index < metaRows.length - 1 ? `1px solid ${theme.palette.divider}` : "none",
                    }}>
                    <Box
                      sx={{
                        width: 28,
                        height: 28,
                        borderRadius: "6px",
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: theme.palette.action.hover,
                      }}>
                      <Icon iconName={row.icon} style={{ fontSize: 13, color: theme.palette.primary.main }} />
                    </Box>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography
                        component="div"
                        sx={{
                          fontSize: 11,
                          fontWeight: 600,
                          letterSpacing: "0.3px",
                          color: "text.secondary",
                        }}>
                        {row.label}
                      </Typography>
                      <Typography
                        component="div"
                        sx={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35, overflowWrap: "anywhere" }}>
                        {row.value}
                      </Typography>
                    </Box>
                  </Stack>
                ))}
              </Box>

              <Typography sx={{ marginTop: "10px", fontSize: 12, color: "text.secondary" }}>
                {t("owned_by", {
                  name: itemSpace.kind === "personal" ? t("only_you") : spaceDisplayName(itemSpace, t),
                })}
              </Typography>

              {item.type === "template" && item.template_catalog_status === "published" && (
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: "8px" }}>
                  <Icon
                    iconName={ICON_NAME.GLOBE}
                    style={{ fontSize: 13, color: theme.palette.primary.main }}
                  />
                  <Typography sx={{ fontSize: 12.5, fontWeight: 700, color: "primary.main" }}>
                    {t("goat_catalog")}
                  </Typography>
                </Stack>
              )}

              <Box sx={{ height: "1px", backgroundColor: theme.palette.divider, margin: "14px 0 10px" }} />

              <Typography
                component="div"
                sx={{
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: "0.7px",
                  textTransform: "uppercase",
                  color: "text.secondary",
                  marginBottom: "8px",
                }}>
                {t("who_has_access")}
              </Typography>
              {item.restricted && (
                <Typography sx={{ fontSize: 12, marginBottom: "8px", lineHeight: 1.5 }}>
                  {t("restricted_note")}
                </Typography>
              )}
              {!item.restricted && item.restricted_inherited && (
                <Typography sx={{ fontSize: 12, marginBottom: "8px", lineHeight: 1.5 }}>
                  <Trans
                    i18nKey="common:restricted_inherited_note"
                    values={{ folder: restrictedAncestorName(folders, item.folder_id) }}
                    components={{ b: <b /> }}
                  />
                </Typography>
              )}
              <Stack>
                {/* A restricted item withholds the space default (D9), so the
                space is not one of its audiences — only the grants below are.
                A personal space has no members for the flag to narrow. */}
                {(!isRestricted || itemSpace.kind === "personal") && (
                  <Box sx={{ display: "flex", alignItems: "center", gap: "9px", padding: "4px 0" }}>
                    <Box sx={accessCircleSx}>
                      <Icon
                        iconName={spaceIconFor(itemSpace)}
                        style={{ fontSize: 11, color: theme.palette.text.secondary }}
                      />
                    </Box>
                    <Typography
                      component="span"
                      noWrap
                      sx={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600 }}>
                      {itemSpace.kind === "personal" ? t("only_you") : spaceDisplayName(itemSpace, t)}
                    </Typography>
                    {itemSpace.kind !== "personal" && (
                      <Chip label={t("space_members")} size="small" sx={roleChipSx} />
                    )}
                  </Box>
                )}
                {grants.map((entry) => (
                  <Box
                    key={entry.id}
                    sx={{ display: "flex", alignItems: "center", gap: "9px", padding: "4px 0" }}>
                    <Box sx={accessCircleSx}>
                      <Icon
                        iconName={ICON_NAME.USERS}
                        style={{ fontSize: 11, color: theme.palette.text.secondary }}
                      />
                    </Box>
                    <Typography
                      component="span"
                      noWrap
                      sx={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600 }}>
                      {entry.name ?? entry.id}
                    </Typography>
                    <Chip label={t(lastRoleSegment(entry.role))} size="small" sx={roleChipSx} />
                  </Box>
                ))}
              </Stack>

              {item.type === "folder" && grants.length > 0 && (
                <Typography
                  sx={{
                    display: "block",
                    marginTop: "8px",
                    fontSize: 11.5,
                    color: "text.disabled",
                    lineHeight: 1.45,
                  }}>
                  {t("folder_share_cascade")}
                </Typography>
              )}

              {isPublic && (
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: "10px" }}>
                  <Icon
                    iconName={ICON_NAME.GLOBE}
                    style={{ fontSize: 13, color: theme.palette.warning.main }}
                  />
                  <Typography sx={{ fontSize: 12.5, fontWeight: 700, color: "warning.main" }}>
                    {t("published_to_web")}
                  </Typography>
                </Stack>
              )}

              {isActionable && (
                <Stack direction="row" spacing="8px" sx={{ mt: "16px" }}>
                  <Button
                    variant="contained"
                    onClick={onShare}
                    startIcon={<Icon iconName={ICON_NAME.SHARE} style={{ fontSize: 13 }} />}
                    sx={actionPillSx}>
                    {t("share")}
                  </Button>
                  <Button
                    variant="outlined"
                    color="inherit"
                    onClick={onMove}
                    startIcon={<Icon iconName={ICON_NAME.FOLDER} style={{ fontSize: 13 }} />}
                    sx={{ ...actionPillSx, borderColor: alpha(theme.palette.text.primary, 0.24) }}>
                    {t("move_to")}
                  </Button>
                </Stack>
              )}
            </Box>
          )}

          {selected.length > 1 && (
            <Box>
              <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 2 }}>
                {t("n_selected", { count: selected.length })}
              </Typography>
              <Stack spacing={1}>
                {selected.map((entry) => (
                  <Stack key={entry.id} direction="row" alignItems="center" spacing={1}>
                    <Icon iconName={iconFor(entry)} style={{ fontSize: 14 }} />
                    <Typography variant="body2" noWrap>
                      {entry.name}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
              {(canMoveSelection || canDeleteSelection) && (
                <Stack direction="row" spacing="8px" sx={{ mt: "16px" }}>
                  {canMoveSelection && (
                    <Button
                      variant="outlined"
                      color="inherit"
                      onClick={onMove}
                      startIcon={<Icon iconName={ICON_NAME.FOLDER} style={{ fontSize: 13 }} />}
                      sx={{ ...actionPillSx, borderColor: alpha(theme.palette.text.primary, 0.24) }}>
                      {t("move_to")}
                    </Button>
                  )}
                  {canDeleteSelection && (
                    <Button
                      variant="outlined"
                      color="error"
                      onClick={onDelete}
                      startIcon={<Icon iconName={ICON_NAME.TRASH} style={{ fontSize: 13 }} />}
                      sx={actionPillSx}>
                      {t("delete")}
                    </Button>
                  )}
                </Stack>
              )}
            </Box>
          )}
        </Box>
      </Paper>
    </Box>
  );
};

export default ContentDetailsPanel;

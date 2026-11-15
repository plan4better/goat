"use client";

import {
  Box,
  IconButton,
  ListItemButton,
  Paper,
  Skeleton,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { Space } from "@/lib/validations/content";

import type { ActiveScope } from "@/hooks/dashboard/content/useContentPageState";

import { selectedRowInk } from "@/components/dashboard/common/currentPlace";
import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";

/** The card plus the 40px inset that keeps it on the page title's edge. */
const PANEL_WIDTH = 312;
/** The card alone, without that inset — the width a flush rail takes. */
const PANEL_CARD_WIDTH = 272;

interface ContentSpacesPanelProps {
  spaces: Space[];
  active: ActiveScope;
  onSelectSpace: (spaceId: string) => void;
  onSelectView: (view: "shared_with_me" | "recent") => void;
  /** Count badge on "Shared with me"; hidden when 0 or unset. */
  sharedCount?: number;
  /** The space a drag is currently hovering. */
  dropTargetId?: string | null;
  onDragOverSpace?: (spaceId: string | null) => void;
  onDropSpace?: (spaceId: string) => void;
  onOpenTrash?: () => void;
  onOpenSettings?: (spaceId: string) => void;
  /** Below `md` the page has no persistent left column — this panel instead
   * renders full-bleed inside a bottom sheet, with its own close button. */
  mobile?: boolean;
  onClose?: () => void;
  /** Whether the space list is still being fetched. The team group is then a
   * row of placeholders, and no count is claimed for a list nobody has yet. */
  loading?: boolean;
  /** Edge-to-edge: no inset, no card radius and no border of its own — the
   * picker's rail, like the catalog picker's filter rail. The host draws the
   * single rule between the rail and what sits beside it. */
  flush?: boolean;
}

/** The left column of the Content page: every space the user belongs to
 * (personal, team, organization) plus the cross-space views, always visible
 * on desktop so switching spaces never re-fetches the page shell. Renders as
 * a floating card inset from the page canvas, with the organisation's storage
 * quota in its footer. */
const ContentSpacesPanel = ({
  spaces,
  active,
  onSelectSpace,
  onSelectView,
  sharedCount,
  dropTargetId,
  onDragOverSpace,
  onDropSpace,
  onOpenTrash,
  onOpenSettings,
  mobile,
  onClose,
  loading,
  flush,
}: ContentSpacesPanelProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [teamSpacesOpen, setTeamSpacesOpen] = useState(true);

  const personalSpace = spaces.find((s) => s.kind === "personal");
  const teamSpaces = spaces.filter((s) => s.kind === "team");
  const organizationSpace = spaces.find((s) => s.kind === "organization");

  const isActiveSpace = (spaceId: string) => active.kind === "space" && active.spaceId === spaceId;
  const isActiveView = (view: "shared_with_me" | "recent") => active.kind === "view" && active.view === view;

  const activeSpace = spaces.find((s) => active.kind === "space" && active.spaceId === s.id);
  const canOpenTrash = activeSpace?.my_role === "owner";
  const canOpenSettings = (space: Space) => space.kind !== "personal" && space.my_role === "owner";

  const dragHandlers = (spaceId: string) => ({
    onDragOver: onDragOverSpace
      ? (event: React.DragEvent) => {
          event.preventDefault();
          onDragOverSpace(spaceId);
        }
      : undefined,
    onDragLeave: onDragOverSpace ? () => onDragOverSpace(null) : undefined,
    onDrop: onDropSpace
      ? (event: React.DragEvent) => {
          event.preventDefault();
          onDropSpace(spaceId);
        }
      : undefined,
  });

  const dropOutline = (spaceId: string) =>
    dropTargetId === spaceId
      ? { outline: `2px dashed ${theme.palette.primary.main}`, outlineOffset: -2 }
      : undefined;

  /** Shared shape of every navigation row in the panel body. */
  const rowSx = (selected: boolean) => ({
    display: "flex",
    alignItems: "center",
    gap: 1.25,
    padding: "9px 10px",
    borderRadius: "8px",
    minHeight: 0,
    ...(selected && { backgroundColor: theme.palette.action.selected }),
    "&:hover": { backgroundColor: selected ? theme.palette.action.selected : theme.palette.action.hover },
  });

  const rowLabelSx = (selected: boolean) => ({
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    fontWeight: selected ? 700 : 500,
    color: selected ? selectedRowInk(theme) : theme.palette.text.primary,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  });

  const countBadge = (value: number) => (
    <Box
      component="span"
      sx={{
        fontSize: 11,
        fontWeight: 700,
        color: theme.palette.text.secondary,
        backgroundColor: theme.palette.action.hover,
        borderRadius: "999px",
        padding: "1px 8px",
      }}>
      {value}
    </Box>
  );

  const divider = (
    <Box sx={{ height: "1px", backgroundColor: theme.palette.divider, mx: "8px", my: "8px" }} />
  );

  /** Every user has a personal space, so the row is drawn while the list is
   * still being fetched — inert until there is an id to select. */
  const personalPlaceholderRow = (
    <ListItemButton disableGutters disabled sx={rowSx(false)}>
      <Box sx={{ display: "flex", flexShrink: 0 }}>
        <Icon iconName={ICON_NAME.USER} style={{ fontSize: 17, color: theme.palette.text.secondary }} />
      </Box>
      <Typography component="span" sx={rowLabelSx(false)}>
        {t("my_content")}
      </Typography>
    </ListItemButton>
  );

  const spaceRow = (space: Space, icon: ICON_NAME, label: string, tooltip: string) => {
    const selected = isActiveSpace(space.id);
    return (
      <ListItemButton
        key={space.id}
        disableGutters
        onClick={() => onSelectSpace(space.id)}
        sx={{ ...rowSx(selected), ...dropOutline(space.id) }}
        {...dragHandlers(space.id)}>
        <Tooltip title={tooltip} placement="right">
          <Box sx={{ display: "flex", flexShrink: 0 }}>
            <Icon
              iconName={icon}
              style={{
                fontSize: 17,
                color: selected ? selectedRowInk(theme) : theme.palette.text.secondary,
              }}
            />
          </Box>
        </Tooltip>
        <Typography component="span" title={label} sx={rowLabelSx(selected)}>
          {label}
        </Typography>
        {canOpenSettings(space) && selected && onOpenSettings && (
          <Tooltip title={t("space_settings")}>
            <IconButton
              size="small"
              aria-label={t("space_settings")}
              onClick={(event) => {
                event.stopPropagation();
                onOpenSettings(space.id);
              }}>
              <Icon iconName={ICON_NAME.SETTINGS} style={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
      </ListItemButton>
    );
  };

  const viewRow = (view: "shared_with_me" | "recent", icon: ICON_NAME, badge?: number) => {
    const selected = isActiveView(view);
    return (
      <ListItemButton disableGutters onClick={() => onSelectView(view)} sx={rowSx(selected)}>
        <Box sx={{ display: "flex", flexShrink: 0 }}>
          <Icon
            iconName={icon}
            style={{
              fontSize: 17,
              color: selected ? selectedRowInk(theme) : theme.palette.text.secondary,
            }}
          />
        </Box>
        <Typography component="span" sx={rowLabelSx(selected)}>
          {t(view)}
        </Typography>
        {!!badge && countBadge(badge)}
      </ListItemButton>
    );
  };

  return (
    <Box
      component="aside"
      sx={{
        width: mobile ? "100%" : flush ? PANEL_CARD_WIDTH : PANEL_WIDTH,
        flexShrink: 0,
        padding: mobile || flush ? 0 : "18px 0 18px 40px",
        boxSizing: "border-box",
        display: "flex",
        // On mobile the panel sits inside a `SwipeableDrawer` sheet capped
        // by `maxHeight` rather than a fixed-height column, so it grows with
        // its own content (and scrolls) instead.
        maxHeight: mobile ? "78vh" : undefined,
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
          ...(flush && { borderRadius: 0, border: "none", boxShadow: "none" }),
        }}>
        <Box
          sx={{
            padding: mobile ? "13px 8px 13px 14px" : "13px 12px 13px 16px",
            borderBottom: `1px solid ${theme.palette.divider}`,
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}>
          <Typography
            component="span"
            sx={{ flex: 1, fontSize: mobile ? 13.5 : 15, fontWeight: 700, letterSpacing: "-0.1px" }}>
            {t("spaces")}
          </Typography>
          {mobile && onClose && (
            <IconButton size="small" onClick={onClose} aria-label={t("close")}>
              <Icon iconName={ICON_NAME.CLOSE} fontSize="small" />
            </IconButton>
          )}
        </Box>

        <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px" }}>
          {personalSpace && spaceRow(personalSpace, ICON_NAME.USER, t("my_content"), t("personal_space"))}
          {!personalSpace && loading && personalPlaceholderRow}

          {divider}

          <Box
            component="button"
            type="button"
            onClick={() => setTeamSpacesOpen(!teamSpacesOpen)}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.75,
              width: "100%",
              padding: "6px 10px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontFamily: "inherit",
            }}>
            <Icon
              iconName={teamSpacesOpen ? ICON_NAME.CHEVRON_DOWN : ICON_NAME.CHEVRON_RIGHT}
              style={{ fontSize: 13, color: theme.palette.text.secondary }}
            />
            <Typography
              component="span"
              sx={{
                flex: 1,
                textAlign: "left",
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: "0.5px",
                textTransform: "uppercase",
                color: theme.palette.text.secondary,
              }}>
              {t("team_spaces")}
            </Typography>
            {!loading && countBadge(teamSpaces.length)}
          </Box>
          {loading &&
            Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} variant="rounded" height={40} sx={{ borderRadius: "8px", mb: 1 }} />
            ))}
          {!loading &&
            teamSpacesOpen &&
            teamSpaces.map((space) => spaceRow(space, ICON_NAME.USERS, space.name, t("team_space")))}

          {divider}

          {organizationSpace &&
            spaceRow(organizationSpace, ICON_NAME.ORGANIZATION, t("organization"), t("organization_space"))}

          {divider}

          {viewRow("shared_with_me", ICON_NAME.SHARE, loading ? undefined : sharedCount)}
          {viewRow("recent", ICON_NAME.CLOCK)}

          {canOpenTrash && onOpenTrash && (
            <>
              {divider}
              <ListItemButton disableGutters onClick={onOpenTrash} sx={rowSx(false)}>
                <Box sx={{ display: "flex", flexShrink: 0 }}>
                  <Icon
                    iconName={ICON_NAME.TRASH}
                    style={{ fontSize: 17, color: theme.palette.text.secondary }}
                  />
                </Box>
                <Typography component="span" sx={rowLabelSx(false)}>
                  {t("trash")}
                </Typography>
              </ListItemButton>
            </>
          )}
        </Box>
      </Paper>
    </Box>
  );
};

export default ContentSpacesPanel;

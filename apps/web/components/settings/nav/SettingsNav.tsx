"use client";

import {
  Box,
  Collapse,
  ListItemButton,
  Paper,
  Skeleton,
  type Theme,
  Typography,
  useTheme,
} from "@mui/material";
import NextLink from "next/link";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { focusRing } from "@/components/assistant/styles";
import { selectedRowInk } from "@/components/dashboard/common/currentPlace";
import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";
import type { SettingsNavGroup, SettingsNavItem } from "@/components/settings/nav/settingsNav";

/** Remembers whether the viewer left White Label open (a per-viewer convenience). */
export const WHITE_LABEL_OPEN_KEY = "goat.settings.whiteLabelOpen";

const readOpen = (): boolean | null => {
  try {
    const stored = window.localStorage.getItem(WHITE_LABEL_OPEN_KEY);
    return stored === null ? null : stored === "1";
  } catch {
    return null;
  }
};
const writeOpen = (open: boolean) => {
  try {
    window.localStorage.setItem(WHITE_LABEL_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Private window or blocked storage: the nav still works, it just forgets.
  }
};

// The look of Content's left menu (`components/dashboard/content/ContentSpacesPanel.tsx`,
// `rowSx`, `rowLabelSx`, `countBadge`, `divider`), so the two menus read as one.

/** The shape of every row: Content's `rowSx`, plus a keyboard focus ring. */
const rowSx = (theme: Theme, selected: boolean, minHeight?: number) =>
  ({
    display: "flex",
    alignItems: "center",
    gap: 1.25,
    padding: "9px 10px",
    borderRadius: "8px",
    minHeight: minHeight ?? 0,
    ...(selected && { backgroundColor: theme.palette.action.selected }),
    "&:hover": {
      backgroundColor: selected ? theme.palette.action.selected : theme.palette.action.hover,
    },
    // Keyboard focus only: a ring, so it reads on the current row's fill too.
    // The mouse look stays Content's.
    ...focusRing(theme),
  }) as const;

/** Content's `rowLabelSx`. */
const rowLabelSx = (theme: Theme, selected: boolean) =>
  ({
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    fontWeight: selected ? 700 : 500,
    color: selected ? selectedRowInk(theme) : theme.palette.text.primary,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  }) as const;

/** Content's group heading ("Team spaces"). */
const headingSx = (theme: Theme) =>
  ({
    fontSize: 11.5,
    fontWeight: 700,
    letterSpacing: "0.5px",
    color: theme.palette.text.secondary,
  }) as const;

const RowIcon = ({ icon, selected }: { icon: ICON_NAME; selected: boolean }) => {
  const theme = useTheme();
  return (
    <Box sx={{ display: "flex", flexShrink: 0 }}>
      <Icon
        iconName={icon}
        style={{ fontSize: 17, color: selected ? selectedRowInk(theme) : theme.palette.text.secondary }}
      />
    </Box>
  );
};

/** The line between two groups: Content's `divider`. */
export const NavDivider = () => (
  <Box aria-hidden sx={{ height: "1px", backgroundColor: "divider", mx: "8px", my: "8px" }} />
);

/** Where a child row's label starts: under its parent's label (row padding,
 * icon and gap). */
const CHILD_INDENT = "32px";

/** One link row: icon, label, the Mitglieder badge. A link
 * (`<a href>`, prefetched as every `next/link`) drawn as Content's rows, so it
 * reads as a menu entry rather than as text with an underline. */
export function NavRow({
  item,
  memberCount,
  indent = false,
  minHeight,
  onNavigate,
}: {
  item: SettingsNavItem;
  memberCount?: number;
  indent?: boolean;
  /** 44 in the phone sheet; else the row's own height. */
  minHeight?: number;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  if (item.skeleton || !item.href) {
    // The row's own height (its padding around a 14px line), so nothing moves
    // when the roles arrive.
    return (
      <Box aria-hidden sx={{ ...rowSx(theme, false, minHeight), "&:hover": undefined }}>
        <Skeleton variant="rounded" height={14} width="70%" sx={{ my: "3.5px", borderRadius: "6px" }} />
      </Box>
    );
  }
  return (
    <ListItemButton
      component={NextLink}
      href={item.href}
      disableGutters
      aria-current={item.current ? "page" : undefined}
      onClick={onNavigate}
      sx={{ ...rowSx(theme, item.current, minHeight), ...(indent && { pl: CHILD_INDENT }) }}>
      {item.icon && <RowIcon icon={item.icon} selected={item.current} />}
      <Typography component="span" sx={rowLabelSx(theme, item.current)}>
        {t(item.labelKey)}
      </Typography>
      {item.key === "members" && memberCount !== undefined && (
        <Box
          component="span"
          aria-hidden
          sx={{
            fontSize: 11,
            fontWeight: 700,
            color: "text.secondary",
            backgroundColor: "action.hover",
            borderRadius: "999px",
            padding: "1px 8px",
          }}>
          {memberCount}
        </Box>
      )}
    </ListItemButton>
  );
}

function WhiteLabelRow({ item }: { item: SettingsNavItem }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const childrenId = useId();
  // Read after mount: the server cannot know it, and the first render must
  // match. undefined until read, null when nothing is stored.
  const [stored, setStored] = useState<boolean | null | undefined>(undefined);
  useEffect(() => setStored(readOpen()), []);
  // Nothing moves until the render after the stored state is applied (a
  // transition reads the props of the render that flips it), or the group
  // would visibly fold shut on every entry.
  const read = stored !== undefined;
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    if (read) setAnimate(true);
  }, [read]);
  const open = !!item.containsCurrent || stored !== false;

  return (
    <>
      <ListItemButton
        component="button"
        type="button"
        disableGutters
        aria-expanded={open}
        aria-controls={childrenId}
        // Open while a child is current, and a click there does nothing: say so.
        aria-disabled={item.containsCurrent || undefined}
        onClick={() => {
          // Open while a child is current: a click there would only store
          // "closed" for every other settings page.
          if (item.containsCurrent) return;
          const next = !open;
          setStored(next);
          writeOpen(next);
        }}
        // A <button>, unlike the link rows: the app's font, as Content's fold button sets.
        sx={{ ...rowSx(theme, false), width: "100%", textAlign: "left", fontFamily: "inherit" }}>
        <RowIcon icon={ICON_NAME.LINK} selected={false} />
        <Typography component="span" sx={rowLabelSx(theme, false)}>
          {t(item.labelKey)}
        </Typography>
        <Icon
          iconName={ICON_NAME.CHEVRON_DOWN}
          style={{
            fontSize: 13,
            color: theme.palette.text.secondary,
            transform: open ? "rotate(180deg)" : "none",
            transition: animate ? "transform 140ms" : "none",
          }}
        />
      </ListItemButton>
      <Collapse in={open} id={childrenId} timeout={animate ? "auto" : 0}>
        {item.children?.map((child) => <NavRow key={child.key} item={child} indent />)}
      </Collapse>
    </>
  );
}

/** A group's heading as Content's "Team spaces": small, bold, muted, in capitals. */
export function NavHeading({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Typography aria-hidden sx={{ ...headingSx(theme), padding: "6px 10px", textTransform: "uppercase" }}>
      {children}
    </Typography>
  );
}

/** The desktop nav (from `md`): the groups in one card that runs the height
 * of the column, as Content's left menu; its body scrolls on its own. */
export default function SettingsNav({
  groups,
  memberCount,
}: {
  groups: SettingsNavGroup[];
  memberCount?: number;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <Paper
      component="nav"
      aria-labelledby="settings-navigation"
      elevation={0}
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: "12px",
        boxShadow: surfaceShadows(theme).rest,
      }}>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px" }}>
        {groups.map((group, index) => (
          <Box key={group.key}>
            {index > 0 && <NavDivider />}
            <Box role="group" aria-label={t(group.labelKey)}>
              <NavHeading>{t(group.labelKey)}</NavHeading>
              {group.items.map((item) =>
                item.key === "whiteLabel" && !item.skeleton ? (
                  <WhiteLabelRow key={item.key} item={item} />
                ) : (
                  <NavRow key={item.key} item={item} memberCount={memberCount} />
                )
              )}
            </Box>
          </Box>
        ))}
      </Box>
    </Paper>
  );
}

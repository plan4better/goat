import type { Theme } from "@mui/material";
import { Box, ButtonBase, IconButton, SwipeableDrawer, Tooltip, Typography, useTheme } from "@mui/material";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { GOATLogoIconOnlyGreen } from "@p4b/ui/assets/svg/GOATLogoIconOnlyGreen";
import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { SETTINGS_ROUTES } from "@/lib/settingsRoutes";

import type { NavItem } from "@/types/common/navigation";

import { focusRing } from "@/components/assistant/styles";
import { POPOVER_ROW_SX } from "@/components/common/popoverRow";
import { currentPlaceColors } from "@/components/dashboard/common/currentPlace";
import { TOOLBAR_HEIGHT, toolbarBorder } from "@/components/header/Toolbar";

interface Props {
  hidden: boolean;
  collapsedWidth: number;
  width: number;
  navVisible: boolean;
  setNavVisible: (value: boolean) => void;
  /** Beside the logo at the top of the phone's menu: the header's title. */
  title?: string;
}

/** One place on the rail: its icon in a rounded square, its name in a tooltip
 * beside it, so the rail stays as narrow as the toolbar is high. */
function RailItem({ item, theme }: { item: NavItem; theme: Theme }) {
  const { fill, ink } = currentPlaceColors(theme);
  return (
    <Tooltip title={item.label} placement="right" arrow>
      <ButtonBase
        component={NextLink}
        href={item.link}
        aria-label={item.label}
        aria-current={item.current ? "page" : undefined}
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 40,
          height: 40,
          mx: "auto",
          flexShrink: 0,
          borderRadius: "10px",
          color: item.current ? ink : theme.palette.text.secondary,
          backgroundColor: item.current ? fill : "transparent",
          ...(!item.current && {
            "&:hover": {
              color: theme.palette.text.primary,
              backgroundColor: theme.palette.action.hover,
            },
          }),
          ...focusRing(theme),
        }}>
        <Icon iconName={item.icon} htmlColor="inherit" sx={{ fontSize: 18 }} />
      </ButtonBase>
    </Tooltip>
  );
}

/** One place in the phone's menu: the popovers' row at a height a thumb hits,
 * the current one marked as on the rail. A link and nothing else: one stop. */
function DrawerItem({ item, theme, onPick }: { item: NavItem; theme: Theme; onPick: () => void }) {
  const { fill, ink } = currentPlaceColors(theme);
  return (
    <ButtonBase
      component={NextLink}
      href={item.link}
      onClick={onPick}
      aria-current={item.current ? "page" : undefined}
      sx={{
        ...POPOVER_ROW_SX,
        justifyContent: "flex-start",
        minHeight: 44,
        px: "12px",
        fontFamily: "inherit",
        fontSize: 14,
        fontWeight: item.current ? 700 : 600,
        color: item.current ? ink : theme.palette.text.primary,
        backgroundColor: item.current ? fill : "transparent",
        ...(!item.current && { "&:hover": { backgroundColor: theme.palette.action.hover } }),
        ...focusRing(theme),
      }}>
      <Icon
        iconName={item.icon}
        htmlColor="inherit"
        sx={{ fontSize: 17, flexShrink: 0, color: item.current ? "inherit" : theme.palette.text.secondary }}
      />
      {item.label}
    </ButtonBase>
  );
}

const DashboardSidebar = (props: Props) => {
  const { hidden, width, collapsedWidth, navVisible, setNavVisible, title } = props;
  const theme = useTheme();
  const pathname = usePathname();

  // A page change by another way than a pick here (the browser's Back) closes
  // the phone's menu too.
  const lastPathname = useRef(pathname);
  useEffect(() => {
    if (lastPathname.current === pathname) return;
    lastPathname.current = pathname;
    setNavVisible(false);
  }, [pathname, setNavVisible]);

  const { t } = useTranslation("common");

  const places: NavItem[] = [
    {
      link: "/home",
      icon: ICON_NAME.HOUSE,
      label: t("home"),
      current: pathname?.includes("/home"),
    },
    {
      link: "/content",
      icon: ICON_NAME.FOLDER,
      label: t("content"),
      current: pathname?.includes("/content"),
    },
    {
      link: "/catalog",
      icon: ICON_NAME.EARTH,
      label: t("catalog"),
      current: pathname?.includes("/catalog"),
    },
  ];
  const settings: NavItem = {
    link: SETTINGS_ROUTES.profile,
    icon: ICON_NAME.GEAR,
    label: t("settings"),
    current: pathname?.includes("/settings"),
  };

  // From md: a rail that is always there and never opens over the page; a
  // place's name shows in a tooltip. `hidden` is false on the server and the first client
  // render, so the breakpoint (not `hidden`) hides it on a phone.
  if (!hidden) {
    return (
      <Box
        component="nav"
        aria-label={t("main_navigation")}
        sx={{
          display: { xs: "none", md: "flex" },
          flexDirection: "column",
          gap: 2,
          width: collapsedWidth,
          flexShrink: 0,
          py: 2.5,
          boxSizing: "border-box",
          overflowY: "auto",
          backgroundColor: theme.palette.background.paper,
          borderRight: `1px solid ${theme.palette.divider}`,
        }}>
        {places.map((item) => (
          <RailItem key={item.link} item={item} theme={theme} />
        ))}
        <Box
          aria-hidden
          sx={{ width: 24, height: "1px", mx: "auto", flexShrink: 0, backgroundColor: theme.palette.divider }}
        />
        <RailItem item={settings} theme={theme} />
      </Box>
    );
  }

  // Below md: the drawer the header's menu button opens. It covers the header,
  // so it has a top row of its own, at the header's height, with the way out.
  return (
    <SwipeableDrawer
      variant="temporary"
      open={navVisible}
      onOpen={() => setNavVisible(true)}
      onClose={() => setNavVisible(false)}
      ModalProps={{ keepMounted: true }}
      sx={{
        zIndex: (theme) => theme.zIndex.drawer + 2,
        "& .MuiPaper-root": {
          width: `min(${width}px, 85vw)`,
          overflowX: "hidden",
          backgroundColor: theme.palette.background.paper,
          backgroundImage: "none",
        },
      }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          height: TOOLBAR_HEIGHT,
          flexShrink: 0,
          pl: "14px",
          pr: "6px",
          borderBottom: toolbarBorder(theme),
        }}>
        <GOATLogoIconOnlyGreen style={{ width: 28, height: 28, flexShrink: 0 }} />
        {title && (
          <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 700 }}>
            {title}
          </Typography>
        )}
        <IconButton aria-label={t("close")} onClick={() => setNavVisible(false)} sx={{ ml: "auto" }}>
          <Icon iconName={ICON_NAME.XCLOSE} htmlColor="inherit" sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>
      <Box
        component="nav"
        aria-label={t("main_navigation")}
        sx={{ display: "flex", flexDirection: "column", gap: "2px", p: 2 }}>
        {places.map((item) => (
          <DrawerItem key={item.link} item={item} theme={theme} onPick={() => setNavVisible(false)} />
        ))}
        <Box aria-hidden sx={{ height: "1px", mx: 2, my: 1.5, backgroundColor: theme.palette.divider }} />
        <DrawerItem item={settings} theme={theme} onPick={() => setNavVisible(false)} />
      </Box>
    </SwipeableDrawer>
  );
};

export default DashboardSidebar;

import type { CSSObject, Theme } from "@mui/material";
import {
  Link,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  SwipeableDrawer,
  useTheme,
} from "@mui/material";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { SETTINGS_ROUTES } from "@/lib/settingsRoutes";

import type { NavItem } from "@/types/common/navigation";

const openedMixin = (theme: Theme): CSSObject => ({
  transition: theme.transitions.create("width", {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.enteringScreen,
  }),
});

const closedMixin = (theme: Theme): CSSObject => ({
  transition: theme.transitions.create("width", {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.leavingScreen,
  }),
});

interface Props {
  hidden: boolean;
  collapsedWidth: number;
  width: number;
  navVisible: boolean;
  setNavVisible: (value: boolean) => void;
}

const DashboardSidebar = (props: Props) => {
  const { hidden, width, collapsedWidth, navVisible, setNavVisible } = props;
  const theme = useTheme();
  const pathname = usePathname();

  const { t } = useTranslation("common");
  const MobileDrawerProps = {
    open: navVisible,
    onOpen: () => setNavVisible(true),
    onClose: () => setNavVisible(false),
    ModalProps: {
      keepMounted: true,
    },
  };

  const DesktopDrawerProps = {
    open: navVisible,
    onOpen: () => null,
    onClose: () => null,
  };

  const navigation: NavItem[] = [
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
      icon: ICON_NAME.GLOBE,
      label: t("catalog"),
      current: pathname?.includes("/catalog"),
    },
    {
      link: SETTINGS_ROUTES.profile,
      icon: ICON_NAME.SETTINGS,
      label: t("settings"),
      current: pathname?.includes("/settings"),
    },
  ];

  return (
    <SwipeableDrawer
      variant={hidden ? "temporary" : "permanent"}
      {...(hidden ? { ...MobileDrawerProps } : { ...DesktopDrawerProps })}
      open={navVisible}
      onMouseEnter={() => {
        if (!hidden) setNavVisible(true);
      }}
      onMouseLeave={() => {
        if (!hidden) setNavVisible(false);
      }}
      sx={{
        width: hidden ? width : collapsedWidth,
        // `hidden` is false on the server and the first client render, so a phone would paint
        // the rail until hydration. Hide the permanent rail by breakpoint so the server HTML is
        // already right; the temporary drawer (hidden) is a portal and must not be touched.
        ...(!hidden && { display: { xs: "none", md: "block" } }),
        zIndex: (theme) => (hidden ? theme.zIndex.drawer + 2 : theme.zIndex.drawer),
        "& .MuiPaper-root": {
          ...(!hidden && {
            width: navVisible ? width : collapsedWidth,
          }),
          ...(navVisible && {
            ...openedMixin(theme),
          }),
          ...(!navVisible && {
            ...closedMixin(theme),
          }),
          position: "relative",
          overflowX: "hidden",
          backgroundColor: theme.palette.background.paper,
          borderRight: "1px solid rgba(58, 53, 65, 0.12)",
        },
      }}>
      <List dense>
        {navigation.map((item) => (
          <Link
            key={item.icon}
            href={item.link}
            component={NextLink}
            passHref
            style={{ textDecoration: "none" }}>
            <ListItem
              disablePadding
              sx={{
                display: "block",
              }}>
              <ListItemButton
                selected={item.current}
                sx={{
                  minHeight: 48,
                }}>
                <ListItemIcon
                  sx={{
                    minWidth: 0,
                    ml: 0,
                    mr: 6,
                    justifyContent: "center",
                  }}>
                  <Icon
                    iconName={item.icon}
                    fontSize="small"
                    htmlColor={item.current ? theme.palette.primary.main : "inherit"}
                  />
                </ListItemIcon>
                <ListItemText
                  primary={item.label}
                  sx={{
                    "& .MuiTypography-root": {
                      fontWeight: 700,
                      ...(item.current && {
                        color: theme.palette.primary.main,
                      }),
                    },
                  }}
                />
              </ListItemButton>
            </ListItem>
          </Link>
        ))}
      </List>
    </SwipeableDrawer>
  );
};

export default DashboardSidebar;

"use client";

import { Box, useTheme } from "@mui/material";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { SETTINGS_ROUTES } from "@/lib/settingsRoutes";

import PageHeader from "@/components/dashboard/common/PageHeader";
import SettingsNav from "@/components/settings/nav/SettingsNav";
import SettingsNavSheet from "@/components/settings/nav/SettingsNavSheet";
import { settingsNav, settingsPageAllowed } from "@/components/settings/nav/settingsNav";
import { useSettingsNavInput } from "@/components/settings/nav/useSettingsNavInput";

/**
 * The settings shell (decision 14): the title, the nav (or its sheet below
 * `md`) and the page on the page background. The whole area scrolls as one,
 * the scrollbar at the window's edge: the title scrolls away, the nav stays
 * (sticky). A page the caller may not open sends them to Profil once the roles
 * are known; the API refuses them anyway, this only spares an empty page.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const { input, organization, memberCount, isError } = useSettingsNavInput();
  const desktopGroups = settingsNav({ ...input, pathname, phone: false, failed: isError });
  const phoneGroups = settingsNav({ ...input, pathname, phone: true, failed: isError });
  const allowed = settingsPageAllowed(pathname, input);

  const theme = useTheme();
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (allowed === false) router.replace(SETTINGS_ROUTES.profile);
  }, [allowed, router]);

  // The area outlives its pages: a page opened from a scrolled one starts at
  // its top, title included.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [pathname]);

  return (
    // The scroll area: the window's width below the app header, so its
    // scrollbar sits at the window's edge. `width` because the dashboard's
    // main is a flex column. A size container, so the nav can be as high as
    // the area (`cqh`).
    <Box
      ref={scroller}
      sx={{
        height: "100%",
        minHeight: 0,
        width: "100%",
        overflowY: "auto",
        containerType: "size",
        bgcolor: "background.default",
      }}>
      {/* Content's frame (`components/dashboard/content/ContentPage.tsx`) and
          measure, the theme's `xl` (GOAT's is 1432px), centred. At least the
          area's height, so the nav column of a short page runs to its bottom. */}
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          minHeight: "100%",
          maxWidth: theme.breakpoints.values.xl,
          mx: "auto",
        }}>
        <Box sx={{ padding: { xs: "16px 14px 0", md: "40px 40px 0" }, flexShrink: 0 }}>
          <PageHeader title={t("settings_nav_title")} titleId="settings-navigation" responsive />
        </Box>
        {/* A landmark of its own below `md`, as the desktop nav is one. */}
        <Box
          component="nav"
          aria-label={t("settings_nav_sheet_title")}
          sx={{ display: { xs: "block", md: "none" }, padding: "12px 14px 10px", flexShrink: 0 }}>
          <SettingsNavSheet groups={phoneGroups} memberCount={memberCount} />
        </Box>
        <Box sx={{ flex: 1, display: "flex" }}>
          {/* Content's panel column: a 272px card inset 40px from the frame's
              edge, 18px below the title, running to the bottom. */}
          <Box
            sx={{
              display: { xs: "none", md: "flex" },
              width: 312,
              flexShrink: 0,
              padding: "18px 0 18px 40px",
              boxSizing: "border-box",
            }}>
            {/* Stays while the page scrolls, 18px from the area's top and
                bottom; the card's own body scrolls when it is higher. */}
            <Box
              sx={{
                position: "sticky",
                top: "18px",
                display: "flex",
                width: "100%",
                height: "min(100%, calc(100cqh - 36px))",
              }}>
              <SettingsNav
                groups={desktopGroups}
                organization={organization}
                failed={isError}
                memberCount={memberCount}
              />
            </Box>
          </Box>
          {/* Content's right column: the page fills it, heading included. */}
          <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            {allowed === false ? null : children}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

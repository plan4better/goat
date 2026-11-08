"use client";

import { Box, useTheme } from "@mui/material";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";

import { SETTINGS_ROUTES } from "@/lib/settingsRoutes";

import PageHeader from "@/components/dashboard/common/PageHeader";
import SettingsNav from "@/components/settings/nav/SettingsNav";
import SettingsNavSheet from "@/components/settings/nav/SettingsNavSheet";
import { settingsNav, settingsPageAllowed } from "@/components/settings/nav/settingsNav";
import { useSettingsNavInput } from "@/components/settings/nav/useSettingsNavInput";

/**
 * The settings shell (decision 14): the title, the nav (or its sheet below
 * `md`) and the page on the page background. A page the caller may not open
 * sends them to Profil once the roles are known; the API refuses them anyway,
 * this only spares an empty page.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const { input, organization, memberCount, needsAttention, isError } = useSettingsNavInput();
  const desktopGroups = settingsNav({ ...input, pathname, phone: false, failed: isError });
  const phoneGroups = settingsNav({ ...input, pathname, phone: true, failed: isError });
  const allowed = settingsPageAllowed(pathname, input);

  const theme = useTheme();

  useEffect(() => {
    if (allowed === false) router.replace(SETTINGS_ROUTES.profile);
  }, [allowed, router]);

  return (
    // Content's frame (`components/dashboard/content/ContentPage.tsx`): the
    // title and the nav stay where they are; each page, heading included,
    // scrolls as one inside its `SettingsPage`. `width` because the dashboard's
    // main is a flex column: a centred item without one shrinks to its
    // content, and the nav would move with each page.
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        width: "100%",
        // Content's measure, the theme's `xl` (GOAT's is 1432px).
        maxWidth: theme.breakpoints.values.xl,
        mx: "auto",
        bgcolor: "background.default",
      }}>
      <Box sx={{ padding: { xs: "16px 14px 0", md: "40px 40px 0" }, flexShrink: 0 }}>
        <PageHeader title={t("settings_nav_title")} titleId="settings-navigation" responsive />
      </Box>
      {/* A landmark of its own below `md`, as the desktop nav is one. */}
      <Box
        component="nav"
        aria-label={t("settings_nav_sheet_title")}
        sx={{ display: { xs: "block", md: "none" }, padding: "12px 14px 10px", flexShrink: 0 }}>
        <SettingsNavSheet groups={phoneGroups} memberCount={memberCount} needsAttention={needsAttention} />
      </Box>
      <Box sx={{ flex: 1, display: "flex", minHeight: 0 }}>
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
          <SettingsNav
            groups={desktopGroups}
            organization={organization}
            failed={isError}
            memberCount={memberCount}
            needsAttention={needsAttention}
          />
        </Box>
        {/* Content's right column: the page fills it and, heading included,
            scrolls as one inside its `SettingsPage`. */}
        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {allowed === false ? null : children}
        </Box>
      </Box>
    </Box>
  );
}

"use client";

import { Box, Tab, Tabs } from "@mui/material";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { NavItem } from "@/types/common/navigation";

interface OrganizationLayoutProps {
  children: React.ReactNode;
}

const OrganizationLayout = (props: OrganizationLayoutProps) => {
  const children = props.children;
  const pathname = usePathname();
  const { t } = useTranslation("common");

  const navigation: NavItem[] = [
    {
      link: "/profile",
      icon: ICON_NAME.ORGANIZATION,
      label: t("profile"),
      current: pathname?.includes("/profile"),
    },
    {
      link: "/members",
      icon: ICON_NAME.ADD_USER,
      label: t("members"),
      current: pathname?.includes("/members"),
    },
  ];

  // Sub-sections that have their own tabs (e.g. White Label) should not
  // inherit the Profile/Members tabs. Add their path prefixes here as they
  // grow — keeps each sub-section's tab strip self-contained. The AI page has no tabs at all.
  const hideOwnTabs = pathname?.includes("/white-label") || pathname?.includes("/organization/ai");

  if (hideOwnTabs) {
    return <>{children}</>;
  }

  return (
    <>
      <Tabs value={navigation.find((item) => item.current)?.link || false} variant="fullWidth" scrollButtons>
        {navigation.map((item) => (
          <Tab
            LinkComponent={NextLink}
            key={item.link}
            href={`/settings/organization${item.link}`}
            icon={
              <Box sx={{ pr: 2 }}>
                <Icon iconName={item.icon} htmlColor="inherit" style={{ fontSize: 15 }} />
              </Box>
            }
            iconPosition="start"
            label={item.label}
            value={item.link}
            sx={{
              ...(item.current && {
                color: "primary.main",
                fontWeight: "bold",
              }),
            }}
          />
        ))}
      </Tabs>
      {children}
    </>
  );
};

export default OrganizationLayout;

"use client";

import {
  Box,
  Container,
  Grid,
  Link,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Skeleton,
  useTheme,
} from "@mui/material";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useAuthZ } from "@/hooks/auth/AuthZ";

import PageHeader from "@/components/dashboard/common/PageHeader";

interface SettingsLayoutProps {
  children: React.ReactNode;
}

const SettingsLayout = (props: SettingsLayoutProps) => {
  const { children } = props;
  const pathname = usePathname();
  const theme = useTheme();
  const { t } = useTranslation("common");
  const { isOrgAdmin, isLoading: isUserProfileLoading } = useAuthZ();
  const navigation = useMemo(() => {
    return [
      {
        link: "/settings/account",
        icon: ICON_NAME.USER,
        label: t("account"),
        current: pathname?.includes("/account"),
      },
      {
        link: "/settings/teams",
        icon: ICON_NAME.USERS,
        label: t("teams"),
        current: pathname?.includes("/teams"),
      },
      {
        link: "/settings/organization",
        icon: ICON_NAME.ORGANIZATION,
        label: t("organization"),
        current: pathname?.includes("/organization") && !pathname?.includes("/white-label"),
        auth: isOrgAdmin,
      },
      {
        link: "/settings/organization/white-label/domains",
        icon: ICON_NAME.GLOBE,
        label: t("white_label"),
        current: pathname?.includes("/white-label"),
        auth: isOrgAdmin,
      },
      {
        link: "/settings/usage",
        icon: ICON_NAME.CHART_PIE,
        label: t("usage_and_quotas"),
        current: pathname?.includes("/usage"),
        auth: isOrgAdmin,
      },
    ];
  }, [pathname, t, isOrgAdmin]);

  return (
    <Container sx={{ py: 10, px: 10 }} maxWidth="xl">
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          mb: 8,
        }}>
        <PageHeader title={t("settings")} />
      </Box>
      <Grid container justifyContent="space-between" spacing={4}>
        <Grid
          item
          xs={3}
          sx={{
            [theme.breakpoints.down("md")]: {
              display: "none",
            },
          }}>
          <Paper elevation={3}>
            {isUserProfileLoading && <Skeleton variant="rectangular" width="100%" height={200} />}
            {!isUserProfileLoading && (
              <List sx={{ width: "100%" }} component="nav" aria-labelledby="settings-navigation">
                {navigation.map((item) =>
                  item.auth !== false ? (
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
                          <ListItemText primary={item.label} />
                        </ListItemButton>
                      </ListItem>
                    </Link>
                  ) : null
                )}
              </List>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} md={9}>
          <Paper elevation={3}>{children}</Paper>
        </Grid>
      </Grid>
    </Container>
  );
};

export default SettingsLayout;

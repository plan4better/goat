"use client";

import { Box, Button, Chip, Skeleton, Typography } from "@mui/material";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { AnalyticsDashboard, OrganizationAnalytics } from "@/lib/validations/organizationAnalytics";

import SurfaceCard from "@/components/dashboard/common/SurfaceCard";
import RowMenu from "@/components/settings/common/RowMenu";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import { UsageMark } from "@/components/settings/usage/UsageMark";

const PLAIN = { interpolation: { escapeValue: false } } as const;

/** Where an instance is, "Matomo · {URL} · Site-ID {id}" (the URL in
 * monospace), for the card and the remove dialog. */
export function MatomoAddress({ instance }: { instance: OrganizationAnalytics }) {
  const { t } = useTranslation("common");
  const config = instance.config as { url?: string; site_id?: string };
  return (
    <>
      Matomo ·{" "}
      <Box component="span" sx={{ fontFamily: "monospace" }}>
        {config.url}
      </Box>{" "}
      · {t("settings_analytics_site_id", { id: config.site_id ?? "", ...PLAIN })}
    </>
  );
}

/** One Matomo instance: where it is, what it measures (four names, two on a
 * phone). The published dashboards are read once for every card: until they
 * are there, or when they failed, the card claims no measured dashboard and
 * offers no assignment. */
export default function AnalyticsCard({
  instance,
  dashboards,
  dashboardsLoading,
  dashboardsFailed,
  onRetryDashboards,
  onAssign,
  onEdit,
  onRemove,
}: {
  instance: OrganizationAnalytics;
  dashboards: AnalyticsDashboard[];
  dashboardsLoading: boolean;
  dashboardsFailed: boolean;
  onRetryDashboards: () => void;
  onAssign: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("common");
  const titleId = useId();
  const measured = dashboards.filter((dashboard) => dashboard.analytics_id === instance.id);
  const known = !dashboardsLoading && !dashboardsFailed;

  return (
    <SurfaceCard
      component="article"
      aria-labelledby={titleId}
      hoverable={false}
      sx={{ p: 4, display: "flex", flexDirection: "column", gap: 3 }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 3 }}>
        <UsageMark icon={ICON_NAME.CHART} tone="primary" />
        <Box sx={{ flex: "1 1 240px", minWidth: 0 }}>
          <Typography component="h3" id={titleId} fontWeight={700} sx={{ m: 0, overflowWrap: "anywhere" }}>
            {instance.name}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            component="div"
            sx={{ overflowWrap: "anywhere" }}>
            <MatomoAddress instance={instance} />
          </Typography>
        </Box>
        <Button
          size="small"
          variant="outlined"
          disabled={!known}
          startIcon={<Icon iconName={ICON_NAME.MAP} style={{ fontSize: 14 }} htmlColor="inherit" />}
          onClick={onAssign}
          sx={{ borderRadius: 999, whiteSpace: "nowrap" }}>
          {t("settings_analytics_assign")}
        </Button>
        <RowMenu
          label={t("settings_more_actions_for", { name: instance.name, ...PLAIN })}
          items={[
            { key: "edit", label: t("settings_analytics_edit"), onClick: onEdit },
            { key: "remove", label: t("settings_analytics_remove"), danger: true, onClick: onRemove },
          ]}
        />
      </Box>
      {dashboardsFailed ? (
        <SettingsLoadError onRetry={onRetryDashboards} />
      ) : dashboardsLoading ? (
        <Box role="status" aria-busy="true" aria-label={t("settings_nav_loading")}>
          <Skeleton variant="text" width={260} />
        </Box>
      ) : measured.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t("settings_analytics_measures_none")}
        </Typography>
      ) : (
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5 }}>
          <Typography variant="body2" color="text.secondary">
            {t("settings_analytics_measures", { count: measured.length })}
          </Typography>
          {measured.slice(0, 4).map((dashboard, index) => (
            <Chip
              key={dashboard.project_id}
              size="small"
              label={dashboard.name}
              sx={index >= 2 ? { display: { xs: "none", md: "inline-flex" } } : undefined}
            />
          ))}
          {measured.length > 2 && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: { xs: "inline", md: "none" } }}>
              {t("settings_analytics_more", { n: measured.length - 2 })}
            </Typography>
          )}
          {measured.length > 4 && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: { xs: "none", md: "inline" } }}>
              {t("settings_analytics_more", { n: measured.length - 4 })}
            </Typography>
          )}
        </Box>
      )}
    </SurfaceCard>
  );
}

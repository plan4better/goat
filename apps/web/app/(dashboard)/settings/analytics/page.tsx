"use client";

import { Alert, Button, Skeleton, Stack } from "@mui/material";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import {
  useOrganizationAnalytics,
  useOrganizationAnalyticsDashboards,
} from "@/lib/api/organizationAnalytics";
import type { OrganizationAnalytics } from "@/lib/validations/organizationAnalytics";

import { useOrganizationId } from "@/hooks/settings/useOrganizationId";

import { DialogLoadFailed, orLoadFailed } from "@/components/assistant/LoadFailed";
import EmptyState from "@/components/dashboard/common/EmptyState";
import PageHeader from "@/components/dashboard/common/PageHeader";
import AnalyticsCard from "@/components/settings/analytics/AnalyticsCard";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import SettingsPage, { pageActionSx } from "@/components/settings/common/SettingsPage";

// Loaded on first open (L5). A dialog whose code does not load (a deploy
// since the page opened) shows a notice instead of taking the page down.
const MatomoDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/analytics/MatomoDialog"), DialogLoadFailed),
  { ssr: false }
);
const AssignDashboardsDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/analytics/AssignDashboardsDialog"), DialogLoadFailed),
  { ssr: false }
);
const RemoveAnalyticsDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/analytics/RemoveAnalyticsDialog"), DialogLoadFailed),
  { ssr: false }
);

/**
 * White Label › Analytics (owners and admins, with the `white_label` feature;
 * the shell guards both): one card per Matomo instance with the dashboards it
 * measures, the dialogs to connect, edit, assign dashboards and remove. A
 * dashboard is also assigned in the project's Teilen dialog.
 */
export default function AnalyticsPage() {
  const { t } = useTranslation("common");
  // The cookie's id until the organization answers, so the list starts at once (L4).
  const organizationId = useOrganizationId();
  const { analyticsList, isLoading, isError, mutate } = useOrganizationAnalytics(organizationId);
  const {
    dashboards,
    isLoading: dashboardsLoading,
    isError: dashboardsError,
    mutate: mutateDashboards,
  } = useOrganizationAnalyticsDashboards(organizationId);
  const [editing, setEditing] = useState<OrganizationAnalytics | "new" | null>(null);
  const [assigning, setAssigning] = useState<OrganizationAnalytics | null>(null);
  const [removing, setRemoving] = useState<OrganizationAnalytics | null>(null);
  const loading = organizationId === undefined || (isLoading && !isError);
  // A dashboards read that loads has no list yet, also while SWR tries a failed
  // one again (it keeps the error meanwhile); one that failed has none to show.
  const dashboardsPending = organizationId === undefined || dashboardsLoading;
  const dashboardsFailed = !!dashboardsError && !dashboardsLoading;
  const refresh = () => Promise.all([mutate(), mutateDashboards()]);

  const connect = (
    <Button
      variant="contained"
      disabled={!organizationId}
      startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 16 }} htmlColor="inherit" />}
      onClick={() => setEditing("new")}
      sx={pageActionSx}>
      {t("settings_analytics_connect")}
    </Button>
  );

  return (
    <SettingsPage
      header={
        <PageHeader
          level={2}
          responsive
          eyebrow={t("settings_nav_group_white_label")}
          title={t("settings_analytics_title")}
          subtitle={t("settings_analytics_subtitle")}
          action={analyticsList.length > 0 ? connect : undefined}
        />
      }>
      <Alert severity="info" role="note">
        {t("settings_analytics_note")}
      </Alert>
      {isError && analyticsList.length === 0 ? (
        <SettingsLoadError onRetry={() => void mutate()} />
      ) : loading ? (
        <Stack spacing={4} role="status" aria-busy="true" aria-label={t("settings_nav_loading")}>
          <Skeleton variant="rounded" height={112} sx={{ borderRadius: "12px" }} />
        </Stack>
      ) : analyticsList.length === 0 ? (
        <EmptyState
          icon={ICON_NAME.CHART}
          title={t("settings_analytics_empty_title")}
          hint={t("settings_analytics_empty_hint")}
          action={connect}
        />
      ) : (
        // Cards 16px apart, as on every settings page.
        <Stack spacing={4}>
          {analyticsList.map((instance) => (
            <AnalyticsCard
              key={instance.id}
              instance={instance}
              dashboards={dashboards}
              dashboardsLoading={dashboardsPending}
              dashboardsFailed={dashboardsFailed}
              onRetryDashboards={() => void mutateDashboards()}
              onAssign={() => setAssigning(instance)}
              onEdit={() => setEditing(instance)}
              onRemove={() => setRemoving(instance)}
            />
          ))}
        </Stack>
      )}
      {editing !== null && organizationId && (
        <MatomoDialog
          organizationId={organizationId}
          instance={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {assigning && organizationId && (
        <AssignDashboardsDialog
          organizationId={organizationId}
          instance={assigning}
          instances={analyticsList}
          dashboards={dashboards}
          onClose={() => setAssigning(null)}
          onSaved={async (updated) => {
            await mutateDashboards(updated, { revalidate: false });
            // The instances' usage counts follow the assignment.
            await mutate();
          }}
          onSaveFailed={() => void mutateDashboards()}
        />
      )}
      {removing && organizationId && (
        <RemoveAnalyticsDialog
          organizationId={organizationId}
          instance={removing}
          onClose={() => setRemoving(null)}
          onRemoved={refresh}
        />
      )}
    </SettingsPage>
  );
}

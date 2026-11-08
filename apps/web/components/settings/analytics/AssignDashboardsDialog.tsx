"use client";

import { Box, Checkbox, FormControlLabel, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { setAnalyticsDashboards } from "@/lib/api/organizationAnalytics";
import type { AnalyticsDashboard, OrganizationAnalytics } from "@/lib/validations/organizationAnalytics";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { DialogSearchField, warningTextInk } from "@/components/modals/content/ContentDialogChrome";

const PLAIN = { interpolation: { escapeValue: false } } as const;

/** "Dashboards zuweisen": the published dashboards this instance measures, the
 * complete list saved at once. A dashboard measured by another instance says
 * so, and that it moves once ticked. After a failed save the list is read
 * again, and a dashboard no longer in it is not sent again. */
export default function AssignDashboardsDialog({
  organizationId,
  instance,
  instances,
  dashboards,
  onClose,
  onSaved,
  onSaveFailed,
}: {
  organizationId: string;
  instance: OrganizationAnalytics;
  instances: OrganizationAnalytics[];
  dashboards: AnalyticsDashboard[];
  onClose: () => void;
  /** Takes the dashboards as core now has them. */
  onSaved: (updated: AnalyticsDashboard[]) => Promise<unknown>;
  /** Reads the dashboards again: one may have been unpublished meanwhile. */
  onSaveFailed: () => void;
}) {
  const { t } = useTranslation("common");
  const [checked, setChecked] = useState<string[]>(() =>
    dashboards
      .filter((dashboard) => dashboard.analytics_id === instance.id)
      .map((dashboard) => dashboard.project_id)
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const nameOf = new Map(instances.map((other) => [other.id, other.name]));
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? dashboards.filter((dashboard) => dashboard.name.toLowerCase().includes(needle))
    : dashboards;

  const toggle = (projectId: string) =>
    setChecked((current) =>
      current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId]
    );

  const save = async () => {
    setBusy(true);
    try {
      // Only what is still listed: a dashboard gone since the last read would
      // fail the save again.
      const listed = new Set(dashboards.map((dashboard) => dashboard.project_id));
      const updated = await setAnalyticsDashboards(
        organizationId,
        instance.id,
        checked.filter((id) => listed.has(id))
      );
      await onSaved(updated);
      toast.success(t("settings_analytics_assigned"));
      onClose();
    } catch {
      toast.error(t("settings_analytics_assign_error"));
      onSaveFailed();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      open
      onClose={onClose}
      icon={ICON_NAME.MAP}
      title={t("settings_analytics_assign")}
      subtitle={t("settings_analytics_assign_subtitle", { name: instance.name, ...PLAIN })}
      maxWidth={560}
      closeDisabled={busy}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          cancelDisabled={busy}
          primaryLabel={t("save")}
          primaryDisabled={dashboards.length === 0}
          primaryLoading={busy}
          onPrimary={() => void save()}
        />
      }>
      {dashboards.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t("settings_analytics_no_dashboards")}
        </Typography>
      ) : (
        <Stack spacing={3}>
          {/* The search a dialog's list is filtered with (the share dialog's). */}
          <DialogSearchField
            value={query}
            onChange={setQuery}
            placeholder={t("settings_analytics_assign_filter")}
            clearLabel={t("clear")}
            disabled={busy}
          />
          <Stack>
            {shown.map((dashboard) => {
              const on = checked.includes(dashboard.project_id);
              const other =
                dashboard.analytics_id && dashboard.analytics_id !== instance.id
                  ? nameOf.get(dashboard.analytics_id)
                  : undefined;
              return (
                <FormControlLabel
                  key={dashboard.project_id}
                  disabled={busy}
                  control={<Checkbox checked={on} onChange={() => toggle(dashboard.project_id)} />}
                  label={
                    <Box component="span" sx={{ display: "block", py: 1 }}>
                      <Typography variant="body2" component="span" sx={{ display: "block" }}>
                        {dashboard.name}
                      </Typography>
                      {other && (
                        <Typography
                          variant="caption"
                          component="span"
                          sx={{
                            display: "block",
                            // The warning ink, dark enough for small text on paper.
                            color: on ? warningTextInk : "text.secondary",
                          }}>
                          {t(on ? "settings_analytics_switching" : "settings_analytics_currently", {
                            name: other,
                            ...PLAIN,
                          })}
                        </Typography>
                      )}
                    </Box>
                  }
                />
              );
            })}
          </Stack>
        </Stack>
      )}
    </AppDialog>
  );
}

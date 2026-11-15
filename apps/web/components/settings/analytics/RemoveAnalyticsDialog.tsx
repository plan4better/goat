"use client";

import { Stack, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { deleteOrganizationAnalytics } from "@/lib/api/organizationAnalytics";
import type { OrganizationAnalytics } from "@/lib/validations/organizationAnalytics";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { MatomoAddress } from "@/components/settings/analytics/AnalyticsCard";

const PLAIN = { interpolation: { escapeValue: false } } as const;

/** "{Name} entfernen?": names the instance and, when published dashboards use
 * it, that tracking stops there. */
export default function RemoveAnalyticsDialog({
  organizationId,
  instance,
  onClose,
  onRemoved,
}: {
  organizationId: string;
  instance: OrganizationAnalytics;
  onClose: () => void;
  /** Reads the instances and their dashboards again. */
  onRemoved: () => Promise<unknown>;
}) {
  const { t } = useTranslation("common");
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await deleteOrganizationAnalytics(organizationId, instance.id);
      await onRemoved();
      onClose();
    } catch {
      toast.error(t("settings_analytics_remove_error", { name: instance.name, ...PLAIN }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      open
      onClose={onClose}
      icon={ICON_NAME.TRASH}
      tone="warning"
      title={t("settings_analytics_remove_title", { name: instance.name, ...PLAIN })}
      closeDisabled={busy}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          cancelDisabled={busy}
          primaryLabel={t("settings_analytics_remove")}
          primaryColor="error"
          primaryLoading={busy}
          onPrimary={() => void remove()}
        />
      }>
      <Stack spacing={3}>
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
          <MatomoAddress instance={instance} />
        </Typography>
        {instance.usage_count > 0 && (
          <Typography variant="body2">
            {t("settings_analytics_remove_used", { count: instance.usage_count })}
          </Typography>
        )}
      </Stack>
    </AppDialog>
  );
}

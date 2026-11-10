"use client";

import { Alert, Button, Skeleton, Stack, Typography } from "@mui/material";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useCustomDomainConfigRead } from "@/lib/api/customDomainConfig";
import {
  assignDomainToProject,
  deleteCustomDomain,
  unassignDomainFromProject,
  useOrganizationDomains,
} from "@/lib/api/customDomains";
import { undoToast } from "@/lib/toasts";
import type { CustomDomain } from "@/lib/validations/customDomain";

import { useOrganizationId } from "@/hooks/settings/useOrganizationId";

import { DialogLoadFailed, orLoadFailed } from "@/components/assistant/LoadFailed";
import EmptyState from "@/components/dashboard/common/EmptyState";
import PageHeader from "@/components/dashboard/common/PageHeader";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import SettingsPage, { pageActionSx } from "@/components/settings/common/SettingsPage";
import DnsHelpCard from "@/components/settings/whiteLabel/DnsHelpCard";
import DomainCard from "@/components/settings/whiteLabel/DomainCard";
import { customDomainsOff } from "@/components/settings/whiteLabel/domainStatus";

// Loaded on first open (L5). A dialog whose code does not load (a deploy
// since the page opened) shows a notice instead of taking the page down.
const AddDomainDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/whiteLabel/AddDomain/AddDomainDialog"), DialogLoadFailed),
  { ssr: false }
);
const DeleteDomainDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/whiteLabel/DeleteDomainDialog"), DialogLoadFailed),
  { ssr: false }
);
const PLAIN = { interpolation: { escapeValue: false } } as const;

/**
 * White Label › Domains (owners and admins, with the `white_label` feature;
 * the shell guards both): one card per domain with its DNS record and status,
 * the help card, and the add dialog. A domain is assigned to a project in the
 * project's Teilen dialog; here it can only lose its assignment (with undo).
 */
export default function DomainsPage() {
  const { t } = useTranslation("common");
  // The cookie's id until the organization answers, so the list starts at once (L4).
  const organizationId = useOrganizationId();
  const { domains, isError, mutate } = useOrganizationDomains(organizationId);
  const { config, isError: configFailed, mutate: rereadConfig } = useCustomDomainConfigRead();
  const off = customDomainsOff(config);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<CustomDomain | null>(null);

  const unassign = async (domain: CustomDomain) => {
    const projectId = domain.assigned_project_id;
    if (!projectId) return;
    try {
      await unassignDomainFromProject(projectId);
      await mutate();
      undoToast(
        t("settings_domains_unassigned_toast", { domain: domain.base_domain, ...PLAIN }),
        async () => {
          await assignDomainToProject(projectId, domain.id);
          await mutate();
        },
        t
      );
    } catch {
      toast.error(t("settings_domains_unassign_error"));
    }
  };

  // Core refuses adding while custom domains are off: nothing to add until
  // its config says they are on.
  const add = (label: string) => (
    <Button
      variant="contained"
      disabled={!config || off || !organizationId}
      startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 16 }} htmlColor="inherit" />}
      onClick={() => setAdding(true)}
      sx={pageActionSx}>
      {label}
    </Button>
  );

  return (
    <SettingsPage
      header={
        <PageHeader
          level={2}
          responsive
          eyebrow={t("settings_nav_group_white_label")}
          title={t("settings_domains_title")}
          subtitle={t("settings_domains_subtitle")}
          action={domains && domains.length > 0 && !off ? add(t("settings_domains_add")) : undefined}
        />
      }>
      {off ? (
        <Alert severity="info" role="note">
          {t("settings_domains_off")}
        </Alert>
      ) : (
        <DnsHelpCard config={config} failed={!config && !!configFailed} onRetry={() => void rereadConfig()} />
      )}
      {!domains ? (
        isError ? (
          <SettingsLoadError onRetry={() => void mutate()} />
        ) : (
          <Stack spacing={4} role="status" aria-busy="true" aria-label={t("settings_nav_loading")}>
            <Skeleton variant="text" width={90} height={21} />
            <Skeleton variant="rounded" height={86} sx={{ borderRadius: "12px" }} />
            <Skeleton variant="rounded" height={86} sx={{ borderRadius: "12px" }} />
          </Stack>
        )
      ) : domains.length === 0 ? (
        <EmptyState
          icon={ICON_NAME.GLOBE}
          title={t("settings_domains_empty_title")}
          hint={t("settings_domains_empty_hint")}
          action={add(t("settings_domains_add_first"))}
        />
      ) : (
        // Cards 16px apart, as on every settings page.
        <Stack spacing={4}>
          <Typography variant="body2" fontWeight={700}>
            {t("settings_domains_count", { count: domains.length })}
          </Typography>
          {domains.map((domain) => (
            <DomainCard
              key={domain.id}
              domain={domain}
              organizationId={organizationId ?? domain.organization_id}
              onChanged={() => mutate()}
              onUnassign={(target) => void unassign(target)}
              onDelete={setDeleting}
            />
          ))}
        </Stack>
      )}
      {adding && organizationId && (
        <AddDomainDialog
          open
          organizationId={organizationId}
          onClose={() => setAdding(false)}
          onCreated={() => void mutate()}
        />
      )}
      {deleting && organizationId && (
        <DeleteDomainDialog
          domain={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await deleteCustomDomain(organizationId, deleting.id);
            await mutate();
            setDeleting(null);
          }}
        />
      )}
    </SettingsPage>
  );
}

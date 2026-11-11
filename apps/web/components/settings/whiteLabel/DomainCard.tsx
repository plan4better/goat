"use client";

import { LoadingButton } from "@mui/lab";
import { Box, Button, Collapse, Link, Skeleton, Stack, Typography, alpha, useTheme } from "@mui/material";
import { formatDistanceToNow } from "date-fns";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { useCustomDomainConfig } from "@/lib/api/customDomainConfig";
import { recheckCustomDomain } from "@/lib/api/customDomains";
import { parseApiDate } from "@/lib/utils/credits";
import type { CustomDomain } from "@/lib/validations/customDomain";

import StatusPill from "@/components/common/StatusPill";
import SurfaceCard from "@/components/dashboard/common/SurfaceCard";
import RowMenu from "@/components/settings/common/RowMenu";
import { UsageMark } from "@/components/settings/usage/UsageMark";
import { DnsRecordCard, dnsRecordOf } from "@/components/settings/whiteLabel/AddDomain/DnsRecordCard";
import {
  type DomainState,
  STATUS_KEY,
  customDomainsOff,
  domainState,
  recheckOutcome,
} from "@/components/settings/whiteLabel/domainStatus";

const PLAIN = { interpolation: { escapeValue: false } } as const;
/** The active details, "DNS: …", "Zertifikat: …", "Projekt: …", as a
 * definition list in two columns. */
const DETAILS_SX = {
  m: 0,
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr)",
  columnGap: 2,
  rowGap: 1,
  typography: "body2",
  "& dt": { "&::after": { content: '":"' } },
  "& dd": { m: 0, wordBreak: "break-word" },
} as const;
const PILL_TONE: Record<DomainState, "primary" | "warning" | "info" | "error"> = {
  active: "primary",
  pending_dns: "warning",
  issuing: "info",
  failed: "error",
};

/** One domain as an article: its status, project and check, the details
 * inline (open for a domain that waits or failed), the ⋮ menu. */
export default function DomainCard({
  domain,
  organizationId,
  onChanged,
  onUnassign,
  onDelete,
}: {
  domain: CustomDomain;
  organizationId: string;
  /** Reads the list again after a check. */
  onChanged: () => Promise<unknown>;
  onUnassign: (domain: CustomDomain) => void;
  onDelete: (domain: CustomDomain) => void;
}) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const locale = useDateFnsLocale();
  const config = useCustomDomainConfig();
  const titleId = useId();
  const detailsId = useId();
  const state = domainState(domain);
  const [open, setOpen] = useState(state === "pending_dns" || state === "failed");
  const [checking, setChecking] = useState(false);
  // Core refuses a check while custom domains are off (deleting stays), so
  // none is offered until its config says they are on.
  const off = customDomainsOff(config);
  const canCheck = config !== undefined && !off;
  const added = new Intl.DateTimeFormat(i18n.language, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(parseApiDate(domain.created_at));

  const recheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const after = await recheckCustomDomain(organizationId, domain.id);
      await onChanged();
      const outcome = recheckOutcome(domain, after);
      // A DNS record found shows in the status pill; one still wrong or no
      // change shows nowhere on the card, so those are said.
      if (outcome === "wrong") toast.warning(t("settings_domains_still_wrong"));
      else if (outcome === "unchanged") toast.success(t("settings_domains_unchanged"));
    } catch {
      toast.error(t("settings_domains_recheck_error"));
    } finally {
      setChecking(false);
    }
  };

  const record = dnsRecordOf(domain.base_domain, config);
  const found = [domain.dns_status_message, domain.cert_status_message].filter(Boolean);
  const waiting = state === "pending_dns" || state === "failed";

  return (
    <SurfaceCard component="article" aria-labelledby={titleId} hoverable={false} sx={{ p: 4 }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 3 }}>
        <UsageMark icon={ICON_NAME.GLOBE} tone={state === "active" ? "primary" : "neutral"} />
        <Box sx={{ flex: "1 1 240px", minWidth: 0 }}>
          <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2 }}>
            <Typography
              component="h3"
              id={titleId}
              sx={{ m: 0, fontFamily: "monospace", fontSize: 15, fontWeight: 700, wordBreak: "break-all" }}>
              {state === "active" ? (
                <Link href={`https://${domain.base_domain}`} target="_blank" rel="noopener noreferrer">
                  {domain.base_domain}
                </Link>
              ) : (
                domain.base_domain
              )}
            </Typography>
            <StatusPill tone={PILL_TONE[state]}>{t(STATUS_KEY[state])}</StatusPill>
          </Box>
          <Typography
            variant="caption"
            color="text.secondary"
            component="div"
            sx={{ display: "flex", flexWrap: "wrap", columnGap: 3, rowGap: 0.5, mt: 1 }}>
            <span>{t("settings_domains_added_on", { date: added })}</span>
            <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
              <Icon iconName={ICON_NAME.MAP} style={{ fontSize: 12 }} htmlColor="inherit" />
              {domain.assigned_project_name ? (
                domain.assigned_project_name
              ) : (
                <Box component="span" sx={{ fontStyle: "italic", color: "text.secondary" }}>
                  {t("settings_domains_unassigned")}
                </Box>
              )}
            </Box>
          </Typography>
        </Box>
        {waiting && (
          <LoadingButton
            size="small"
            variant="outlined"
            loading={checking}
            disabled={!canCheck}
            onClick={() => void recheck()}
            sx={{ borderRadius: 999, whiteSpace: "nowrap" }}>
            {t(state === "failed" ? "settings_domains_retry" : "settings_domains_recheck")}
          </LoadingButton>
        )}
        <Button
          size="small"
          variant="text"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen(!open)}
          sx={{ whiteSpace: "nowrap" }}>
          {t(open ? "settings_domains_details_hide" : "settings_domains_details_show")}
        </Button>
        <RowMenu
          label={t("settings_more_actions_for", { name: domain.base_domain, ...PLAIN })}
          items={[
            ...(state === "active" && domain.assigned_project_id
              ? [
                  {
                    key: "unassign",
                    label: t("settings_domains_unassign"),
                    onClick: () => onUnassign(domain),
                  },
                ]
              : []),
            ...(state !== "issuing"
              ? [
                  {
                    key: "recheck",
                    label: t("settings_domains_recheck"),
                    disabled: !canCheck,
                    reason: off ? t("settings_domains_off") : undefined,
                    onClick: () => void recheck(),
                  },
                ]
              : []),
            {
              key: "delete",
              label: t("settings_domains_delete"),
              danger: true,
              onClick: () => onDelete(domain),
            },
          ]}
        />
      </Box>
      <Collapse in={open} id={detailsId}>
        <Stack spacing={3} sx={{ mt: 4 }}>
          {state === "issuing" && (
            <Typography variant="body2">{t("settings_domains_issuing_text")}</Typography>
          )}
          {/* A certificate that failed has its DNS right: no record to ask for then. */}
          {waiting && domain.dns_status !== "verified" && (
            <>
              <Typography variant="body2" fontWeight={700}>
                {t("settings_domains_record_missing")}
              </Typography>
              <DnsRecordCard domain={domain.base_domain} />
            </>
          )}
          {waiting && found.length > 0 && (
            <Box
              sx={{
                p: 3,
                borderRadius: "8px",
                backgroundColor: alpha(
                  state === "failed" ? theme.palette.error.main : theme.palette.warning.main,
                  0.1
                ),
              }}>
              <Typography variant="body2" fontWeight={700}>
                {t("settings_domains_found")}
              </Typography>
              {found.map((line) => (
                <Typography key={line} variant="body2" sx={{ wordBreak: "break-word" }}>
                  {line}
                </Typography>
              ))}
            </Box>
          )}
          {state === "active" && (
            <Box component="dl" sx={DETAILS_SX}>
              {/* The target comes from core's config: a skeleton until it answers,
                  no row on an instance without custom domains (no target). */}
              {(!config || record.target) && (
                <>
                  <dt>{t("settings_domains_detail_dns")}</dt>
                  <dd>
                    {config ? (
                      t("settings_domains_detail_dns_value", { ...record, ...PLAIN })
                    ) : (
                      <Skeleton variant="text" width={240} />
                    )}
                  </dd>
                </>
              )}
              <dt>{t("settings_domains_detail_cert")}</dt>
              <dd>{t("settings_domains_detail_cert_value")}</dd>
              {domain.assigned_project_name && (
                <>
                  <dt>{t("settings_domains_detail_project")}</dt>
                  <dd>{domain.assigned_project_name}</dd>
                </>
              )}
            </Box>
          )}
          {/* Only once core has recorded a check: today it records none. */}
          {domain.dns_last_checked_at && (
            <Typography variant="caption" color="text.secondary">
              {t("settings_domains_last_checked", {
                when: formatDistanceToNow(parseApiDate(domain.dns_last_checked_at), {
                  addSuffix: true,
                  locale,
                }),
              })}
            </Typography>
          )}
        </Stack>
      </Collapse>
    </SurfaceCard>
  );
}

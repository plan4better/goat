"use client";

import { Alert, Box, Link, Stack, Typography, alpha, useTheme } from "@mui/material";
import type { TFunction } from "i18next";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { parseAsString, parseAsStringEnum, useQueryStates } from "nuqs";
import { useEffect, useId } from "react";
import { useTranslation } from "react-i18next";

import { type CreditBalance, useCreditBalance } from "@/lib/api/usage";
import { useFeatures } from "@/lib/api/users";
import { formatCreditsDay, parseApiDate } from "@/lib/utils/credits";
import { daySpanLabel } from "@/lib/utils/usageRange";

import { useAuthZ } from "@/hooks/auth/AuthZ";

import { accentText } from "@/components/assistant/styles";
import { AiCreditsDetail } from "@/components/settings/usage/AiCreditsDetail";
import { CreditsDetail } from "@/components/settings/usage/CreditsDetail";
import { EditorsDetail } from "@/components/settings/usage/EditorsDetail";
import { ProjectsDetail } from "@/components/settings/usage/ProjectsDetail";
import { QUOTA_KEYS, type QuotaKey, QuotaTiles, quotaTabId } from "@/components/settings/usage/QuotaTiles";
import { StorageDetail } from "@/components/settings/usage/StorageDetail";
import { DetailHeaderSkeleton } from "@/components/settings/usage/UsageDetailParts";
import { useReportProblemHref } from "@/components/support/SupportMenu";

/** The day an instant falls on for the reader, as the UTC midnight that
 * {@link daySpanLabel} writes: the same day the tiles' "Resets on" names. */
const readerDay = (value: string): Date => {
  const date = parseApiDate(value);
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
};

/** "Credits period 31 Oct to 30 Nov 2026." or "Trial until 14 Nov 2026.", then who sees the page. */
const subtitleOf = (balance: CreditBalance | undefined, t: TFunction, language: string): string => {
  const trialEnd = balance?.on_trial
    ? formatCreditsDay(balance.plan_renewal_date, language, { year: true })
    : null;
  const period =
    balance && !balance.on_trial && balance.period_start && balance.credits_reset_at
      ? t("usage_credits_period", {
          span: daySpanLabel(
            readerDay(balance.period_start),
            readerDay(balance.credits_reset_at),
            t,
            language
          ),
        })
      : null;
  return [trialEnd ? t("usage_trial_until", { date: trialEnd }) : period, t("usage_admins_only")]
    .filter(Boolean)
    .join(" ");
};

export default function UsagePage() {
  const { t, i18n } = useTranslation("common");
  const language = i18n.language;
  const theme = useTheme();
  const router = useRouter();
  const panelId = useId();
  const { features, isError: featuresError } = useFeatures();
  const { isOrgAdmin, isLoading: rolesLoading, isUserProfileError } = useAuthZ();
  // Self-hosted (billing off): there is no usage to show. For the organization's
  // owners and admins only, as the settings menu offers it. A profile that
  // failed to load says nothing about the roles: no redirect then.
  const billingOff = features?.billing === false;
  const profileFailed = !!isUserProfileError;
  const notAdmin = !rolesLoading && !profileFailed && !isOrgAdmin;
  const allowed = features?.billing === true && !rolesLoading && !profileFailed && isOrgAdmin;
  const { balance, isLoading: balanceLoading, isError: balanceError } = useCreditBalance(allowed);
  const supportHref = useReportProblemHref();
  // The open tile is in the address, so a link opens one ("See usage" opens
  // the AI credits); the member narrows only the two credit details.
  const [params, setParams] = useQueryStates(
    { quota: parseAsStringEnum<QuotaKey>(QUOTA_KEYS), member: parseAsString },
    { history: "replace" }
  );
  useEffect(() => {
    if (billingOff || notAdmin) router.replace("/settings/account");
  }, [billingOff, notAdmin, router]);

  // Without the feature flags or the profile we cannot tell who may see the
  // page: say so instead of leaving it blank or sending them away.
  if ((!features && featuresError) || (profileFailed && !billingOff)) {
    return <Alert severity="error">{t("usage_load_error")}</Alert>;
  }
  if (!allowed) return null;

  // Without a tile in the address the page opens on the credits; a tile that
  // needs attention says so with its dot.
  const open: QuotaKey = params.quota ?? "credits";
  const choose = (key: QuotaKey) =>
    void setParams(key === "credits" || key === "ai" ? { quota: key } : { quota: key, member: null });
  const trialEnd = balance?.on_trial
    ? formatCreditsDay(balance.plan_renewal_date, language, { year: true })
    : null;

  return (
    // On the page background (the settings layout leaves this page bare): the
    // header's top lines up with the menu card's.
    <Stack spacing={5} sx={{ pb: 5 }}>
      <Stack spacing={1}>
        <Typography
          component="h2"
          sx={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.3px", lineHeight: 1.2 }}>
          {t("usage_and_quotas")}
        </Typography>
        <Typography sx={{ fontSize: 14, lineHeight: 1.5, color: "text.secondary", maxWidth: 640 }}>
          {subtitleOf(balance, t, language)}
        </Typography>
      </Stack>

      {balance?.on_trial && (
        <Stack
          role="status"
          direction="row"
          alignItems="center"
          useFlexGap
          flexWrap="wrap"
          gap={3}
          sx={{
            px: 4,
            py: 3,
            borderRadius: "12px",
            backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === "light" ? 0.12 : 0.16),
          }}>
          <Typography sx={{ flex: "1 1 300px", fontSize: 14, lineHeight: 1.5 }}>
            {trialEnd && <strong>{t("usage_trial_until", { date: trialEnd })}</strong>}{" "}
            {t("usage_trial_banner")}
          </Typography>
          {supportHref && (
            <Link
              {...(supportHref.startsWith("/") ? { component: NextLink } : {})}
              href={supportHref}
              underline="hover"
              sx={{ fontSize: 13, fontWeight: 700, color: accentText(theme) }}>
              {t("usage_talk_plan")}
            </Link>
          )}
        </Stack>
      )}

      {!balance && balanceError ? (
        <Alert severity="error">{t("usage_load_error")}</Alert>
      ) : (
        <>
          <QuotaTiles
            balance={balance}
            isLoading={balanceLoading}
            value={open}
            onChange={choose}
            panelId={panelId}
          />
          {/* One panel, labelled by the open tile; only its detail is there, so
              only its data is read. */}
          <Box role="tabpanel" id={panelId} aria-labelledby={quotaTabId(panelId, open)} sx={{ pt: 1 }}>
            {!balance ? (
              <DetailHeaderSkeleton />
            ) : open === "credits" ? (
              <CreditsDetail balance={balance} />
            ) : open === "ai" ? (
              <AiCreditsDetail balance={balance} />
            ) : open === "storage" ? (
              <StorageDetail balance={balance} />
            ) : open === "projects" ? (
              <ProjectsDetail balance={balance} />
            ) : (
              <EditorsDetail
                balance={balance}
                // Credits or AI credits, narrowed to the member Editors names.
                onOpenUsage={(quota, member) => void setParams({ quota, member })}
              />
            )}
          </Box>
        </>
      )}
    </Stack>
  );
}

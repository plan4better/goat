"use client";

import { Box, Divider, Skeleton, Stack, Typography, useTheme } from "@mui/material";
import { format } from "date-fns";
import prettyBytes from "pretty-bytes";
import { Trans, useTranslation } from "react-i18next";

import { useDateFnsLocale } from "@/i18n/utils";

import { useCreditBalance, useCreditBreakdown, useStorageByLayer } from "@/lib/api/usage";
import { formatCredits, formatRate, parseApiDate } from "@/lib/utils/credits";

import { useAuthZ } from "@/hooks/auth/AuthZ";

import QuotaStatus from "@/components/common/QuotaStatus";

/** Compute time as people read it: seconds below a minute, whole minutes above. */
function formatComputeTime(seconds: number, units: { s: string; min: string }): string {
  return seconds < 60 ? `${Math.round(seconds)} ${units.s}` : `${Math.round(seconds / 60)} ${units.min}`;
}

/** Traffic in the unit that fits: kB and MB while small, GB later (decimal, as charged). */
function formatTraffic(bytes: number, locale?: string): string {
  return prettyBytes(bytes, { locale, maximumFractionDigits: 1 });
}

/** Storage quotas are kept in MB: MB below a GB, GB above, one decimal at most. */
function formatMegabytes(mb: number, locale?: string): string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return mb >= 1024 ? `${number.format(mb / 1024)} GB` : `${number.format(mb)} MB`;
}

interface ColorDotProps {
  color: string;
}

function ColorDot({ color }: ColorDotProps) {
  return (
    <Box
      component="span"
      sx={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "2px",
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  );
}

export function UsageOverview() {
  const { t, i18n } = useTranslation("common");
  const dateLocale = useDateFnsLocale();
  const theme = useTheme();
  const { balance, isLoading: balanceLoading } = useCreditBalance();
  const { breakdown, isLoading: breakdownLoading } = useCreditBreakdown("category");
  // Every layer's name, owner and size: for organization owners and admins only.
  // A 403 (or any failure) just hides the list, with no error shown.
  const { isOrgAdmin } = useAuthZ();
  const { storage: storageByLayer, isError: storageError } = useStorageByLayer(isOrgAdmin);

  const isLoading = balanceLoading || breakdownLoading;

  const computeRow = breakdown?.rows.find((r) => r.key === "compute");
  const egressRow = breakdown?.rows.find((r) => r.key === "egress");

  const computeSeconds = computeRow?.units ?? 0;
  const egressBytes = egressRow?.units ?? 0;
  const computeCredits = computeRow?.credits ?? 0;
  const egressCredits = egressRow?.credits ?? 0;

  const total = balance?.total_credits ?? null;
  const usedCredits = balance?.used_credits ?? 0;
  // Never negative: runs in flight can take the ledger past the budget.
  const remainingCredits = total !== null ? Math.max(0, total - usedCredits) : null;
  const outOfCredits = total !== null && usedCredits >= total;

  // What a credit buys, from the server: credits per minute of compute / per GB of traffic.
  const computeRate = balance?.rates?.find((r) => r.category === "compute")?.rate;
  const egressRate = balance?.rates?.find((r) => r.category === "egress")?.rate;

  const computePct = total && total > 0 ? (computeCredits / total) * 100 : 0;
  const egressPct = total && total > 0 ? (egressCredits / total) * 100 : 0;

  const showStorageList = isOrgAdmin && !storageError;
  const sortedLayers = [...(showStorageList ? (storageByLayer?.rows ?? []) : [])].sort(
    (a, b) => (b.size_mb ?? 0) - (a.size_mb ?? 0)
  );

  return (
    <Box sx={{ p: 4 }}>
      <Stack spacing={6}>
        <Divider />
        <Box>
          <Typography variant="body1" fontWeight="bold">
            {t("usage_and_quotas")}
          </Typography>
          <Typography variant="caption">{t("usage_and_quotas_information")}</Typography>
        </Box>
        <Divider />

        {isLoading && <Skeleton variant="rectangular" height={200} />}

        {!isLoading && balance && (
          <Stack spacing={6}>
            {/* Consumption stats */}
            <Stack direction="row" gap={2} flexWrap="wrap">
              {/* Compute stat */}
              <Stack direction="row" alignItems="flex-start" spacing={2} sx={{ flex: 1, minWidth: 160 }}>
                <Box sx={{ pt: "6px" }}>
                  <ColorDot color={theme.palette.primary.main} />
                </Box>
                <Stack>
                  <Typography variant="caption" color="text.secondary" fontWeight="bold">
                    {t("compute")}
                  </Typography>
                  <Typography variant="h5" fontWeight="bold" sx={{ fontSize: "26px", lineHeight: 1.2 }}>
                    {formatComputeTime(computeSeconds, { s: t("seconds_abbr"), min: t("minutes_abbr") })}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatCredits(computeCredits, i18n?.language)} {t("credits")} ·{" "}
                    {t("compute_this_period")}
                  </Typography>
                </Stack>
              </Stack>

              {/* Traffic stat */}
              <Stack direction="row" alignItems="flex-start" spacing={2} sx={{ flex: 1, minWidth: 160 }}>
                <Box sx={{ pt: "6px" }}>
                  <ColorDot color={theme.palette.info.main} />
                </Box>
                <Stack>
                  <Typography variant="caption" color="text.secondary" fontWeight="bold">
                    {t("traffic")}
                  </Typography>
                  <Typography variant="h5" fontWeight="bold" sx={{ fontSize: "26px", lineHeight: 1.2 }}>
                    {formatTraffic(egressBytes, i18n?.language)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatCredits(egressCredits, i18n?.language)} {t("credits")} · {t("traffic_this_period")}
                  </Typography>
                </Stack>
              </Stack>
            </Stack>

            {/* Credit budget */}
            <Stack spacing={2}>
              <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                <Typography variant="body2" fontWeight="bold">
                  {t("credit_budget")}
                </Typography>
                {total !== null && (
                  <Typography variant="body2" color="primary">
                    {formatCredits(usedCredits, i18n?.language)} {t("out_of")}{" "}
                    {formatCredits(total, i18n?.language)} {t("credits")}
                    {/* A trial's credits last the whole trial; a subscription's reset monthly. */}
                    {!balance?.on_trial && ` / ${t("month")}`}
                  </Typography>
                )}
              </Stack>

              {total === null ? (
                <Typography variant="body2" color="text.secondary">
                  {t("unlimited")}
                </Typography>
              ) : (
                <>
                  {/* Stacked bar */}
                  <Box
                    sx={{
                      position: "relative",
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: "grey.200",
                      overflow: "hidden",
                      display: "flex",
                    }}>
                    <Box
                      sx={{
                        width: `${Math.min(computePct, 100)}%`,
                        backgroundColor: "primary.main",
                        transition: "width 0.3s ease",
                      }}
                    />
                    <Box
                      sx={{
                        width: `${Math.max(0, Math.min(egressPct, 100 - Math.min(computePct, 100)))}%`,
                        backgroundColor: "info.main",
                        transition: "width 0.3s ease",
                      }}
                    />
                  </Box>

                  {/* Legend */}
                  <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                    flexWrap="wrap"
                    gap={1}>
                    <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
                      <Stack direction="row" spacing={1} alignItems="center">
                        <ColorDot color={theme.palette.primary.main} />
                        <Typography variant="caption">
                          {t("compute")} {formatCredits(computeCredits, i18n?.language)}
                        </Typography>
                      </Stack>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <ColorDot color={theme.palette.info.main} />
                        <Typography variant="caption">
                          {t("traffic")} {formatCredits(egressCredits, i18n?.language)}
                        </Typography>
                      </Stack>
                      {remainingCredits !== null && (
                        <Typography
                          variant="caption"
                          color={outOfCredits ? "warning.main" : "text.secondary"}>
                          · {formatCredits(remainingCredits, i18n?.language)} {t("remaining")}
                        </Typography>
                      )}
                    </Stack>
                    {balance.on_trial && balance.plan_renewal_date && (
                      <Typography variant="caption" color="text.secondary">
                        {t("trial_credits_until")}:{" "}
                        {format(parseApiDate(balance.plan_renewal_date), "PP", { locale: dateLocale })}
                      </Typography>
                    )}
                    {!balance.on_trial && balance.credits_reset_at && (
                      <Typography variant="caption" color="text.secondary">
                        {t("resets_on")}:{" "}
                        {format(parseApiDate(balance.credits_reset_at), "PP", { locale: dateLocale })}
                      </Typography>
                    )}
                  </Stack>

                  {/* Approximation caption */}
                  {outOfCredits && (
                    <Typography variant="caption" color="warning.main" fontWeight="bold">
                      {t("credits_used_up")}
                    </Typography>
                  )}
                  {!outOfCredits && remainingCredits !== null && !!computeRate && !!egressRate && (
                    <Typography variant="caption" color="text.secondary">
                      {t("credits_remaining", {
                        remaining: formatCredits(remainingCredits, i18n?.language),
                        gb: formatCredits(remainingCredits / egressRate, i18n?.language),
                        minutes: formatCredits(remainingCredits / computeRate, i18n?.language),
                      })}
                    </Typography>
                  )}
                </>
              )}
            </Stack>

            <Divider />

            {/* How credits are counted: the prices, from the server */}
            {balance.rates && balance.rates.some((r) => r.category !== "ai") && (
              <>
                <Stack spacing={2}>
                  <Typography variant="body1" fontWeight="bold">
                    {t("credit_pricing_title")}
                  </Typography>
                  <Stack component="ul" spacing={1} sx={{ m: 0, pl: 5 }}>
                    {balance.rates
                      .filter((r) => r.category !== "ai") // no AI assistant yet
                      .map((r) => (
                        <Typography component="li" variant="body2" key={r.category}>
                          {t(`credit_pricing_${r.category}`, {
                            rate: formatRate(r.rate, i18n?.language),
                            defaultValue: `${r.category}: ${r.rate} / ${r.unit_basis}`,
                          })}
                        </Typography>
                      ))}
                    <Typography component="li" variant="body2" color="text.secondary">
                      {t("credit_pricing_free")}
                    </Typography>
                  </Stack>
                </Stack>
                <Divider />
              </>
            )}

            {/* Capacity section */}
            <Stack spacing={2}>
              <Typography variant="body1" fontWeight="bold">
                {t("capacity")}
              </Typography>
            </Stack>

            <Stack spacing={6} divider={<Divider />}>
              {/* Storage */}
              <Stack spacing={1}>
                {balance.total_storage === null ? (
                  <Stack>
                    <Typography variant="body2" fontWeight="bold">
                      {t("storage")}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {t("unlimited")}
                    </Typography>
                  </Stack>
                ) : (
                  <QuotaStatus
                    current={balance.used_storage}
                    total={balance.total_storage}
                    titleLabel={t("storage")}
                    quotaLabel={
                      <Trans
                        i18nKey="common:current_storage_out_of_total_quota"
                        values={{
                          current: formatMegabytes(balance.used_storage, i18n?.language),
                          total: formatMegabytes(balance.total_storage, i18n?.language),
                        }}
                        components={{
                          highlight: (
                            <span
                              style={{
                                color:
                                  balance.used_storage >= balance.total_storage
                                    ? theme.palette.warning.main
                                    : theme.palette.primary.main,
                              }}
                            />
                          ),
                        }}
                      />
                    }
                    colorWhenFull={theme.palette.warning.main}
                  />
                )}
                <Typography variant="caption" color="text.secondary">
                  {t("storage_quota_information")}
                </Typography>

                {/* Storage by layer list (admins only) */}
                {showStorageList && sortedLayers.length > 0 && (
                  <Stack spacing={0.5} sx={{ mt: 2 }}>
                    {sortedLayers.map((layer) => (
                      <Stack
                        key={layer.layer_id}
                        direction="row"
                        justifyContent="space-between"
                        alignItems="center"
                        sx={{ py: 0.5 }}>
                        <Stack>
                          <Typography variant="caption" fontWeight="medium">
                            {layer.name}
                          </Typography>
                          {layer.owner && (
                            <Typography variant="caption" color="text.secondary">
                              {layer.owner}
                            </Typography>
                          )}
                        </Stack>
                        <Typography variant="caption" color="text.secondary">
                          {prettyBytes((layer.size_mb ?? 0) * 1024 * 1024)}
                        </Typography>
                      </Stack>
                    ))}
                  </Stack>
                )}
              </Stack>

              {/* Projects */}
              <Stack spacing={1}>
                {balance.total_projects === null ? (
                  <Stack>
                    <Typography variant="body2" fontWeight="bold">
                      {t("projects")}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {t("unlimited")}
                    </Typography>
                  </Stack>
                ) : (
                  <QuotaStatus
                    current={balance.used_projects}
                    total={balance.total_projects}
                    titleLabel={t("projects")}
                    quotaLabel={
                      <Trans
                        i18nKey="common:current_projects_out_of_total_quota"
                        values={{
                          current: balance.used_projects,
                          total: balance.total_projects,
                        }}
                        components={{
                          highlight: (
                            <span
                              style={{
                                color:
                                  balance.used_projects >= balance.total_projects
                                    ? theme.palette.warning.main
                                    : theme.palette.primary.main,
                              }}
                            />
                          ),
                        }}
                      />
                    }
                    colorWhenFull={theme.palette.warning.main}
                  />
                )}
                <Typography variant="caption" color="text.secondary">
                  {t("projects_quota_information")}
                </Typography>
              </Stack>

              {/* Seats / Editors */}
              <Stack spacing={1}>
                {balance.total_editors === null ? (
                  <Stack>
                    <Typography variant="body2" fontWeight="bold">
                      {t("editors")}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {t("unlimited")}
                    </Typography>
                  </Stack>
                ) : (
                  <QuotaStatus
                    current={balance.used_editors}
                    total={balance.total_editors}
                    titleLabel={t("editors")}
                    quotaLabel={
                      <Trans
                        i18nKey="common:editors_quota_label"
                        values={{
                          current: balance.used_editors,
                          total: balance.total_editors,
                        }}
                        components={{
                          highlight: (
                            <span
                              style={{
                                color:
                                  balance.used_editors >= balance.total_editors
                                    ? theme.palette.warning.main
                                    : theme.palette.primary.main,
                              }}
                            />
                          ),
                        }}
                      />
                    }
                    colorWhenFull={theme.palette.warning.main}
                  />
                )}
                <Typography variant="caption" color="text.secondary">
                  {t("editors_quota_information")}
                </Typography>
              </Stack>
            </Stack>
          </Stack>
        )}
      </Stack>
    </Box>
  );
}

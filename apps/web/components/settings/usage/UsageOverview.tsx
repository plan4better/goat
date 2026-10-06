"use client";

import { Box, Divider, Skeleton, Stack, Typography, useTheme } from "@mui/material";
import { format } from "date-fns";
import prettyBytes from "pretty-bytes";
import { Trans, useTranslation } from "react-i18next";

import { useCreditBalance, useCreditBreakdown, useStorageByLayer } from "@/lib/api/usage";

import QuotaStatus from "@/components/common/QuotaStatus";

/** Convert compute units (seconds) → display minutes */
function secondsToMinutes(seconds: number): string {
  return Math.round(seconds / 60).toString();
}

/** Convert bytes → display GB */
function bytesToGB(bytes: number): string {
  return (bytes / 1_000_000_000).toFixed(2);
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
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { balance, isLoading: balanceLoading } = useCreditBalance();
  const { breakdown, isLoading: breakdownLoading } = useCreditBreakdown("category");
  const { storage: storageByLayer, isLoading: storageLoading } = useStorageByLayer();

  const isLoading = balanceLoading || breakdownLoading || storageLoading;

  const computeRow = breakdown?.rows.find((r) => r.key === "compute");
  const egressRow = breakdown?.rows.find((r) => r.key === "egress");

  const computeSeconds = computeRow?.units ?? 0;
  const egressBytes = egressRow?.units ?? 0;
  const computeCredits = computeRow?.credits ?? 0;
  const egressCredits = egressRow?.credits ?? 0;

  const total = balance?.total_credits ?? null;
  const usedCredits = balance?.used_credits ?? 0;
  const remainingCredits = total !== null ? total - usedCredits : null;

  const computePct = total && total > 0 ? (computeCredits / total) * 100 : 0;
  const egressPct = total && total > 0 ? (egressCredits / total) * 100 : 0;

  const sortedLayers = [...(storageByLayer?.rows ?? [])].sort((a, b) => (b.size_mb ?? 0) - (a.size_mb ?? 0));

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
                    {secondsToMinutes(computeSeconds)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {computeCredits.toFixed(2)} {t("credits")} · {t("compute_this_period")}
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
                    {bytesToGB(egressBytes)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {egressCredits.toFixed(2)} {t("credits")} · {t("traffic_this_period")}
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
                    {usedCredits.toFixed(2)} {t("out_of")} {total.toFixed(2)} {t("credits")} / {t("month")}
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
                          {t("compute")} {computeCredits.toFixed(2)}
                        </Typography>
                      </Stack>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <ColorDot color={theme.palette.info.main} />
                        <Typography variant="caption">
                          {t("traffic")} {egressCredits.toFixed(2)}
                        </Typography>
                      </Stack>
                      {remainingCredits !== null && (
                        <Typography variant="caption" color="text.secondary">
                          · {remainingCredits.toFixed(2)} {t("remaining")}
                        </Typography>
                      )}
                    </Stack>
                    {balance.plan_renewal_date && (
                      <Typography variant="caption" color="text.secondary">
                        {t("resets_on")}: {format(new Date(balance.plan_renewal_date), "MMM d, yyyy")}
                      </Typography>
                    )}
                  </Stack>

                  {/* Approximation caption */}
                  {remainingCredits !== null && remainingCredits > 0 && (
                    <Typography variant="caption" color="text.secondary">
                      {t("credits_remaining", { remaining: remainingCredits.toFixed(2) })}
                      {" · "}≈ {Math.round(remainingCredits / 20)} {t("gb_abbr")} {t("or")}{" "}
                      {Math.round(remainingCredits / 10)} {t("minutes_abbr")} {t("remaining")}
                    </Typography>
                  )}
                </>
              )}
            </Stack>

            <Divider />

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
                          current: `${balance.used_storage} MB`,
                          total: `${balance.total_storage} MB`,
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

                {/* Storage by layer list */}
                {sortedLayers.length > 0 && (
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

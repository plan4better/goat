"use client";

import { Alert, Box, Divider, Link, Stack, Typography, useTheme } from "@mui/material";
import { format } from "date-fns";
import prettyBytes from "pretty-bytes";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Trans } from "react-i18next";

import { useOrganization } from "@/lib/api/users";
import { CONTACT_URL } from "@/lib/constants";
import { getNextMonthDate } from "@/lib/utils/helpers";

import QuotaStatus from "@/components/common/QuotaStatus";

export default function Usage() {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const { organization } = useOrganization();

  const isQuotaFull = useMemo(() => {
    if (!organization)
      return {
        isCreditFull: false,
        isStorageFull: false,
        isProjectsFull: false,
      };

    return {
      isCreditFull:
        organization.total_credits != null && organization.used_credits >= organization.total_credits,
      isStorageFull:
        organization.total_storage != null && organization.used_storage >= organization.total_storage,
      isProjectsFull:
        organization.total_projects != null && organization.used_projects >= organization.total_projects,
    };
  }, [organization]);

  // Without a contact page the alerts keep the word, unlinked.
  const contactAnchor = CONTACT_URL ? (
    <Link sx={{ fontWeight: "bold" }} target="_blank" href={CONTACT_URL} />
  ) : (
    <span />
  );

  return (
    <>
      <Box sx={{ p: 4 }}>
        <Stack spacing={theme.spacing(6)}>
          <Divider />
          <Box>
            <Typography variant="body1" fontWeight="bold">
              {t("usage_and_quotas")}
            </Typography>
            <Typography variant="caption">{t("usage_and_quotas_information")}</Typography>
          </Box>
          <Divider />
          {organization && (
            <Stack spacing={theme.spacing(8)}>
              <Stack>
                {isQuotaFull.isCreditFull && (
                  <>
                    <Alert severity="warning" sx={{ mb: 4 }}>
                      <Trans
                        i18nKey="common:organization_credits_quota_alert"
                        components={{
                          b: <b />,
                          anchor: contactAnchor,
                        }}
                      />
                    </Alert>
                  </>
                )}

                <QuotaStatus
                  current={organization.used_credits}
                  total={organization.total_credits}
                  titleLabel={t("credits")}
                  quotaLabel={
                    <Trans
                      i18nKey="common:current_credits_out_of_total_quota"
                      values={{
                        current: organization.used_credits,
                        total: organization.total_credits ?? "∞",
                      }}
                      components={{
                        highlight: (
                          <span
                            style={{
                              color: isQuotaFull.isCreditFull
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
                <Stack sx={{ mt: 1 }} alignItems="flex-end">
                  <Typography variant="caption">
                    {t("resets_on") + ": " + format(getNextMonthDate(), "MMM d, yyyy", {})}
                  </Typography>
                </Stack>
                <Stack sx={{ mt: 1 }}>
                  <Typography variant="caption">{t("credits_quota_information")}</Typography>
                </Stack>
              </Stack>
              <Divider />

              {isQuotaFull.isStorageFull && (
                <>
                  <Alert severity="warning" sx={{ mb: 4 }}>
                    <Trans
                      i18nKey="common:organization_storage_quota_alert"
                      components={{
                        b: <b />,
                        anchor: contactAnchor,
                      }}
                    />
                  </Alert>
                </>
              )}
              <QuotaStatus
                current={organization.used_storage}
                total={organization.total_storage}
                titleLabel={t("storage")}
                quotaLabel={
                  <Trans
                    i18nKey="common:current_storage_out_of_total_quota"
                    values={{
                      current: prettyBytes(organization.used_storage * 1024 * 1024, {
                        binary: true,
                        locale: i18n?.language || "en",
                      }),
                      total:
                        organization.total_storage == null
                          ? "∞"
                          : prettyBytes(organization.total_storage * 1024 * 1024, {
                              binary: true,
                              locale: i18n?.language || "en",
                            }),
                    }}
                    components={{
                      highlight: (
                        <span
                          style={{
                            color: isQuotaFull.isStorageFull
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
              <Stack sx={{ mt: 1 }}>
                <Typography variant="caption">{t("storage_quota_information")}</Typography>
              </Stack>
              <Divider />
              {isQuotaFull.isProjectsFull && (
                <>
                  <Alert severity="warning" sx={{ mb: 4 }}>
                    <Trans
                      i18nKey="common:organization_projects_quota_alert"
                      components={{
                        b: <b />,
                        anchor: contactAnchor,
                      }}
                    />
                  </Alert>
                </>
              )}
              <QuotaStatus
                current={organization.used_projects}
                total={organization.total_projects}
                titleLabel={t("projects")}
                quotaLabel={
                  <Trans
                    i18nKey="common:current_projects_out_of_total_quota"
                    values={{
                      current: organization.used_projects,
                      total: organization.total_projects ?? "∞",
                    }}
                    components={{
                      highlight: (
                        <span
                          style={{
                            color: isQuotaFull.isProjectsFull
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
              <Stack sx={{ mt: 1 }}>
                <Typography variant="caption">{t("projects_quota_information")}</Typography>
              </Stack>
            </Stack>
          )}
        </Stack>
      </Box>
    </>
  );
}

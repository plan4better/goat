"use client";

import { Alert, Box, Stack, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import type { CustomDomain } from "@/lib/validations/customDomain";

import { DnsRecordCard } from "./DnsRecordCard";

/** Step 2, "DNS-Eintrag": the record to create and how the dialog checks it
 * (the domain itself is the dialog's subtitle). */
export function StepConfigureDns({ domain }: { domain: CustomDomain }) {
  const { t } = useTranslation("common");
  return (
    <Stack spacing={3}>
      <Typography variant="body2" color="text.secondary">
        {t("settings_domains_dns_text")}
      </Typography>
      <DnsRecordCard domain={domain.base_domain} />
      <Alert severity="info" variant="outlined" role="note">
        {t("settings_domains_dns_status")}
      </Alert>
      {/* What the last check found, read out when a check changes it. */}
      <Box role="status">
        {domain.dns_status_message && (
          <Typography variant="caption" color="text.secondary">
            {domain.dns_status_message}
          </Typography>
        )}
      </Box>
    </Stack>
  );
}

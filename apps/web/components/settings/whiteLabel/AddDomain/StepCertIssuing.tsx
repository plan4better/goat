"use client";

import { Alert } from "@mui/material";
import { useTranslation } from "react-i18next";

/** Step 3, "Zertifikat": DNS is confirmed, the certificate follows. An alert,
 * so a check that moves the dialog on while it is open is read out. */
export function StepCertIssuing() {
  const { t } = useTranslation("common");
  return (
    <Alert severity="success" variant="outlined">
      {t("settings_domains_cert_text")}
    </Alert>
  );
}

"use client";

import { Alert, Button } from "@mui/material";
import { useTranslation } from "react-i18next";

/** The place of a part whose request failed, with a retry of that request alone. */
export default function SettingsLoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation("common");
  return (
    <Alert
      severity="error"
      action={
        <Button variant="text" color="inherit" size="small" onClick={onRetry}>
          {t("settings_card_retry")}
        </Button>
      }>
      {t("settings_card_load_error")}
    </Alert>
  );
}

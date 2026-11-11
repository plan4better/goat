"use client";

import { LoadingButton } from "@mui/lab";
import { Box, Button, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { warningTextInk } from "@/components/modals/content/ContentDialogChrome";

/** The footer of a card with text fields: whether it is saved, Verwerfen while
 * it is not, and Speichern (the card form's submit button). The buttons'
 * labels as a dialog's footer writes them (`AppDialogFooter`). */
export default function CardSaveBar({
  formId,
  dirty,
  valid,
  saving,
  onDiscard,
}: {
  formId: string;
  dirty: boolean;
  valid: boolean;
  saving: boolean;
  onDiscard: () => void;
}) {
  const { t } = useTranslation("common");
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 2,
        px: 6,
        py: 3,
        borderTop: 1,
        borderColor: "divider",
      }}>
      <Typography
        role="status"
        sx={{ flex: 1, minWidth: 0, fontSize: 13, color: dirty ? warningTextInk : "text.secondary" }}>
        {dirty ? t("settings_card_unsaved") : t("settings_card_all_saved")}
      </Typography>
      {dirty && (
        <Button variant="text" onClick={onDiscard} disabled={saving}>
          <Typography variant="body2" fontWeight="bold">
            {t("settings_card_discard")}
          </Typography>
        </Button>
      )}
      <LoadingButton
        type="submit"
        form={formId}
        variant="contained"
        disableElevation
        loading={saving}
        disabled={!dirty || !valid}
        sx={{ borderRadius: 999 }}>
        <Typography variant="body2" fontWeight="bold" color="inherit">
          {t("settings_card_save")}
        </Typography>
      </LoadingButton>
    </Box>
  );
}

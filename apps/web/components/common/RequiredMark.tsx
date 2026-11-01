"use client";

import { Box } from "@mui/material";
import { visuallyHidden } from "@mui/utils";
import { useTranslation } from "react-i18next";

/**
 * Follows the label of a field that must be filled in: an asterisk on screen,
 * the word "required" for screen readers (the asterisk itself is hidden from
 * them).
 */
export default function RequiredMark() {
  const { t } = useTranslation("common");
  return (
    <>
      <Box
        component="span"
        aria-hidden="true"
        sx={{ ml: 0.25, mr: 1, fontSize: "0.75rem", lineHeight: 1.66 }}>
        *
      </Box>
      <Box component="span" sx={visuallyHidden}>
        {t("required_field_marker")}
      </Box>
    </>
  );
}

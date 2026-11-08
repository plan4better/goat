"use client";

import { IconButton } from "@mui/material";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

/** Copies a DNS value to the clipboard and says so, or says that it could not
 * (no clipboard outside a secure context, or the browser refused). */
export default function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation("common");
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("No clipboard");
      await navigator.clipboard.writeText(value);
      toast.success(t("settings_card_copied"));
    } catch {
      toast.error(t("settings_card_copy_failed"));
    }
  };
  return (
    <IconButton
      size="small"
      aria-label={t("settings_card_copy_value", { value, interpolation: { escapeValue: false } })}
      onClick={() => void copy()}>
      <Icon iconName={ICON_NAME.COPY} style={{ fontSize: 14 }} />
    </IconButton>
  );
}

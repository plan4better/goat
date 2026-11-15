"use client";

import { IconButton, Tooltip } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

const COPIED_MS = 1500;

/** Copies a DNS value to the clipboard and, as GOAT's other copy buttons
 * (`CopyAnswer`), shows a check and "Kopiert" for a moment; or says that it
 * could not (no clipboard outside a secure context, or the browser refused). */
export default function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation("common");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = t("settings_card_copy_value", { value, interpolation: { escapeValue: false } });
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("No clipboard");
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      toast.error(t("settings_card_copy_failed"));
    }
  };
  return (
    <Tooltip title={copied ? t("copied") : label}>
      <IconButton size="small" aria-label={label} onClick={() => void copy()}>
        <Icon iconName={copied ? ICON_NAME.CHECK : ICON_NAME.COPY} style={{ fontSize: 14 }} />
      </IconButton>
    </Tooltip>
  );
}

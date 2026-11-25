"use client";

import { IconButton, Tooltip } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { copyText } from "@/lib/utils/clipboard";

const COPIED_MS = 1500;

/** Copies a value (a DNS record, an address) to the clipboard (`copyText`,
 * which also works on plain http) and, as GOAT's other copy buttons
 * (`CopyAnswer`), shows a check and "Kopiert" for a moment; or says that it
 * could not (the browser refused every way). Named "Copy <value>" unless given
 * a `label`: a long value (an address) would make a long name. */
export default function CopyButton({ value, label: given }: { value: string; label?: string }) {
  const { t } = useTranslation("common");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = given ?? t("settings_card_copy_value", { value, interpolation: { escapeValue: false } });
  const copy = async () => {
    if (await copyText(value)) setCopied(true);
    else toast.error(t("settings_card_copy_failed"));
  };
  return (
    <Tooltip title={copied ? t("copied") : label}>
      <IconButton size="small" aria-label={label} onClick={() => void copy()}>
        <Icon iconName={copied ? ICON_NAME.CHECK : ICON_NAME.COPY} style={{ fontSize: 14 }} />
      </IconButton>
    </Tooltip>
  );
}

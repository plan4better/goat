"use client";

import { IconButton, Tooltip, useTheme } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { headerIconButtonSx } from "@/components/assistant/styles";

const COPIED_MS = 1500;

/** Copies an answer's text (its Markdown source) to the clipboard. */
export default function CopyAnswer({ text }: { text: string }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  if (!text.trim()) return null;
  return (
    <Tooltip title={copied ? t("copied") : t("assistant_copy_answer")}>
      <IconButton
        aria-label={t("assistant_copy_answer")}
        onClick={() =>
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => undefined)
        }
        sx={headerIconButtonSx(theme)}>
        <Icon
          iconName={copied ? ICON_NAME.CHECK : ICON_NAME.COPY}
          style={{ fontSize: 15, color: "inherit" }}
        />
      </IconButton>
    </Tooltip>
  );
}

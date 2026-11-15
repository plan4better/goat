"use client";

import { Box, Button, Skeleton, Typography } from "@mui/material";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { CustomDomainConfig } from "@/lib/api/customDomainConfig";

import SettingsCard from "@/components/settings/common/SettingsCard";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import CopyButton from "@/components/settings/whiteLabel/CopyButton";

const OPEN_KEY = "goat.settings.domainsHelpOpen";
const PLAIN = { interpolation: { escapeValue: false } } as const;

function HelpBlock({
  title,
  example,
  line,
  value,
}: {
  title: string;
  example: string;
  /** "CNAME auf …"; undefined while the config loads. */
  line?: string;
  value?: string | null;
}) {
  return (
    <Box sx={{ p: 3, borderRadius: "8px", backgroundColor: "action.hover" }}>
      <Typography variant="body2" fontWeight={700}>
        {title}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p">
        {example}
      </Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 1, minHeight: 30 }}>
        {line === undefined ? (
          <Skeleton variant="text" width={200} />
        ) : (
          <Typography sx={{ fontFamily: "monospace", fontSize: 13, wordBreak: "break-all" }}>
            {line}
          </Typography>
        )}
        {value && <CopyButton value={value} />}
      </Box>
    </Box>
  );
}

/** "So zeigt eine Domain auf GOAT": the CNAME target and the A address, open
 * until the viewer closes it (remembered per viewer). Static: it renders at
 * once, the two values fill in when core's config answers; a failed read of
 * the config takes the body's place, with a retry. */
export default function DnsHelpCard({
  config,
  failed = false,
  onRetry,
}: {
  config?: CustomDomainConfig;
  /** The config could not be read (and is not there). */
  failed?: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation("common");
  const bodyId = useId();
  const [stored, setStored] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      const value = window.localStorage.getItem(OPEN_KEY);
      setStored(value === null ? null : value === "1");
    } catch {
      setStored(null);
    }
  }, []);
  const open = stored !== false;
  const toggle = () => {
    setStored(!open);
    try {
      window.localStorage.setItem(OPEN_KEY, open ? "0" : "1");
    } catch {
      // Blocked storage: the card just forgets.
    }
  };

  return (
    <SettingsCard
      title={t("settings_domains_help_title")}
      icon={ICON_NAME.INFO}
      action={
        failed ? undefined : (
          <Button
            size="small"
            variant="text"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}>
            {t(open ? "settings_domains_help_hide" : "settings_domains_help_show")}
          </Button>
        )
      }>
      {failed && <SettingsLoadError onRetry={() => onRetry?.()} />}
      {!failed && open && (
        <Box id={bodyId} sx={{ display: "grid", gap: 3, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
          <HelpBlock
            title={t("settings_domains_help_subdomain")}
            example={t("settings_domains_help_subdomain_example")}
            line={config && t("settings_domains_help_cname", { target: config.cname_target, ...PLAIN })}
            value={config?.cname_target}
          />
          {/* A main domain needs the address core resolved; left out without one. */}
          {(!config || config.apex_ipv4) && (
            <HelpBlock
              title={t("settings_domains_help_apex")}
              example={t("settings_domains_help_apex_example")}
              line={
                config?.apex_ipv4
                  ? t("settings_domains_help_a", { ip: config.apex_ipv4, ...PLAIN })
                  : undefined
              }
              value={config?.apex_ipv4}
            />
          )}
        </Box>
      )}
    </SettingsCard>
  );
}

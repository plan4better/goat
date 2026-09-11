"use client";

import { Box, Button, Link, Typography, alpha, useTheme } from "@mui/material";
import { formatDistance } from "date-fns";
import { useTranslation } from "react-i18next";

import { useDateFnsLocale } from "@/i18n/utils";
import { sourceLink } from "@/lib/utils/templates";
import type { TemplateRead } from "@/lib/validations/template";

export interface TemplateSnapshotLineProps {
  /** A single read (`readTemplate`), so `source` is resolved. */
  template: TemplateRead;
  onRefresh: () => Promise<void>;
  refreshing?: boolean;
}

/** How old the frozen payload is, where it came from (linked), and the
 * refresh that replaces it — disabled with the reason when the source is
 * gone or no longer readable by the caller. */
const TemplateSnapshotLine = ({ template, onRefresh, refreshing }: TemplateSnapshotLineProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dateLocale = useDateFnsLocale();
  const kind = t(`template_kind_${template.payload_kind}`);
  const source = template.source ?? null;
  const links = source ? sourceLink(source) : null;
  const payloadName = source?.kind === "layout" ? source.layout_name : source?.workflow_name;
  const available = !!source?.available;
  const time = formatDistance(new Date(template.updated_at), new Date(), { addSuffix: true, locale: dateLocale });

  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "12px",
        padding: "10px 12px",
        borderRadius: "10px",
        border: `1px solid ${theme.palette.divider}`,
        backgroundColor: alpha(theme.palette.text.primary, 0.02),
      }}>
      <Typography sx={{ fontSize: 12.5, color: "text.secondary", minWidth: 0 }}>
        {available && links && source ? (
          <>
            {t("snapshot_of_source", { time, kind })}
            {links.payload && payloadName ? (
              <>
                {" "}
                <Link href={links.payload} target="_blank" rel="noreferrer" sx={{ fontWeight: 700 }}>
                  {payloadName} ↗
                </Link>
              </>
            ) : null}
            {source.project_name ? (
              <>
                {" "}
                {t("in_project")}{" "}
                <Link href={links.project} target="_blank" rel="noreferrer" sx={{ fontWeight: 700 }}>
                  {source.project_name} ↗
                </Link>
              </>
            ) : null}
          </>
        ) : (
          t("source_unavailable", { kind })
        )}
      </Typography>
      <Button
        size="small"
        variant="text"
        disabled={!available || refreshing}
        onClick={() => void onRefresh()}
        sx={{ flexShrink: 0, textTransform: "none", fontWeight: 700 }}>
        {t("update_template_from_source")}
      </Button>
    </Box>
  );
};

export default TemplateSnapshotLine;

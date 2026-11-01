"use client";

import { Box, Link, Skeleton, Stack, Typography, alpha, useTheme } from "@mui/material";
import NextLink from "next/link";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { readableText } from "@/lib/utils/credits";

import { accentText } from "@/components/assistant/styles";
import { useReportProblemHref } from "@/components/support/SupportMenu";

/** "Ask for more": the support form where there are tickets, else the
 * support email; nothing where there is neither. */
const AskForMore = () => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const href = useReportProblemHref();
  if (!href) return null;
  return (
    <Link
      {...(href.startsWith("/") ? { component: NextLink } : {})}
      href={href}
      underline="hover"
      sx={{ fontSize: 13, fontWeight: 700, color: accentText(theme), whiteSpace: "nowrap" }}>
      {t("usage_ask_for_more")}
    </Link>
  );
};

export interface UsageDetailHeaderProps {
  title: string;
  /** The figure, in bold. */
  amount: string;
  /** The rest of the amount's sentence; null while a part of it (a member's
   * name) is still loading: a short placeholder stands in. */
  amountRest: string | null;
  amountTone?: "error";
  /** A line under the amount on what it holds beyond the list below (the
   * projects in the trash). */
  note?: string;
  explain: string;
  /** What happens at the limit; left out where there is none. */
  limitLine?: string;
  callout?: string;
  /** Beside the title block ("Manage members"). */
  action?: ReactNode;
}

/**
 * The head of a quota's detail: its title, the amount ("2,204 out of 10,000
 * this period."), one sentence on what counts, and what happens at the limit
 * with a way to ask for more. A quota over its limit shows an error callout
 * with that way instead.
 */
export const UsageDetailHeader = ({
  title,
  amount,
  amountRest,
  amountTone,
  note,
  explain,
  limitLine,
  callout,
  action,
}: UsageDetailHeaderProps) => {
  const theme = useTheme();
  return (
    <Stack spacing={4}>
      <Stack direction="row" alignItems="flex-start" useFlexGap flexWrap="wrap" gap={4}>
        <Stack spacing={1.5} sx={{ flex: "1 1 300px", minWidth: 0 }}>
          <Typography component="h3" sx={{ fontSize: 17, fontWeight: 700 }}>
            {title}
          </Typography>
          <Typography sx={{ fontSize: 14 }}>
            <Box
              component="strong"
              sx={{
                color: amountTone === "error" ? readableText(theme, theme.palette.error.main) : undefined,
              }}>
              {amount}
            </Box>{" "}
            {amountRest ?? (
              <Skeleton
                variant="text"
                width={200}
                sx={{ display: "inline-block", verticalAlign: "middle" }}
              />
            )}
          </Typography>
          {note && (
            <Typography sx={{ fontSize: 13, lineHeight: 1.5, color: "text.secondary", maxWidth: 660 }}>
              {note}
            </Typography>
          )}
          <Typography sx={{ fontSize: 14, lineHeight: 1.5, color: "text.secondary", maxWidth: 660 }}>
            {explain}
          </Typography>
          {limitLine && (
            <Typography sx={{ fontSize: 13, lineHeight: 1.5, color: "text.secondary", maxWidth: 660 }}>
              {limitLine} <AskForMore />
            </Typography>
          )}
        </Stack>
        {action && <Box sx={{ flexShrink: 0 }}>{action}</Box>}
      </Stack>
      {callout && (
        <Stack
          role="status"
          direction="row"
          alignItems="center"
          useFlexGap
          flexWrap="wrap"
          gap={3}
          sx={{
            px: 4,
            py: 3,
            borderRadius: "12px",
            backgroundColor: alpha(theme.palette.error.main, theme.palette.mode === "light" ? 0.08 : 0.18),
          }}>
          <Typography sx={{ flex: "1 1 280px", fontSize: 14, lineHeight: 1.5 }}>{callout}</Typography>
          <AskForMore />
        </Stack>
      )}
    </Stack>
  );
};

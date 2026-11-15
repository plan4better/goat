"use client";

import { Box, Typography, useTheme } from "@mui/material";
import type { ReactNode } from "react";

/** The title block every dashboard page opens with: the page's name, an
 * optional line saying what it is for, and an optional control on the right.
 * One scale, so Content, Catalog and Settings read as the same product. The
 * gap below it belongs to the caller. */
const PageHeader = ({
  title,
  subtitle,
  action,
  mobile = false,
  eyebrow,
  level = 1,
  titleId,
  responsive = false,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Right-aligned control on the title row. */
  action?: ReactNode;
  mobile?: boolean;
  /** A small muted line above the title: the settings nav group ("Konto"). */
  eyebrow?: string;
  /** 2 under a page title of its own (a settings page under "Einstellungen"). */
  level?: 1 | 2;
  titleId?: string;
  /** 21px below `md`, 24px from `md` (and the subtitle alike), decided by CSS. */
  responsive?: boolean;
}) => {
  const theme = useTheme();
  const titleSize = responsive ? { xs: 21, md: 24 } : mobile ? 21 : 24;
  const subtitleSize = responsive ? { xs: 12.5, md: 14 } : mobile ? 12.5 : 14;

  return (
    <Box>
      {eyebrow && (
        <Typography
          component="p"
          sx={{
            m: 0,
            mb: "4px",
            fontSize: 12,
            fontWeight: 700,
            lineHeight: 1.4,
            color: theme.palette.text.secondary,
          }}>
          {eyebrow}
        </Typography>
      )}
      <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
        <Typography
          component={level === 2 ? "h2" : "h1"}
          id={titleId}
          sx={{
            m: 0,
            flex: 1,
            minWidth: 0,
            fontSize: titleSize,
            fontWeight: 600,
            letterSpacing: "-0.3px",
            lineHeight: 1.2,
          }}>
          {title}
        </Typography>
        {action}
      </Box>
      {subtitle && (
        <Typography
          component="p"
          sx={{
            m: 0,
            mt: "4px",
            fontSize: subtitleSize,
            lineHeight: 1.5,
            color: theme.palette.text.secondary,
            maxWidth: 640,
            // A long name in the line (an organization's) breaks instead of
            // running past the column.
            overflowWrap: "anywhere",
          }}>
          {subtitle}
        </Typography>
      )}
    </Box>
  );
};

export default PageHeader;

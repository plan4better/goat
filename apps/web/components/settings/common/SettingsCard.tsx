"use client";

import { Box, Typography, alpha, useTheme } from "@mui/material";
import { type ReactNode, useId } from "react";

import { type ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import SurfaceCard from "@/components/dashboard/common/SurfaceCard";

export interface SettingsCardProps {
  title: string;
  /** A 16px glyph before the title (the DNS help card's info icon). */
  icon?: ICON_NAME;
  hint?: ReactNode;
  /** Right of the title: a button or a link. */
  action?: ReactNode;
  /** `danger`: an error-tinted border and the title in error ink. */
  tone?: "default" | "danger";
  /** Below the body, full width: the save bar. */
  footer?: ReactNode;
  /** 24px around the body; off for a body that draws its own rows. */
  bodyPadding?: boolean;
  children?: ReactNode;
}

/**
 * One section of a settings page: a card without hover lift, its h3 title and
 * a hint line below, an optional action on the right, the body and an
 * optional footer. Every settings section is one, so the pages read alike.
 */
export default function SettingsCard({
  title,
  icon,
  hint,
  action,
  tone = "default",
  footer,
  bodyPadding = true,
  children,
}: SettingsCardProps) {
  const theme = useTheme();
  const titleId = useId();
  const danger = tone === "danger";
  const hasBody = children !== undefined && children !== null && children !== false;

  return (
    <SurfaceCard
      component="section"
      aria-labelledby={titleId}
      hoverable={false}
      sx={{ overflow: "hidden", ...(danger && { borderColor: alpha(theme.palette.error.main, 0.45) }) }}>
      {/* Content's toolbar row (`ContentToolbar.tsx`): below `md` the title
          and hint take the row and the action goes under them; from `md` the
          action sits on the right and drops under the title only when the
          title would get narrower than 220px. */}
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          gap: { xs: 2, md: 4 },
          px: 6,
          pt: 5,
          pb: hasBody ? 0 : 5,
        }}>
        <Box sx={{ flex: { xs: "1 0 100%", md: 1 }, minWidth: { xs: 0, md: 220 } }}>
          <Typography
            id={titleId}
            component="h3"
            sx={{
              m: 0,
              display: "flex",
              alignItems: "center",
              gap: 2,
              fontSize: 15,
              fontWeight: 700,
              lineHeight: 1.4,
              color: danger ? "error.main" : "text.primary",
            }}>
            {icon && (
              <Icon iconName={icon} style={{ fontSize: 16 }} htmlColor={theme.palette.text.secondary} />
            )}
            {title}
          </Typography>
          {hint && (
            <Typography
              component="p"
              sx={{ m: 0, mt: "2px", fontSize: 13, lineHeight: 1.5, color: "text.secondary" }}>
              {hint}
            </Typography>
          )}
        </Box>
        {action && <Box sx={{ flexShrink: 0 }}>{action}</Box>}
      </Box>
      {hasBody && <Box sx={bodyPadding ? { px: 6, pt: 4, pb: 6 } : { pt: 3 }}>{children}</Box>}
      {footer}
    </SurfaceCard>
  );
}

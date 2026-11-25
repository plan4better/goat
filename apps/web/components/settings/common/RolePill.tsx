"use client";

import { Box, Tooltip, alpha, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { type OrgRole, roleWords } from "@/components/settings/common/roleWords";

/** A role that cannot be changed here (the owner's, one's own), with why. */
export default function RolePill({ role, reason }: { role: OrgRole; reason: string }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const word = roleWords(t)[role].word;
  return (
    <Tooltip title={reason}>
      <Box
        component="span"
        // An image role, so the span may carry a name: the word and why it is fixed.
        role="img"
        tabIndex={0}
        aria-label={`${word}. ${reason}`}
        // The share dialog's role picker without a role granted
        // (`components/modals/content/RolePicker.tsx`): the same pill, muted,
        // and no chevron, as nothing opens.
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: "7px",
          padding: "5px 12px",
          borderRadius: "999px",
          border: `1px solid ${alpha(theme.palette.text.primary, 0.24)}`,
          color: theme.palette.text.primary,
          fontSize: 12.5,
          fontWeight: 700,
          // RoleMenu's line, so a static role is as tall as a changeable one.
          lineHeight: 1.15,
          whiteSpace: "nowrap",
        }}>
        {role === "organization-owner" && (
          <Icon iconName={ICON_NAME.CROWN} style={{ fontSize: 11 }} htmlColor={theme.palette.warning.main} />
        )}
        {word}
      </Box>
    </Tooltip>
  );
}

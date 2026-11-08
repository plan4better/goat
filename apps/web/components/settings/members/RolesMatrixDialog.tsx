"use client";

import { Box, Table, TableBody, TableCell, TableHead, TableRow, Typography } from "@mui/material";
import { visuallyHidden } from "@mui/utils";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { ORG_ROLE_ORDER, type OrgRole, roleWords } from "@/components/settings/common/roleWords";

/** Each row: the key of what is allowed, then owner, admin, editor, viewer.
 * "Alle Teams der Organisation verwalten" joins in phase 2 (decision 2). */
const ROWS: [string, boolean, boolean, boolean, boolean][] = [
  ["settings_members_matrix_view", true, true, true, true],
  ["settings_members_matrix_edit", true, true, true, false],
  ["settings_members_matrix_teams", true, true, true, false],
  ["settings_members_matrix_members", true, true, false, false],
  ["settings_members_matrix_org", true, true, false, false],
  ["settings_members_matrix_delete", true, false, false, false],
];

/** "Rollen erklärt": what each organization role may do. */
export default function RolesMatrixDialog({
  callerRole,
  onClose,
}: {
  callerRole?: OrgRole;
  onClose: () => void;
}) {
  const { t } = useTranslation("common");
  const words = roleWords(t);
  return (
    <AppDialog
      open
      onClose={onClose}
      icon={ICON_NAME.LOCK}
      title={t("settings_members_matrix_title")}
      subtitle={t("settings_members_matrix_subtitle")}
      maxWidth={720}
      footer={<AppDialogFooter cancelLabel={t("close")} onCancel={onClose} />}>
      <Typography variant="body2" sx={{ mb: 4 }}>
        {t("settings_members_matrix_intro")}
      </Typography>
      <Box sx={{ overflowX: "auto" }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 700 }}>{t("settings_members_matrix_may")}</TableCell>
              {ORG_ROLE_ORDER.map((role) => (
                <TableCell
                  key={role}
                  align="center"
                  sx={{ fontWeight: 700, color: role === callerRole ? "primary.main" : undefined }}>
                  {words[role].word}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {ROWS.map(([key, ...allowed]) => (
              <TableRow key={key}>
                <TableCell component="th" scope="row">
                  {t(key)}
                </TableCell>
                {allowed.map((yes, index) => (
                  <TableCell key={ORG_ROLE_ORDER[index]} align="center">
                    <Box component="span" aria-hidden sx={{ color: yes ? "text.primary" : "text.secondary" }}>
                      {yes ? "✓" : "·"}
                    </Box>
                    <Box component="span" sx={visuallyHidden}>
                      {t(yes ? "settings_members_matrix_yes" : "settings_members_matrix_no")}
                    </Box>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
      <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 3 }}>
        {t("settings_members_matrix_footnote")}
      </Typography>
    </AppDialog>
  );
}

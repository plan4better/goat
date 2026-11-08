"use client";

import { Box, Button, Drawer, IconButton, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { NavDivider, NavHeading, NavRow } from "@/components/settings/nav/SettingsNav";
import type { SettingsNavGroup } from "@/components/settings/nav/settingsNav";

/** Below `md`: a pill naming "Gruppe › Seite" that opens the sections as a
 * bottom sheet (44px rows; White Label's children without it), as Content's
 * space pill opens its spaces (`ContentBreadcrumb`, `ContentSpacesPanel`'s
 * mobile sheet). The close button, the backdrop, Escape and picking a row
 * close it. */
export default function SettingsNavSheet({
  groups,
  memberCount,
  needsAttention,
}: {
  groups: SettingsNavGroup[];
  memberCount?: number;
  needsAttention: boolean;
}) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const current = groups.flatMap((group) => group.items).find((item) => item.current);

  return (
    <>
      <Button
        variant="outlined"
        size="small"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        startIcon={current?.icon ? <Icon iconName={current.icon} fontSize="small" /> : undefined}
        endIcon={<Icon iconName={ICON_NAME.CHEVRON_DOWN} style={{ fontSize: 12 }} />}
        sx={{ borderRadius: 999, textTransform: "none", maxWidth: "100%" }}>
        <Box
          component="span"
          sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {current
            ? t("settings_nav_current", { group: t(current.groupLabelKey), page: t(current.labelKey) })
            : t("settings_nav_title")}
        </Box>
      </Button>
      <Drawer
        anchor="bottom"
        open={open}
        onClose={() => setOpen(false)}
        PaperProps={{
          role: "dialog",
          "aria-label": t("settings_nav_sheet_title"),
          sx: { borderTopLeftRadius: "16px", borderTopRightRadius: "16px", maxHeight: "78vh" },
        }}>
        <Box
          sx={{
            padding: "13px 8px 13px 14px",
            borderBottom: 1,
            borderColor: "divider",
            display: "flex",
            alignItems: "center",
            gap: 1,
            flexShrink: 0,
          }}>
          <Typography
            component="span"
            sx={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 700, letterSpacing: "-0.1px" }}>
            {t("settings_nav_sheet_title")}
          </Typography>
          <IconButton size="small" onClick={() => setOpen(false)} aria-label={t("close")}>
            <Icon iconName={ICON_NAME.CLOSE} fontSize="small" />
          </IconButton>
        </Box>
        <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px" }}>
          {groups.map((group, index) => (
            <Box key={group.key}>
              {index > 0 && <NavDivider />}
              <Box role="group" aria-label={t(group.labelKey)}>
                <NavHeading>{t(group.labelKey)}</NavHeading>
                {group.items.map((item) => (
                  <NavRow
                    key={item.key}
                    item={item}
                    // Domains and Analytics have no icon: their labels line
                    // up with the others.
                    indent={!item.icon}
                    minHeight={44}
                    memberCount={memberCount}
                    needsAttention={needsAttention}
                    onNavigate={() => setOpen(false)}
                  />
                ))}
              </Box>
            </Box>
          ))}
        </Box>
      </Drawer>
    </>
  );
}

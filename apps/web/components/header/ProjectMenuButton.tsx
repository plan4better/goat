"use client";

import { Button, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import { GOATLogoIconOnlyGreen } from "@p4b/ui/assets/svg/GOATLogoIconOnlyGreen";
import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

/**
 * The map header's project menu button: the logo with its chevron. The project
 * menu opens from it; the shared header draws it as the menu's placeholder
 * while the menu's code loads (`placeholder`: no control, hidden from assistive
 * tech), so the title beside it keeps its place when the menu arrives. The logo
 * says nothing to assistive tech, so the button carries the menu's name.
 */
export default function ProjectMenuButton({ placeholder = false }: { placeholder?: boolean }) {
  const theme = useTheme();
  const { t } = useTranslation("common");
  return (
    <Button
      color="secondary"
      endIcon={<Icon iconName={ICON_NAME.CHEVRON_DOWN} style={{ fontSize: "14px", color: "inherit" }} />}
      sx={{
        textTransform: "none",
        borderRadius: 1,
        ml: -2,
        my: 4,
        "&:hover": {
          color: theme.palette.primary.main,
        },
      }}
      size="small"
      variant="text"
      {...(placeholder ? { tabIndex: -1, "aria-hidden": true } : { "aria-label": t("common:project_menu") })}>
      <GOATLogoIconOnlyGreen style={{ width: "32px", height: "32px", cursor: "pointer" }} />
    </Button>
  );
}

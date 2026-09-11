"use client";

import { Chip, Tooltip, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import { Icon } from "@p4b/ui/components/Icon";

import type { Audience } from "@/lib/utils/content";

interface AudienceChipProps {
  audience: Audience;
}

/** Who else can see an item, as a small icon+label chip. Public link
 * visibility gets the warning palette so it reads as the strongest,
 * most exposed claim; every other audience — including restricted — uses a
 * neutral outline. A share reads only "Shared" — the space it is listed in
 * already says with whom, mostly — and names every grantee on hover. */
const AudienceChip = ({ audience }: AudienceChipProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const isPublic = audience.kind === "public";
  const names = audience.sharedWithNames ?? [];
  const title = names.length > 0 ? t("shared_with_names", { names: names.join(", ") }) : "";

  return (
    <Tooltip title={title} placement="top" disableInteractive>
    <Chip
      size="small"
      variant="outlined"
      icon={<Icon iconName={audience.icon} style={{ fontSize: 12 }} />}
      label={t(audience.labelKey)}
      sx={{
        height: 20,
        fontSize: 11,
        fontStyle: "normal",
        maxWidth: "100%",
        // The small chip's icon slot carries a negative right margin by
        // default, which pulls the label across the glyph — both margins are
        // set here so the icon and the label never overlap.
        "& .MuiChip-icon": { ml: 1, mr: 0, fontSize: 12, color: "inherit" },
        "& .MuiChip-label": { pl: 0.75, pr: 1, fontStyle: "normal" },
        ...(isPublic && {
          color: theme.palette.warning.main,
          borderColor: theme.palette.warning.main,
        }),
      }}
    />
    </Tooltip>
  );
};

export default AudienceChip;

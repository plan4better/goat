"use client";

// How the conditions combine, in the head over them: every one of them, or at least one. The filter panel's, and a
// style rule's from two conditions on.
import { ButtonBase } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { FilterModel } from "@/lib/filter/model";

import { DropdownMenu } from "@/components/map/panels/styleEditor/popovers/DropdownMenu";

export function MatchMenu({
  match,
  onChange,
}: {
  match: FilterModel["match"];
  onChange: (match: FilterModel["match"]) => void;
}) {
  const { t } = useTranslation("common");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <ButtonBase
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
        sx={{
          height: 24,
          mr: -1.5,
          pl: 2,
          pr: 1.5,
          gap: 1,
          borderRadius: 1.5,
          color: "text.secondary",
          typography: "caption",
          fontWeight: "bold",
          "&:hover, &.Mui-focusVisible": { bgcolor: "action.hover" },
        }}>
        {t(`filter_panel.match_${match}`)}
        <Icon iconName={ICON_NAME.CHEVRON_DOWN} sx={{ fontSize: 10 }} />
      </ButtonBase>
      <DropdownMenu
        anchorEl={anchor}
        role="menu"
        width={260}
        onClose={() => setAnchor(null)}
        items={(["all", "any"] as const).map((value) => ({
          label: t(`filter_panel.match_${value}`),
          sub: t(`filter_panel.match_${value}_note`),
          selected: match === value,
          onClick: () => onChange(value),
        }))}
      />
    </>
  );
}

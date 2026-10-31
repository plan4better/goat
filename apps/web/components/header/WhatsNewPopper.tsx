"use client";

import { Badge, IconButton, Tooltip } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { FEEDS_ENABLED, changelogUrl } from "@/lib/api/feeds";
import { patchPreferences, usePreferences } from "@/lib/api/preferences";
import { unreadCount, useReleases } from "@/lib/api/releases";

import { ArrowPopper } from "@/components/ArrowPoper";
import ReleaseItem from "@/components/dashboard/home/ReleaseItem";
import {
  HeaderPopoverFooter,
  HeaderPopoverFooterAction,
  HeaderPopoverHeader,
  HeaderPopoverList,
} from "@/components/header/HeaderPopover";
import HeaderPopoverPaper, { HEADER_POPOVER_PLACEMENT } from "@/components/header/HeaderPopoverPaper";

/** H7's header surface for release notes: the changelog feed as a scrollable
 * list behind the rocket, badged with the unread count. Renders nothing when
 * no website URL is configured or the feed has no entries. */
export default function WhatsNewPopper() {
  const { t, i18n } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const locale = i18n.language === "de" ? "de" : "en";

  const { entries } = useReleases(locale);
  const { preferences, mutate } = usePreferences();

  // No feed, or nothing in it yet (or the website unreachable): no rocket rather than an empty panel.
  if (!FEEDS_ENABLED || entries.length === 0) return null;

  // No badge until the preferences are in: the feed usually arrives first,
  // and a missing watermark would flash the full count for a moment.
  const unread = preferences ? unreadCount(entries, preferences.releases_seen_at) : 0;

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      void patchPreferences({ releases_seen_at: new Date().toISOString() }).then(() => mutate());
    }
  };

  return (
    <ArrowPopper
      open={open}
      onClose={() => setOpen(false)}
      placement={HEADER_POPOVER_PLACEMENT}
      arrow={false}
      content={
        <HeaderPopoverPaper>
          <HeaderPopoverHeader title={t("whats_new")} />
          <HeaderPopoverList sx={{ maxHeight: 360, overflowY: "auto" }}>
            {entries.map((entry) => (
              <ReleaseItem key={entry.id} entry={entry} />
            ))}
          </HeaderPopoverList>
          <HeaderPopoverFooter>
            <HeaderPopoverFooterAction href={changelogUrl(locale)} newTab>
              {t("view_all_updates")}
              <Icon iconName={ICON_NAME.EXTERNAL_LINK} style={{ fontSize: 11 }} />
            </HeaderPopoverFooterAction>
          </HeaderPopoverFooter>
        </HeaderPopoverPaper>
      }>
      <Tooltip title={t("whats_new")}>
        <IconButton
          size="small"
          onClick={handleToggle}
          // The count badge reaches past the icon: a little room before the next header item.
          sx={{ mr: "4px", ...(open && { color: "primary.main" }) }}>
          <Badge color="warning" badgeContent={unread} max={9} invisible={unread === 0}>
            <Icon iconName={ICON_NAME.ROCKET} fontSize="inherit" />
          </Badge>
        </IconButton>
      </Tooltip>
    </ArrowPopper>
  );
}

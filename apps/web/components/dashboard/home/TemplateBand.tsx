"use client";

import { Box, Button, Skeleton, Typography, useMediaQuery, useTheme } from "@mui/material";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useSpaces } from "@/lib/api/content";
import { useFavoriteStars } from "@/lib/api/favorites";
import { useTemplates } from "@/lib/api/templates";
import {
  TEMPLATE_EMPTY_HINT_KEY,
  templateEmptyTitle,
  templateShelfOf,
  templateSourceLabel,
} from "@/lib/utils/templates";
import type { TemplateKind, TemplateRead, TemplateSourceFilter } from "@/lib/validations/template";

import { contentPath } from "@/hooks/dashboard/content/useContentPageState";
import { templateResultHref } from "@/hooks/templates/useUseTemplate";

import EmptyState from "@/components/dashboard/common/EmptyState";
import StarterCard from "@/components/dashboard/common/StarterCard";
import HomeSection from "@/components/dashboard/home/HomeSection";
import TemplateBrowser from "@/components/templates/TemplateBrowser";
import TemplateKindFilter from "@/components/templates/TemplateKindFilter";
import TemplatePreviewDialog from "@/components/templates/TemplatePreviewDialog";
import TemplateSourceSegments from "@/components/templates/TemplateSourceSegments";
import UseTemplateFlow from "@/components/templates/UseTemplateFlow";

const GRID_SIZE = 12;
const MAX_CARDS = 6;
const MAX_CARDS_MOBILE = 4;

/** One grid cell's worth of loading placeholder — a rounded rectangle at the
 * thumbnail height `StarterCard` uses, plus its two text lines. */
const CardSkeleton = ({ mobile }: { mobile: boolean }) => (
  <Box>
    <Skeleton variant="rectangular" height={mobile ? 96 : 132} sx={{ borderRadius: "11px" }} />
    <Skeleton variant="text" width="70%" sx={{ fontSize: 14, mt: "9px" }} />
    <Skeleton variant="text" width="45%" sx={{ fontSize: 12, mt: "2px" }} />
  </Box>
);

/**
 * §4's Home band: "Start from a template" with kind/source filters shared
 * with the browser, a capped grid of `StarterCard`s (pinned first), and a
 * footer that both states the visible/total count and links out to the
 * fuller surface for whichever source is selected — the GOAT catalog's
 * Templates tab for `goat`, Content filtered to templates for `mine`/`team`/
 * `org`. Card click opens the preview dialog; "Use template" hands off to
 * `UseTemplateFlow` in the `new_project` context, same as every other
 * unfiltered entry point (T7). Renders nothing only when the feed itself
 * errors — an empty page (genuinely zero templates) still shows the header
 * and filters, per §3's "mount every stage". While the first load is in
 * flight (no cached page yet — SWR keeps the previous page across a
 * revalidation, so a refetch never re-triggers this), the header still
 * renders but the filters and footer stay hidden and a skeleton grid takes
 * the cards' place, so the page doesn't pop in once every band's data lands.
 */
const TemplateBand = () => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const router = useRouter();
  const mobile = useMediaQuery(theme.breakpoints.down("md"));

  const [kind, setKind] = useState<TemplateKind | "all">("all");
  const [source, setSource] = useState<TemplateSourceFilter>("all");
  const [selected, setSelected] = useState<TemplateRead | null>(null);
  const [using, setUsing] = useState<TemplateRead | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);

  const { page, isLoading, isError } = useTemplates({
    source,
    kind: kind === "all" ? undefined : kind,
    size: GRID_SIZE,
  });
  const { spaces } = useSpaces();
  const { starred, toggleStar } = useFavoriteStars("template");

  const templates = useMemo(() => {
    const items = page?.items ?? [];
    const pinned = items.filter((item) => starred[item.id]);
    const rest = items.filter((item) => !starred[item.id]);
    return [...pinned, ...rest].slice(0, mobile ? MAX_CARDS_MOBILE : MAX_CARDS);
  }, [page, starred, mobile]);

  if (isError) return null;

  const showSkeleton = isLoading && !page;
  const showEmpty = !showSkeleton && templates.length === 0;
  const narrowedSource = source === "mine" || source === "team" || source === "org";

  const personalSpaceId = spaces.find((space) => space.kind === "personal")?.id;
  const teamSpaceId = spaces.find((space) => space.kind === "team")?.id;
  const orgSpaceId = spaces.find((space) => space.kind === "organization")?.id;

  const footerLink = (() => {
    if (source === "goat") {
      return (
        <Button variant="text" size="small" onClick={() => router.push("/catalog?tab=templates")}>
          {t("browse_goat_templates")}
        </Button>
      );
    }
    const spaceId = source === "mine" ? personalSpaceId : source === "team" ? teamSpaceId : orgSpaceId;
    if (!narrowedSource || !spaceId) return null;
    return (
      <Button
        variant="text"
        size="small"
        onClick={() => router.push(`${contentPath({ spaceId })}?types=template`)}>
        {t("show_in_content")}
      </Button>
    );
  })();

  return (
    <>
      <HomeSection
        title={t("start_from_a_template")}
        action={
          <Button
            variant="text"
            size="small"
            endIcon={<Icon iconName={ICON_NAME.CHEVRON_RIGHT} style={{ fontSize: 12 }} />}
            onClick={() => setBrowserOpen(true)}
            sx={{ borderRadius: 0 }}>
            {t("all_templates")}
          </Button>
        }>
        <Box sx={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {!showSkeleton && (
            <Box
              sx={{
                display: "flex",
                flexDirection: mobile ? "column" : "row",
                justifyContent: "space-between",
                alignItems: mobile ? "flex-start" : "center",
                gap: "10px",
              }}>
              <TemplateKindFilter kind={kind} onChange={setKind} />
              <TemplateSourceSegments source={source} onChange={setSource} spaces={spaces} />
            </Box>
          )}

          {showSkeleton ? (
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: mobile
                  ? "repeat(auto-fill, minmax(min(100%, 168px), 1fr))"
                  : "repeat(auto-fill, minmax(210px, 1fr))",
                gap: mobile ? "10px" : "16px",
              }}>
              {Array.from({ length: mobile ? MAX_CARDS_MOBILE : MAX_CARDS }).map((_, index) => (
                <CardSkeleton key={index} mobile={mobile} />
              ))}
            </Box>
          ) : showEmpty ? (
            <EmptyState
              icon={ICON_NAME.CLONE}
              title={templateEmptyTitle(t, source)}
              hint={t(TEMPLATE_EMPTY_HINT_KEY[source])}
              action={
                <Button variant="outlined" size="small" onClick={() => setBrowserOpen(true)}>
                  {t("all_templates")}
                </Button>
              }
            />
          ) : (
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: mobile
                  ? "repeat(auto-fill, minmax(min(100%, 168px), 1fr))"
                  : "repeat(auto-fill, minmax(210px, 1fr))",
                gap: mobile ? "10px" : "16px",
              }}>
              {templates.map((template) => (
                <StarterCard
                  key={template.id}
                  template={template}
                  pinned={!!starred[template.id]}
                  onTogglePin={() => toggleStar(template.id)}
                  onOpen={() => setSelected(template)}
                  mobile={mobile}
                />
              ))}
            </Box>
          )}

          {!showSkeleton && (
            <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
              <Typography component="div" sx={{ fontSize: 12, color: theme.palette.text.secondary }}>
                {t("showing_n_of_m_templates", { n: templates.length, m: page?.total ?? 0 })}
              </Typography>
              {footerLink}
            </Box>
          )}
        </Box>
      </HomeSection>

      <TemplatePreviewDialog
        open={!!selected}
        template={selected ?? undefined}
        sourceLabel={selected ? templateSourceLabel(templateShelfOf(selected, spaces), t) : undefined}
        onClose={() => setSelected(null)}
        onUse={() => {
          setUsing(selected);
          setSelected(null);
        }}
      />

      {browserOpen && (
        <TemplateBrowser
          mode="dialog"
          open
          onClose={() => setBrowserOpen(false)}
          onUse={(template) => {
            setBrowserOpen(false);
            setUsing(template);
          }}
        />
      )}

      {using && (
        <UseTemplateFlow
          template={using}
          context={{ kind: "outside_project" }}
          onClose={() => setUsing(null)}
          onDone={(result) => {
            const template = using;
            setUsing(null);
            router.push(templateResultHref(template, result));
          }}
        />
      )}
    </>
  );
};

export default TemplateBand;

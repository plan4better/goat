"use client";

import { Box, Chip, Link as MuiLink, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { visuallyHidden } from "@mui/utils";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";

/** The detail chrome the catalog and dataset views are built from: header, tabs, section card, metadata sidebar. */

/** The bundle accent, on both the badge and the tag. */
export const BUNDLE_ACCENT = "#7B5BD1";

export type DetailBadge = {
  label: string;
  color?: string;
  /** Sentence-case rather than an uppercase pill — for "Part of the bundle X". */
  plain?: boolean;
};

export const DetailHeader = ({
  onBack,
  backLabel,
  badge,
  title,
  subtitle,
  actions,
  size = "large",
}: {
  /** Back navigation. The button renders only where one is passed. */
  onBack?: () => void;
  /** Names where back goes ("Back to <bundle>"). Plain "Back" without it. */
  backLabel?: string;
  badge?: DetailBadge | null;
  title: string;
  subtitle?: string | null;
  actions?: React.ReactNode;
  /** `compact` shrinks the title and the gap under it, for a header inside a dialog. */
  size?: "large" | "compact";
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const badgeColor = badge?.color ?? theme.palette.primary.main;

  return (
    <>
      {onBack && (
        <Box
          component="button"
          type="button"
          onClick={onBack}
          sx={{
            display: "inline-flex",
            alignItems: "center",
            gap: 1.5,
            py: 1,
            mb: 3,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            font: "inherit",
            fontSize: 14,
            fontWeight: 600,
            color: theme.palette.primary.main,
          }}>
          <Icon
            iconName={ICON_NAME.CHEVRON_LEFT}
            style={{ fontSize: 12 }}
            htmlColor={theme.palette.primary.main}
          />
          {backLabel ? t("catalog_back_to", { target: backLabel }) : t("back")}
        </Box>
      )}

      <Stack
        direction="row"
        useFlexGap
        flexWrap="wrap"
        alignItems="flex-start"
        justifyContent="space-between"
        sx={{ gap: 6, mb: size === "compact" ? 4 : 6 }}>
        <Box sx={{ minWidth: 260, flex: "1 1 320px" }}>
          {badge && (
            <Typography
              component="span"
              sx={{
                display: "inline-block",
                mb: 2,
                px: 2.25,
                py: 0.75,
                borderRadius: 1,
                fontSize: badge.plain ? 12 : 10.5,
                fontWeight: badge.plain ? 500 : 700,
                letterSpacing: badge.plain ? 0 : 0.8,
                textTransform: badge.plain ? "none" : "uppercase",
                color: badgeColor,
                // 1A ≈ 10% alpha.
                backgroundColor: `${badgeColor}1A`,
              }}>
              {badge.label}
            </Typography>
          )}
          {/* `component`, not `variant`: the theme runs h1 through responsiveFontSizes(), whose media queries would override a plain fontSize here and render the title at display size. */}
          <Typography
            component="h1"
            sx={{
              fontSize: size === "compact" ? 22 : 28,
              fontWeight: 700,
              letterSpacing: "-0.4px",
              lineHeight: 1.2,
              overflowWrap: "anywhere",
            }}>
            {title}
          </Typography>
          {subtitle && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 1.5, maxWidth: 720, lineHeight: 1.5 }}>
              {subtitle}
            </Typography>
          )}
        </Box>
        {actions && (
          <Stack direction="row" useFlexGap flexWrap="wrap" justifyContent="flex-end" gap={2}>
            {actions}
          </Stack>
        )}
      </Stack>
    </>
  );
};

export type DetailTab<T extends string> = { id: T; label: string; count?: number };

export const DetailTabs = <T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: DetailTab<T>[];
  active: T;
  onChange: (tab: T) => void;
}) => {
  const theme = useTheme();
  const { i18n } = useTranslation();

  // A single tab is a label, not a choice.
  return (
    <Stack
      direction="row"
      useFlexGap
      flexWrap="wrap"
      sx={{ gap: 1, borderBottom: `1px solid ${theme.palette.divider}`, mb: 6 }}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <Box
            key={tab.id}
            component="button"
            type="button"
            onClick={() => onChange(tab.id)}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              px: 1,
              py: 3,
              mr: 8,
              mb: "-1px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              font: "inherit",
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: selected ? theme.palette.primary.main : theme.palette.text.secondary,
              borderBottom: `3px solid ${selected ? theme.palette.primary.main : "transparent"}`,
            }}>
            {tab.label}
            {tab.count !== undefined && (
              <Typography
                component="span"
                sx={{
                  fontSize: 11,
                  fontWeight: 700,
                  px: 1.75,
                  py: 0.25,
                  borderRadius: "999px",
                  backgroundColor: selected ? theme.palette.action.selected : theme.palette.action.hover,
                  color: selected ? theme.palette.primary.main : theme.palette.text.secondary,
                }}>
                {tab.count.toLocaleString(i18n.language)}
              </Typography>
            )}
          </Box>
        );
      })}
    </Stack>
  );
};

/**
 * A titled card. `bleed` keeps the title inset while the body runs to the card's
 * edges — for tables and maps, which should not sit in a padded well.
 */
export const SectionCard = ({
  title,
  note,
  right,
  children,
  pad = 6,
  bleed,
}: {
  title?: string;
  note?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  /** Padding in theme units (4px each). */
  pad?: number;
  bleed?: boolean;
}) => {
  const theme = useTheme();
  return (
    <Box
      sx={{
        backgroundColor: theme.palette.background.paper,
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 2.5,
        boxShadow: surfaceShadows(theme).rest,
        p: pad,
        overflow: bleed ? "hidden" : undefined,
        // Harvested metadata is arbitrary text: publisher names, keywords and
        // URLs arrive with single tokens wider than the card, which the default
        // `normal` will not break and so spills past the border. Inherited, so
        // one declaration covers every panel body.
        overflowWrap: "anywhere",
      }}>
      {title && (
        <Stack direction="row" alignItems="baseline" spacing={3} sx={{ mb: note ? 1.5 : 3.5 }}>
          {/* A heading, not a label: the weight and colour of the table headers beneath it, so a section reads as the start of its content rather than as a caption stamped above it. */}
          <Typography
            sx={{
              fontSize: 15,
              fontWeight: 600,
              color: theme.palette.text.primary,
            }}>
            {title}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {right}
        </Stack>
      )}
      {note && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 3.5 }}>
          {note}
        </Typography>
      )}
      {bleed ? <Box sx={{ mx: -pad, mb: -pad }}>{children}</Box> : children}
    </Box>
  );
};

export type MetaField = {
  icon: ICON_NAME;
  label: string;
  value: React.ReactNode;
};

/** The metadata column: one row per field, each a tinted icon tile with a label above its value. */
export const MetaSidebar = ({
  fields,
  children,
  flat,
}: {
  fields: (MetaField | null | undefined | false)[];
  children?: React.ReactNode;
  /** Drop the card around the field list, for a host that is already a surface
   * of its own — a dialog. Rows and dividers are unchanged. */
  flat?: boolean;
}) => {
  const theme = useTheme();
  const rows = fields.filter(
    (field): field is MetaField =>
      !!field && field.value !== null && field.value !== undefined && field.value !== ""
  );
  if (rows.length === 0 && !children) return null;

  return (
    <Box component="aside" sx={{ width: { xs: "100%", md: 280 }, flexShrink: 0, alignSelf: "stretch" }}>
      {/* Sticky only once it is a column beside the content: stuck to the top of a stacked layout it would float over what follows it. */}
      <Box sx={{ position: { md: "sticky" }, top: { md: 16 } }}>
        {rows.length > 0 && (
          <Box
            sx={{
              ...(flat
                ? { px: 0 }
                : {
                    backgroundColor: theme.palette.background.paper,
                    border: `1px solid ${theme.palette.divider}`,
                    borderRadius: 2.5,
                    boxShadow: surfaceShadows(theme).rest,
                    px: 4.5,
                  }),
              py: 1,
            }}>
            {rows.map((field, index) => (
              <Stack
                key={field.label}
                direction="row"
                spacing={3}
                alignItems="flex-start"
                sx={{
                  py: 3.5,
                  borderBottom: index < rows.length - 1 ? `1px solid ${theme.palette.divider}` : "none",
                }}>
                <Box
                  sx={{
                    width: 28,
                    height: 28,
                    mt: 0.5,
                    borderRadius: 1.5,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: theme.palette.action.hover,
                  }}>
                  <Icon
                    iconName={field.icon}
                    style={{ fontSize: 14 }}
                    htmlColor={theme.palette.primary.main}
                  />
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Typography
                    sx={{
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: 0.3,
                      mb: 0.5,
                      color: theme.palette.text.secondary,
                    }}>
                    {field.label}
                  </Typography>
                  <Typography
                    component="div"
                    sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.35, overflowWrap: "anywhere" }}>
                    {field.value}
                  </Typography>
                </Box>
              </Stack>
            ))}
          </Box>
        )}
        {children}
      </Box>
    </Box>
  );
};

/** A license, linked to its terms when the catalog published a `rel="license"` link. */
const OPEN_LICENSE = /^(cc0|cc-by|cc-zero|odbl|odc-|pddl|dl-de|mit|apache)/i;

export const LicenseBadge = ({ license, href }: { license: string; href?: string }) => {
  const theme = useTheme();
  const open = OPEN_LICENSE.test(license);
  const tone = open ? theme.palette.primary.main : theme.palette.text.secondary;
  const looksLikeUrl = /^https?:\/\//.test(license);
  const label = looksLikeUrl
    ? license
        .replace(/^https?:\/\//, "")
        .split("/")
        .pop() || license
    : license;

  // No icon inside the badge: every caller places it in a `MetaSidebar` row, whose tile already draws a licence glyph.
  const badge = (
    <Typography
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        px: 2.5,
        py: 1,
        borderRadius: 1.5,
        backgroundColor: `${tone}1A`,
        color: tone,
        fontSize: 12.5,
        fontWeight: 700,
      }}>
      {label}
    </Typography>
  );

  const target = href ?? (looksLikeUrl ? license : undefined);
  if (!target) return badge;
  return (
    <MuiLink href={target} target="_blank" rel="noreferrer noopener" underline="none" title={license}>
      {badge}
    </MuiLink>
  );
};

/** Where the licence has no name: link its terms. */
export const LicenseTerms = ({ href }: { href?: string }) => {
  const { t } = useTranslation("common");
  if (!href) return null;
  return (
    <MuiLink
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      variant="body2"
      sx={{ overflowWrap: "anywhere" }}>
      {t("catalog_license_terms_at_source")}
    </MuiLink>
  );
};

export const LicenseNotices = ({
  attribution,
  lineage,
}: {
  attribution?: string | null;
  lineage?: string | null;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  if (!attribution && !lineage) return null;
  const notice = (heading: string, body: string) => (
    <Box sx={{ "&:not(:first-of-type)": { mt: 0.5 } }}>
      <Typography
        component="span"
        sx={{
          display: "block",
          fontSize: 9,
          fontWeight: 700,
          lineHeight: 1,
          mb: 0.125,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          opacity: 0.7,
        }}>
        {heading}
      </Typography>
      {body}
    </Box>
  );
  return (
    <Tooltip
      placement="top"
      slotProps={{
        tooltip: {
          sx: { maxWidth: 320, whiteSpace: "pre-wrap", py: 0.25, px: 1, lineHeight: 1.25 },
        },
      }}
      title={
        <>
          {attribution && notice(t("metadata.headings.attribution"), attribution)}
          {lineage && notice(t("metadata.headings.lineage"), lineage)}
        </>
      }>
      <Box component="span" tabIndex={0} sx={{ display: "inline-flex", cursor: "help" }}>
        <Icon
          iconName={ICON_NAME.CIRCLEINFO}
          style={{ fontSize: 12 }}
          htmlColor={theme.palette.text.secondary}
        />
        <Box component="span" sx={visuallyHidden}>
          {t("metadata.headings.license")}
        </Box>
      </Box>
    </Tooltip>
  );
};

/**
 * The keywords, under their own heading, below a rule inside a section card.
 *
 * The heading is a smaller, quieter `SectionCard` heading rather than a different
 * kind of label: it sits in the same card as one, and upper-case letter-spaced text
 * beside a sentence-case heading reads as an inconsistency, not as hierarchy.
 */
export const KeywordSection = ({ keywords }: { keywords?: string[] | null }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  if (!keywords?.length) return null;
  return (
    <Box sx={{ mt: 4.5, pt: 4, borderTop: `1px solid ${theme.palette.divider}` }}>
      <Typography
        sx={{
          fontSize: 13,
          fontWeight: 600,
          color: theme.palette.text.secondary,
          mb: 2.5,
        }}>
        {t("catalog_keywords")}
      </Typography>
      <KeywordChips keywords={keywords} />
    </Box>
  );
};

/** A dataset's keywords, as a pill row. */
export const KeywordChips = ({ keywords }: { keywords: string[] }) => {
  const theme = useTheme();
  return (
    <Stack direction="row" useFlexGap flexWrap="wrap" gap={1.5}>
      {keywords.map((keyword) => (
        <Chip
          key={keyword}
          label={keyword}
          size="small"
          sx={{
            borderRadius: "999px",
            border: `1px solid ${theme.palette.divider}`,
            backgroundColor: theme.palette.action.hover,
            fontSize: 12.5,
            fontWeight: 500,
          }}
        />
      ))}
    </Stack>
  );
};

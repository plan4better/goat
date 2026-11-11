"use client";

import {
  Box,
  Checkbox,
  FormControlLabel,
  InputBase,
  Link,
  Radio,
  RadioGroup,
  Skeleton,
  Stack,
  Typography,
  useTheme,
} from "@mui/material";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { templateSourceOptions } from "@/lib/utils/templates";
import type { Space } from "@/lib/validations/content";
import type { TemplateSourceFilter } from "@/lib/validations/template";

import { ArrowPopper } from "@/components/ArrowPoper";
import PopoverPaper from "@/components/common/PopoverPaper";
import ToolPill from "@/components/dashboard/common/ToolPill";
import TemplateTag from "@/components/templates/TemplateTag";

interface TemplateFilterPillProps {
  source: TemplateSourceFilter;
  onSource: (source: TemplateSourceFilter) => void;
  /** Which of Team/Organization the source list offers is read off these. */
  spaces: Space[];
  /** The shelf is fixed by whoever mounted the browser — the Catalog
   * Templates tab, which is GOAT-only — so the popover offers the
   * categories alone and no source to switch to. */
  hideSource?: boolean;
  tags: string[];
  /** The categories on this shelf with their counts, most used first — the
   * facet the API answers with, or the loaded page's own tags when that
   * request failed. */
  availableTags: { tag: string; count: number }[];
  onToggleTag: (tag: string) => void;
  /** The tag list is still being fetched, and none is on screen yet. */
  tagsLoading?: boolean;
  activeFilterCount: number;
  onClear: () => void;
}

/** The browser dialog's Filter pill: the Content toolbar's pill and popover,
 * over a template shelf's two facets — one source, and any number of the
 * categories the loaded templates carry. Where the shelf itself is fixed
 * (`hideSource`), the categories are the only facet offered. The pill's
 * badge counts what is narrowing the list, and every choice is also
 * removable from the chip row under the search field. */
/** How the categories section is bounded: the options it shows before
 * "Show all", the height it scrolls inside once expanded, and the number of
 * options at which it also gains a search field of its own. */
const VISIBLE_TAGS = 8;
/** How many rows stand in for the tag list while it loads. */
const SKELETON_TAGS = 3;
const EXPANDED_MAX_HEIGHT = 240;
const SEARCHABLE_FROM = 13;

const TemplateFilterPill = ({
  source,
  onSource,
  spaces,
  hideSource,
  tags,
  availableTags,
  onToggleTag,
  tagsLoading,
  activeFilterCount,
  onClear,
}: TemplateFilterPillProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [tagQuery, setTagQuery] = useState("");
  // Wraps the pill and its popover (the popover renders in place here, not
  // through a portal), so one Escape handler sees a key press from either —
  // the pill itself, still focused from the click that opened it, or
  // whatever inside the popover the caller tabbed or clicked into.
  const containerRef = useRef<HTMLDivElement>(null);

  // A popover is one layer of "back": Escape closes it first and gives the
  // pill its focus back, rather than falling through to the dialog's own
  // Escape handler. A second press, with the popover already closed, still
  // reaches the dialog as before.
  const closePopoverOnEscape = (event: React.KeyboardEvent) => {
    if (!open || event.key !== "Escape") return;
    event.stopPropagation();
    setOpen(false);
    containerRef.current?.querySelector("button")?.focus();
  };

  // Selected first, so a tag stays where it was ticked; the rest as the hook
  // ordered them, by how many templates carry them.
  const ordered = useMemo(
    () => [...availableTags].sort((a, b) => Number(tags.includes(b.tag)) - Number(tags.includes(a.tag))),
    [availableTags, tags]
  );
  const searchable = availableTags.length > SEARCHABLE_FROM;
  const needle = tagQuery.trim().toLowerCase();
  // A selected tag survives the search text — a filter you cannot see is a
  // filter you cannot untick.
  const matching = needle
    ? ordered.filter((option) => option.tag.toLowerCase().includes(needle) || tags.includes(option.tag))
    : ordered;
  const listed = expanded || needle ? matching : matching.slice(0, VISIBLE_TAGS);
  const scrolls = expanded || !!needle;

  const groupLabelSx = {
    px: "10px",
    pt: "6px",
    pb: "4px",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.5px",
    textTransform: "uppercase" as const,
    color: theme.palette.text.secondary,
  };

  return (
    <Box ref={containerRef} onKeyDown={closePopoverOnEscape} sx={{ display: "contents" }}>
      <ArrowPopper
        open={open}
        placement="bottom-end"
        onClose={() => setOpen(false)}
        arrow={false}
        content={
          <PopoverPaper sx={{ minWidth: 230, maxHeight: 380, overflowY: "auto", py: 1 }}>
            {/* The clear link sits beside the first section's heading, and
              on its own row where the source section is not offered. */}
            <Stack
              direction="row"
              alignItems="center"
              justifyContent={hideSource ? "flex-end" : "space-between"}
              sx={{ pr: "10px" }}>
              {!hideSource && (
                <Typography component="div" sx={groupLabelSx}>
                  {t("source")}
                </Typography>
              )}
              {activeFilterCount > 0 && (
                <Link
                  component="button"
                  underline="none"
                  typography="body2"
                  onClick={onClear}
                  sx={{ color: theme.palette.primary.main }}>
                  {t("clear_all")}
                </Link>
              )}
            </Stack>
            {!hideSource && (
              <RadioGroup
                value={source}
                onChange={(_, value) => onSource(value as TemplateSourceFilter)}
                sx={{ px: "6px" }}>
                {templateSourceOptions(spaces).map((option) => (
                  <FormControlLabel
                    key={option.value}
                    value={option.value}
                    sx={{ display: "flex", mx: 0 }}
                    control={<Radio size="small" />}
                    label={<Typography variant="body2">{t(option.labelKey)}</Typography>}
                  />
                ))}
              </RadioGroup>
            )}

            {/* The heading stands while the tags are on their way, so the
              section does not appear from nowhere under the source radios. */}
            {availableTags.length === 0 && tagsLoading && (
              <>
                <Typography component="div" sx={groupLabelSx}>
                  {t("categories")}
                </Typography>
                <Box sx={{ px: "12px" }}>
                  {Array.from({ length: SKELETON_TAGS }, (_, index) => (
                    <Skeleton key={index} height={26} />
                  ))}
                </Box>
              </>
            )}

            {availableTags.length > 0 && (
              <>
                <Typography component="div" sx={groupLabelSx}>
                  {t("categories")}
                </Typography>
                {searchable && (
                  <Stack
                    direction="row"
                    alignItems="center"
                    spacing={2}
                    sx={{
                      mx: "10px",
                      mb: 1,
                      px: 2.5,
                      py: 1,
                      borderRadius: 1.5,
                      border: `1px solid ${theme.palette.divider}`,
                      backgroundColor: theme.palette.action.hover,
                    }}>
                    <Icon
                      iconName={ICON_NAME.SEARCH}
                      style={{ fontSize: 12 }}
                      htmlColor={theme.palette.text.secondary}
                    />
                    <InputBase
                      value={tagQuery}
                      onChange={(event) => setTagQuery(event.target.value)}
                      placeholder={t("catalog_filter_values")}
                      inputProps={{ "aria-label": t("catalog_filter_values") }}
                      sx={{ flex: 1, fontSize: 12.5 }}
                    />
                  </Stack>
                )}
                <Box
                  sx={
                    scrolls
                      ? {
                          maxHeight: EXPANDED_MAX_HEIGHT,
                          overflowY: "auto",
                          // Hairlines say "there is more" without a label.
                          borderTop: `1px solid ${theme.palette.divider}`,
                          borderBottom: `1px solid ${theme.palette.divider}`,
                        }
                      : undefined
                  }>
                  {listed.map((option) => (
                    <Box
                      key={option.tag}
                      sx={{ display: "flex", alignItems: "center", gap: "6px", pr: "12px" }}>
                      <FormControlLabel
                        sx={{ display: "flex", flex: 1, minWidth: 0, mx: 0, px: "6px" }}
                        control={
                          <Checkbox
                            size="small"
                            checked={tags.includes(option.tag)}
                            onChange={() => onToggleTag(option.tag)}
                          />
                        }
                        label={<TemplateTag label={option.tag} tone="category" />}
                      />
                      <Typography variant="caption" color="text.secondary">
                        {option.count}
                      </Typography>
                    </Box>
                  ))}
                  {listed.length === 0 && (
                    <Typography variant="caption" color="text.secondary" sx={{ px: "16px" }}>
                      {t("no_results")}
                    </Typography>
                  )}
                </Box>
                {!needle && matching.length > VISIBLE_TAGS && (
                  <Link
                    component="button"
                    underline="none"
                    typography="body2"
                    onClick={() => setExpanded((prev) => !prev)}
                    sx={{ display: "block", px: "16px", pt: "6px", color: theme.palette.primary.main }}>
                    {expanded ? t("show_less") : t("show_all")}
                  </Link>
                )}
              </>
            )}
          </PopoverPaper>
        }>
        <ToolPill
          icon={ICON_NAME.FILTER}
          label={t("filter")}
          chevron
          active={open || activeFilterCount > 0}
          badge={activeFilterCount > 0 ? activeFilterCount : undefined}
          onClick={() => setOpen((prev) => !prev)}
        />
      </ArrowPopper>
    </Box>
  );
};

export default TemplateFilterPill;

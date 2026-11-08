"use client";

import { Box, LinearProgress, Skeleton, useTheme } from "@mui/material";
import { visuallyHidden } from "@mui/utils";
import { type ReactNode, forwardRef } from "react";

import { accentText, focusRing } from "@/components/assistant/styles";
import SurfaceCard, { type SurfaceCardProps } from "@/components/dashboard/common/SurfaceCard";

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

export interface QuotaTileProps extends Omit<SurfaceCardProps, "children" | "selected" | "title"> {
  label: string;
  /** After the label: the Beta chip. */
  badge?: ReactNode;
  /** A dot (red: over the limit, amber: full) and the hidden `attentionText`. */
  attention?: "full" | "over" | null;
  attentionText: string;
  /** The figure; undefined while it loads (skeletons in its place). */
  figure?: { used: string; limit: string | null; usedWord: string; color: string };
  /** The 4px bar; null keeps its height, empty (no limit). */
  bar?: { percent: number; color: string } | null;
  note?: { text: ReactNode; color?: string } | null;
  selected: boolean;
  /** A phone's tile: a smaller figure; the label may wrap. */
  compact?: boolean;
}

/** A quota tile as the Usage page and the Mitglieder seat tiles draw it: the
 * label (and a dot that needs attention), the figure, a bar and one note.
 * A plain button; the caller gives it its role (tab or toggle). */
export const QuotaTile = forwardRef<HTMLDivElement, QuotaTileProps>(function QuotaTile(
  { label, badge, attention, attentionText, figure, bar, note, selected, compact, sx, ...rest },
  ref
) {
  const theme = useTheme();
  return (
    <SurfaceCard
      ref={ref}
      component="button"
      // A plain button, never one that submits a form around it; the spread
      // passes it on, as SurfaceCard's props are a div's.
      {...{ type: "button" }}
      selected={selected}
      {...rest}
      sx={[
        {
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: "6px",
          minWidth: 0,
          m: 0,
          p: "14px 16px 16px",
          textAlign: "left",
          font: "inherit",
          color: "text.primary",
          cursor: "pointer",
          ...focusRing(theme),
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}>
      <Box
        component="span"
        sx={{
          display: "flex",
          flexWrap: compact ? "wrap" : "nowrap",
          alignItems: "center",
          gap: "6px",
          fontSize: 13,
          fontWeight: 700,
          color: selected ? accentText(theme) : "text.secondary",
        }}>
        <Box component="span" sx={{ ...ellipsis, minWidth: 0 }}>
          {label}
        </Box>
        {badge}
        {attention && (
          <>
            <Box
              component="span"
              aria-hidden
              sx={{
                flexShrink: 0,
                width: 8,
                height: 8,
                ml: "auto",
                borderRadius: "50%",
                backgroundColor: attention === "over" ? "error.main" : "warning.main",
              }}
            />
            <Box component="span" sx={visuallyHidden}>
              {attentionText}
            </Box>
          </>
        )}
      </Box>
      {figure ? (
        <>
          <Box component="span" sx={{ ...ellipsis, fontSize: 13, color: "text.secondary" }}>
            <Box
              component="strong"
              sx={{
                fontSize: compact ? 18 : 22,
                fontWeight: 800,
                color: figure.color,
                fontVariantNumeric: "tabular-nums",
              }}>
              {figure.used}
            </Box>{" "}
            {figure.limit === null ? figure.usedWord : `/ ${figure.limit}`}
          </Box>
          {bar ? (
            <LinearProgress
              variant="determinate"
              value={bar.percent}
              aria-hidden
              sx={{
                height: 4,
                borderRadius: "2px",
                backgroundColor: "action.selected",
                "& .MuiLinearProgress-bar": { borderRadius: "2px", backgroundColor: bar.color },
              }}
            />
          ) : (
            // The bar's place, so the notes of all tiles stay on one line.
            <Box component="span" aria-hidden sx={{ display: "block", height: 4 }} />
          )}
          {note && (
            // A long note (German, a narrow tile) wraps to a second line
            // rather than losing its end, and stops there.
            <Box
              component="span"
              sx={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                fontSize: 12,
                lineHeight: 1.4,
                color: note.color ?? "text.secondary",
              }}>
              {note.text}
            </Box>
          )}
        </>
      ) : (
        <>
          <Skeleton variant="rounded" height={24} width="70%" sx={{ borderRadius: "6px" }} />
          <Skeleton variant="rounded" height={4} sx={{ borderRadius: "2px" }} />
          <Skeleton variant="rounded" height={12} width="50%" sx={{ borderRadius: "6px" }} />
        </>
      )}
    </SurfaceCard>
  );
});

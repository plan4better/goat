"use client";

import { Box, Skeleton, Stack } from "@mui/material";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import SettingsCard from "@/components/settings/common/SettingsCard";

/** A card while its data loads: the real title and hint (static), and lines
 * shaped like the body so nothing jumps when it arrives (Settings load, L3).
 * A "fields" row has a LabeledField's shape: the label line, 6px, the small
 * field and, with `help`, the help line below it. */
export default function CardSkeleton({
  title,
  hint,
  rows = 3,
  variant = "fields",
  help = false,
  footer = false,
}: {
  title: string;
  hint?: ReactNode;
  rows?: number;
  variant?: "fields" | "list";
  /** A help line under each field, as the loaded fields have one. */
  help?: boolean;
  /** The loaded card ends in a CardSaveBar: its place, at its height. */
  footer?: boolean;
}) {
  const { t } = useTranslation("common");
  return (
    <SettingsCard
      title={title}
      hint={hint}
      footer={
        footer ? (
          <Box
            sx={{
              display: "flex",
              justifyContent: "flex-end",
              px: 6,
              py: 3,
              borderTop: 1,
              borderColor: "divider",
            }}>
            {/* CardSaveBar's Speichern: a contained button with a body2 label. */}
            <Skeleton variant="rounded" width={112} height={39} sx={{ borderRadius: 999 }} />
          </Box>
        ) : undefined
      }>
      <Stack
        spacing={variant === "list" ? 2 : 4}
        role="status"
        aria-busy="true"
        aria-label={t("settings_nav_loading")}>
        {Array.from({ length: rows }).map((_, index) =>
          variant === "list" ? (
            <Skeleton key={index} variant="rounded" height={57} sx={{ borderRadius: "8px" }} />
          ) : (
            <Box key={index}>
              <Skeleton variant="text" width={140} height={21} sx={{ mb: 1.5 }} />
              <Skeleton variant="rounded" height={40} sx={{ borderRadius: "8px" }} />
              {help && <Skeleton variant="text" width="60%" height={20} sx={{ mt: "3px" }} />}
            </Box>
          )
        )}
      </Stack>
    </SettingsCard>
  );
}

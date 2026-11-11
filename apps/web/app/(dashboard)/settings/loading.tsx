"use client";

import { Skeleton, Stack } from "@mui/material";

import SettingsPage from "@/components/settings/common/SettingsPage";

export default function Loading() {
  return (
    <SettingsPage
      header={
        <Stack spacing={1}>
          <Skeleton variant="text" width={80} height={16} />
          <Skeleton variant="text" width={220} height={32} />
          <Skeleton variant="text" sx={{ width: 480, maxWidth: "100%" }} height={20} />
        </Stack>
      }>
      <Skeleton variant="rounded" height={220} sx={{ borderRadius: "12px" }} />
      <Skeleton variant="rounded" height={160} sx={{ borderRadius: "12px" }} />
    </SettingsPage>
  );
}

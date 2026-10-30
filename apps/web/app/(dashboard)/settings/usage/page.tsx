"use client";

import { Alert, Box, Card, Tab, Tabs } from "@mui/material";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useFeatures } from "@/lib/api/users";

import { UsageActivity } from "@/components/settings/usage/UsageActivity";
import { UsageOverview } from "@/components/settings/usage/UsageOverview";

export default function UsagePage() {
  const { t } = useTranslation("common");
  const [tab, setTab] = useState(0);
  const router = useRouter();
  const { features, isError: featuresError } = useFeatures();
  // Self-hosted (billing off): there is no usage to show.
  const billingOff = features?.billing === false;

  useEffect(() => {
    if (billingOff) router.replace("/settings/account");
  }, [billingOff, router]);

  // Without the feature flags we cannot tell billing on from off: say so
  // instead of leaving the page blank.
  if (!features && featuresError) return <Alert severity="error">{t("usage_load_error")}</Alert>;
  if (!features?.billing) return null;

  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }}>
      <Box sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          variant="fullWidth"
          indicatorColor="primary"
          textColor="primary">
          <Tab label={t("overview")} sx={{ textTransform: "uppercase", fontWeight: "bold" }} />
          <Tab label={t("activity")} sx={{ textTransform: "uppercase", fontWeight: "bold" }} />
        </Tabs>
      </Box>
      {tab === 0 && <UsageOverview />}
      {tab === 1 && <UsageActivity />}
    </Card>
  );
}

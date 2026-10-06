"use client";

import { Box, Card, Tab, Tabs } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { UsageActivity } from "@/components/settings/usage/UsageActivity";
import { UsageOverview } from "@/components/settings/usage/UsageOverview";

export default function UsagePage() {
  const { t } = useTranslation("common");
  const [tab, setTab] = useState(0);

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

"use client";

import {
  Box,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Pagination,
  Paper,
  Select,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  useTheme,
} from "@mui/material";
import { format } from "date-fns";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useCreditBreakdown, useCreditUsage } from "@/lib/api/usage";

const GROUP_BY_OPTIONS = [
  { value: "tool", label: "group_by_tool" },
  { value: "workflow", label: "group_by_workflow" },
  { value: "service", label: "group_by_service_type" },
  { value: "layer", label: "group_by_layer" },
  { value: "member", label: "group_by_member" },
  { value: "month", label: "group_by_month" },
] as const;

type GroupByValue = (typeof GROUP_BY_OPTIONS)[number]["value"];

/** Groups whose credits represent compute (primary color) */
const COMPUTE_GROUPS = new Set<GroupByValue>(["tool", "workflow"]);
/** Groups whose credits represent traffic (info color) */
const TRAFFIC_GROUPS = new Set<GroupByValue>(["service", "layer"]);

const PAGE_SIZE = 20;

export function UsageActivity() {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [groupBy, setGroupBy] = useState<GroupByValue>("tool");
  const [page, setPage] = useState(1);

  const { breakdown, isLoading: breakdownLoading } = useCreditBreakdown(groupBy);
  const { usage, isLoading: usageLoading } = useCreditUsage(page, PAGE_SIZE);

  const totalPages = usage ? Math.ceil(usage.total / PAGE_SIZE) : 0;

  const creditColor = COMPUTE_GROUPS.has(groupBy)
    ? theme.palette.primary.main
    : TRAFFIC_GROUPS.has(groupBy)
      ? theme.palette.info.main
      : "inherit";

  return (
    <Box sx={{ p: 4 }}>
      <Stack spacing={6}>
        <Divider />
        <Box>
          <Typography variant="body1" fontWeight="bold">
            {t("usage_activity")}
          </Typography>
          <Typography variant="caption">{t("usage_activity_description")}</Typography>
        </Box>
        <Divider />

        {/* Breakdown section */}
        <Stack spacing={4}>
          <Stack direction="row" alignItems="center" spacing={4}>
            <Typography variant="body2" fontWeight="bold">
              {t("breakdown")}
            </Typography>
            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="group-by-label">{t("group_by")}</InputLabel>
              <Select
                labelId="group-by-label"
                label={t("group_by")}
                value={groupBy}
                onChange={(e) => {
                  setGroupBy(e.target.value as GroupByValue);
                }}>
                {GROUP_BY_OPTIONS.map((opt) => (
                  <MenuItem key={opt.value} value={opt.value}>
                    {t(opt.label as never, { defaultValue: opt.value })}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {breakdownLoading && <CircularProgress size={18} />}
          </Stack>

          {breakdownLoading && <Skeleton variant="rectangular" height={120} />}

          {!breakdownLoading && breakdown && breakdown.rows.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              {t("no_activity_data")}
            </Typography>
          )}

          {!breakdownLoading && breakdown && breakdown.rows.length > 0 && (
            <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 360 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>{t("key")}</TableCell>
                    {groupBy === "workflow" && <TableCell align="right">{t("runs")}</TableCell>}
                    {groupBy === "month" && <TableCell align="right">{t("count")}</TableCell>}
                    {groupBy === "member" ? (
                      <>
                        <TableCell align="right">{t("compute")}</TableCell>
                        <TableCell align="right">{t("traffic")}</TableCell>
                        <TableCell align="right">{t("credits")}</TableCell>
                      </>
                    ) : (
                      <TableCell align="right">{t("credits")}</TableCell>
                    )}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {breakdown.rows.map((row, idx) => (
                    <TableRow key={`${row.key ?? "null"}-${idx}`}>
                      <TableCell>{row.key ?? t("unknown")}</TableCell>
                      {groupBy === "workflow" && (
                        <TableCell align="right">{(row.runs ?? 0) as number}</TableCell>
                      )}
                      {groupBy === "month" && <TableCell align="right">{row.count ?? 0}</TableCell>}
                      {groupBy === "member" ? (
                        <>
                          <TableCell align="right" sx={{ color: theme.palette.primary.main }}>
                            {((row.compute ?? 0) as number).toFixed(4)}
                          </TableCell>
                          <TableCell align="right" sx={{ color: theme.palette.info.main }}>
                            {((row.traffic ?? 0) as number).toFixed(4)}
                          </TableCell>
                          <TableCell align="right">{((row.credits ?? 0) as number).toFixed(4)}</TableCell>
                        </>
                      ) : (
                        <TableCell align="right" sx={{ color: creditColor }}>
                          {((row.credits ?? 0) as number).toFixed(4)}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}

          {!breakdownLoading && (
            <Typography variant="caption" color="text.secondary">
              {COMPUTE_GROUPS.has(groupBy)
                ? t("usage_activity_description")
                : TRAFFIC_GROUPS.has(groupBy)
                  ? t("traffic_this_period")
                  : groupBy === "member"
                    ? t("usage_activity_description")
                    : t("usage_activity_description")}
            </Typography>
          )}
        </Stack>

        <Divider />

        {/* Itemized ledger */}
        <Stack spacing={4}>
          <Typography variant="body2" fontWeight="bold">
            {t("ledger")}
          </Typography>

          {usageLoading && <Skeleton variant="rectangular" height={200} />}

          {!usageLoading && usage && usage.items.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              {t("no_activity_data")}
            </Typography>
          )}

          {!usageLoading && usage && usage.items.length > 0 && (
            <>
              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>{t("date")}</TableCell>
                      <TableCell>{t("member")}</TableCell>
                      <TableCell>{t("action")}</TableCell>
                      <TableCell align="right">{t("units")}</TableCell>
                      <TableCell align="right">{t("cost")}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {usage.items.map((item, idx) => (
                      <TableRow key={idx}>
                        <TableCell>{format(new Date(item.created_at), "yyyy-MM-dd HH:mm")}</TableCell>
                        <TableCell>{item.member ?? "—"}</TableCell>
                        <TableCell>{item.action}</TableCell>
                        <TableCell align="right">{item.unit}</TableCell>
                        <TableCell align="right">{item.cost.toFixed(4)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>

              {totalPages > 1 && (
                <Stack alignItems="center">
                  <Pagination count={totalPages} page={page} onChange={(_, p) => setPage(p)} size="small" />
                </Stack>
              )}
            </>
          )}
        </Stack>
      </Stack>
    </Box>
  );
}

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
import prettyBytes from "pretty-bytes";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useCreditBreakdown, useCreditUsage } from "@/lib/api/usage";
import { formatCredits, parseApiDate } from "@/lib/utils/credits";

import { useAuthZ } from "@/hooks/auth/AuthZ";

const GROUP_BY_OPTIONS = [
  { value: "tool", label: "group_by_tool" },
  { value: "workflow", label: "group_by_workflow" },
  { value: "service", label: "group_by_service_type" },
  { value: "layer", label: "group_by_layer" },
  { value: "member", label: "group_by_member" },
  { value: "month", label: "group_by_month" },
] as const;

type GroupByValue = (typeof GROUP_BY_OPTIONS)[number]["value"];

/** A ledger row's native amount as people read it: run time, data, tokens. */
function formatUnit(
  value: number | string,
  unitType: string,
  labels: { s: string; min: string },
  locale?: string
): string {
  const unit = Number(value) || 0; // the API may send numerics as strings
  if (unitType === "seconds") {
    return unit < 60 ? `${Math.round(unit)} ${labels.s}` : `${Math.round(unit / 60)} ${labels.min}`;
  }
  if (unitType === "bytes") return prettyBytes(unit, { locale, maximumFractionDigits: 1 });
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(unit);
}

/** Groups whose credits represent compute (primary color) */
const COMPUTE_GROUPS = new Set<GroupByValue>(["tool", "workflow"]);
/** Groups whose credits represent traffic (info color) */
const TRAFFIC_GROUPS = new Set<GroupByValue>(["service", "layer"]);

const PAGE_SIZE = 20;

export function UsageActivity() {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const [groupBy, setGroupBy] = useState<GroupByValue>("tool");
  const [page, setPage] = useState(1);
  // Organization admins see everyone's usage and can narrow it to one member.
  const { isOrgAdmin } = useAuthZ();
  const [member, setMember] = useState<string>("");

  const { breakdown, isLoading: breakdownLoading } = useCreditBreakdown(groupBy, member || undefined);
  const { usage, isLoading: usageLoading } = useCreditUsage(page, PAGE_SIZE, member || undefined);
  const { breakdown: members } = useCreditBreakdown("member");
  const memberOptions = (members?.rows ?? []).filter((row) => row.key);

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
            {isOrgAdmin && memberOptions.length > 0 && (
              <FormControl size="small" sx={{ minWidth: 200 }}>
                <InputLabel id="member-filter-label" shrink>{t("filter_by_member")}</InputLabel>
                <Select
                  labelId="member-filter-label"
                  label={t("filter_by_member")}
                  value={member}
                  displayEmpty
                  notched
                  onChange={(e) => {
                    setMember(e.target.value as string);
                    setPage(1);
                  }}>
                  <MenuItem value="">{t("all_members")}</MenuItem>
                  {memberOptions.map((row) => (
                    <MenuItem key={row.key as string} value={row.key as string}>
                      {row.name ?? t("unknown")}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}
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
                      <TableCell>
                        {groupBy === "member"
                          ? (row.name ?? (row.key ? t("unknown") : t("public_traffic")))
                          : (row.key ?? t("unknown"))}
                      </TableCell>
                      {groupBy === "workflow" && (
                        <TableCell align="right">{(row.runs ?? 0) as number}</TableCell>
                      )}
                      {groupBy === "month" && <TableCell align="right">{row.count ?? 0}</TableCell>}
                      {groupBy === "member" ? (
                        <>
                          <TableCell align="right" sx={{ color: theme.palette.primary.main }}>
                            {formatCredits(row.compute as number, i18n?.language)}
                          </TableCell>
                          <TableCell align="right" sx={{ color: theme.palette.info.main }}>
                            {formatCredits(row.traffic as number, i18n?.language)}
                          </TableCell>
                          <TableCell align="right">
                            {formatCredits(row.credits as number, i18n?.language)}
                          </TableCell>
                        </>
                      ) : (
                        <TableCell align="right" sx={{ color: creditColor }}>
                          {formatCredits(row.credits as number, i18n?.language)}
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
                        <TableCell>{format(parseApiDate(item.created_at), "yyyy-MM-dd HH:mm")}</TableCell>
                        <TableCell>{item.member ?? "—"}</TableCell>
                        <TableCell>{item.action}</TableCell>
                        <TableCell align="right">
                          {formatUnit(
                            item.unit,
                            item.unit_type,
                            { s: t("seconds_abbr"), min: t("minutes_abbr") },
                            i18n?.language
                          )}
                        </TableCell>
                        <TableCell align="right">{formatCredits(item.cost, i18n?.language)}</TableCell>
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

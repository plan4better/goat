import { Alert, Stack, Typography, styled } from "@mui/material";
import LinearProgress, { linearProgressClasses } from "@mui/material/LinearProgress";
import type { ReactNode } from "react";

const BorderLinearProgress = styled(
  ({
    colorWhenFull: _,
    variant,
    ...other
  }: {
    colorWhenFull: string;
    value: number;
    variant: "determinate" | "indeterminate" | "buffer" | "query";
  }) => <LinearProgress variant={variant} {...other} />
)<{ value: number; colorWhenFull: string; variant: "determinate" | "indeterminate" | "buffer" | "query" }>(
  ({ theme, value, colorWhenFull }) => ({
    height: 6,
    borderRadius: 6,
    [`&.${linearProgressClasses.colorPrimary}`]: {
      backgroundColor: theme.palette.grey[200],
      ...theme.applyStyles("dark", {
        backgroundColor: theme.palette.grey[800],
      }),
    },
    [`& .${linearProgressClasses.bar}`]: {
      borderRadius: 5,
      backgroundColor: value === 100 ? colorWhenFull : theme.palette.primary.main,
      ...theme.applyStyles("dark", {
        backgroundColor: value === 100 ? colorWhenFull : theme.palette.primary.main,
      }),
    },
  })
);

interface QuotaStatusProps {
  current: number;
  /** null = unlimited (no cap) — the bar stays empty */
  total: number | null;
  quotaLabel: string | ReactNode;
  titleLabel?: string;
  colorWhenFull?: string;
  alertMessage?: string;
  alertSeverity?: "error" | "warning" | "info" | "success";
}

export default function QuotaStatus({
  current,
  total,
  quotaLabel,
  titleLabel,
  colorWhenFull = "red",
  alertMessage,
  alertSeverity = "info",
}: QuotaStatusProps) {
  const progressValue = total == null || total <= 0 ? 0 : Math.min(100, (current / total) * 100);

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between">
        {titleLabel && (
          <Typography variant="body2" fontWeight="bold">
            {titleLabel}
          </Typography>
        )}
        <Typography variant="body2" fontWeight="bold">
          {quotaLabel}
        </Typography>
      </Stack>
      <BorderLinearProgress variant="determinate" value={progressValue} colorWhenFull={colorWhenFull} />
      {alertMessage && (
        <Alert severity={alertSeverity} sx={{ mt: 5 }}>
          {alertMessage}
        </Alert>
      )}
    </Stack>
  );
}

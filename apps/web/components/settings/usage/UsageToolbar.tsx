"use client";

import CheckIcon from "@mui/icons-material/Check";
import {
  Box,
  Button,
  Divider,
  Menu,
  MenuItem,
  MenuList,
  Popover,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { visuallyHidden } from "@mui/utils";
import { type ReactNode, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import {
  FIRST_USAGE_DAY,
  type RangePreset,
  type UsageRange,
  customRange,
  presetsFor,
  rangeLabel,
  rangeSpan,
  utcToday,
} from "@/lib/utils/usageRange";

import { accentText } from "@/components/assistant/styles";
import ToolPill from "@/components/dashboard/common/ToolPill";
import UserAvatar from "@/components/dashboard/common/UserAvatar";
import TextFieldInput from "@/components/map/panels/common/TextFieldInput";

/** The heading of a group of options in a pill's popover. */
const GroupLabel = ({ children }: { children: ReactNode }) => (
  <Typography
    component="div"
    sx={{
      px: 4,
      pt: 2.5,
      pb: 1,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: "0.5px",
      textTransform: "uppercase",
      color: "text.secondary",
    }}>
    {children}
  </Typography>
);

/** One option of a pill's menu: its label (with what is before it and a line
 * below), and a check on the one in force. */
const OptionContent = ({
  label,
  sub,
  lead,
  selected,
}: {
  label: string;
  sub?: string | null;
  lead?: ReactNode;
  selected: boolean;
}) => (
  <Stack direction="row" alignItems="center" spacing={2.5} sx={{ width: "100%", minWidth: 0 }}>
    {lead}
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography
        variant="body2"
        noWrap
        sx={{ fontWeight: selected ? 600 : 500 }}
        color={selected ? "primary" : "text.primary"}>
        {label}
      </Typography>
      {sub && (
        <Typography variant="caption" component="div" color="text.secondary" noWrap>
          {sub}
        </Typography>
      )}
    </Box>
    {selected && <CheckIcon sx={{ fontSize: 14 }} color="primary" />}
  </Stack>
);

/**
 * The date range of a usage detail: the presets (a trial has no last period
 * and no longer ranges; without a known period there is no last one either),
 * each with the days it covers where they are known, and two date fields for
 * a range of one's own, from 2020 up to today. The pill names the range in
 * force and fills while it is not this period.
 */
export const DateRangePill = ({
  value,
  onChange,
  onTrial,
  hasPeriod,
  periodStart,
  disabled,
  disabledHint,
}: {
  value: UsageRange;
  onChange: (range: UsageRange) => void;
  onTrial: boolean;
  /** The balance knows where the current period began (`period_start`). */
  hasPeriod: boolean;
  /** The balance's `period_start`: this period and the last one name their
   * days from it. */
  periodStart?: string | null;
  /** The list below does not follow the range (whole periods); `disabledHint`
   * says why: on hover, and to assistive tech as the pill's description. */
  disabled?: boolean;
  disabledHint?: string;
}) => {
  const { t, i18n } = useTranslation("common");
  const language = i18n.language;
  const anchor = useRef<HTMLButtonElement | null>(null);
  const hintId = useId();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const presets = presetsFor(onTrial).filter((preset) => preset !== "last" || hasPeriod);
  const label = rangeLabel(value, t, language, onTrial);
  // The periods name their days from the period's start, and without one stay
  // unnamed; the day ranges count back from today.
  const period = { period_start: periodStart ?? null, credits_reset_at: null, on_trial: onTrial };
  // The days a date field offers (UTC days, as the ledger's); a day typed
  // past them is moved to the nearest one on Apply (customRange).
  const dayBounds = { min: FIRST_USAGE_DAY, max: utcToday() };

  const openPopover = () => {
    setFrom(value.preset === "custom" ? (value.from ?? "") : "");
    setTo(value.preset === "custom" ? (value.to ?? "") : "");
    setOpen(true);
  };
  const choose = (preset: RangePreset) => {
    onChange({ preset });
    setOpen(false);
  };

  const pill = (
    <ToolPill
      ref={anchor}
      icon={ICON_NAME.CALENDAR}
      label={label}
      chevron
      active={!disabled && (open || value.preset !== "period")}
      disabled={disabled}
      describedBy={disabled && disabledHint ? hintId : undefined}
      onClick={openPopover}
    />
  );

  return (
    <>
      {disabled && disabledHint ? (
        <>
          {/* A disabled button gets no pointer events: the tooltip listens on
              a wrapper. It cannot take focus either, so the reason is also
              its description. */}
          <Tooltip title={disabledHint}>
            <Box component="span" sx={{ display: "inline-flex" }}>
              {pill}
            </Box>
          </Tooltip>
          <Box component="span" id={hintId} sx={visuallyHidden}>
            {disabledHint}
          </Box>
        </>
      ) : (
        pill
      )}
      <Popover
        anchorEl={anchor.current}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        slotProps={{
          paper: {
            elevation: 8,
            role: "dialog",
            "aria-label": label,
            sx: { minWidth: 320, maxWidth: "calc(100vw - 32px)", mt: 1.5 },
          },
        }}>
        <GroupLabel>{t("usage_period")}</GroupLabel>
        <MenuList sx={{ pt: 0 }}>
          {presets.map((preset) => {
            const selected = value.preset === preset;
            return (
              <MenuItem key={preset} selected={selected} onClick={() => choose(preset)}>
                <OptionContent
                  label={rangeLabel({ preset }, t, language, onTrial)}
                  sub={rangeSpan({ preset }, period, t, language)}
                  selected={selected}
                />
              </MenuItem>
            );
          })}
        </MenuList>
        <Divider />
        <GroupLabel>{t("usage_range_custom")}</GroupLabel>
        <Stack spacing={3.5} sx={{ px: 4, pt: 1.5, pb: 3.5 }}>
          <Stack direction="row" spacing={2.5}>
            <TextFieldInput
              type="date"
              label={t("usage_from")}
              value={from}
              onChange={setFrom}
              clearable={false}
              inputProps={{ "aria-label": t("usage_from"), ...dayBounds }}
            />
            <TextFieldInput
              type="date"
              label={t("usage_to")}
              value={to}
              onChange={setTo}
              clearable={false}
              inputProps={{ "aria-label": t("usage_to"), ...dayBounds }}
            />
          </Stack>
          <Stack direction="row" justifyContent="flex-end" spacing={2}>
            <Button variant="text" size="small" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="contained"
              size="small"
              disabled={!from || !to}
              onClick={() => {
                // The days the pill names are the days the list and the export read.
                onChange(customRange(from, to));
                setOpen(false);
              }}>
              {t("apply")}
            </Button>
          </Stack>
        </Stack>
      </Popover>
    </>
  );
};

export interface MemberOption {
  id: string;
  name: string;
  /** A line below the name ("590 credits"). */
  sub?: string;
}

/**
 * Narrows a usage detail to one member: everyone first, then each option with
 * its avatar. `allLabel` names everyone ("All owners" where the options are
 * owners).
 */
export const MemberPill = ({
  value,
  options,
  onChange,
  allLabel,
  valueLabel,
}: {
  value: string | null;
  options: MemberOption[];
  onChange: (id: string | null) => void;
  allLabel?: string;
  /** Names the chosen member where `options` lacks them (no usage in the
   * range picked since); empty while their name loads. */
  valueLabel?: string;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const everyone = allLabel ?? t("all_members");
  const chosen = options.find((option) => option.id === value);
  const label = chosen?.name ?? (value !== null && valueLabel !== undefined ? valueLabel : everyone);
  const choose = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <>
      <ToolPill
        ref={anchor}
        icon={ICON_NAME.USER}
        label={label}
        // While the chosen member's name loads the pill shows none; it is
        // still the member filter.
        ariaLabel={label ? undefined : t("member")}
        chevron
        active={open || value !== null}
        onClick={() => setOpen(true)}
      />
      <Menu
        anchorEl={anchor.current}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        slotProps={{ paper: { sx: { minWidth: 260, maxWidth: "calc(100vw - 32px)", mt: 1.5 } } }}>
        <MenuItem selected={value === null} onClick={() => choose(null)}>
          <OptionContent
            label={everyone}
            selected={value === null}
            lead={
              <Icon
                iconName={ICON_NAME.USER}
                style={{ fontSize: 13 }}
                htmlColor={value === null ? accentText(theme) : theme.palette.text.secondary}
              />
            }
          />
        </MenuItem>
        {options.map((option) => (
          <MenuItem key={option.id} selected={option.id === value} onClick={() => choose(option.id)}>
            <OptionContent
              label={option.name}
              sub={option.sub}
              selected={option.id === value}
              lead={<UserAvatar id={option.id} name={option.name} size={22} />}
            />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
};

/** Saves a detail's rows as CSV; the pill waits while the file is made, and a
 * failed export says so. */
export const ExportPill = ({ onExport }: { onExport: () => Promise<void> }) => {
  const { t } = useTranslation("common");
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    try {
      await onExport();
    } catch {
      toast.error(t("usage_export_failed"));
    } finally {
      setRunning(false);
    }
  };
  return (
    <ToolPill
      icon={ICON_NAME.DOWNLOAD}
      label={t("usage_export_csv")}
      disabled={running}
      onClick={() => void run()}
    />
  );
};

/** The row a detail's search and pills sit in; it wraps on a narrow screen. */
export const UsageToolbar = ({ children }: { children: ReactNode }) => (
  <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" }}>{children}</Box>
);

import {
  Box,
  ClickAwayListener,
  Fade,
  Popper,
  Stack,
  Switch,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import { useTranslation } from "react-i18next";

import { formatFieldValue } from "@/lib/utils/formatFieldValue";
import type { AttributeFormatConfig } from "@/lib/validations/layer";

import type { SelectorItem } from "@/types/map/common";

import Selector from "@/components/map/panels/common/Selector";
import TextFieldInput from "@/components/map/panels/common/TextFieldInput";

/** A control's name above it: the panels' caption in the secondary text color. */
function MiniLabel({ children }: { children: string }) {
  return (
    <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
      {children}
    </Typography>
  );
}

// Same ladder the layer-schema FieldEditor exposes, so the format panel
// speaks the same vocabulary across the app.
const DECIMALS_OPTIONS: ("auto" | number)[] = ["auto", 0, 1, 2, 3, 4, 5];

// Two preview values picked to illustrate both ends of the formatting
// spectrum — a value large enough to exercise thousands separators and
// abbreviation, plus a fractional value where decimals matter.
const PREVIEW_VALUES = [1234567.891, 12.345];

interface FieldFormatPopoverProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  config: AttributeFormatConfig | undefined;
  prefix: string | undefined;
  suffix: string | undefined;
  onChange: (next: {
    format_config?: AttributeFormatConfig;
    prefix?: string;
    suffix?: string;
  }) => void;
  onClose: () => void;
  /** Optional concrete sample value pulled from a real feature on the map. */
  sampleValue?: number | null;
}

export function FieldFormatPopover({
  open,
  anchorEl,
  config,
  prefix,
  suffix,
  onChange,
  onClose,
  sampleValue,
}: FieldFormatPopoverProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const cfg: AttributeFormatConfig = config ?? {};

  const update = (partial: Partial<AttributeFormatConfig>) => {
    const next = { ...cfg, ...partial };
    // Strip undefined keys so the stored config stays minimal — and so
    // the downstream "do we have any config?" check is honest.
    for (const k of Object.keys(next) as Array<keyof AttributeFormatConfig>) {
      if (next[k] === undefined) delete next[k];
    }
    onChange({ format_config: Object.keys(next).length > 0 ? next : undefined });
  };

  const decimalsItems: SelectorItem[] = DECIMALS_OPTIONS.map((o) => ({
    value: String(o),
    label: o === "auto" ? t("auto") : String(o),
  }));
  const selectedDecimals =
    decimalsItems.find((i) => i.value === String(cfg.decimals ?? "auto")) ?? decimalsItems[0];

  // Use the row's real sample first, then the canned ladder. Real value
  // makes the preview easier to reason about ("how will this row look"),
  // the ladder reinforces formatting behavior across magnitudes.
  const previewValues = [
    ...(sampleValue != null && !Number.isNaN(sampleValue) ? [sampleValue] : []),
    ...PREVIEW_VALUES,
  ];

  const renderPreview = (v: number) => {
    let s = formatFieldValue(v, "number", cfg);
    if (prefix || suffix) s = `${prefix ?? ""}${s}${suffix ?? ""}`;
    return s;
  };

  return (
    <Popper
      open={open}
      anchorEl={anchorEl}
      placement="left-start"
      modifiers={[
        // Anchor is the row's "123" button inside the block-edit popper;
        // place this popover to the left so it floats out over the map
        // canvas instead of covering the other attribute rows.
        { name: "offset", options: { offset: [0, 12] } },
        { name: "flip", enabled: true, options: { fallbackPlacements: ["right-start", "bottom-end"] } },
        { name: "preventOverflow", enabled: true, options: { padding: 8 } },
      ]}
      transition
      sx={{ zIndex: (themeArg) => themeArg.zIndex.modal + 1 }}>
      {({ TransitionProps }) => (
        <Fade {...TransitionProps} timeout={120}>
          <Box
            sx={{
              width: 300,
              bgcolor: "background.paper",
              border: 1,
              borderColor: "divider",
              borderRadius: 1.5,
              boxShadow: 8,
              overflow: "hidden",
            }}>
            <ClickAwayListener
              mouseEvent="onMouseDown"
              onClickAway={(e) => {
                // Don't close when clicks land on Select-portal menus
                // (decimals dropdown) — Popper-portaled menus fire
                // ClickAway against our root, so we whitelist the open
                // listbox role.
                const target = e.target as HTMLElement | null;
                if (target?.closest?.('[role="listbox"], [role="option"]')) return;
                onClose();
              }}>
              <Box>
                {/* Header bar — matches the small title used inside the
                    parent block-edit popper so the two surfaces feel like
                    the same family. */}
                <Stack
                  direction="row"
                  alignItems="center"
                  sx={{
                    px: 2,
                    py: 1.25,
                    borderBottom: 1,
                    borderColor: "divider",
                    bgcolor: alpha(theme.palette.text.primary, 0.02),
                  }}>
                  <Typography variant="body2" fontWeight="bold">
                    {t("format_number")}
                  </Typography>
                </Stack>

                <Stack spacing={2} sx={{ px: 2, py: 2 }}>
                  <Box>
                    <MiniLabel>{t("decimals")}</MiniLabel>
                    <Selector
                      items={decimalsItems}
                      selectedItems={selectedDecimals}
                      setSelectedItems={(item) => {
                        if (item && !Array.isArray(item)) {
                          update({
                            decimals: item.value === "auto" ? "auto" : Number(item.value),
                          });
                        }
                      }}
                    />
                  </Box>

                  <Stack spacing={0.75}>
                    <ToggleRow
                      label={t("show_thousands_separator")}
                      checked={cfg.thousands_separator ?? false}
                      onChange={(v) => update({ thousands_separator: v || undefined })}
                    />
                    <ToggleRow
                      label={t("abbreviate_large_numbers")}
                      checked={cfg.abbreviate ?? false}
                      onChange={(v) => update({ abbreviate: v || undefined })}
                    />
                    <ToggleRow
                      label={t("always_show_sign")}
                      checked={cfg.always_show_sign ?? false}
                      onChange={(v) => update({ always_show_sign: v || undefined })}
                    />
                  </Stack>

                  <Stack direction="row" spacing={1.25}>
                    <Box sx={{ flex: 1 }}>
                      <MiniLabel>{t("prefix")}</MiniLabel>
                      <TextFieldInput
                        placeholder="$"
                        clearable={false}
                        value={prefix ?? ""}
                        onChange={(v) => onChange({ prefix: v || undefined })}
                      />
                    </Box>
                    <Box sx={{ flex: 1 }}>
                      <MiniLabel>{t("suffix")}</MiniLabel>
                      <TextFieldInput
                        placeholder="kg"
                        clearable={false}
                        value={suffix ?? ""}
                        onChange={(v) => onChange({ suffix: v || undefined })}
                      />
                    </Box>
                  </Stack>

                  <Box>
                    <MiniLabel>{t("preview")}</MiniLabel>
                    <Stack
                      spacing={0}
                      sx={{
                        border: 1,
                        borderColor: "divider",
                        borderRadius: 1,
                        overflow: "hidden",
                      }}>
                      {previewValues.map((v, i) => (
                        <Box
                          key={`${v}-${i}`}
                          sx={{
                            px: 1.25,
                            py: 0.75,
                            fontFamily: "monospace",
                            fontSize: 12,
                            color: "text.primary",
                            borderBottom: i === previewValues.length - 1 ? 0 : 1,
                            borderColor: "divider",
                            bgcolor:
                              i === 0 && sampleValue != null
                                ? alpha(theme.palette.primary.main, 0.04)
                                : "transparent",
                          }}>
                          {renderPreview(v)}
                        </Box>
                      ))}
                    </Stack>
                  </Box>
                </Stack>
              </Box>
            </ClickAwayListener>
          </Box>
        </Fade>
      )}
    </Popper>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      sx={{ minHeight: 32 }}>
      <Typography variant="body2">{label}</Typography>
      <Switch size="small" checked={checked} onChange={(_, v) => onChange(v)} />
    </Stack>
  );
}

/**
 * The assumptions behind the Explorer's figures, in one dialog: cost rates per
 * operator and route type (board 15), the time periods headways and running
 * times are given for, and the layover that estimates vehicles where a feed
 * has no blocks. Edited as a draft; Save keeps them for this bundle in this
 * browser and every figure follows.
 */
import { Box, InputAdornment, Stack, Tab, Tabs, TextField, Typography } from "@mui/material";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { clock, count, currencySymbol } from "@/lib/explorer/format";
import { type ModeKey, modeOf } from "@/lib/explorer/modes";
import {
  type ExplorerSettings,
  PERIOD_KEYS,
  SERVICE_DAY_END_S,
  allCurrencies,
  defaultRate,
  modeRate,
  periodsFrom,
  rateKey,
  rateKeyMode,
  ratesByKind,
  settingsProblems,
} from "@/lib/explorer/settings";
import { type ExplorerSettingsTab, openExplorerSettings } from "@/lib/store/explorer/slice";

import { useRoutes, useServiceDays } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { useExplorer } from "@/components/explorer/ExplorerContext";
import { modeIcon } from "@/components/explorer/modeIcon";
import Selector from "@/components/map/panels/common/Selector";

/** A number field's text, so it can be blank or half-typed while edited. */
type RateDraft = Record<string, { km: string; hour: string }>;

interface Draft {
  currency: string;
  rates: RateDraft;
  /** The periods' starts after the first, as `HH:MM`. */
  starts: string[];
  layover_min: string;
}

/** Every field's width: one right edge down a card. */
const FIELD_WIDTH = 112;

/** A card on the dialog's tinted ground, rows split by hairlines: as the
 * route summary's headways table. */
function Card({ children }: { children: ReactNode }) {
  return <Box sx={{ bgcolor: "action.hover", borderRadius: 1.5, px: 1.5 }}>{children}</Box>;
}

function Row({ first, children }: { first: boolean; children: ReactNode }) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.5}
      sx={{ minHeight: 52, py: 1.25, borderTop: first ? 0 : 1, borderColor: "divider" }}>
      {children}
    </Stack>
  );
}

/** A row's name, with a quiet line under it. */
function RowLabel({ icon, label, note }: { icon?: ReactNode; label: string; note?: string }) {
  return (
    <Stack direction="row" spacing={1.25} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
      {icon && <Box sx={{ display: "flex", color: "text.secondary", flexShrink: 0 }}>{icon}</Box>}
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" fontWeight={600} noWrap>
          {label}
        </Typography>
        {note && (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ lineHeight: 1.4 }}>
            {note}
          </Typography>
        )}
      </Box>
    </Stack>
  );
}

/** A compact number field on white, its unit inside it at the right. */
function UnitField({
  value,
  onChange,
  unit,
  label,
  placeholder,
  error,
  disabled,
  numeric = "decimal",
}: {
  value: string;
  onChange?: (value: string) => void;
  unit?: string;
  label: string;
  placeholder?: string;
  error?: boolean;
  disabled?: boolean;
  numeric?: "decimal" | "numeric" | "text";
}) {
  // A value that is not the user's to set: plain text, on the fields' line.
  if (disabled)
    return (
      <Typography
        variant="body2"
        color="text.secondary"
        aria-label={label}
        sx={{
          width: FIELD_WIDTH,
          flexShrink: 0,
          textAlign: "right",
          pr: "11px",
          fontSize: "0.8125rem",
          fontVariantNumeric: "tabular-nums",
        }}>
        {value}
      </Typography>
    );
  return (
    <TextField
      size="small"
      value={value}
      placeholder={placeholder}
      error={error}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
      inputProps={{ "aria-label": label, inputMode: numeric }}
      InputProps={
        unit
          ? {
              endAdornment: (
                <InputAdornment position="end">
                  <Typography variant="caption" color="text.secondary">
                    {unit}
                  </Typography>
                </InputAdornment>
              ),
            }
          : undefined
      }
      sx={{
        width: FIELD_WIDTH,
        flexShrink: 0,
        "& .MuiOutlinedInput-root": {
          height: 32,
          pr: unit ? 1.25 : 0,
          borderRadius: 1,
          bgcolor: "background.paper",
          fontSize: "0.8125rem",
        },
        "& .MuiInputBase-input": {
          px: 1.25,
          py: 0,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        },
        "& .MuiInputAdornment-root": { ml: 0.5 },
      }}
    />
  );
}

/** `HH:MM` as seconds; hours may pass 24, as a feed's times do. */
function parseClock(text: string): number | null {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(text.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : null;
}

/** The tabs' shared height: the time periods' six rows and their note. */
const TAB_HEIGHT = 380;

function toDraft(settings: ExplorerSettings): Draft {
  const rates: RateDraft = {};
  for (const [key, r] of Object.entries(ratesByKind(settings.rates)))
    rates[key] = { km: String(r.per_km), hour: r.per_hour === null ? "" : String(r.per_hour) };
  return {
    currency: settings.currency,
    rates,
    starts: settings.periods.slice(1).map((p) => clock(p.start_s)),
    layover_min: String(Math.round(settings.layover_s / 60)),
  };
}

/** The draft as settings, or null where a field does not parse. */
function fromDraft(draft: Draft, base: ExplorerSettings): ExplorerSettings | null {
  const rates: ExplorerSettings["rates"] = {};
  for (const [key, r] of Object.entries(draft.rates)) {
    // Both blank is no rate: the kind keeps its default. An hour rate alone
    // keeps the default km rate beside it, which the km field shows.
    if (!r.km.trim() && !r.hour.trim()) continue;
    const per_km = r.km.trim() ? Number(r.km.replace(",", ".")) : modeRate(rateKeyMode(key)).per_km;
    const per_hour = r.hour.trim() ? Number(r.hour.replace(",", ".")) : null;
    if (Number.isNaN(per_km) || (per_hour !== null && Number.isNaN(per_hour))) return null;
    rates[key] = { per_km, per_hour };
  }
  const starts = draft.starts.map(parseClock);
  const layover = Number(draft.layover_min);
  if (starts.some((s) => s === null) || Number.isNaN(layover)) return null;
  return {
    ...base,
    currency: draft.currency,
    rates,
    periods: periodsFrom(starts as number[]),
    layover_s: Math.round(layover * 60),
  };
}

function RatesTab({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const { t, i18n } = useTranslation("common");
  const { db, window } = useExplorer();
  const routes = useRoutes(db);
  const days = useServiceDays(db, window);
  const lang = i18n.language;
  const symbol = currencySymbol(draft.currency, lang);
  // Every currency, by its code and its name in the reader's language.
  const currencyItems = useMemo(() => {
    const names = new Intl.DisplayNames([lang], { type: "currency" });
    return allCurrencies().map((c) => ({ value: c, label: `${c} · ${names.of(c) ?? c}` }));
  }, [lang]);

  // The operators, each with the route types it runs and how many routes.
  const agencies = useMemo(() => {
    const byAgency = new Map<
      string,
      { id: string | null; name: string; types: Map<number | null, number>; n: number }
    >();
    for (const r of routes.data ?? []) {
      const id = r.agency_id;
      const key = id ?? "";
      const a = byAgency.get(key) ?? {
        id,
        name: r.agency ?? t("explorer_unknown_agency"),
        types: new Map(),
        n: 0,
      };
      a.types.set(r.route_type, (a.types.get(r.route_type) ?? 0) + 1);
      a.n += 1;
      byAgency.set(key, a);
    }
    return [...byAgency.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }, [routes.data, t]);
  const [agencyKey, setAgencyKey] = useState<string | null>(null);
  const agency = agencies.find((a) => (a.id ?? "") === agencyKey) ?? agencies[0];

  const hasRates = (agencyId: string | null) =>
    Object.entries(draft.rates).some(
      ([key, r]) => key.startsWith(`${agencyId ?? ""}|`) && (r.km.trim() !== "" || r.hour.trim() !== "")
    );
  // One row per kind of vehicle the operator runs (bus, tram, …), however
  // many route types the feed gives it: its routes counted together.
  const kinds = useMemo(() => {
    const byMode = new Map<ModeKey, { type: number | null; n: number }>();
    for (const [type, n] of agency?.types ?? []) {
      const mode = modeOf(type);
      const k = byMode.get(mode);
      byMode.set(mode, { type: k && (k.type ?? 0) <= (type ?? 0) ? k.type : type, n: (k?.n ?? 0) + n });
    }
    return [...byMode.entries()].sort((a, b) => (a[1].type ?? 0) - (b[1].type ?? 0));
  }, [agency]);
  const setRate = (key: string, field: "km" | "hour", value: string) => {
    const current = draft.rates[key] ?? { km: "", hour: "" };
    setDraft({ ...draft, rates: { ...draft.rates, [key]: { ...current, [field]: value } } });
  };

  return (
    <Stack spacing={2}>
      {/* A feed may have one operator or fifty: a searchable list, as the
          toolbox picks from many. Operators with rates set say so. Beside
          it, the currency every rate is in. */}
      <Stack direction="row" spacing={1.5} alignItems="flex-end">
        {agencies.length > 1 && (
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Selector
              label={t("explorer_filter_agency")}
              enableSearch={agencies.length > 8}
              items={agencies.map((a) => ({
                value: a.id ?? "",
                label: `${a.name} · ${t("explorer_n_routes", { count: a.n })}${
                  hasRates(a.id) ? ` · ${t("explorer_rates_set")}` : ""
                }`,
              }))}
              selectedItems={
                agency
                  ? {
                      value: agency.id ?? "",
                      label: `${agency.name} · ${t("explorer_n_routes", { count: agency.n })}`,
                    }
                  : undefined
              }
              setSelectedItems={(item) => {
                if (item && !Array.isArray(item)) setAgencyKey(String(item.value));
              }}
            />
          </Box>
        )}
        <Box sx={{ width: agencies.length > 1 ? 112 : 160, flexShrink: 0 }}>
          <Selector
            label={t("explorer_currency")}
            items={currencyItems}
            enableSearch
            selectedItems={{ value: draft.currency, label: draft.currency }}
            setSelectedItems={(item) => {
              if (item && !Array.isArray(item)) setDraft({ ...draft, currency: String(item.value) });
            }}
          />
        </Box>
      </Stack>
      {agency && (
        <Card>
          {kinds.map(([mode, { type, n }], i) => {
            const key = rateKey(agency.id, type);
            const value = draft.rates[key] ?? { km: "", hour: "" };
            return (
              <Row key={key} first={i === 0}>
                <RowLabel
                  icon={<Icon iconName={modeIcon(mode)} style={{ fontSize: 14 }} htmlColor="inherit" />}
                  label={t(`explorer_mode_${mode}`)}
                  note={t("explorer_n_routes", { count: n })}
                />
                <UnitField
                  value={value.km}
                  // The default shows where none is set: what applies now.
                  placeholder={String(defaultRate(type).per_km)}
                  unit={t("explorer_rate_km_head", { currency: symbol })}
                  label={t("explorer_rate_km_head", { currency: symbol })}
                  onChange={(v) => setRate(key, "km", v)}
                />
                <UnitField
                  value={value.hour}
                  placeholder="—"
                  unit={t("explorer_rate_hour_head", { currency: symbol })}
                  label={t("explorer_rate_hour_head", { currency: symbol })}
                  onChange={(v) => setRate(key, "hour", v)}
                />
              </Row>
            );
          })}
        </Card>
      )}
      <Typography variant="caption" color="text.secondary">
        {t("explorer_rates_note")}
        {days.data &&
          ` ${t("explorer_rates_days_counted", {
            days: count(days.data.weekdays + days.data.saturdays + days.data.sundays, lang),
          })}`}
      </Typography>
    </Stack>
  );
}

function PeriodsTab({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const { t } = useTranslation("common");
  // Each period is set by when it ends; it starts where the one before ends.
  // The draft keeps the boundaries between periods, the ends of all but the
  // last, which ends with the service day.
  const ends = draft.starts;
  return (
    <Stack spacing={1.5}>
      <Card>
        {PERIOD_KEYS.map((key, i) => {
          const start = i === 0 ? "00:00" : ends[i - 1];
          const last = i === PERIOD_KEYS.length - 1;
          return (
            <Row key={key} first={i === 0}>
              <RowLabel label={t(`explorer_period_${key}`)} />
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ width: 56, flexShrink: 0, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {start} –
              </Typography>
              <UnitField
                value={last ? clock(SERVICE_DAY_END_S) : ends[i]}
                disabled={last}
                numeric="text"
                label={t(`explorer_period_${key}`)}
                error={!last && parseClock(ends[i]) === null}
                onChange={(v) => {
                  const next = [...ends];
                  next[i] = v;
                  setDraft({ ...draft, starts: next });
                }}
              />
            </Row>
          );
        })}
      </Card>
      <Typography variant="caption" color="text.secondary">
        {t("explorer_periods_note")}
      </Typography>
    </Stack>
  );
}

function VehiclesTab({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const { t } = useTranslation("common");
  return (
    <Card>
      <Row first>
        <RowLabel label={t("explorer_layover")} note={t("explorer_layover_note")} />
        <UnitField
          value={draft.layover_min}
          numeric="numeric"
          unit={t("explorer_minutes_short")}
          label={t("explorer_layover")}
          onChange={(v) => setDraft({ ...draft, layover_min: v })}
        />
      </Row>
    </Card>
  );
}

export function ExplorerSettingsDialog() {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const tab = useAppSelector((s) => s.explorer.settingsTab);
  const { settings, setSettings } = useExplorer();
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings));
  const [saveFailed, setSaveFailed] = useState(false);

  // Each opening starts from what is saved.
  useEffect(() => {
    if (tab) {
      setDraft(toDraft(settings));
      setSaveFailed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab !== null]);

  const next = fromDraft(draft, settings);
  const problems = next ? settingsProblems(next) : ["explorer_settings_invalid"];
  const close = () => dispatch(openExplorerSettings(null));

  return (
    <AppDialog
      open={tab !== null}
      onClose={close}
      icon={ICON_NAME.SLIDERS}
      title={t("explorer_settings")}
      maxWidth={600}
      notice={
        problems.length || saveFailed ? (
          <Typography variant="body2" color="error">
            {saveFailed ? t("explorer_settings_not_kept") : t(problems[0])}
          </Typography>
        ) : undefined
      }
      footer={
        <AppDialogFooter
          onCancel={close}
          primaryLabel={t("save")}
          primaryDisabled={problems.length > 0}
          onPrimary={() => {
            if (!next) return;
            if (setSettings(next)) close();
            else setSaveFailed(true);
          }}
          extra={
            <Typography variant="caption" color="text.secondary">
              {t("explorer_settings_where")}
            </Typography>
          }
        />
      }>
      <Tabs
        value={tab ?? "rates"}
        onChange={(_e, value: ExplorerSettingsTab) => dispatch(openExplorerSettings(value))}
        sx={{ minHeight: 36, mb: 2, borderBottom: 1, borderColor: "divider" }}>
        <Tab value="rates" label={t("explorer_cost_rates")} sx={{ minHeight: 36, textTransform: "none" }} />
        <Tab
          value="periods"
          label={t("explorer_time_periods")}
          sx={{ minHeight: 36, textTransform: "none" }}
        />
        <Tab value="vehicles" label={t("explorer_vehicles")} sx={{ minHeight: 36, textTransform: "none" }} />
      </Tabs>
      {/* One height for every tab, scrolling within it: the dialog does not
          grow or shrink under the pointer as the tabs change, where a click
          meant for it could land outside and close it. */}
      <Box sx={{ height: TAB_HEIGHT, overflowY: "auto" }}>
        {tab === "rates" && <RatesTab draft={draft} setDraft={setDraft} />}
        {tab === "periods" && <PeriodsTab draft={draft} setDraft={setDraft} />}
        {tab === "vehicles" && <VehiclesTab draft={draft} setDraft={setDraft} />}
      </Box>
    </AppDialog>
  );
}

/**
 * A trip's edits, each in its dialog, opened from the trip's actions (its
 * bar, its menu) (decided 26 Nov 2026):
 *
 * - Shift (4.4): every time of the trip earlier or later by the minutes
 *   typed; a stop with no time stays untimed;
 * - Duplicate (4.3): a copy of the trip leaving at the time typed, its
 *   running times as the trip's;
 * - Edit times (5.1): its stop times as the feed has them (a frequency-based
 *   trip's, its template's), each changed in place; the stops after the last
 *   one changed move with it unless told not to. Delete trip, in red at the
 *   left of the footer, goes to the Apply bar's delete card.
 *
 * Preview hands the edit to the Apply bar, where every edit ends.
 */
import { Box, Button, Checkbox, FormControlLabel, Stack, TextField, Typography } from "@mui/material";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { StopTimeInput } from "@/lib/explorer/edit/ops/trips";
import { clock, timeOf } from "@/lib/explorer/format";
import { setEditDialog, setEditDraft } from "@/lib/store/explorer/slice";

import { useTripCalls } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { useExplorer } from "@/components/explorer/ExplorerContext";
import { CHECKBOX_SX, ICON_GAP } from "@/components/explorer/SectionHeader";

/** A time as the fields show it: with its seconds only where it has some. */
function timeText(s: number | null): string {
  if (s === null) return "";
  return s % 60 ? `${clock(s)}:${String(s % 60).padStart(2, "0")}` : clock(s);
}

const TIME_FIELD = {
  width: 96,
  "& .MuiInputBase-input": { textAlign: "right", fontVariantNumeric: "tabular-nums" },
};

export function TripDialogs() {
  const dialog = useAppSelector((s) => s.explorer.edit.dialog);
  if (dialog?.kind === "trip-shift") return <ShiftDialog trip_idx={dialog.trip_idx} />;
  if (dialog?.kind === "trip-duplicate")
    return <DuplicateDialog trip_idx={dialog.trip_idx} dep_s={dialog.dep_s} />;
  if (dialog?.kind === "trip-times") return <TimesDialog trip_idx={dialog.trip_idx} />;
  return null;
}

/** A trip dialog's frame: Cancel, and Preview once something is set. */
function TripDialog({
  title,
  icon,
  ready,
  onPreview,
  extra,
  wide = false,
  children,
}: {
  title: string;
  icon: ICON_NAME;
  ready: boolean;
  onPreview: () => void;
  extra?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const close = () => dispatch(setEditDialog(null));
  return (
    <AppDialog
      open
      onClose={close}
      icon={icon}
      title={title}
      maxWidth={wide ? 560 : 440}
      footer={
        <AppDialogFooter
          extra={extra}
          cancelLabel={t("cancel")}
          onCancel={close}
          primaryLabel={t("explorer_preview")}
          primaryDisabled={!ready}
          onPrimary={() => {
            onPreview();
            close();
          }}
        />
      }>
      {children}
    </AppDialog>
  );
}

function ShiftDialog({ trip_idx }: { trip_idx: number }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const draft = useAppSelector((s) => s.explorer.edit.draft);
  const before = draft?.kind === "trip-shift" && draft.trip_idxs.includes(trip_idx) ? draft : null;
  const [text, setText] = useState(
    before ? `${before.by_s > 0 ? "+" : ""}${Math.round(before.by_s / 60)}` : ""
  );
  const minutes = /^[+-]?\d+$/.test(text.trim()) ? Number(text.trim()) : null;
  const bad = !!text.trim() && (minutes === null || minutes === 0);
  return (
    <TripDialog
      title={t("explorer_trip_shift_title")}
      icon={ICON_NAME.CLOCK}
      ready={minutes !== null && minutes !== 0}
      onPreview={() =>
        minutes && dispatch(setEditDraft({ kind: "trip-shift", trip_idxs: [trip_idx], by_s: minutes * 60 }))
      }>
      <Stack direction="row" alignItems="center" spacing={2}>
        <Typography variant="body2" fontWeight={600} sx={{ flex: 1 }}>
          {t("explorer_trip_shift_by")}
        </Typography>
        <TextField
          size="small"
          autoFocus
          value={text}
          placeholder="+5"
          error={bad}
          onChange={(e) => setText(e.target.value)}
          inputProps={{ "aria-label": t("explorer_trip_shift_by"), inputMode: "numeric" }}
          InputProps={{
            endAdornment: (
              <Typography variant="caption" color="text.secondary" sx={{ pl: 0.5 }}>
                {t("explorer_minutes_short")}
              </Typography>
            ),
          }}
          sx={TIME_FIELD}
        />
      </Stack>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>
        {t("explorer_trip_shift_note")}
      </Typography>
    </TripDialog>
  );
}

function DuplicateDialog({ trip_idx, dep_s }: { trip_idx: number; dep_s: number }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const draft = useAppSelector((s) => s.explorer.edit.draft);
  const before = draft?.kind === "trip-duplicate" && draft.trip_idx === trip_idx ? draft : null;
  const [text, setText] = useState(before ? timeText(before.dep_s) : "");
  const at = timeOf(text);
  const bad = !!text.trim() && at === null;
  return (
    <TripDialog
      title={t("explorer_trip_duplicate_title")}
      icon={ICON_NAME.COPY}
      ready={at !== null && at !== dep_s}
      onPreview={() =>
        at !== null && dispatch(setEditDraft({ kind: "trip-duplicate", trip_idx, dep_s: at }))
      }>
      <Stack direction="row" alignItems="center" spacing={2}>
        <Typography variant="body2" fontWeight={600} sx={{ flex: 1 }}>
          {t("explorer_trip_duplicate_at")}
        </Typography>
        <TextField
          size="small"
          autoFocus
          value={text}
          placeholder={clock(dep_s)}
          error={bad}
          onChange={(e) => setText(e.target.value)}
          inputProps={{ "aria-label": t("explorer_trip_duplicate_at") }}
          sx={TIME_FIELD}
        />
      </Stack>
      <Typography variant="caption" color={bad ? "error" : "text.secondary"} display="block" sx={{ mt: 1.5 }}>
        {bad ? t("explorer_service_time_hint") : t("explorer_trip_duplicate_note")}
      </Typography>
    </TripDialog>
  );
}

function TimesDialog({ trip_idx }: { trip_idx: number }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { db } = useExplorer();
  const calls = useTripCalls(db, trip_idx).data;
  const draft = useAppSelector((s) => s.explorer.edit.draft);
  const before = draft?.kind === "trip-times" && draft.trip_idx === trip_idx ? draft : null;
  // What was typed, by stop_sequence and field; untouched fields show the
  // feed's time.
  const [typed, setTyped] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (before?.times ?? []).flatMap((x) => [
        [`${x.stop_sequence}:a`, timeText(x.arrival_s)],
        [`${x.stop_sequence}:d`, timeText(x.departure_s)],
      ])
    )
  );
  const [follow, setFollow] = useState(before?.follow ?? true);
  const { times, bad } = useMemo(() => {
    const out: StopTimeInput[] = [];
    let wrong = false;
    for (const c of calls ?? []) {
      const field = (k: "a" | "d", was: number | null) => {
        const text = typed[`${c.stop_sequence}:${k}`];
        if (text === undefined) return was;
        if (!text.trim()) return null;
        const s = timeOf(text);
        if (s === null) wrong = true;
        return s ?? was;
      };
      const a = field("a", c.arrival_s);
      const d = field("d", c.departure_s);
      if (a !== c.arrival_s || d !== c.departure_s)
        out.push({ stop_sequence: c.stop_sequence, arrival_s: a, departure_s: d });
    }
    return { times: out, bad: wrong };
  }, [calls, typed]);

  return (
    <TripDialog
      title={t("explorer_trip_times_title")}
      icon={ICON_NAME.EDIT}
      wide
      ready={times.length > 0 && !bad}
      onPreview={() => dispatch(setEditDraft({ kind: "trip-times", trip_idx, times, follow }))}
      extra={
        <Button
          color="error"
          onClick={() => {
            dispatch(setEditDraft({ kind: "trip-delete", trip_idxs: [trip_idx] }));
            dispatch(setEditDialog(null));
          }}>
          <Typography variant="body2" fontWeight="bold" color="inherit">
            {t("explorer_delete_trip", { count: 1 })}
          </Typography>
        </Button>
      }>
      {!calls ? (
        <Typography variant="body2" color="text.secondary">
          {t("explorer_calculating")}
        </Typography>
      ) : (
        <>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) auto auto",
              columnGap: 2,
              alignItems: "center",
              maxHeight: 360,
              overflowY: "auto",
            }}>
            {[t("explorer_stop"), t("explorer_arrival"), t("explorer_departure")].map((h, i) => (
              <Typography
                key={h}
                variant="caption"
                color="text.secondary"
                fontWeight={600}
                sx={{
                  py: 1,
                  textAlign: i ? "right" : "left",
                  position: "sticky",
                  top: 0,
                  bgcolor: "background.paper",
                }}>
                {h}
              </Typography>
            ))}
            {calls.map((c) => {
              const rule = { borderTop: 1, borderColor: "divider", py: 0.5, alignSelf: "stretch" };
              const field = (k: "a" | "d", was: number | null) => {
                const key = `${c.stop_sequence}:${k}`;
                const text = typed[key] ?? timeText(was);
                return (
                  <Box sx={{ ...rule, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                    <TextField
                      size="small"
                      value={text}
                      placeholder="–"
                      error={!!text.trim() && timeOf(text) === null}
                      onChange={(e) => setTyped((s) => ({ ...s, [key]: e.target.value }))}
                      inputProps={{
                        "aria-label": `${c.name} ${k === "a" ? t("explorer_arrival") : t("explorer_departure")}`,
                      }}
                      sx={TIME_FIELD}
                    />
                  </Box>
                );
              };
              return (
                <Box key={c.stop_sequence} sx={{ display: "contents" }}>
                  <Box sx={{ ...rule, display: "flex", alignItems: "center", minWidth: 0 }}>
                    <Typography variant="body2" noWrap>
                      {c.name}
                    </Typography>
                  </Box>
                  {field("a", c.arrival_s)}
                  {field("d", c.departure_s)}
                </Box>
              );
            })}
          </Box>
          <FormControlLabel
            sx={{ mt: 1.5, mb: 0.5, mx: 0, gap: ICON_GAP }}
            control={
              <Checkbox
                size="small"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
                sx={CHECKBOX_SX}
              />
            }
            label={<Typography variant="body2">{t("explorer_trip_times_follow")}</Typography>}
          />
          <Typography variant="caption" color={bad ? "error" : "text.secondary"} display="block">
            {bad ? t("explorer_service_time_hint") : t("explorer_trip_times_note")}
          </Typography>
        </>
      )}
    </TripDialog>
  );
}

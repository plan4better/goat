/**
 * A stop's Details tab (board 23), for everyone: its GTFS fields (stops.txt)
 * as they are, those its location type has
 * (`stopRules.ts`); then what goes with its type: the lines calling at a
 * stop, the locations in a station. Edited from the stop's action bar, in
 * its dialog (decided 26 Nov 2026: panels show, dialogs edit), where the
 * same fields are edited (StopEditor), each checked on its field.
 */
import AccessibleIcon from "@mui/icons-material/Accessible";
import DoorFrontIcon from "@mui/icons-material/DoorFront";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import NotAccessibleIcon from "@mui/icons-material/NotAccessible";
import WorkspacesOutlinedIcon from "@mui/icons-material/WorkspacesOutlined";
import {
  Autocomplete,
  Box,
  List,
  ListItemButton,
  MenuItem,
  Stack,
  TextField,
  Typography,
  createFilterOptions,
} from "@mui/material";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import {
  EDITABLE_LOCATION_TYPES,
  type LocationType,
  type StopValues,
  type Wheelchair,
} from "@/lib/explorer/edit/drafts";
import { metres } from "@/lib/explorer/edit/ops/geo";
import {
  type StopField,
  nameRequired,
  parentRequired,
  parentTypeFor,
  parseLatLon,
  stopFieldProblems,
  stopFieldsShown,
} from "@/lib/explorer/edit/ops/stopRules";
import { sameStopValues } from "@/lib/explorer/edit/ops/stops";
import type { Check } from "@/lib/explorer/edit/ops/types";
import { distance } from "@/lib/explorer/format";
import { openExplorerPanel, setEditDraft } from "@/lib/store/explorer/slice";

import { useDraftEditShown } from "@/hooks/explorer/useDraftEdit";
import {
  type LocationRow,
  type RouteRow,
  useChildLocations,
  useLocationsOfType,
  useStopRecord,
} from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";
import { RouteListItem } from "@/components/explorer/RouteListItem";
import { ICON_GAP, PX, SectionHeader } from "@/components/explorer/SectionHeader";
import { StopMarker } from "@/components/explorer/StopMarker";

/** The label column, as wide as the longest label ("Description"). */
const LABEL_W = 88;

/** A field as the Explorer's settings have them: 32 px, 13 px text. */
export const FIELD_SX = {
  "& .MuiOutlinedInput-root": {
    minHeight: 32,
    borderRadius: 1,
    bgcolor: "background.paper",
    fontSize: "0.8125rem",
  },
  "& .MuiOutlinedInput-root:not(.MuiAutocomplete-inputRoot)": { height: 32 },
  // Text 10 px in from the border, where a dropdown's value starts too.
  "& .MuiInputBase-input": { px: "10px", py: 0 },
  // A mark at the start (a colour's swatch) brings its own room: none of
  // MUI's 14 px before it.
  "& .MuiInputBase-adornedStart": { pl: 0 },
  // The search fields' own padding off: their text starts where the other
  // fields' does.
  "&& .MuiAutocomplete-inputRoot": { py: 0, pl: 0 },
  "&& .MuiAutocomplete-inputRoot .MuiAutocomplete-input": { px: "10px", py: 0, height: 32 },
  // Its arrow where the dropdowns' is (MUI puts it 2 px further in).
  "&& .MuiAutocomplete-endAdornment": { right: "7px" },
  "& .MuiSelect-select": { display: "flex", alignItems: "center" },
  "& .MuiFormHelperText-root": { mx: 0, mt: 0.5, fontSize: "0.6875rem", lineHeight: 1.4 },
  // A locked field's note (why its type stays) is read, not greyed out.
  "& .MuiFormHelperText-root.Mui-disabled": { color: "text.secondary" },
};
/** Every dropdown's options, and the list they open in: one row height
 * and inset, and the Explorer's popup card (the line chooser's). */
export const OPTION_SX = { minHeight: 32, px: "10px", py: "6px" };
export const POPUP_SX = { mt: 0.5, borderRadius: "12px", boxShadow: "rgba(0, 0, 0, 0.2) 0px 0px 10px" };

/** An option of a dropdown, and the value its field shows: an icon, the
 * label, a quiet note at the right. */
export function Choice({ icon, label, note }: { icon: ReactNode; label: string; note?: string | null }) {
  return (
    <Stack direction="row" alignItems="center" spacing={ICON_GAP} sx={{ flex: 1, minWidth: 0 }}>
      <Box
        aria-hidden
        sx={{ width: 16, flexShrink: 0, display: "flex", justifyContent: "center", color: "text.secondary" }}>
        {icon}
      </Box>
      <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: "0.8125rem" }}>
        {label}
      </Typography>
      {note && (
        <Typography variant="caption" color="text.secondary" noWrap>
          {note}
        </Typography>
      )}
    </Stack>
  );
}

const SMALL_ICON = { fontSize: 15 };

/** Each location type's mark: the map's stop and station markers, a door. */
function typeIcon(type: number): ReactNode {
  if (type === 1) return <StopMarker station size={10} />;
  if (type === 2) return <DoorFrontIcon sx={SMALL_ICON} />;
  return <StopMarker size={10} />;
}

/** Each wheelchair boarding's mark; unknown in a station is the station's. */
function wheelchairIcon(w: Wheelchair, inherits: boolean): ReactNode {
  if (w === 1) return <AccessibleIcon sx={SMALL_ICON} />;
  if (w === 2) return <NotAccessibleIcon sx={SMALL_ICON} />;
  return inherits ? <StopMarker station size={10} /> : <HelpOutlineIcon sx={SMALL_ICON} />;
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    // Labels on the first line: a value with a note under it (a move, a
    // problem) keeps its label level with the value, not between the two.
    <Stack direction="row" alignItems="flex-start" spacing={1.5} sx={{ minHeight: 32 }}>
      {/* In the fields' size, as the Explorer's settings rows. */}
      <Typography
        color="text.secondary"
        noWrap
        title={label}
        sx={{ width: LABEL_W, flexShrink: 0, fontSize: "0.8125rem", lineHeight: "32px" }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Stack>
  );
}

/** The position, typed or pasted: kept as text while it is no position yet,
 * passed on once it is one; put back in step when it changes elsewhere (a
 * drag on the map). */
function LocationField({
  lat,
  lon,
  onChange,
}: {
  lat: number | null;
  lon: number | null;
  onChange: (lon: number, lat: number) => void;
}) {
  const { t } = useTranslation("common");
  const shown = lat === null || lon === null ? "" : `${Number(lat.toFixed(6))}, ${Number(lon.toFixed(6))}`;
  const [text, setText] = useState(shown);
  useEffect(() => {
    setText((x) => {
      const p = parseLatLon(x);
      return p && p.lat === lat && p.lon === lon ? x : shown;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lon]);
  const bad = parseLatLon(text) === null;
  return (
    <TextField
      size="small"
      fullWidth
      value={text}
      placeholder={t("explorer_lat_lon_hint")}
      error={bad}
      helperText={bad ? t("explorer_field_invalid_lat_lon") : undefined}
      onChange={(e) => {
        setText(e.target.value);
        const p = parseLatLon(e.target.value);
        if (p && (p.lat !== lat || p.lon !== lon)) onChange(p.lon, p.lat);
      }}
      // Back to the position it has, if left as none.
      onBlur={() => bad && setText(shown)}
      inputProps={{
        "aria-label": t("explorer_stop_field_location"),
        inputMode: "decimal",
        spellCheck: false,
      }}
      sx={FIELD_SX}
    />
  );
}

const PARENT_FILTER = createFilterOptions<LocationRow>({
  limit: 50,
  stringify: (o) => `${o.name} ${o.stop_id}`,
});

/** Locations nearest first, each with how far it is, found by name or id:
 * the one way the Explorer offers places to pick (a station for a stop, a
 * stop to add to a line). `away` measures each, from wherever matters. */
export function NearestPicker({
  options: all,
  loading,
  away: measure,
  value,
  onChange,
  mark,
  label,
  placeholder,
  noOptions,
  error,
  onBlur,
}: {
  options: LocationRow[];
  loading: boolean;
  away: (o: LocationRow) => number | null;
  value: number | null;
  onChange: (stop_idx: number | null) => void;
  mark: ReactNode;
  /** Its name, for the screen reader: the field's label says it. */
  label: string;
  placeholder?: string;
  noOptions: string;
  error?: string;
  onBlur?: () => void;
}) {
  const { i18n } = useTranslation("common");
  const { options, away } = useMemo(() => {
    const m = new Map<number, number>();
    for (const o of all) {
      const d = measure(o);
      if (d !== null) m.set(o.stop_idx, d);
    }
    const far = (o: LocationRow) => m.get(o.stop_idx) ?? Infinity;
    return { options: [...all].sort((a, b) => far(a) - far(b)), away: m };
  }, [all, measure]);
  const picked = options.find((o) => o.stop_idx === value) ?? null;
  return (
    <Autocomplete
      size="small"
      options={options}
      value={picked}
      onChange={(_, o) => onChange(o?.stop_idx ?? null)}
      onBlur={onBlur}
      loading={loading}
      filterOptions={PARENT_FILTER}
      getOptionLabel={(o) => o.name}
      isOptionEqualToValue={(a, b) => a.stop_idx === b.stop_idx}
      noOptionsText={noOptions}
      renderOption={({ key: _key, ...props }, o) => (
        <Box component="li" {...props} key={o.stop_idx} sx={OPTION_SX}>
          <Choice icon={mark} label={o.name} note={distance(away.get(o.stop_idx) ?? null, i18n.language)} />
        </Box>
      )}
      slotProps={{ paper: { sx: POPUP_SX } }}
      // The search list's own option padding outranks the row's: set here.
      ListboxProps={{ sx: { "&& .MuiAutocomplete-option": OPTION_SX } }}
      renderInput={(params) => (
        <TextField
          {...params}
          placeholder={placeholder}
          error={!!error}
          helperText={error}
          inputProps={{ ...params.inputProps, "aria-label": label }}
          InputProps={{
            ...params.InputProps,
            // The picked place's mark, where the dropdowns show theirs.
            startAdornment: picked ? (
              <Box
                aria-hidden
                // Where a dropdown's mark sits, its words where theirs start.
                sx={{ display: "flex", justifyContent: "center", width: 16, ml: "10px", mr: "-2px" }}>
                {mark}
              </Box>
            ) : undefined,
          }}
        />
      )}
      sx={FIELD_SX}
    />
  );
}

/** The station a location belongs to, nearest first, found by name or id. */
function ParentPicker({
  value,
  onChange,
  type,
  self,
  lat,
  lon,
  error,
  required,
  onBlur,
}: {
  value: number | null;
  onChange: (parent: number | null) => void;
  type: LocationType;
  self: number | null;
  lat: number | null;
  lon: number | null;
  error?: string;
  required: boolean;
  onBlur: () => void;
}) {
  const { t } = useTranslation("common");
  const { db } = useExplorer();
  const query = useLocationsOfType(db, parentTypeFor(type));
  const options = useMemo(() => (query.data ?? []).filter((o) => o.stop_idx !== self), [query.data, self]);
  // From the location itself.
  const away = useCallback(
    (o: LocationRow) =>
      lat !== null && lon !== null && o.lat !== null && o.lon !== null
        ? metres([lon, lat], [o.lon, o.lat])
        : null,
    [lat, lon]
  );
  return (
    <NearestPicker
      options={options}
      loading={query.loading}
      away={away}
      value={value}
      onChange={onChange}
      mark={<StopMarker station size={10} />}
      label={t("explorer_stop_field_parent_idx")}
      // An optional station says what none means; a required one is simply
      // empty until picked.
      placeholder={required ? undefined : t("explorer_parent_none")}
      noOptions={t("explorer_no_stations")}
      error={error}
      onBlur={onBlur}
    />
  );
}

/** The stop's own fields, by its location type: Properties', and a new
 * location's (board 18). */
export function StopFields({
  values,
  onChange,
  self = null,
  typeFixed = false,
  refused = null,
  lat,
  lon,
  onLocation,
  moved = null,
  autoFocus = false,
}: {
  values: StopValues;
  onChange: (next: Partial<StopValues>) => void;
  /** The stop itself, never its own parent; none for a new one. */
  self?: number | null;
  /** A saved location keeps its type: another type is another location,
   * deleted and made anew (decided 29 Oct 2026). */
  typeFixed?: boolean;
  /** The edit's refusal, shown on its field when it has one. */
  refused?: Check | null;
  lat: number | null;
  lon: number | null;
  /** A position typed: a move, or where a new location goes. */
  onLocation: (lon: number, lat: number) => void;
  /** Metres it was dragged, while the move waits for Apply (board 23). */
  moved?: number | null;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation("common");
  // A problem is said on its field once the field was left or changed, not
  // before the user had a chance to fill it in.
  const [touched, setTouched] = useState<Set<StopField>>(() => new Set());
  const touch = (f: StopField) => setTouched((s) => (s.has(f) ? s : new Set(s).add(f)));
  // A new type starts its own fields afresh, their problems unsaid until
  // they are touched.
  const setType = (location_type: LocationType) => {
    setTouched((s) => {
      const next = new Set(s).add("location_type");
      next.delete("parent_idx");
      return next;
    });
    onChange({ location_type, parent_idx: null, platform_code: "" });
  };
  const set = (f: StopField, next: Partial<StopValues>) => {
    touch(f);
    onChange(next);
  };
  const problems = stopFieldProblems(values);
  // Said on a field only while it is the one being edited; a refusal about
  // one left alone (a parent of the wrong kind once the type changed) is said
  // in a toast. One still to be filled in is not said until it is touched.
  const error = (f: StopField) => {
    const code = touched.has(f)
      ? (problems[f] ?? (refused?.field === f ? refused.code : undefined))
      : undefined;
    return code ? t(`explorer_field_${code}`) : undefined;
  };
  // A field still to be filled in (missing_*), a new stop's ID among them
  // while it is drawn, is no news: not said.
  const untouchedRefusal =
    refused?.field &&
    !touched.has(refused.field as StopField) &&
    !problems[refused.field as StopField] &&
    !refused.code.startsWith("missing_")
      ? refused.code
      : null;
  useEffect(() => {
    if (untouchedRefusal) toast.error(t(`explorer_field_${untouchedRefusal}`), { toastId: untouchedRefusal });
  }, [untouchedRefusal, t]);
  const shown = stopFieldsShown(values);
  const type = values.location_type;
  const editableType = (EDITABLE_LOCATION_TYPES as readonly number[]).includes(type);
  // A new location's type is held while it belongs to a station: clearing
  // the station frees it (decided 29 Oct 2026).
  const lock = typeFixed || values.parent_idx !== null;
  // In a station, an unknown accessibility is the station's.
  const inherits = values.parent_idx !== null;
  const wheelchairLabel = (w: Wheelchair) =>
    t(w === 0 && inherits ? "explorer_wheelchair_inherit" : `explorer_wheelchair_${w}`);

  return (
    // Fields 16 px apart, room for a note under one: nearer, they read as
    // one block (the settings' rows sit 20 px apart, on dividers).
    <Stack spacing="16px" sx={{ px: PX }}>
      <Row label={t("explorer_stop_field_name")}>
        <TextField
          size="small"
          fullWidth
          required={nameRequired(type)}
          autoFocus={autoFocus}
          value={values.name}
          error={!!error("name")}
          helperText={error("name")}
          onBlur={() => touch("name")}
          onChange={(e) => set("name", { name: e.target.value })}
          inputProps={{ "aria-label": t("explorer_stop_field_name") }}
          sx={FIELD_SX}
        />
      </Row>
      <Row label={t("explorer_stop_field_location_type")}>
        <TextField
          select
          size="small"
          fullWidth
          value={type}
          disabled={lock || !editableType}
          error={!!error("location_type")}
          helperText={error("location_type")}
          onChange={(e) => setType(Number(e.target.value) as LocationType)}
          SelectProps={{
            // The name on the control a user picks with, not the hidden input.
            SelectDisplayProps: { "aria-label": t("explorer_stop_field_location_type") },
            renderValue: (k) => (
              <Choice icon={typeIcon(Number(k))} label={t(`explorer_location_type_${k}`)} />
            ),
            MenuProps: { PaperProps: { sx: POPUP_SX } },
          }}
          sx={FIELD_SX}>
          {[...EDITABLE_LOCATION_TYPES, ...(editableType ? [] : [type])].map((k) => (
            <MenuItem key={k} value={k} sx={OPTION_SX}>
              <Choice icon={typeIcon(k)} label={t(`explorer_location_type_${k}`)} />
            </MenuItem>
          ))}
        </TextField>
      </Row>
      {shown.has("parent_idx") && (
        <Row label={t(type === 4 ? "explorer_stop_field_parent_platform" : "explorer_stop_field_parent_idx")}>
          <ParentPicker
            value={values.parent_idx}
            onChange={(parent_idx) => set("parent_idx", { parent_idx })}
            onBlur={() => touch("parent_idx")}
            type={type}
            self={self}
            lat={lat}
            lon={lon}
            required={parentRequired(type)}
            error={error("parent_idx")}
          />
        </Row>
      )}
      <Row label={t("explorer_stop_field_wheelchair")}>
        <TextField
          select
          size="small"
          fullWidth
          value={values.wheelchair}
          onChange={(e) => set("wheelchair", { wheelchair: Number(e.target.value) as Wheelchair })}
          SelectProps={{
            SelectDisplayProps: { "aria-label": t("explorer_stop_field_wheelchair") },
            renderValue: (w) => (
              <Choice
                icon={wheelchairIcon(w as Wheelchair, inherits)}
                label={wheelchairLabel(w as Wheelchair)}
              />
            ),
            MenuProps: { PaperProps: { sx: POPUP_SX } },
          }}
          sx={FIELD_SX}>
          {([0, 1, 2] as const).map((w) => (
            <MenuItem key={w} value={w} sx={OPTION_SX}>
              <Choice icon={wheelchairIcon(w, inherits)} label={wheelchairLabel(w)} />
            </MenuItem>
          ))}
        </TextField>
      </Row>
      <Row label={t("explorer_stop_field_location")}>
        {/* Typed, or dragged on the map: both make the same move. */}
        <LocationField lat={lat} lon={lon} onChange={onLocation} />
        {moved !== null && (
          <Typography variant="caption" fontWeight={700} color="primary" display="block">
            {t("explorer_moved_on_map", { metres: Math.round(moved) })}
          </Typography>
        )}
      </Row>
    </Stack>
  );
}

/** A section of the tab: its header, then what it holds; under a line,
 * for a section of fields (the lists draw their own). */
export function DetailsSection({
  icon,
  label,
  first = false,
  ruled = false,
  children,
}: {
  icon: Parameters<typeof SectionHeader>[0]["icon"];
  label: string;
  first?: boolean;
  ruled?: boolean;
  children: ReactNode;
}) {
  return (
    <Box sx={{ mt: first ? 0 : 1 }}>
      <SectionHeader icon={icon} label={label} />
      {ruled ? <Box sx={{ borderTop: 1, borderColor: "divider", pt: "12px" }}>{children}</Box> : children}
    </Box>
  );
}

/** A section's rows under a line, as the left panel's lists: its rows, or
 * a note in the left panel's notes' place when it has none. */
function SectionRows({ empty, children }: { empty: string | null; children: ReactNode }) {
  return (
    <Box sx={{ borderTop: 1, borderColor: "divider" }}>
      {empty === null ? (
        <List dense disablePadding>
          {children}
        </List>
      ) : (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: PX, py: 1 }}>
          {empty}
        </Typography>
      )}
    </Box>
  );
}

/** The lines that call at a stop or platform. */
export function LinesSection({ lines }: { lines: RouteRow[] }) {
  const { t } = useTranslation("common");
  return (
    <DetailsSection icon={ICON_NAME.ROUTE} label={t("explorer_lines")}>
      {/* As the left panel's Lines: each row opens its line. */}
      <SectionRows empty={lines.length ? null : t("explorer_no_lines")}>
        {lines.map((r) => (
          <RouteListItem key={r.route_idx} route={r} />
        ))}
      </SectionRows>
    </DetailsSection>
  );
}

/** What belongs to a station: its stops and platforms, its entrances; each
 * opens as itself. */
export function StationSection({ stop_idx }: { stop_idx: number | null }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { db } = useExplorer();
  const query = useChildLocations(stop_idx === null ? undefined : db, stop_idx ?? -1);
  const children = stop_idx === null ? [] : (query.data ?? []);
  return (
    // What belongs together under the station: a group's mark.
    <DetailsSection icon={<WorkspacesOutlinedIcon sx={{ fontSize: 15 }} />} label={t("explorer_in_station")}>
      <SectionRows empty={children.length ? null : t("explorer_station_empty")}>
        {children.map((c) => (
          // As a line's row: its mark, its name, what it is at the right.
          <ListItemButton
            key={c.stop_idx}
            onClick={() =>
              dispatch(
                openExplorerPanel({
                  item: {
                    kind: "stop",
                    stop: { stop_idx: c.stop_idx, name: c.name, lon: c.lon ?? 0, lat: c.lat ?? 0 },
                  },
                  push: true,
                })
              )
            }
            sx={{ px: PX, py: 0.75, gap: 1.5, minHeight: 36 }}>
            <Box sx={{ width: 16, display: "flex", justifyContent: "center", color: "text.secondary" }}>
              {typeIcon(c.location_type)}
            </Box>
            <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
              {c.platform_code ? t("explorer_platform", { code: c.platform_code }) : c.name}
            </Typography>
            <Typography variant="caption" color="text.disabled" noWrap>
              {t(`explorer_location_type_${c.location_type}`)}
            </Typography>
          </ListItemButton>
        ))}
      </SectionRows>
    </DetailsSection>
  );
}

/** The sections a location type has after its fields. */
export function TypeSections({
  type,
  stop_idx,
  lines,
}: {
  type: LocationType;
  stop_idx: number | null;
  lines: RouteRow[];
}) {
  if (type === 0) return <LinesSection lines={lines} />;
  if (type === 1) return <StationSection stop_idx={stop_idx} />;
  return null;
}

/** A stop's Details tab: its fields as they are; then what goes with its
 * type. Edited from its action bar (StopDialog). */
export function StopDetails({ stop_idx, lines }: { stop_idx: number; lines: RouteRow[] }) {
  const { t } = useTranslation("common");
  const { db } = useExplorer();
  const query = useStopRecord(db, stop_idx);
  const record = query.data;
  if (query.error)
    return (
      <Typography variant="body2" color="error" sx={{ px: PX, mt: 2 }}>
        {query.error}
      </Typography>
    );
  if (!record) return null;
  const { stop_idx: _i, stop_id: _id, lat, lon, ...values } = record;
  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", pb: 2 }}>
      <DetailsSection first ruled icon={ICON_NAME.INFO} label={t("explorer_stop_tab_properties")}>
        <StopView values={values} lat={lat} lon={lon} />
      </DetailsSection>
      <TypeSections type={values.location_type} stop_idx={stop_idx} lines={lines} />
    </Box>
  );
}

/** A stop's fields as they are, in the rows the dialog edits them in. */
function StopView({ values, lat, lon }: { values: StopValues; lat: number | null; lon: number | null }) {
  const { t } = useTranslation("common");
  const { db } = useExplorer();
  const parent = useStopRecord(values.parent_idx === null ? undefined : db, values.parent_idx ?? -1).data;
  const shown = stopFieldsShown(values);
  const text = (v: string | null | undefined) => (
    <Typography
      color={v ? "text.primary" : "text.secondary"}
      sx={{ fontSize: "0.8125rem", lineHeight: "32px", wordBreak: "break-word" }}>
      {v || "–"}
    </Typography>
  );
  const inherits = values.parent_idx !== null;
  return (
    <Stack spacing="4px" sx={{ px: PX }}>
      <Row label={t("explorer_stop_field_name")}>{text(values.name)}</Row>
      <Row label={t("explorer_stop_field_location_type")}>
        <Box sx={{ height: 32, display: "flex" }}>
          <Choice
            icon={typeIcon(values.location_type)}
            label={t(`explorer_location_type_${values.location_type}`)}
          />
        </Box>
      </Row>
      {shown.has("parent_idx") && (
        <Row
          label={t(
            values.location_type === 4
              ? "explorer_stop_field_parent_platform"
              : "explorer_stop_field_parent_idx"
          )}>
          {text(values.parent_idx === null ? null : (parent?.name ?? "…"))}
        </Row>
      )}
      {shown.has("platform_code") && values.platform_code && (
        <Row label={t("explorer_stop_field_platform_code")}>{text(values.platform_code)}</Row>
      )}
      <Row label={t("explorer_stop_field_wheelchair")}>
        <Box sx={{ height: 32, display: "flex" }}>
          <Choice
            icon={wheelchairIcon(values.wheelchair, inherits)}
            label={t(
              values.wheelchair === 0 && inherits
                ? "explorer_wheelchair_inherit"
                : `explorer_wheelchair_${values.wheelchair}`
            )}
          />
        </Box>
      </Row>
      <Row label={t("explorer_stop_field_location")}>
        {text(lat === null || lon === null ? null : `${Number(lat.toFixed(6))}, ${Number(lon.toFixed(6))}`)}
      </Row>
    </Stack>
  );
}

/** A stop's fields, edited (its dialog, StopDialog): typing makes a draft
 * the Apply bar applies; a position typed, or the stop dragged on the map,
 * a move. */
export function StopEditor({ stop_idx }: { stop_idx: number }) {
  const dispatch = useAppDispatch();
  const { db } = useExplorer();
  const query = useStopRecord(db, stop_idx);
  const record = query.data;
  const draft = useAppSelector((s) => s.explorer.edit.draft);
  const edit = useDraftEditShown();
  const moving = draft?.kind === "stop-move" && draft.stop_idx === stop_idx ? draft : null;
  if (query.error)
    return (
      <Typography variant="body2" color="error">
        {query.error}
      </Typography>
    );
  if (!record) return null;

  const { stop_idx: _i, stop_id: _id, lat, lon, ...saved } = record;
  const values = draft?.kind === "stop-details" && draft.stop_idx === stop_idx ? draft.values : saved;
  // Back where it was: nothing to apply.
  const set = (next: Partial<StopValues>) => {
    const v = { ...values, ...next };
    dispatch(setEditDraft(sameStopValues(v, saved) ? null : { kind: "stop-details", stop_idx, values: v }));
  };
  const refused =
    edit?.draft.kind === "stop-details" && edit.built && !edit.built.ok ? edit.built.refused : null;
  return (
    <Box sx={{ mx: -PX }}>
      <StopFields
        values={values}
        onChange={set}
        self={stop_idx}
        typeFixed
        refused={refused}
        lat={moving ? moving.lat : lat}
        lon={moving ? moving.lon : lon}
        onLocation={(lon2, lat2) =>
          dispatch(
            setEditDraft(
              // Back where it was: nothing to apply.
              lon2 === lon && lat2 === lat ? null : { kind: "stop-move", stop_idx, lon: lon2, lat: lat2 }
            )
          )
        }
        moved={moving && lat !== null && lon !== null ? metres([lon, lat], [moving.lon, moving.lat]) : null}
      />
    </Box>
  );
}

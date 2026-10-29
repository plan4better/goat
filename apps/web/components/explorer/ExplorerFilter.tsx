/**
 * The Explorer tab's filter (board 4): a button beside the search that opens
 * the choices — type, route type, agency, each with its count — and the
 * active ones as removable chips under the search. Choices apply as they are
 * ticked; Done only closes.
 */
import { Box, ButtonBase, Checkbox, Chip, Divider, Popover, Stack, Typography } from "@mui/material";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { agencyCounts, filterCount, modeCounts, toggle } from "@/lib/explorer/filters";
import { count } from "@/lib/explorer/format";
import type { ModeKey } from "@/lib/explorer/modes";
import { type ExplorerFilters, NO_FILTERS, setExplorerFilters } from "@/lib/store/explorer/slice";

import type { AgencyRow, RouteRow } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { StopMarker } from "@/components/explorer/StopMarker";
import { modeIcon } from "@/components/explorer/modeIcon";
import DropdownFooter from "@/components/map/panels/style/other/DropdownFooter";

interface Facets {
  routes: RouteRow[];
  agencies: AgencyRow[];
  stopCount: number | undefined;
}

function GroupLabel({ children }: { children: string }) {
  return (
    <Typography
      component="div"
      sx={{
        px: 2,
        pt: 1.5,
        pb: 0.5,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.5px",
        textTransform: "uppercase",
        color: "text.secondary",
      }}>
      {children}
    </Typography>
  );
}

function Option({
  checked,
  icon,
  label,
  amount,
  onToggle,
}: {
  checked: boolean;
  icon: ICON_NAME | ReactElement;
  label: string;
  amount: string;
  onToggle: () => void;
}) {
  return (
    <Stack
      component="label"
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{ px: 1, pr: 2, minHeight: 34, cursor: "pointer", "&:hover": { bgcolor: "action.hover" } }}>
      <Checkbox size="small" checked={checked} onChange={onToggle} />
      <Box sx={{ display: "flex", color: "text.secondary" }}>
        {typeof icon === "string" ? (
          <Icon iconName={icon} style={{ fontSize: 13 }} htmlColor="inherit" />
        ) : (
          icon
        )}
      </Box>
      <Typography variant="body2" fontWeight={checked ? 600 : 400} noWrap sx={{ flex: 1 }}>
        {label}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {amount}
      </Typography>
    </Stack>
  );
}

export function ExplorerFilterButton({ routes, agencies, stopCount }: Facets) {
  const { t, i18n } = useTranslation("common");
  const dispatch = useAppDispatch();
  const filters = useAppSelector((s) => s.explorer.filters);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = !!anchor;
  const lang = i18n.language;
  const set = (next: ExplorerFilters) => dispatch(setExplorerFilters(next));
  const modes = modeCounts(routes);
  const perAgency = agencyCounts(routes);
  // An agency with no routes in the list has nothing to filter to.
  const listedAgencies = agencies.filter((a) => perAgency.has(a.agency_idx));
  const active = filterCount(filters);

  return (
    <>
      {/* Inside the search field, at its end: one control, not two boxes
          side by side. The count of active choices replaces a badge. */}
      <ButtonBase
        aria-label={t("explorer_filter")}
        aria-expanded={open}
        onClick={(e) =>
          // Anchored to the whole field, so the choices open beside the panel.
          setAnchor(anchor ? null : (e.currentTarget.closest(".MuiInputBase-root") as HTMLElement))
        }
        sx={{
          gap: 0.75,
          height: 28,
          px: 1,
          mr: -0.75,
          borderRadius: 1,
          color: active ? "primary.main" : "text.secondary",
          bgcolor: active || open ? "action.selected" : "transparent",
          "&:hover": { bgcolor: "action.hover" },
        }}>
        <Icon iconName={ICON_NAME.FILTER} style={{ fontSize: 13 }} htmlColor="inherit" />
        {active > 0 && (
          <Typography variant="caption" fontWeight={700} color="inherit">
            {active}
          </Typography>
        )}
      </ButtonBase>
      {/* Opens beside the panel, over the map, as on board 4. */}
      <Popover
        open={open}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        slotProps={{
          paper: {
            elevation: 8,
            sx: { ml: 1.5, maxHeight: "70vh", display: "flex", flexDirection: "column", overflow: "hidden" },
          },
        }}>
        <Box sx={{ width: 280, pt: 0.5, flex: 1, minHeight: 0, overflowY: "auto" }}>
          <GroupLabel>{t("explorer_filter_type")}</GroupLabel>
          <Option
            checked={filters.types.includes("routes")}
            icon={ICON_NAME.ROUTE}
            label={t("explorer_routes")}
            amount={count(routes.length, lang)}
            onToggle={() => set({ ...filters, types: toggle(filters.types, "routes") })}
          />
          <Option
            checked={filters.types.includes("stops")}
            icon={<StopMarker size={10} />}
            label={t("explorer_stops_stations")}
            amount={stopCount !== undefined ? count(stopCount, lang) : "…"}
            onToggle={() => set({ ...filters, types: toggle(filters.types, "stops") })}
          />
          {/* A choice of one is no choice: a group shows with two or more. */}
          {modes.length > 1 && (
            <>
              <Divider sx={{ mt: 1 }} />
              <GroupLabel>{t("explorer_filter_route_type")}</GroupLabel>
              {modes.map(([mode, n]) => (
                <Option
                  key={mode}
                  checked={filters.modes.includes(mode)}
                  icon={modeIcon(mode)}
                  label={t(`explorer_mode_${mode}`)}
                  amount={count(n, lang)}
                  onToggle={() => set({ ...filters, modes: toggle<ModeKey>(filters.modes, mode) })}
                />
              ))}
              <Typography variant="caption" color="text.secondary" display="block" sx={{ px: 2, pt: 0.5 }}>
                {t("explorer_filter_route_type_note")}
              </Typography>
            </>
          )}
          {listedAgencies.length > 1 && (
            <>
              <Divider sx={{ mt: 1 }} />
              <GroupLabel>{t("explorer_filter_agency")}</GroupLabel>
              {listedAgencies.map((a) => (
                <Option
                  key={a.agency_idx}
                  checked={filters.agencies.includes(a.agency_idx)}
                  icon={ICON_NAME.ORGANIZATION}
                  label={a.name ?? ""}
                  amount={count(perAgency.get(a.agency_idx) ?? 0, lang)}
                  onToggle={() => set({ ...filters, agencies: toggle(filters.agencies, a.agency_idx) })}
                />
              ))}
            </>
          )}
        </Box>
        {/* Always in view, however long the choices run. */}
        <Box sx={{ flexShrink: 0, pb: 1 }}>
          <Divider sx={{ mb: 1 }} />
          <DropdownFooter
            isValid
            cancelLabel={t("reset")}
            onCancel={() => set(NO_FILTERS)}
            applyLabel={t("done")}
            onApply={() => setAnchor(null)}
          />
        </Box>
      </Popover>
    </>
  );
}

/** The active choices under the search, each removable. */
export function ExplorerFilterChips({ agencies }: { agencies: AgencyRow[] }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const filters = useAppSelector((s) => s.explorer.filters);
  if (!filterCount(filters)) return null;
  const set = (next: ExplorerFilters) => dispatch(setExplorerFilters(next));
  const chips = [
    ...filters.types.map((type) => ({
      key: `t:${type}`,
      icon: type === "routes" ? ICON_NAME.ROUTE : <StopMarker size={9} />,
      label: type === "routes" ? t("explorer_routes") : t("explorer_stops_stations"),
      remove: () => set({ ...filters, types: toggle(filters.types, type) }),
    })),
    ...filters.modes.map((mode) => ({
      key: `m:${mode}`,
      icon: modeIcon(mode),
      label: t(`explorer_mode_${mode}`),
      remove: () => set({ ...filters, modes: toggle(filters.modes, mode) }),
    })),
    ...filters.agencies.map((idx) => ({
      key: `a:${idx}`,
      icon: ICON_NAME.ORGANIZATION,
      label: agencies.find((a) => a.agency_idx === idx)?.name ?? "",
      remove: () => set({ ...filters, agencies: toggle(filters.agencies, idx) }),
    })),
  ];
  return (
    <Stack direction="row" useFlexGap flexWrap="wrap" spacing={0.75} sx={{ mt: 1.25 }}>
      {chips.map((c) => (
        // Quiet pills on the panel's tinted ground, as the date pill: what
        // the list is narrowed to, each with a small × to undo it.
        <Chip
          key={c.key}
          size="small"
          icon={
            typeof c.icon === "string" ? (
              <Icon iconName={c.icon} style={{ fontSize: 11 }} htmlColor="inherit" />
            ) : (
              c.icon
            )
          }
          label={c.label}
          onDelete={c.remove}
          deleteIcon={<Icon iconName={ICON_NAME.XCLOSE} htmlColor="inherit" />}
          sx={{
            height: 26,
            maxWidth: "100%",
            borderRadius: "13px",
            bgcolor: "action.hover",
            color: "text.primary",
            fontSize: 12,
            fontWeight: 600,
            fontStyle: "normal",
            "& .MuiChip-icon": { ml: 1, mr: "2px", color: "text.secondary" },
            "& .MuiChip-label": { pl: 0.75, pr: 0.5 },
            "& .MuiChip-deleteIcon": {
              fontSize: "9px",
              width: 9,
              height: 9,
              ml: 0.25,
              mr: 1.25,
              color: "text.secondary",
              "&:hover": { color: "text.primary" },
            },
          }}
        />
      ))}
    </Stack>
  );
}

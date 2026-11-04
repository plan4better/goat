"""Shared routing-mode budget constants and the single travel-budget field.

Centralised so the per-mode time / distance caps stay consistent across
catchment_area_v2, heatmap_v2 and huff_model_v2 form schemas.

The v2 tools expose ONE `max_cost` field — the same name and meaning the C++
routing engine and the analysis schemas use. Its default, floor and cap vary by
routing_mode x cost_type, which the form renderer resolves from `default_from`
and `max_value_from`; `validate_budget` enforces the same bounds server-side for
callers that bypass the UI.
"""

from typing import Any

import numpy as np

# The access/egress leg cap is owned by the analysis layer — that is what
# consumes the lookup tables the cap describes. Imported rather than restated
# so the form cap and the analysis field bound cannot drift apart.
from goatlib.analysis.schemas.catchment_area_v2 import (
    DEFAULT_SPEED_KMH,
    LEG_DEFAULT_SPEED_KMH,
)
from goatlib.analysis.schemas.heatmap_v2 import MAX_LEG_TIME_LOOKUP_MIN

# Defaults (minutes / metres).
DEFAULT_MAX_TIME_ACTIVE_MIN = 15
DEFAULT_MAX_TIME_CAR_MIN = 30
DEFAULT_MAX_TIME_PT_MIN = 30
DEFAULT_MAX_DISTANCE_ACTIVE_M = 500
DEFAULT_MAX_DISTANCE_CAR_M = 5000

# Per-mode hard caps.
MAX_TIME_ACTIVE_MIN = 45
MAX_TIME_CAR_MIN = 90
MAX_TIME_PT_MIN = 90
MAX_DISTANCE_ACTIVE_M = 20000
MAX_DISTANCE_CAR_M = 100000

# i18n message keys (defined in goatlib/i18n/translations/{en,de}.json and
# apps/web/i18n/locales/{en,de}/common.json).
ACTIVE_TIME_LIMIT_MSG = "active_mobility_time_limit_message"
CAR_TIME_LIMIT_MSG = "car_time_limit_message"
PT_TIME_LIMIT_MSG = "pt_time_limit_message"
ACTIVE_DISTANCE_LIMIT_MSG = "active_mobility_distance_limit_message"
CAR_DISTANCE_LIMIT_MSG = "car_distance_limit_message"

# Floors: minutes are whole numbers from 1; distances are metres from 50.
MIN_TIME_MIN = 1
MIN_DISTANCE_M = 50

# One row per (routing_mode, cost_type) case, most specific first — the form
# renderer and the validators below all take the first matching row. PT is
# time-only (its cost_type toggle is hidden), so it matches on mode alone.
_BUDGET_RULES: tuple[dict[str, Any], ...] = (
    {
        "when": {"routing_mode": "pt"},
        "default": DEFAULT_MAX_TIME_PT_MIN,
        "max": MAX_TIME_PT_MIN,
        "min": MIN_TIME_MIN,
        "unit": "unit_minutes",
        "message": PT_TIME_LIMIT_MSG,
    },
    {
        "when": {"routing_mode": "car", "cost_type": "distance"},
        "default": DEFAULT_MAX_DISTANCE_CAR_M,
        "max": MAX_DISTANCE_CAR_M,
        "min": MIN_DISTANCE_M,
        "unit": "unit_meters",
        "message": CAR_DISTANCE_LIMIT_MSG,
    },
    {
        "when": {"routing_mode": "car"},
        "default": DEFAULT_MAX_TIME_CAR_MIN,
        "max": MAX_TIME_CAR_MIN,
        "min": MIN_TIME_MIN,
        "unit": "unit_minutes",
        "message": CAR_TIME_LIMIT_MSG,
    },
    {
        "when": {"cost_type": "distance"},
        "default": DEFAULT_MAX_DISTANCE_ACTIVE_M,
        "max": MAX_DISTANCE_ACTIVE_M,
        "min": MIN_DISTANCE_M,
        "unit": "unit_meters",
        "message": ACTIVE_DISTANCE_LIMIT_MSG,
    },
    {
        "when": {},
        "default": DEFAULT_MAX_TIME_ACTIVE_MIN,
        "max": MAX_TIME_ACTIVE_MIN,
        "min": MIN_TIME_MIN,
        "unit": "unit_minutes",
        "message": ACTIVE_TIME_LIMIT_MSG,
    },
)


def _val(x: Any) -> str | None:
    return None if x is None else str(getattr(x, "value", x))


def budget_rule(routing_mode: Any, cost_type: Any) -> dict[str, Any]:
    """First rule matching this mode / cost type. Conditions naming a field that
    is None are skipped, so a partially-filled form still resolves."""
    ctx = {"routing_mode": _val(routing_mode), "cost_type": _val(cost_type)}
    for rule in _BUDGET_RULES:
        if all(ctx.get(k) == v for k, v in rule["when"].items()):
            return rule
    return _BUDGET_RULES[-1]


def resolve_budget_default(routing_mode: Any, cost_type: Any) -> int:
    """Default budget for a mode / cost type — the value the form pre-fills."""
    return int(budget_rule(routing_mode, cost_type)["default"])


def validate_cost_type(routing_mode: Any, cost_type: Any) -> None:
    """PT journeys are measured in time. Reject a distance cost type instead of
    quietly rewriting it: the form hides the toggle for PT, so a `distance` here
    means a stale or hand-built payload, and silently accepting it would read a
    minute budget as metres. Raises ValueError."""
    if _val(routing_mode) == "pt" and _val(cost_type) not in (None, "time"):
        raise ValueError(
            f"cost_type must be 'time' for routing_mode=pt, got {_val(cost_type)!r}"
        )


def validate_budget(routing_mode: Any, cost_type: Any, max_cost: Any) -> None:
    """Enforce the same floor / cap the form does. Raises ValueError."""
    if max_cost is None:
        return
    rule = budget_rule(routing_mode, cost_type)
    unit = "m" if rule["unit"] == "unit_meters" else "min"
    if not rule["min"] <= max_cost <= rule["max"]:
        raise ValueError(
            f"max_cost must be between {rule['min']} and {rule['max']} {unit} "
            f"for routing_mode={_val(routing_mode)} / cost_type={_val(cost_type)}"
        )


def budget_widget_options() -> dict[str, Any]:
    """`default_from` + `unit_from` + `max_value_from` for a single `max_cost`
    field, so one field carries a per-mode default, unit, floor, cap and error
    message. The unit suffix is what tells the user what the value means when
    the cost_type toggle is hidden (PT is time-only)."""
    return {
        "default_from": {
            "fields": [
                {"value": r["default"], **({"when": r["when"]} if r["when"] else {})}
                for r in _BUDGET_RULES
            ]
        },
        "unit_from": {
            "fields": [
                {"value": r["unit"], **({"when": r["when"]} if r["when"] else {})}
                for r in _BUDGET_RULES
            ]
        },
        "max_value_from": {
            "fields": [
                {
                    "value": r["max"],
                    "min": r["min"],
                    "message": r["message"],
                    **({"when": r["when"]} if r["when"] else {}),
                }
                for r in _BUDGET_RULES
            ],
            "message": ACTIVE_TIME_LIMIT_MSG,
        },
    }


def speed_default_by_field(mode_field: str, *, leg: bool = False) -> dict[str, Any]:
    """`default_by_field` for a speed field: each active mode's default speed,
    keyed by the value of `mode_field`. `leg=True` for a PT access or egress
    leg, whose modes are named `walk` / `bicycle` / `pedelec`. The values come
    from the table the routing tools fall back to when a run names no speed, so
    the form and a run without it route at the same speed."""
    speeds = LEG_DEFAULT_SPEED_KMH if leg else DEFAULT_SPEED_KMH
    return {
        "field": mode_field,
        "values": {str(mode): speed for mode, speed in speeds.items()},
    }


def leg_budget_widget_options(
    cost_type_field: str,
    message: str,
    *,
    lookup_table: bool = False,
    budget_field: str = "max_cost",
) -> dict[str, Any]:
    """Same three conditional options as `budget_widget_options`, but for a PT
    access / egress leg: keyed on that leg's own cost type rather than the
    journey's.

    `lookup_table=True` describes a leg served by a precomputed, time-based
    access/egress table (`HeatmapConfig.access_max_time`): distance is not
    offered and the cap is the table's own horizon. Otherwise the leg is routed
    live, so distance is available and a time leg is capped by the journey's own
    budget (`budget_field`, whichever field holds it) — a leg cannot outlast the
    trip. The field shape is identical
    either way, so enabling distance later is just this flag plus widening the
    tool's cost-type enum.
    """
    allow_distance = not lookup_table
    time_cap: dict[str, Any] = (
        {"value": MAX_LEG_TIME_LOOKUP_MIN} if lookup_table else {"field": budget_field}
    )
    default_fields: list[dict[str, Any]] = []
    unit_fields: list[dict[str, Any]] = []
    max_fields: list[dict[str, Any]] = []
    if allow_distance:
        default_fields.append(
            {
                "value": DEFAULT_MAX_DISTANCE_ACTIVE_M,
                "when": {cost_type_field: "distance"},
            }
        )
        unit_fields.append(
            {"value": "unit_meters", "when": {cost_type_field: "distance"}}
        )
        max_fields.append(
            {
                "value": MAX_DISTANCE_ACTIVE_M,
                "min": MIN_DISTANCE_M,
                "when": {cost_type_field: "distance"},
                "message": message,
            }
        )
    default_fields.append({"value": DEFAULT_MAX_TIME_ACTIVE_MIN})
    unit_fields.append({"value": "unit_minutes"})
    max_fields.append(
        {
            **time_cap,
            "min": MIN_TIME_MIN,
            "when": {cost_type_field: "time"},
            "message": message,
        }
    )
    return {
        "default_from": {"fields": default_fields},
        "unit_from": {"fields": unit_fields},
        "max_value_from": {"fields": max_fields, "message": message},
    }


def validate_leg_budget(
    cost_type: Any, max_cost: Any, label: str, *, lookup_table: bool = False
) -> None:
    """Floor / ceiling for an access or egress leg budget — the server-side twin
    of `leg_budget_widget_options`, taking the same `lookup_table` flag so the
    two cannot disagree about the cap. Raises ValueError."""
    if max_cost is None:
        return
    if _val(cost_type) == "distance":
        lo, hi, unit = MIN_DISTANCE_M, MAX_DISTANCE_ACTIVE_M, "m"
    else:
        lo = MIN_TIME_MIN
        hi = MAX_LEG_TIME_LOOKUP_MIN if lookup_table else MAX_TIME_ACTIVE_MIN
        unit = "min"
    if not lo <= max_cost <= hi:
        raise ValueError(
            f"{label}_max_cost must be between {lo} and {hi} {unit} "
            f"for {label}_cost_type={_val(cost_type)}"
        )


# Pre-rename PT leg field names, mapped onto the engine-aligned ones. Every tool
# now exposes `*_max_cost`; the time-only pipelines translate that to the
# analysis layer's `*_max_time` in process().
_LEGACY_LEG_FIELDS: dict[str, str] = {
    "pt_access_mode": "access_mode",
    "pt_access_cost_type": "access_cost_type",
    "pt_access_speed": "access_speed",
    "pt_access_max_time": "access_max_cost",
    "pt_egress_mode": "egress_mode",
    "pt_egress_cost_type": "egress_cost_type",
    "pt_egress_speed": "egress_speed",
    "pt_egress_max_time": "egress_max_cost",
}


def resolve_leg_names(data: Any) -> Any:
    """Map a pre-rename PT leg payload onto the engine-aligned field names.
    Used by the time-only tools, which have no time/distance pair to collapse."""
    if not isinstance(data, dict):
        return data
    out = dict(data)
    for old, new in _LEGACY_LEG_FIELDS.items():
        if out.get(new) is None and out.get(old) is not None:
            out[new] = out[old]
    return out


def resolve_leg_budget_input(data: Any) -> Any:
    """Map a pre-rename PT leg payload onto the engine-aligned field names, and
    collapse each leg's old time/distance pair onto its single `*_max_cost`
    using that leg's own cost type."""
    if not isinstance(data, dict):
        return data
    out = dict(resolve_leg_names(data))
    for leg in ("access", "egress"):
        target = f"{leg}_max_cost"
        if out.get(target) is not None:
            continue
        distance = _val(out.get(f"{leg}_cost_type")) == "distance"
        order = (
            (f"pt_{leg}_max_cost_distance", f"pt_{leg}_max_cost_time")
            if distance
            else (f"pt_{leg}_max_cost_time", f"pt_{leg}_max_cost_distance")
        )
        for name in order:
            if out.get(name) is not None:
                out[target] = out[name]
                break
        else:
            out[target] = (
                DEFAULT_MAX_DISTANCE_ACTIVE_M
                if distance
                else DEFAULT_MAX_TIME_ACTIVE_MIN
            )
    return out


def resolve_budget_input(
    data: Any, routing_mode_key: str = "routing_mode", *, fill_default: bool = True
) -> Any:
    """Normalise the budget on an incoming payload, in precedence order:

    1. an explicit `max_cost` wins untouched;
    2. otherwise a pre-collapse field name matching the payload's own mode /
       cost type, so saved workflows keep the budget the user chose;
    3. otherwise the mode-aware default — the form fills this via
       `default_from`, and API callers need the same value. Without it a caller
       that sets cost_type=distance and omits the budget would inherit the
       time-based schema default and fail the distance floor.

    `fill_default=False` stops at step 2, for a tool whose budget is genuinely
    optional (travel cost matrix: unset means unbounded).
    """
    if not isinstance(data, dict) or data.get("max_cost") is not None:
        return data
    mode, cost = _val(data.get(routing_mode_key)), _val(data.get("cost_type"))
    if cost == "distance":
        order = (
            ("max_cost_distance_car", "max_cost_distance")
            if mode == "car"
            else ("max_cost_distance", "max_cost_distance_car")
        )
    elif mode == "pt":
        order = ("max_cost_time_pt", "max_cost_time", "max_cost_time_active")
    elif mode == "car":
        order = ("max_cost_time_car", "max_cost_time", "max_cost_time_active")
    else:
        order = ("max_cost_time_active", "max_cost_time", "max_cost_time_car")
    for name in order:
        if data.get(name) is not None:
            return {**data, "max_cost": data[name]}
    if not fill_default:
        return data
    return {**data, "max_cost": resolve_budget_default(mode, cost)}


# Maximum distance between the farthest corners of a routed request's points,
# per routing mode, in metres.
MAX_EXTENT_M: dict[str, int] = {
    "walking": 100_000,
    "bicycle": 100_000,
    "pedelec": 100_000,
    "car": 300_000,
    "pt": 300_000,
}

_EARTH_RADIUS_M = 6371000.0


def _max_reach_m(routing_mode: Any) -> int:
    return MAX_EXTENT_M.get(_val(routing_mode), 300_000)


def _extent_m(
    o_min_lat: Any,
    o_max_lat: Any,
    o_min_lon: Any,
    o_max_lon: Any,
    d_min_lat: Any,
    d_max_lat: Any,
    d_min_lon: Any,
    d_max_lon: Any,
) -> Any:
    """Distance in metres between the farthest corners of the origin and
    destination bounding boxes, which bounds the farthest O-D pair. Takes
    degrees as floats, or the origin bounds as arrays for one origin each."""
    lat_span = np.maximum(np.abs(o_max_lat - d_min_lat), np.abs(d_max_lat - o_min_lat))
    lon_span = np.maximum(np.abs(o_max_lon - d_min_lon), np.abs(d_max_lon - o_min_lon))
    avg_lat = np.radians((o_min_lat + o_max_lat + d_min_lat + d_max_lat) / 4.0)
    dy = np.radians(lat_span) * _EARTH_RADIUS_M
    dx = np.radians(lon_span) * _EARTH_RADIUS_M * np.cos(avg_lat)
    return np.sqrt(dx * dx + dy * dy)


def validate_extent(
    routing_mode: Any,
    origin_lats: list[float],
    origin_lons: list[float],
    dest_lats: list[float],
    dest_lons: list[float],
    label: str = "Origin-destination extent",
) -> None:
    """Reject a request whose origins and destinations lie further apart than
    the mode can route. Raises ValueError."""
    extent_m = float(
        _extent_m(
            min(origin_lats),
            max(origin_lats),
            min(origin_lons),
            max(origin_lons),
            min(dest_lats),
            max(dest_lats),
            min(dest_lons),
            max(dest_lons),
        )
    )
    max_reach_m = _max_reach_m(routing_mode)
    if extent_m > max_reach_m:
        raise ValueError(
            f"{label} ({extent_m / 1000:.0f} km) exceeds "
            f"the maximum reachable distance for {_val(routing_mode)} "
            f"({max_reach_m / 1000:.0f} km). "
            f"Reduce the area or choose a different mode."
        )


def within_extent(
    routing_mode: Any,
    origin_lats: Any,
    origin_lons: Any,
    dest_lats: Any,
    dest_lons: Any,
) -> np.ndarray:
    """Per origin, whether `validate_extent` accepts that origin alone with
    all the destinations. Degrees in; a boolean array out, all False when
    there is no destination."""
    o_lat = np.asarray(origin_lats, dtype=float)
    o_lon = np.asarray(origin_lons, dtype=float)
    d_lat = np.asarray(dest_lats, dtype=float)
    d_lon = np.asarray(dest_lons, dtype=float)
    if not d_lat.size:
        return np.zeros(o_lat.shape, dtype=bool)
    extent_m = _extent_m(
        o_lat, o_lat, o_lon, o_lon, d_lat.min(), d_lat.max(), d_lon.min(), d_lon.max()
    )
    return extent_m <= _max_reach_m(routing_mode)

"""Flatten split Overture segments into member-layer records.

Splitting removes *geometric* scoping, so any property Overture scopes only
geometrically has at most one applicable rule per piece and reduces to a scalar
without loss. The schema makes that partition explicit: ``road_surface``,
``road_flags``, ``level_rules``, ``subclass_rules`` and ``width_rules`` reference
``geometricRangeScopeContainer`` and nothing else, while ``speed_limits``,
``access_restrictions`` and ``prohibited_transitions`` also carry heading,
temporal, travel-mode, purpose-of-use, recognized-status and vehicle scope.

Speed limits are the exception we pull out anyway: their *heading* scope maps onto
a distinction the routing schema already models (``maxspeed_forward`` /
``maxspeed_backward``), so forward and backward limits become columns. Rules
scoped by anything else — time of day, mode, vehicle — have no representation
downstream and stay in the residual only.

Everything not represented by a column is carried verbatim in the ``overture``
JSON residual, so the layer stays lossless: it is the source of truth the routing
artifact is rebuilt from, and a dropped restriction would be a silent behaviour
change.
"""

import json
import logging
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

from goatlib.bundles.importers.street_network.overture.splitter import (
    LR_SCOPE_KEY,
    SplitResult,
)
from goatlib.models.bundle import CLASS_DEFAULT_MAXSPEED, ROUTING_CLASSES

logger = logging.getLogger(__name__)

# Scope dimensions a derived speed column can express. Anything else means the
# rule is conditional and cannot become a static column.
_EXPRESSIBLE_SCOPES = frozenset({"heading"})

# The factor data_preparation uses, kept identical so speeds agree.
_MPH_TO_KPH = 1.60934

# The schema's accessType enum is exactly these three.
_ACCESS_DENIED = "denied"
_ACCESS_OPEN = frozenset({"allowed", "designated"})

# Travel modes that a private car belongs to. The schema's travelMode enum is
# a hierarchy — "motor_vehicle includes car, truck and motorcycle", and `vehicle`
# sits above that — so a denial naming any of these reaches a car, while one
# naming `truck`, `hgv`, `bus`, `hov`, `bicycle` or `foot` does not.
CAR_MODES = frozenset({"vehicle", "motor_vehicle", "car"})

# Scopes we cannot answer for "an ordinary car, at no particular time, travelling
# through". A rule carrying one of these does not match that fact pattern, so it
# neither opens nor closes a direction: a street closed 15:00-18:00 is drivable in
# general, and a rule that only applies with a permit or to over-weight vehicles
# says nothing about an ordinary car.
_SITUATIONAL_SCOPES = frozenset({"during", "using", "recognized", "vehicle"})


def flatten_edges(pieces: Iterable[Dict[str, Any]]) -> Iterator[Dict[str, Any]]:
    """Edge records as the pieces arrive.

    One piece in, one record out, so a streamed split stays streamed: holding
    the flattened copy of a city network is as expensive as holding the split
    one, and there is no reason for either to exist.
    """
    for piece in pieces:
        yield flatten_segment(piece)


def flatten_network(
    result: SplitResult,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Split output -> (edge records, node records) for the member layers."""
    edges = list(flatten_edges(result.segments))
    nodes = [flatten_connector(connector) for connector in result.connectors]
    return edges, nodes


def flatten_segment(piece: Dict[str, Any]) -> Dict[str, Any]:
    """One flat edge record, with everything else in the ``overture`` residual."""
    connectors = piece.get("connectors") or []
    residual: Dict[str, Any] = {}

    record: Dict[str, Any] = {
        "id": piece.get("id"),
        "original_id": piece.get("original_id"),
        "class": piece.get("class"),
        "subclass": _scalar_rule(piece, "subclass_rules", "value", residual)
        or piece.get("subclass"),
        "name": _resolve_name(piece),
        # The two endpoint connectors are the topology the routing artifact needs.
        "source_node": _connector_id(connectors, 0),
        "target_node": _connector_id(connectors, 1),
        "surface": _scalar_rule(piece, "road_surface", "value", residual),
        "coordinates": piece.get("coordinates"),
    }

    forward, backward, unexpressed = _directional_speeds(piece)
    record["speed_limit_kph_forward"] = forward
    record["speed_limit_kph_backward"] = backward
    # Only the rules the two numbers could not express — a limit that applies at
    # certain hours, a denial aimed at another mode. A plain "50 km/h" is fully
    # captured by the column and is not stored twice.
    residual.update(unexpressed)

    record["other"] = _residual_json(piece, residual)
    return record


def flatten_connector(connector: Dict[str, Any]) -> Dict[str, Any]:
    """One flat node record."""
    # No `is_synthetic`: a minted node's own id says so. The splitter names it
    # `{segment_id}@{linear_reference}`, and no GERS id contains an "@" — so a
    # column repeating it would be a second copy of the same fact, kept in step
    # by hand.
    return {
        "id": connector.get("id"),
        "coordinate": connector.get("coordinate"),
    }


def _resolve_name(piece: Dict[str, Any]) -> Optional[str]:
    """The best available well-known name, or None when there genuinely isn't one.

    ``names.primary`` covers essentially every named road — in Augsburg and
    Garching there is not a single case of ``names`` present without it — but the
    ``common`` and ``rules`` fallbacks cost nothing and guard a differently
    populated extract.

    A route reference is the useful last resort: an unnamed trunk road is usually a
    numbered one, so ``B 17`` beats a blank. The bulk of unnamed roads are service
    roads, footways and paths that carry no identifier anywhere, and those stay
    null rather than being given something invented.
    """
    names = piece.get("names") or {}
    primary = names.get("primary")
    if primary:
        return str(primary)

    common = names.get("common") or {}
    if isinstance(common, dict):
        for value in common.values():
            if value:
                return str(value)

    for rule in names.get("rules") or []:
        if isinstance(rule, dict) and rule.get("value"):
            return str(rule["value"])

    for route in piece.get("routes") or []:
        if not isinstance(route, dict):
            continue
        # `ref` is the label a map would show ("B 17"); `name` spells it out.
        for key in ("ref", "name"):
            if route.get(key):
                return str(route[key])
    return None


# --- geometric-only properties --------------------------------------------


def _scalar_rule(
    piece: Dict[str, Any],
    field: str,
    key: str,
    residual: Dict[str, Any],
) -> Any:
    """The single surviving rule's value for a geometric-only property.

    If a rule still carries ``between`` — impossible while we split at every
    boundary, but reachable if that is ever relaxed — the raw field is added to
    the residual as well, so widening the column set can never lose data.
    """
    rules = [r for r in (piece.get(field) or []) if isinstance(r, dict)]
    if not rules:
        return None
    if any(r.get(LR_SCOPE_KEY) for r in rules) or len(rules) > 1:
        residual[field] = piece.get(field)
        logger.debug(
            "%s on %s did not reduce to one value; kept in residual",
            field,
            piece.get("id"),
        )
    return rules[0].get(key)


# --- speed limits ---------------------------------------------------------


def _directional_speeds(
    piece: Dict[str, Any],
) -> Tuple[Optional[int], Optional[int], Dict[str, List[Dict[str, Any]]]]:
    """``(forward, backward, rules_that_did_not_match)`` in km/h.

    One column per direction carries the whole story, so downstream needs only
    the class and these two numbers:

    * ``None`` — the class is not drivable at all (footway, steps, cycleway …),
      so a speed limit is not a meaningful value;
    * a number — Overture stated it, or the class default where it did not;
    * ``0``    — cars may not traverse in that direction. Overture's schema puts
      ``speed.value`` at a minimum of 1, so 0 can never collide with a real
      limit, and it is already how the routing engine spells "impassable".

    Access is evaluated the way the schema specifies, for the fact pattern "an
    ordinary car, travelling through, at no particular time": a rule matches when
    its ``heading`` is absent or equals the direction and its ``mode`` is absent
    or names a mode a car belongs to, and **the last matching rule wins** — rules
    are written general-first, specific-last, following OSM conditional
    restrictions. With no matching rule the direction is open.
    """
    road_class = piece.get("class")
    effective = road_class if road_class in ROUTING_CLASSES else "unknown"
    default = CLASS_DEFAULT_MAXSPEED.get(effective)
    if default is None:
        # Not a drivable class: no speed applies in either direction, and an
        # access rule cannot make one apply — so nothing was expressed and every
        # rule has to be carried.
        return (
            None,
            None,
            _unexpressed(piece.get("speed_limits"), piece.get("access_restrictions")),
        )

    stated_forward, stated_backward, speed_unexpressed = _stated_speeds(piece)
    forward = stated_forward if stated_forward is not None else default
    backward = stated_backward if stated_backward is not None else default

    open_forward, open_backward, access_unexpressed = _car_access(piece)
    if not open_forward:
        forward = 0
    if not open_backward:
        backward = 0

    return forward, backward, _unexpressed(speed_unexpressed, access_unexpressed)


def _unexpressed(
    speed_limits: Optional[List[Dict[str, Any]]],
    access_restrictions: Optional[List[Dict[str, Any]]],
) -> Dict[str, List[Dict[str, Any]]]:
    """Keyed by field, omitting the empties, ready to merge into the residual."""
    out: Dict[str, List[Dict[str, Any]]] = {}
    if speed_limits:
        out["speed_limits"] = list(speed_limits)
    if access_restrictions:
        out["access_restrictions"] = list(access_restrictions)
    return out


def _car_access(piece: Dict[str, Any]) -> Tuple[bool, bool, List[Dict[str, Any]]]:
    """Whether a car may traverse each direction. See ``_directional_speeds``."""
    forward: Optional[bool] = None
    backward: Optional[bool] = None
    unmatched: List[Dict[str, Any]] = []

    for rule in piece.get("access_restrictions") or []:
        if not isinstance(rule, dict):
            continue
        when = rule.get("when") or {}

        if any(when.get(scope) for scope in _SITUATIONAL_SCOPES):
            unmatched.append(rule)
            continue

        modes = when.get("mode") or []
        if modes and not (set(modes) & CAR_MODES):
            unmatched.append(rule)
            continue

        access_type = rule.get("access_type")
        if access_type == _ACCESS_DENIED:
            state = False
        elif access_type in _ACCESS_OPEN:
            state = True
        else:
            logger.debug("Unknown access_type %r on %s", access_type, piece.get("id"))
            unmatched.append(rule)
            continue

        heading = when.get("heading")
        if heading == "forward":
            forward = state
        elif heading == "backward":
            backward = state
        else:
            forward = backward = state

    return (
        True if forward is None else forward,
        True if backward is None else backward,
        unmatched,
    )


def _stated_speeds(
    piece: Dict[str, Any],
) -> Tuple[Optional[int], Optional[int], List[Dict[str, Any]]]:
    """Speeds Overture actually states, averaged per direction.

    data_preparation averages every applicable limit rather than taking the last,
    so a segment carrying two takes the mean. A rule scoped by time, mode or
    vehicle cannot become a static value and is returned for the residual.
    """
    both: List[int] = []
    forward: List[int] = []
    backward: List[int] = []
    conditional: List[Dict[str, Any]] = []

    for rule in piece.get("speed_limits") or []:
        if not isinstance(rule, dict):
            continue
        when = rule.get("when") or {}
        if any(value for key, value in when.items() if key not in _EXPRESSIBLE_SCOPES):
            conditional.append(rule)
            continue
        speed = _to_kph(rule.get("max_speed"))
        if speed is None:
            conditional.append(rule)
            continue
        heading = when.get("heading")
        if heading == "forward":
            forward.append(speed)
        elif heading == "backward":
            backward.append(speed)
        else:
            both.append(speed)

    return (
        _mean(forward) if forward else _mean(both),
        _mean(backward) if backward else _mean(both),
        conditional,
    )


def _mean(values: List[int]) -> Optional[int]:
    return round(sum(values) / len(values)) if values else None


def _to_kph(max_speed: Any) -> Optional[int]:
    if not isinstance(max_speed, dict):
        return None
    value = max_speed.get("value")
    if value is None:
        return None
    unit = max_speed.get("unit")
    if unit == "mph":
        return int(round(float(value) * _MPH_TO_KPH))
    return int(value)


# --- residual -------------------------------------------------------------


def _residual_json(
    piece: Dict[str, Any],
    residual: Dict[str, Any],
) -> Optional[str]:
    """Serialise everything the columns don't carry.

    Anything not in ``_CONSUMED_FIELDS`` lands here, so a field Overture adds
    later survives instead of vanishing on the first import that sees it. That
    default is what keeps the layer lossless — the price is that adding a column
    means adding its source field to ``_CONSUMED_FIELDS``, or the value ends up
    stored twice.
    """
    payload = dict(residual)
    for key, value in piece.items():
        if key not in _CONSUMED_FIELDS and value is not None:
            payload[key] = value

    return json.dumps(payload, sort_keys=True, default=str) if payload else None


# Overture fields the columns are derived from — everything else is residual.
# Must stay in step with `flatten_segment`; `test_no_field_is_both_flattened_and
# _residual` holds that invariant.
_CONSUMED_FIELDS = frozenset(
    {
        # promoted to columns
        "id",
        "original_id",
        # Added by the splitter, not Overture data, and encoded in `id` — kept out
        # of both the columns and the residual.
        "start_lr",
        "end_lr",
        "subtype",
        "class",
        "subclass",
        # Only the primary name is wanted; the variant/language/LR-scoped rules
        # under it are 3 MB a city and nothing displays them.
        "names",
        "connectors",
        "coordinates",
        "road_surface",
        "subclass_rules",
        # read for the speed and access columns; conditional rules within them
        # are put back into the residual by `flatten_segment`
        "speed_limits",
        "access_restrictions",
        # reader/splitter bookkeeping, not layer data
        "geometry",
        "theme",
        "type",
        "version",
        # Overture's own bounding box: fully derivable from the geometry, and it
        # was 15 MB of the residual on a 139k-edge city before being listed here.
        "bbox",
        # Per-edge upstream provenance (OSM way id, licence, update time). 19 MB
        # on that same city — more than the rest of the layer — and nothing reads
        # it. ODbL attribution is a dataset-level obligation, so it belongs once
        # on the bundle rather than 139k times here.
        "sources",
    }
)


def _connector_id(connectors: Sequence[Dict[str, Any]], index: int) -> Optional[str]:
    if len(connectors) <= index:
        return None
    connector_id = connectors[index].get("connector_id")
    return str(connector_id) if connector_id is not None else None

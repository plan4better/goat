"""A stored layer filter as the filter panel's rows, and the rows back.

A layer's filter is stored as `{cql, ui?, metadata?}`: `cql` holds the active
rows under one `and` (match all) or `or` (match any), also a single row, and
the drawn area first under `and` with the rows that match any beside it as one
`or` group; `ui` holds the notes (switched-off rows with their position among
all rows, the area's pieces and a switched-off area's CQL, "match any" where
the CQL cannot say it); `metadata` is kept as it is. `read_rows` splits a
stored query the way the panel's reader does (`readFilter` in
`apps/web/lib/filter/read.ts`) and `write_rows` puts the rows back as the
panel's writer and its save do (`writeFilter` in `write.ts`, `apply` in
`hooks/map/useLayerFilter.ts`), so for a query in the panel's form
`write_rows(read_rows(query, fields)) == query`.

Every condition, note and metadata value is opaque: it is passed through as
the same object, never rewritten. Where the panel's writer would spell a row
anew (a row saved in an older spelling, an area without notes), the rows keep
what was stored. The shared fixture `tests/unit/filter/fixtures/filter_rows.json`
holds both sides to the same answers. Standard library only: the assistant
imports it.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from goatlib.filter.convert import _is_area, _row_of


@dataclass(frozen=True)
class Row:
    """One row: its condition as stored, whether it is switched on, the days
    of a relative date note, and what the panel reads it as (`_row_of`: field,
    operator and value; None for a custom row)."""

    cql: Any
    enabled: bool = True
    relative_days: int | None = None
    panel: dict[str, Any] | None = None


@dataclass(frozen=True)
class Rows:
    """A filter's rows in order, active and switched off, and what goes with
    them. `area` is the area's CQL node as stored, active or switched off;
    `area_notes` is `ui.area` as stored. The area is switched off when its
    notes hold `off`."""

    match: Literal["all", "any"]
    rows: tuple[Row, ...]
    area: Any = None
    area_notes: Any = None
    metadata: Any = None


#: The keys of a stored query.
_PARTS = ("cql", "ui", "metadata")


def _is_index(v: Any) -> bool:
    """A whole number from 0, as the notes' `position` takes it."""
    if isinstance(v, bool):
        return False
    if isinstance(v, float):
        return v.is_integer() and v >= 0
    return isinstance(v, int) and v >= 0


def _panel(node: Any, fields: dict[str, str]) -> dict[str, Any] | None:
    try:
        return _row_of(node, fields)
    except Exception:
        # Nothing in the reader should raise; a node that makes it anyway is a custom row.
        return None


def _area(node: Any) -> bool:
    try:
        return _is_area(node)
    except Exception:
        # A geometry that cannot be read (a number too large for a float) is no area: it stays a row.
        return False


def _notes(ui: Any) -> dict[str, Any]:
    """The well-formed notes (`readNotes`): off rows, relative notes, the area's
    notes and "match any"; nothing for notes of another version."""
    v = ui.get("v") if isinstance(ui, dict) else None
    if isinstance(v, bool) or v != 1:
        return {}
    notes: dict[str, Any] = {}
    off = ui.get("off")
    if isinstance(off, list):
        notes["off"] = [
            (int(e["at"]), e["cql"])
            for e in off
            if isinstance(e, dict)
            and _is_index(e.get("at"))
            and e.get("cql") is not None
        ]
    relative = ui.get("relative")
    if isinstance(relative, list):
        notes["relative"] = [
            (int(e["at"]), int(e["days"]))
            for e in relative
            if isinstance(e, dict)
            and _is_index(e.get("at"))
            and _is_index(e.get("days"))
            and e["days"] > 0
        ]
    if isinstance(ui.get("area"), dict):
        notes["area"] = ui["area"]
    notes["any"] = ui.get("any") is True
    return notes


def _readable_area(notes: Any) -> bool:
    """Whether the panel reads the area's notes (`readAreaNotes`): it drops
    them whole when one piece is malformed, and a switched-off area with
    them."""
    # areas imports this module, so it is imported here.
    from goatlib.filter.areas import _read_notes

    return _read_notes(notes) is not None


def _top_level(cql: Any) -> tuple[Literal["all", "any"], list[Any]]:
    """The top level's args with the match, or the top level as the only arg."""
    if (
        isinstance(cql, dict)
        and cql.get("op") in ("and", "or")
        and isinstance(cql.get("args"), list)
    ):
        return ("all" if cql["op"] == "and" else "any"), list(cql["args"])
    if cql is None or (isinstance(cql, dict) and not cql):
        return "all", []
    return "all", [cql]


def _stored(query: Any) -> tuple[Any, Any, Any]:
    """The CQL, notes and metadata of a stored query. A query without any of
    their keys is the CQL itself, as filters were saved long ago."""
    if query is None or (isinstance(query, dict) and not query):
        return None, None, None
    if isinstance(query, dict) and any(k in query for k in _PARTS):
        return query.get("cql"), query.get("ui"), query.get("metadata")
    return query, None, None


def read_rows(query: Any, fields: Mapping[str, str] | None) -> Rows:
    """The rows of a stored filter as the panel reads them; never raises.

    The top level `and` or `or` is the match and each of its args one row; a top
    level of another kind is one row (a bare condition, as older saves and
    `to_cql2` of one condition write it), and anything no row says is a custom
    row holding the expression whole. An area is taken out of the rows under
    `and` (or alone); one `or` group beside it is the rows matching any, unless
    one row says the group (a value list) and no note says "match any". The
    switched-off rows come from `ui.off`, put back at their positions in order.
    `fields` are the layer's field types by name; None reads each row with the
    type its value shows, so a row that needs the field's type is custom.

    For a query in the panel's form `write_rows` gives it back unchanged. For
    any other (a bare condition, a top level that is no `and` or `or`, notes of
    another version or entries the panel does not read, a switched-off row at a
    position past the end, notes holding nothing but the version) it gives the
    panel's form of it: what the panel saves after reading it.
    """
    known = dict(fields) if fields is not None else {}
    cql, ui, metadata = _stored(query)
    notes = _notes(ui)
    match, args = _top_level(cql)
    area: Any = None
    area_notes: Any = None
    # An area that is one of several alternatives is no area of the filter: it stays a row.
    at = (
        next((i for i, a in enumerate(args) if _area(a)), -1)
        if match == "all" or len(args) == 1
        else -1
    )
    if at >= 0:
        area = args.pop(at)
        area_notes = notes.get("area")
        if isinstance(area_notes, dict) and "off" in area_notes:
            # An active area: the panel writes its notes without a switched-off one.
            area_notes = {k: v for k, v in area_notes.items() if k != "off"}
        group = args[0] if len(args) == 1 else None
        if (
            isinstance(group, dict)
            and group.get("op") == "or"
            and isinstance(group.get("args"), list)
            and (notes.get("any") or _panel(group, known) is None)
        ):
            match, args = "any", list(group["args"])
        else:
            match = "any" if not args and notes.get("any") else "all"
    else:
        noted = notes.get("area")
        if noted is not None and _area(noted.get("off")) and _readable_area(noted):
            area, area_notes = noted["off"], noted
        if not args and notes.get("any"):
            match = "any"

    slots: list[tuple[Any, bool]] = [(node, True) for node in args]
    for position, node in sorted(notes.get("off", []), key=lambda e: e[0]):
        slots.insert(min(position, len(slots)), (node, False))
    relative = notes.get("relative", [])
    rows = tuple(
        Row(
            cql=node,
            enabled=enabled,
            relative_days=next((d for a, d in relative if a == i), None),
            panel=_panel(node, known),
        )
        for i, (node, enabled) in enumerate(slots)
    )
    return Rows(
        match=match,
        rows=rows,
        area=area,
        area_notes=area_notes,
        metadata=metadata,
    )


def write_rows(rows: Rows) -> dict[str, Any] | None:
    """The stored filter of the rows, as the panel saves it, or None when
    nothing is left (no row, no area and no metadata).

    `cql` holds the active rows under `and` or `or`, also a single row; an
    active area comes first under `and` with the rows that match any beside it
    as one `or` group. `ui` holds the switched-off rows and the relative date
    notes at their positions among all rows (counted from `rows`, so they follow
    rows that were added, removed or moved), the area's notes as given (with
    the area as `off` while it is switched off) and `any` where the CQL cannot
    say it; it is left out when it would hold nothing but its version. Without
    an active row or area there is no `cql`: a filter of switched-off rows or a
    switched-off area alone is `{"ui": ...}`. A row whose `cql` is None is left
    out and does not count for the positions.
    """
    active: list[Any] = []
    off: list[dict[str, Any]] = []
    relative: list[dict[str, Any]] = []
    for row in rows.rows:
        if row.cql is None:
            continue
        at = len(active) + len(off)
        if row.enabled:
            active.append(row.cql)
        else:
            off.append({"at": at, "cql": row.cql})
        if row.relative_days is not None:
            relative.append({"at": at, "days": row.relative_days})
    notes = rows.area_notes
    switched_off = isinstance(notes, dict) and "off" in notes
    on = rows.area if rows.area is not None and not switched_off else None
    any_ = rows.match == "any"
    cql: dict[str, Any] | None = None
    if on is not None:
        rest = [{"op": "or", "args": active}] if any_ and active else active
        cql = {"op": "and", "args": [on, *rest]}
    elif active:
        cql = {"op": "or" if any_ else "and", "args": active}
    ui: dict[str, Any] = {"v": 1}
    if off:
        ui["off"] = off
    if relative:
        ui["relative"] = relative
    if rows.area is not None and notes is not None:
        ui["area"] = (
            {**notes, "off": rows.area}
            if switched_off and notes["off"] is not rows.area
            else notes
        )
    if any_ and (on is not None or not active) and (active or off):
        ui["any"] = True
    out: dict[str, Any] = {}
    if rows.metadata is not None:
        out["metadata"] = rows.metadata
    if cql is not None:
        out["cql"] = cql
    if len(ui) > 1:
        out["ui"] = ui
    return out or None

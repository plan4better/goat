"""Grading of the map suite on what core stored: the styles and the map
state of the map project in the snapshots the harness took
(``Transcript.map_before``, ``map_before_answer``, ``map_after``,
``map_undone``), and the view the answer's ``map_update`` calls set.

Computed values carry the time they were computed (``computed.at``), so
documents are compared without those stamps. Rasters are graded on the
stored document only: nothing reads their pixels."""

import functools
import re
from collections.abc import Iterable, Sequence
from typing import Any

import duckdb
from goatlib.filter.areas import (
    REGION_SOURCE,
    FeaturesPiece,
    ShapePiece,
    ViewPiece,
    read_area,
)
from goatlib.filter.rows import read_rows
from goatlib.style.catalog import palettes
from goatlib.style.compute import without_stamps
from goatlib.style.map_rows import GroupRow, LayerRow, build_map_document
from goatlib.style.pointer import get, parse_pointer, to_pointer
from shapely.errors import ShapelyError

from evals.backends import selected_features
from evals.harness import Transcript
from evals.map_backends import _connection, _style_check
from evals.map_fixture import MAP_LAYERS_BY_ID, map_layer
from evals.tasks import (
    AreaRule,
    ClassRule,
    LayerRule,
    MapCheck,
    PathRule,
    StyleCheck,
    ViewCheck,
)

#: The property a classification sets when it names no ``target`` (spec 5).
MAIN_COLOR = {"polygon": "fill.color", "line": "line.color", "point": "marker.color"}
#: Draw order of the layer positions: "top" layers above the basemap's labels,
#: "below_roads" layers under its roads.
POSITIONS = ("top", "below_labels", "below_roads")
_MISSING = object()


# ---- documents ---------------------------------------------------------------------


def value_at(document: Any, path: str) -> Any:
    """The value at a pointer; a classification is also found by its field
    (``/classify/density`` where the classification's id is another).
    ``_MISSING`` where nothing is."""
    try:
        return get(document, path)
    except (KeyError, ValueError, TypeError):
        pass
    segments = parse_pointer(path) if path.startswith("/") else []
    if len(segments) >= 2 and segments[0] == "classify":
        items = document.get("classify") if isinstance(document, dict) else None
        for item in items if isinstance(items, list) else []:
            if isinstance(item, dict) and item.get("field") == segments[1]:
                try:
                    return get(item, to_pointer(segments[2:]))
                except (KeyError, ValueError, TypeError):
                    return _MISSING
    return _MISSING


def _number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def path_problem(document: Any, rule: PathRule) -> str | None:
    """Why the value at the rule's path breaks it; None when it holds."""
    value = value_at(document, rule.path)
    shown = "missing" if value is _MISSING else repr(value)
    present = value is not _MISSING and value is not None and value is not False
    if rule.exists is not None and present != rule.exists:
        return (
            f"{rule.path} is {shown}, expected it {'set' if rule.exists else 'absent'}"
        )
    if "equals" in rule.model_fields_set and (
        value is _MISSING or value != rule.equals
    ):
        return f"{rule.path} is {shown}, expected {rule.equals!r}"
    if rule.one_of is not None and (value is _MISSING or value not in rule.one_of):
        return f"{rule.path} is {shown}, expected one of {rule.one_of}"
    if rule.below is not None and not (_number(value) and value < rule.below):
        return f"{rule.path} is {shown}, expected below {rule.below}"
    if rule.above is not None and not (_number(value) and value > rule.above):
        return f"{rule.path} is {shown}, expected above {rule.above}"
    if rule.pattern is not None and not (
        isinstance(value, str) and re.search(rule.pattern, value)
    ):
        return f"{rule.path} is {shown}, expected text matching {rule.pattern!r}"
    return None


def _classifications(document: dict[str, Any]) -> Iterable[tuple[str, dict[str, Any]]]:
    """Every classification with its pointer: a raster's one, a vector
    style's by id (or index)."""
    render = document.get("render")
    if isinstance(render, dict) and isinstance(render.get("classify"), dict):
        yield "/render/classify", render["classify"]
    items = document.get("classify")
    for index, item in enumerate(items if isinstance(items, list) else []):
        if isinstance(item, dict):
            key = item["id"] if isinstance(item.get("id"), str) else str(index)
            yield to_pointer(["classify", key]), item


def _target(classification: dict[str, Any], geometry: str) -> str:
    return str(classification.get("target") or MAIN_COLOR.get(geometry, ""))


def _value_form(
    document: dict[str, Any], rule: ClassRule, geometry: str
) -> dict[str, Any] | None:
    """A value by attribute of the rule's field at the rule's target."""
    target = rule.target or MAIN_COLOR.get(geometry, "")
    form = value_at(document, "/symbol/" + target.replace(".", "/"))
    if isinstance(form, dict) and form.get("field") == rule.field:
        return form
    return None


def palette_kind(palette: Any) -> str | None:
    """The kind of a catalogue palette, by its id, or of a list of colors
    that equals a catalogue palette's colors or one of its schemes per class
    count."""
    if isinstance(palette, str):
        found = palettes().get(palette)
        return found.kind if found else None
    if isinstance(palette, list):
        colors = tuple(str(c).lower() for c in palette)
        for candidate in palettes().values():
            schemes = [candidate.colors, *candidate.variants.values()]
            if any(tuple(c.lower() for c in s) == colors for s in schemes):
                return str(candidate.kind)
    return None


def _class_colors(classification: dict[str, Any], target: str) -> list[Any]:
    path = "/" + target.replace(".", "/")
    return [
        value_at(record, path)
        for record in classification.get("classes") or []
        if isinstance(record, dict)
    ]


def _kind_of(classification: dict[str, Any], target: str) -> str | None:
    """The palette kind of a classification. Categories without a palette
    whose classes each set a color of their own count as qualitative."""
    kind = palette_kind(classification.get("palette"))
    if kind is None and classification.get("method") == "categories":
        colors = _class_colors(classification, target)
        if (
            colors
            and _MISSING not in colors
            and len(set(map(str, colors))) == len(colors)
        ):
            return "qualitative"
    return kind


def class_shares(
    document: dict[str, Any], pointer: str, features: Sequence[dict[str, Any]]
) -> tuple[list[float], float, float]:
    """For the classification at ``pointer``: the share of ``features`` in
    each class, in no class, and without a value, each of all features."""
    classification = value_at(document, pointer)
    if not isinstance(classification, dict) or not features:
        return [], 0.0, 0.0
    field = classification.get("field")
    records = [r for r in classification.get("classes") or [] if isinstance(r, dict)]
    counts = [0] * len(records)
    other = no_value = 0
    for feature in features:
        value = feature.get(field) if isinstance(field, str) else None
        if value is None:
            no_value += 1
            continue
        index = next(
            (i for i, record in enumerate(records) if _in_class(value, record)), None
        )
        if index is None:
            other += 1
        else:
            counts[index] += 1
    total = len(features)
    return [c / total for c in counts], other / total, no_value / total


def _in_class(value: Any, record: dict[str, Any]) -> bool:
    if record.get("values") is not None:
        return any(value == v or str(value) == str(v) for v in record["values"])
    if not _number(value):
        return False
    low, high = record.get("from"), record.get("to")
    return (low is None or value >= low) and (high is None or value < high)


# ---- snapshots ---------------------------------------------------------------------


def _styles_of(snapshot: dict[str, Any], link: int) -> dict[str, dict[str, Any]]:
    return {
        style_id: style
        for style_id, style in snapshot["styles"].items()
        if style["layer_project_id"] == link
    }


def _active(snapshot: dict[str, Any], link: int) -> str | None:
    """The style the map draws for a layer (``MapState.active_style_id``)."""
    row = snapshot["layers"].get(link)
    if row is None:
        return None
    styles = sorted(
        _styles_of(snapshot, link).values(), key=lambda s: (s["position"], s["id"])
    )
    return row["active_style_id"] or (styles[0]["id"] if styles else None)


def _looks(snapshot: dict[str, Any], links: Iterable[int] | None = None) -> Any:
    """The styles as a viewer sees them: names, documents without stamps and
    the active style per layer; revisions aside, as Undo saves again."""
    chosen = set(snapshot["layers"]) if links is None else set(links)
    return (
        {
            style_id: (style["name"], without_stamps(style["document"]))
            for style_id, style in snapshot["styles"].items()
            if style["layer_project_id"] in chosen
        },
        {link: _active(snapshot, link) for link in sorted(chosen)},
    )


@functools.cache
def _tables() -> duckdb.DuckDBPyConnection:
    return _connection()


def stored_errors(link: int, document: dict[str, Any]) -> list[str]:
    """The error and damage codes processes' check finds in a stored style."""
    _, issues = _style_check(
        _tables, map_layer(link), document, compute=False, stored=True
    )
    return [f"{i.code} at {i.path}" for i in issues if i.level in ("error", "damaged")]


def _popup_fields(document: dict[str, Any]) -> set[str]:
    popup = document.get("popup")
    if not isinstance(popup, dict) or popup.get("enabled") is False:
        return set()
    html = popup.get("mode") == "html"
    texts = [str(popup.get("html") or "")] if html else []
    names: set[str] = set()
    for block in [] if html else popup.get("blocks") or []:
        if not isinstance(block, dict):
            continue
        names.update(
            str(a.get("field"))
            for a in block.get("attributes") or []
            if isinstance(a, dict) and a.get("field")
        )
        if block.get("field"):
            names.add(str(block["field"]))
        texts += [str(block.get("html") or ""), str(block.get("url_template") or "")]
    for text in texts:
        names.update(re.findall(r"\{\{\s*([\w.]+)", text))
    return names


def _snapshots(transcript: Transcript) -> tuple[dict[str, Any], dict[str, Any]] | None:
    if transcript.map_before is None or transcript.map_after is None:
        return None
    return transcript.map_before, transcript.map_after


# ---- style -------------------------------------------------------------------------


def _classification_problems(
    rule: ClassRule,
    document: dict[str, Any],
    link: int,
    check: StyleCheck,
    query: Any,
) -> list[str]:
    layer = map_layer(link)
    raster = document.get("kind") == "raster"
    found = [
        (pointer, item)
        for pointer, item in _classifications(document)
        if raster or item.get("field") == rule.field
    ]
    if not found:
        form = None if raster else _value_form(document, rule, layer.geometry)
        if form is None:
            return [f"no classification of {rule.field}"]
        if "by_attribute" not in rule.methods:
            return [f"{rule.field} by attribute, expected classes {rule.methods}"]
        kind = palette_kind(form.get("palette"))
        if rule.palette_kind and kind != rule.palette_kind:
            return [
                f"palette {form.get('palette')!r} is {kind}, expected {rule.palette_kind}"
            ]
        return []
    # The classification that sets the rule's target, else the first.
    pointer, item = next(
        (
            (p, i)
            for p, i in found
            if rule.target is None or _target(i, layer.geometry) == rule.target
        ),
        found[0],
    )
    problems = []
    target = _target(item, layer.geometry)
    if rule.target is not None and not raster and target != rule.target:
        problems.append(f"target {target}, expected {rule.target}")
    if item.get("method") not in rule.methods:
        problems.append(f"method {item.get('method')}, expected one of {rule.methods}")
    count = len(item.get("classes") or [])
    if not rule.min_classes <= count <= rule.max_classes:
        problems.append(
            f"{count} classes, expected {rule.min_classes} to {rule.max_classes}"
        )
    if rule.palette_kind:
        kind = _kind_of(item, target)
        if kind != rule.palette_kind:
            problems.append(
                f"palette {item.get('palette')!r} is {kind}, expected {rule.palette_kind}"
            )
    if check.legend is not None and not raster:
        features = _kept_features(link, query)
        if features is None:
            return [*problems, f"the filter of {link} cannot be evaluated"]
        shares, other, _ = class_shares(document, pointer, features)
        if (
            check.legend.max_share is not None
            and shares
            and max(shares) > check.legend.max_share
        ):
            problems.append(
                f"one class holds a share of {max(shares):.2f}, "
                f"at most {check.legend.max_share}"
            )
        if check.legend.max_other is not None and other > check.legend.max_other:
            problems.append(
                f"a share of {other:.2f} in no class, at most {check.legend.max_other}"
            )
    return problems


def _kept_features(link: int, query: Any) -> list[dict[str, Any]] | None:
    """The fixture layer's features its stored filter keeps, as the
    statistics stand-ins count them (``selected_features``); None when the
    filter holds a condition the stand-in cannot evaluate."""
    cql = query.get("cql") if isinstance(query, dict) else None
    try:
        return selected_features(map_layer(link), cql or None)
    except (KeyError, IndexError, TypeError, ValueError, ShapelyError):
        return None


def grade_style(check: StyleCheck, transcript: Transcript) -> tuple[bool, str]:
    snapshots = _snapshots(transcript)
    if snapshots is None:
        return False, "no snapshot of the map project"
    before, after = snapshots
    link = check.layer_project_id
    if link not in after["layers"]:
        return False, f"layer {link} is gone"
    styles_before = _styles_of(before, link)
    styles_after = _styles_of(after, link)
    if link not in before["layers"]:
        styles_before = _arrived_with(styles_after)
    active_before = _active(before, link) or next(iter(styles_before), None)
    active_after = _active(after, link)
    if active_before is None or active_after is None:
        return False, f"layer {link} has no style"
    created = [s for s in styles_after if s not in styles_before]
    problems: list[str] = []
    if check.where == "same" and (active_after != active_before or created):
        problems.append(
            f"not edited in place: active {styles_after[active_after]['name']!r}, "
            f"{len(created)} style(s) made"
        )
    if check.where == "new" and active_after in styles_before:
        problems.append(f"no new style active ({styles_after[active_after]['name']!r})")
    if check.where == "any" and active_after not in (active_before, *created):
        problems.append(
            f"another style active ({styles_after[active_after]['name']!r})"
        )
    if check.variants is not None and len(created) < check.variants:
        problems.append(f"{len(created)} variant(s) made, expected {check.variants}")
    if check.active_variant is not None:
        made = sorted(created, key=lambda s: (styles_after[s]["position"], s))
        place = made.index(active_after) + 1 if active_after in made else None
        if place != check.active_variant:
            drawn = (
                "a style from before"
                if place is None
                else f"the style made {_ordinal(place)}"
            )
            problems.append(
                f"{drawn} is active, expected the {_ordinal(check.active_variant)}"
            )
    document = styles_after[active_after]["document"]
    old = styles_before[active_before]["document"]
    if without_stamps(document) == without_stamps(old):
        problems.append("the style is unchanged")
    problems += stored_errors(link, document)
    if check.classification is not None:
        problems += _classification_problems(
            check.classification, document, link, check, after["layers"][link]["query"]
        )
    problems += [p for rule in check.paths if (p := path_problem(document, rule))]
    if check.paths_any:
        misses = [path_problem(document, rule) for rule in check.paths_any]
        if all(misses):
            problems.append("none of: " + "; ".join(m for m in misses if m))
    for pointer in check.unchanged:
        was, now = value_at(old, pointer), value_at(document, pointer)
        if without_stamps(was) != without_stamps(now):
            problems.append(f"{pointer} changed")
    if missing := sorted(set(check.popup_fields) - _popup_fields(document)):
        problems.append(f"the popup does not name {missing}")
    if check.undone:
        problems += _undo_problems(transcript, lambda s: _looks(s, [link]))
    if problems:
        return False, "; ".join(problems)
    return True, f"style {styles_after[active_after]['name']!r} meets the check"


def _arrived_with(styles: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """For a layer the answer added: its first style as it was first stored,
    which is the style the layer arrived with."""
    if not styles:
        return {}
    first = min(styles.values(), key=lambda s: (s["position"], s["id"]))
    document = first["revisions"][min(first["revisions"])]
    return {first["id"]: {**first, "document": document}}


def _ordinal(number: int) -> str:
    suffix = {1: "st", 2: "nd", 3: "rd"}.get(number if number < 20 else number % 10)
    return f"{number}{suffix or 'th'}"


def _undo_problems(transcript: Transcript, looks: Any) -> list[str]:
    before, after, undone = (
        transcript.map_before,
        transcript.map_after,
        transcript.map_undone,
    )
    if transcript.undo != "undone" or undone is None:
        return [f"not undone (Undo: {transcript.undo})"]
    if looks(after) == looks(before):
        return ["the answer changed nothing to undo"]
    if looks(undone) != looks(before):
        return ["after Undo the state differs from the one before"]
    return []


# ---- map ---------------------------------------------------------------------------


def _drawn(snapshot: dict[str, Any]) -> dict[int, tuple[int, bool, str]]:
    """Per layer: its place in the drawing order (0 on top), whether it is
    drawn (it and every group around it shown), its group's name. The tree is
    ordered as core orders it (``build_map_document``)."""
    groups = snapshot["groups"]
    document = build_map_document(
        basemap=None,
        locale=None,
        view_state=None,
        bounds=None,
        groups=[
            GroupRow(
                g, r["name"], r["parent_id"], r["order"], r["visible"], r["expanded"]
            )
            for g, r in groups.items()
        ],
        layers=[
            LayerRow(
                link,
                row["layer_project_group_id"],
                row["order"],
                row["visible"],
                row["position"],
                None,
                None,
                True,
                None,
            )
            for link, row in snapshot["layers"].items()
        ],
    )
    walked: list[tuple[int, bool, str]] = []

    def walk(items: list[dict[str, Any]], shown: bool, group: str) -> None:
        for item in items:
            visible = shown and bool(item.get("visible", True))
            if item["type"] == "group":
                walk(item.get("children") or [], visible, str(item["name"]))
            else:
                walked.append((int(item["id"]), visible, group))

    walk(document["layers"], True, "")
    ranked = sorted(
        range(len(walked)),
        key=lambda i: (
            POSITIONS.index(snapshot["layers"][walked[i][0]]["position"]),
            i,
        ),
    )
    return {
        walked[i][0]: (rank, walked[i][1], walked[i][2])
        for rank, i in enumerate(ranked)
    }


def _filter_parts(query: Any) -> tuple[list[Any], list[Any]]:
    """The condition rows of a stored filter and its drawn area expressions."""
    cql = query.get("cql") if isinstance(query, dict) else None
    if not isinstance(cql, dict) or not cql.get("op"):
        return [], []
    args = cql["args"] if cql["op"] in ("and", "or") else [cql]
    area = [a for a in args if isinstance(a, dict) and a.get("op") == "s_intersects"]
    return [a for a in args if a not in area], area


def _notes(query: Any) -> dict[str, Any]:
    ui = query.get("ui") if isinstance(query, dict) else None
    return ui if isinstance(ui, dict) else {}


def _area_problems(link: int, rule: AreaRule | str, query: Any) -> list[str]:
    """Why a layer filter's area breaks the rule, read as the filter panel
    reads it."""
    rows = read_rows(query, None)
    if rule == "none":
        return [] if rows.area is None else [f"{link} still has an area"]
    assert isinstance(rule, AreaRule)
    if rows.area is None:
        return [f"{link} has no area"]
    area = read_area(rows.area, rows.area_notes)
    if area is None:
        return [f"{link} area cannot be read"]
    problems = []
    if isinstance(rows.area_notes, dict) and "off" in rows.area_notes:
        problems.append(f"{link} area switched off")
    features = [p for p in area.pieces if isinstance(p, FeaturesPiece)]
    regions = sorted(
        f.id for p in features if p.source == REGION_SOURCE for f in p.features
    )
    sources = {p.source: len(p.features) for p in features if p.source != REGION_SOURCE}
    wanted = {map_layer(layer).layer_id for layer in rule.layers}
    if regions != sorted(rule.regions):
        problems.append(
            f"{link} area regions {regions}, expected {sorted(rule.regions)}"
        )
    if set(sources) != wanted:
        named = sorted(
            MAP_LAYERS_BY_ID[source].layer_project_id
            for source in sources
            if source in MAP_LAYERS_BY_ID
        )
        problems.append(f"{link} area layers {named}, expected {sorted(rule.layers)}")
    elif rule.features is not None and sum(sources.values()) != rule.features:
        problems.append(
            f"{link} area holds {sum(sources.values())} features, expected {rule.features}"
        )
    view = any(isinstance(p, ViewPiece) for p in area.pieces)
    if view != rule.view:
        problems.append(f"{link} area {'has' if view else 'lacks'} the map view")
    shapes = any(isinstance(p, ShapePiece) for p in area.pieces)
    if shapes != rule.shapes:
        problems.append(f"{link} area {'has' if shapes else 'lacks'} a drawn shape")
    if area.outside != rule.outside:
        problems.append(f"{link} area outside {area.outside}, expected {rule.outside}")
    return problems


def _rows_of(query: Any) -> tuple[str, list[tuple[Any, bool]]]:
    rows = read_rows(query, None)
    return rows.match, [(row.cql, row.enabled) for row in rows.rows]


def _layer_problems(
    link: int, rule: LayerRule, snapshot: dict[str, Any], before: dict[str, Any]
) -> list[str]:
    row = snapshot["layers"].get(link)
    if row is None:
        return [f"layer {link} is gone"]
    _, drawn, group = _drawn(snapshot)[link]
    problems = []
    if rule.visible is not None and drawn != rule.visible:
        problems.append(f"{link} {'drawn' if drawn else 'not drawn'}")
    for key, value in (
        ("position", row["position"]),
        ("name", row["name"]),
        ("group", group),
    ):
        expected = getattr(rule, key)
        if expected is not None and value != expected:
            problems.append(f"{link} {key} {value!r}, expected {expected!r}")
    if rule.active_style is not None:
        name = snapshot["styles"][_active(snapshot, link)]["name"]
        if name != rule.active_style:
            problems.append(
                f"{link} active style {name!r}, expected {rule.active_style!r}"
            )
    query = row["query"]
    rows, area = _filter_parts(query)
    if rule.filter_count is not None:
        selected = _kept_features(link, query)
        if selected is None:
            problems.append(f"the filter of {link} cannot be evaluated")
        elif len(selected) != rule.filter_count:
            problems.append(
                f"{link} keeps {len(selected)} features, expected {rule.filter_count}"
            )
    if rule.filter_rows is not None and len(rows) != rule.filter_rows:
        problems.append(
            f"{link} has {len(rows)} filter rows, expected {rule.filter_rows}"
        )
    off = _notes(query).get("off") or []
    if rule.off_rows is not None and len(off) != rule.off_rows:
        problems.append(
            f"{link} keeps {len(off)} switched-off rows, expected {rule.off_rows}"
        )
    if rule.area_kept is not None:
        old = before["layers"].get(link, {}).get("query")
        old_area, old_notes = _filter_parts(old)[1], _notes(old).get("area")
        kept = area == old_area and _notes(query).get("area") == old_notes
        if kept != rule.area_kept:
            problems.append(f"{link} area {'kept' if kept else 'changed'}")
    if rule.area is not None:
        problems += _area_problems(link, rule.area, query)
    if rule.rows_kept is not None:
        old = before["layers"].get(link, {}).get("query")
        kept = _rows_of(query) == _rows_of(old)
        if kept != rule.rows_kept:
            problems.append(f"{link} rows {'kept' if kept else 'changed'}")
    return problems


def _map_state(snapshot: dict[str, Any]) -> Any:
    """Everything a viewer of the map sees, revisions aside."""
    return (
        snapshot["layers"],
        snapshot["groups"],
        snapshot["basemap"],
        snapshot["scene"],
        snapshot["builder_config"],
        snapshot["removed"],
        _looks(snapshot),
    )


def grade_map(check: MapCheck, transcript: Transcript) -> tuple[bool, str]:
    snapshots = _snapshots(transcript)
    if snapshots is None:
        return False, "no snapshot of the map project"
    before, after = snapshots
    snapshot = after
    if check.before_answer:
        if transcript.map_before_answer is None:
            return False, "no card was answered"
        snapshot = transcript.map_before_answer
    problems: list[str] = []
    for link, rule in check.layers.items():
        problems += _layer_problems(link, rule, snapshot, before)
    drawn = _drawn(snapshot)
    for upper, lower in check.above:
        if upper not in drawn or lower not in drawn:
            problems.append(f"above: {upper} or {lower} is gone")
        elif drawn[upper][0] > drawn[lower][0]:
            problems.append(f"{upper} is not drawn above {lower}")
    if check.basemap is not None and snapshot["basemap"] != check.basemap:
        problems.append(f"basemap {snapshot['basemap']!r}, expected {check.basemap!r}")
    problems += [
        p for rule in check.scene if (p := path_problem(snapshot["scene"] or {}, rule))
    ]
    for link in check.removed:
        if link in snapshot["layers"] or link not in snapshot["removed"]:
            problems.append(f"{link} not removed")
    problems += [
        f"{link} removed" for link in check.kept if link not in snapshot["layers"]
    ]
    if check.writes == "none" and without_stamps(after) != without_stamps(before):
        problems.append("the answer stored a change")
    if check.undone:
        problems += _undo_problems(transcript, _map_state)
    if problems:
        return False, "; ".join(problems)
    return True, "the map meets the check"


# ---- view --------------------------------------------------------------------------


def grade_view(check: ViewCheck, transcript: Transcript) -> tuple[bool, str]:
    """The view the page ends with: each successful map_update's ``view``
    applied in order (later values win)."""
    calls = [
        call
        for call in transcript.tool_calls
        if call.name == "map_update"
        and not call.failed
        and isinstance(call.result, dict)
    ]
    view: dict[str, Any] = {}
    camera: dict[str, Any] = {}
    for call in calls:
        target = call.result.get("view")
        if isinstance(target, dict):
            camera.update(target.get("camera") or {})
            view.update({k: v for k, v in target.items() if v is not None})
            if target.get("bbox"):
                camera.pop("center", None)
            if (target.get("camera") or {}).get("center"):
                view.pop("bbox", None)
    if not view:
        return False, "no map_update set a view"
    problems = []
    if check.layer_project_id is not None:
        moves = [
            op
            for call in calls
            for op in call.args.get("operations") or []
            if isinstance(op, dict)
            and op.get("op") == "set_view"
            and (op.get("fit_layer_project_id") is not None or op.get("center"))
        ]
        fitted = moves[-1].get("fit_layer_project_id") if moves else None
        if fitted != check.layer_project_id:
            problems.append(f"framed layer {fitted}, expected {check.layer_project_id}")
    if check.contains is not None:
        lon, lat = check.contains
        bbox = view.get("bbox")
        if bbox:
            inside = bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]
        else:
            center = camera.get("center") or [999.0, 999.0]
            inside = abs(center[0] - lon) < 0.05 and abs(center[1] - lat) < 0.05
        if not inside:
            problems.append(f"{check.contains} not in the view")
    if check.mode is not None and view.get("mode") != check.mode:
        problems.append(f"mode {view.get('mode')}, expected {check.mode}")
    pitch = camera.get("pitch")
    if check.min_pitch is not None and not (
        isinstance(pitch, int | float)
        and not isinstance(pitch, bool)
        and pitch >= check.min_pitch
    ):
        problems.append(f"pitch {pitch}, expected at least {check.min_pitch}")
    if problems:
        return False, "; ".join(problems)
    return True, f"view {dict(view, camera=camera)}"

"""Whole-document checks that need no data (the specification's sections 3, 4.5, 5.7, 6.1, 8, 11).

They run on the raw document, so a document whose structure is partly invalid
still gets every finding these rules can make.
"""

from collections.abc import Iterator
from typing import Any

from goatlib.style.catalog import keeps_colors, palettes
from goatlib.style.context import DataContext
from goatlib.style.cql import as_text
from goatlib.style.issues import Fix, Issue, make_issue
from goatlib.style.models.classify import NUMERIC_METHODS
from goatlib.style.models.parts import PARTS, PER_LAYER_KEYS
from goatlib.style.pointer import item_key, to_pointer
from goatlib.style.template import liquid_to_label, problems

GEOMETRY_PARTS = {
    "point": ("marker", "outline", "label"),
    "line": ("line", "casing", "arrows", "label"),
    "polygon": ("fill", "outline", "label"),
}
MAIN_PART = {"point": "marker", "line": "line", "polygon": "fill"}
MAIN_COLOR = {"point": "marker.color", "line": "line.color", "polygon": "fill.color"}
FREE_COLOR = {
    "point": "outline.color",
    "line": "casing.color",
    "polygon": "outline.color",
}
POINT_RENDERS = ("heatmap", "cluster", "h3")
#: Classifications beyond this many are not compared pairwise (5.7); the model
#: refuses more than this anyway.
MAX_COMPARED = 50


def _marker_shape(doc: dict[str, Any]) -> Any:
    symbol = doc.get("symbol")
    marker = symbol.get("marker") if isinstance(symbol, dict) else None
    return marker.get("shape") if isinstance(marker, dict) else None


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def as_list(value: Any) -> list[Any]:
    """`value` when it is a list, else an empty list: the checks read raw documents."""
    return value if isinstance(value, list) else []


def record_places(doc: dict[str, Any]) -> list[tuple[list[str], dict[str, Any], bool]]:
    """Every record that sets parts: the base symbol, class records, `other`, `no_data`, rules."""
    out: list[tuple[list[str], dict[str, Any], bool]] = []
    if isinstance(doc.get("symbol"), dict):
        out.append((["symbol"], doc["symbol"], False))
    for ci, c in enumerate(as_list(doc.get("classify"))):
        if not isinstance(c, dict):
            continue
        cpath = ["classify", item_key(c, ci)]
        for ki, k in enumerate(as_list(c.get("classes"))):
            if isinstance(k, dict):
                out.append((cpath + ["classes", item_key(k, ki)], k, True))
        for extra in ("other", "no_data"):
            if isinstance(c.get(extra), dict):
                out.append((cpath + [extra], c[extra], True))
    for ri, r in enumerate(as_list(doc.get("rules"))):
        if isinstance(r, dict):
            out.append((["rules", item_key(r, ri)], r, True))
    return out


def part_values(
    record: dict[str, Any], path: list[str]
) -> Iterator[tuple[list[str], Any]]:
    """Every value a record's parts set, with its path: the part keys, the label's
    `halo` and `font` keys, and for values by zoom the value of each stop (4.4)."""
    for part in PARTS:
        value = record.get(part)
        if not isinstance(value, dict):
            continue
        for key, v in value.items():
            if key in ("halo", "font") and isinstance(v, dict):
                items = [([part, key, sub], sv) for sub, sv in v.items()]
            else:
                items = [([part, key], v)]
            for vpath, item in items:
                if isinstance(item, dict) and isinstance(item.get("zoom"), list):
                    for i, stop in enumerate(item["zoom"]):
                        if isinstance(stop, list) and len(stop) == 2:
                            yield path + vpath + ["zoom", str(i), "1"], stop[1]
                else:
                    yield path + vpath, item


def _duplicate_ids(issues: list[Issue], doc: dict[str, Any]) -> None:
    """Ids are unique in a document (section 1); a second use is addressed by index."""
    lists: list[tuple[list[str], list[Any]]] = [
        (["classify"], as_list(doc.get("classify"))),
        (["rules"], as_list(doc.get("rules"))),
    ]
    for ci, c in enumerate(as_list(doc.get("classify"))):
        if isinstance(c, dict):
            lists.append(
                (["classify", item_key(c, ci), "classes"], as_list(c.get("classes")))
            )
    if isinstance(doc.get("popup"), dict):
        lists.append((["popup", "blocks"], as_list(doc["popup"].get("blocks"))))
    render = doc.get("render")
    if isinstance(render, dict) and isinstance(render.get("classify"), dict):
        lists.append(
            (
                ["render", "classify", "classes"],
                as_list(render["classify"].get("classes")),
            )
        )
    seen: set[str] = set()
    for path, items in lists:
        for i, item in enumerate(items):
            item_id = item.get("id") if isinstance(item, dict) else None
            if not isinstance(item_id, str):
                continue
            if item_id in seen:
                issues.append(
                    make_issue(
                        "invalid_value",
                        to_pointer(path + [str(i), "id"]),
                        f'The id "{item_id}" is used twice; ids are unique in a document.',
                    )
                )
            seen.add(item_id)


def _label(key: str) -> str:
    return key.replace(".", " ").replace("_", " ").capitalize()


def check_document(
    doc: dict[str, Any],
    style: Any = None,
    geometry: str | None = None,
    *,
    ctx: DataContext | None = None,
) -> list[Issue]:
    """Rules about the document as a whole. `style` is the parsed model when parsing succeeded.

    `ctx`, when given, lets a categories classification count as covering every
    feature (5.7) when its classes list every value of the field.
    """
    if not isinstance(doc, dict):
        return []
    if doc.get("kind") == "raster":
        issues_r: list[Issue] = []
        _zoom_range(issues_r, [], doc, key_path=["min_zoom"])
        _duplicate_ids(issues_r, doc)
        if _num(doc.get("opacity")) and doc["opacity"] < 0.15:
            issues_r.append(
                make_issue("low_opacity", "/opacity", "The layer is under 15% opacity.")
            )
        return issues_r
    geometry = geometry or (
        doc["geometry"] if isinstance(doc.get("geometry"), str) else None
    )
    issues: list[Issue] = []
    places = record_places(doc)
    icon_kinds: set[str] = set()
    per_layer_seen: set[str] = set()

    for path, record, in_override in places:
        if in_override:
            _zoom_range(issues, path, record)
        for part in PARTS:
            value = record.get(part)
            if value is None:
                continue
            ppath = path + [part]
            if geometry and part not in GEOMETRY_PARTS[geometry]:
                issues.append(
                    make_issue(
                        "part_not_for_geometry",
                        to_pointer(ppath),
                        f"{part} is not a part of {geometry}s.",
                    )
                )
                continue
            if not isinstance(value, dict):
                continue
            if in_override:
                for zk in ("min_zoom", "max_zoom"):
                    if _num(value.get(zk)) and value[zk] != int(value[zk]):
                        issues.append(
                            make_issue(
                                "zoom_not_whole",
                                to_pointer(ppath + [zk]),
                                "Class and rule zooms are whole numbers.",
                            )
                        )
            _zoom_range(issues, ppath, value)
            if in_override and part == "marker" and "shape" in value:
                # Classes and rules take shapes and pins; the icon alone draws in a
                # layer of its own, so it is the whole layer's or no one's.
                if value["shape"] == "icon" or _marker_shape(doc) == "icon":
                    issues.append(
                        make_issue(
                            "override_not_per_feature",
                            to_pointer(ppath + ["shape"]),
                            "The icon alone holds for the whole layer: classes and rules take a shape or a pin only on a layer with a shape.",
                        )
                    )
            for key in value:
                dotted = f"{part}.{key}"
                if dotted in PER_LAYER_KEYS:
                    if dotted in per_layer_seen:
                        issues.append(
                            make_issue(
                                "override_not_per_feature",
                                to_pointer(ppath + [key]),
                                f"{dotted} holds one value for the whole layer and is already set elsewhere.",
                            )
                        )
                    per_layer_seen.add(dotted)
            if part == "outline" and geometry == "point" and "dash" in value:
                issues.append(
                    make_issue(
                        "dash_on_point_outline",
                        to_pointer(ppath + ["dash"]),
                        "Circle outlines cannot be dashed.",
                    )
                )
            if part == "label" and isinstance(value.get("text"), str):
                text = value["text"]
                found = problems(text)
                if found:
                    fixed = liquid_to_label(text)
                    tpath = to_pointer(ppath + ["text"])
                    fix = (
                        Fix(op="set", path=tpath, value=fixed)
                        if fixed != text and not problems(fixed)
                        else None
                    )
                    issues.append(
                        make_issue("template_syntax", tpath, found[0], fix=fix)
                    )
            if part == "marker":
                for ref in _strings(value.get("icon")):
                    icon_kinds.add("own" if keeps_colors(ref) else "library")

    _zoom_range(issues, [], doc, key_path=["min_zoom"])
    _duplicate_ids(issues, doc)
    _classifications(issues, doc, geometry, ctx)

    render = doc.get("render")
    if (
        isinstance(render, dict)
        and render.get("type") in POINT_RENDERS
        and geometry
        and geometry != "point"
    ):
        issues.append(
            make_issue(
                "render_not_for_geometry",
                "/render/type",
                f"{render['type']} draws points, not {geometry}s.",
            )
        )
    # On a shape every icon draws inside one marker image; alone, the two kinds draw in two layers.
    if {"library", "own"} <= icon_kinds and _marker_shape(doc) == "icon":
        issues.append(
            make_issue(
                "mixed_icon_kinds",
                "/symbol/marker/icon",
                "Library icons and icons with their own colors (uploads, emoji) compile to two layers; icons of the two kinds do not sort together.",
            )
        )
    symbol = doc.get("symbol")
    if (
        geometry
        and isinstance(symbol, dict)
        and symbol.get(MAIN_PART[geometry]) is False
    ):
        if not any(isinstance(symbol.get(p), dict) for p in GEOMETRY_PARTS[geometry]):
            issues.append(
                make_issue(
                    "nothing_drawn",
                    "/symbol",
                    "Every part of this layer is switched off.",
                )
            )
    if _num(doc.get("opacity")) and doc["opacity"] < 0.15:
        issues.append(
            make_issue("low_opacity", "/opacity", "The layer is under 15% opacity.")
        )
    return issues


def _zoom_range(
    issues: list[Issue],
    path: list[str],
    record: dict[str, Any],
    key_path: list[str] | None = None,
) -> None:
    lo, hi = record.get("min_zoom"), record.get("max_zoom")
    if _num(lo) and _num(hi) and lo >= hi:
        issues.append(
            make_issue(
                "zoom_range_invalid",
                to_pointer(path + (key_path or ["min_zoom"])),
                "min_zoom must be below max_zoom.",
            )
        )


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict) and isinstance(value.get("zoom"), list):
        return [
            s[1]
            for s in value["zoom"]
            if isinstance(s, list) and len(s) == 2 and isinstance(s[1], str)
        ]
    return []


def _set_keys(record: dict[str, Any], geometry: str) -> set[str]:
    keys: set[str] = set()
    for part in GEOMETRY_PARTS[geometry]:
        value = record.get(part)
        if value is False:
            keys.add(f"{part}.*")
        elif isinstance(value, dict):
            keys.update(
                f"{part}.{k}" for k in value if k not in ("min_zoom", "max_zoom")
            )
    return keys


def _target_key(c: dict[str, Any], geometry: str) -> str:
    target = c.get("target")
    return target if isinstance(target, str) else MAIN_COLOR[geometry]


def _fills_target(c: dict[str, Any], records: list[dict[str, Any]]) -> bool:
    """Whether the classification itself sets its target (from a palette or a range)."""
    return "target" in c or "palette" in c or "range" in c or not records


def _sets(record: dict[str, Any], key: str, c: dict[str, Any], geometry: str) -> bool:
    if key in _set_keys(record, geometry) or f"{key.split('.')[0]}.*" in _set_keys(
        record, geometry
    ):
        return True
    return key == _target_key(c, geometry) and _fills_target(c, [record])


def _covers(
    c: dict[str, Any], key: str, geometry: str, ctx: DataContext | None
) -> bool:
    """Whether a classification sets `key` for every feature (5.7)."""
    classes = [k for k in as_list(c.get("classes")) if isinstance(k, dict)]
    other = c.get("other") if isinstance(c.get("other"), dict) else None
    if not classes:
        return key == _target_key(c, geometry)
    if not all(_sets(k, key, c, geometry) for k in classes):
        return False
    if other is not None:
        return _sets(other, key, c, geometry)
    if c.get("method") == "categories":
        info = (
            ctx.fields.get(c.get("field"))
            if ctx is not None and ctx.fields is not None
            else None
        )
        if info is None or info.values is None:
            return False
        listed = {as_text(v) for k in classes for v in as_list(k.get("values"))}
        return all(as_text(v) in listed for v in info.values)
    return "from" not in classes[0] and "to" not in classes[-1]


def _classifications(
    issues: list[Issue],
    doc: dict[str, Any],
    geometry: str | None,
    ctx: DataContext | None,
) -> None:
    entries = []
    for ci, c in enumerate(as_list(doc.get("classify"))):
        if not isinstance(c, dict):
            continue
        cpath = ["classify", item_key(c, ci)]
        target = c.get("target")
        if isinstance(target, str) and "." in target:
            part = target.split(".", 1)[0]
            if geometry and part in PARTS and part not in GEOMETRY_PARTS[geometry]:
                issues.append(
                    make_issue(
                        "part_not_for_geometry",
                        to_pointer(cpath + ["target"]),
                        f"{part} is not a part of {geometry}s.",
                    )
                )
            elif target in PER_LAYER_KEYS:
                issues.append(
                    make_issue(
                        "override_not_per_feature",
                        to_pointer(cpath + ["target"]),
                        f"{target} holds one value for the whole layer; a classification cannot set it per feature.",
                    )
                )
        classes = [k for k in as_list(c.get("classes")) if isinstance(k, dict)]
        n = len(classes) or (c.get("count") if isinstance(c.get("count"), int) else 0)
        if c.get("method") == "categories" and n > 12:
            issues.append(
                make_issue(
                    "too_many_categories",
                    to_pointer(cpath),
                    f"{n} categories are hard to tell apart; 12 is the most that stay readable.",
                )
            )
        elif c.get("method") in NUMERIC_METHODS + ("manual",) and n > 7:
            issues.append(
                make_issue(
                    "too_many_classes",
                    to_pointer(cpath),
                    f"{n} classes are hard to tell apart; 7 is the most that stay readable.",
                )
            )
        _palette_kind(issues, cpath, c)
        if geometry is None or len(entries) >= MAX_COMPARED:
            continue
        records = classes + ([c["other"]] if isinstance(c.get("other"), dict) else [])
        keys: set[str] = set()
        for record in records:
            keys |= _set_keys(record, geometry)
        if _fills_target(c, records):
            keys.add(_target_key(c, geometry))
        entries.append((cpath, c, keys))

    taken = set().union(*(k for _, _, k in entries)) if entries else set()
    for i, (apath, _a, akeys) in enumerate(entries):
        partial = None
        for _bpath, b, bkeys in entries[i + 1 :]:
            shared = sorted(akeys & bkeys)
            if not shared:
                continue
            covering = [k for k in shared if geometry and _covers(b, k, geometry, ctx)]
            if covering:
                free = FREE_COLOR[geometry] if geometry else None
                fix = (
                    Fix(op="retarget", path=to_pointer(apath), target=free)
                    if free and free not in taken and len(akeys) == 1
                    else None
                )
                issues.append(
                    make_issue(
                        "classify_target_conflict",
                        to_pointer(apath),
                        f'{_label(covering[0])} is also set by the classification on "{b.get("field", "")}", which comes later '
                        "and covers every feature. This classification has no visible effect.",
                        fix=fix,
                    )
                )
                partial = None
                break
            if partial is None:
                partial = make_issue(
                    "classify_partial_overlap",
                    to_pointer(apath),
                    f'{_label(shared[0])} is also set by the classification on "{b.get("field", "")}" for some features; '
                    "where it has no class, this classification still shows.",
                )
        if partial is not None:
            issues.append(partial)


def _palette_kind(issues: list[Issue], cpath: list[str], c: dict[str, Any]) -> None:
    ref = c.get("palette")
    palette = palettes().get(ref) if isinstance(ref, str) else None
    if palette is None:
        return
    if c.get("method") == "categories" and palette.kind != "qualitative":
        issues.append(
            make_issue(
                "palette_kind_mismatch",
                to_pointer(cpath + ["palette"]),
                f"{palette.name} is an ordered palette; categories read better with distinct colors.",
                level="info",
            )
        )
    elif (
        c.get("method") in NUMERIC_METHODS + ("manual",)
        and palette.kind == "qualitative"
    ):
        issues.append(
            make_issue(
                "palette_kind_mismatch",
                to_pointer(cpath + ["palette"]),
                f"{palette.name} is a palette for categories; ordered classes read better with a sequential palette.",
            )
        )

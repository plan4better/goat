"""Values the server computes into a style (the specification's section 12).

`needed_stats` names the statistics a document needs; whoever can read the data
(processes, `goatlib.style.data`) computes them, and `apply_computed` writes them
into a copy of the document next to the intent. No IO here.
"""

import copy
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from goatlib.style.check import MAIN_COLOR, as_list, part_values, record_places
from goatlib.style.colors import (
    DEFAULT_CLASSIFY_PALETTE,
    default_range,
    range_values,
    sample_colors,
)
from goatlib.style.cql import as_text
from goatlib.style.defaults import REFERENCE_DEFAULTS
from goatlib.style.h3 import resolutions_of
from goatlib.style.ids import existing_ids, fresh_id
from goatlib.style.issues import Issue, make_issue
from goatlib.style.models.classify import (
    NUMERIC_METHODS,
    TARGET_KINDS,
    Classification,
    ColorClassification,
)
from goatlib.style.models.render import H3Render
from goatlib.style.models.values import ByAttributeColor, ByAttributeNumber
from goatlib.style.pointer import item_key, to_pointer

#: Classes a numeric method makes when the classification gives no `count` (18.4).
DEFAULT_COUNT = 5

#: `("breaks", field, method, count)`, `("top", field, count)`, `("range", field)`
#: (a value form's domain, or the minimum and maximum of manual classes);
#: a sqrt or log scale reads its range over the values it can map,
#: `("range", field, "sqrt")` (from 0) and `("range", field, "log")` (above 0).
#: A raster's "field" is its band as a formula (`b1`, or the formula's expression),
#: and its breaks inside an author's domain carry it: `("breaks", "b1", method,
#: count, from, to)`. H3 cells (8.3): `("h3", op, field, resolution, method,
#: count)`, with an empty field for `count` and an empty method and count for
#: continuous colors (their minimum and maximum).
StatKey = tuple[str, ...]


@dataclass(frozen=True)
class Breaks:
    """Inner breaks over the data's minimum and maximum (None without data);
    `merged` when equal breaks left fewer than the classes asked for."""

    breaks: tuple[float, ...]
    min: float | None
    max: float | None
    merged: bool


StatResults = Mapping[
    StatKey, Breaks | list[tuple[Any, int]] | tuple[float | None, float | None]
]


def breaks_for_classes(
    raw: list[float], minimum: float | None, maximum: float | None, classes: int
) -> Breaks:
    """Breaks as classes use them: none at or beyond the data's edges, none twice."""
    if minimum is None or maximum is None:
        return Breaks((), minimum, maximum, False)
    kept = tuple(sorted({b for b in raw if minimum < b < maximum}))
    return Breaks(kept, minimum, maximum, len(kept) < classes - 1)


def _count(c: dict[str, Any]) -> int | None:
    count = c.get("count")
    if isinstance(count, int) and not isinstance(count, bool) and count >= 1:
        return count
    return None


def _breaks_key(c: dict[str, Any]) -> StatKey | None:
    if c.get("method") in NUMERIC_METHODS and isinstance(c.get("field"), str):
        return ("breaks", c["field"], c["method"], str(_count(c) or DEFAULT_COUNT))
    return None


def _top_key(c: dict[str, Any]) -> StatKey | None:
    """Categories are computed only with a `count`; without one the class list is
    the author's (5.1)."""
    count = _count(c)
    if c.get("method") == "categories" and isinstance(c.get("field"), str) and count:
        return ("top", c["field"], str(count))
    return None


def _manual_range_key(c: dict[str, Any]) -> StatKey | None:
    """Manual classes are the author's; the server computes only the field's
    minimum and maximum, which the open first and last class read."""
    if c.get("method") == "manual" and isinstance(c.get("field"), str):
        return ("range", c["field"])
    return None


def _class_key(c: dict[str, Any]) -> StatKey | None:
    """The statistic a classification needs: its breaks, its most frequent values,
    or the range of its manual classes."""
    return _breaks_key(c) or _top_key(c) or _manual_range_key(c)


def _range_key(v: dict[str, Any]) -> StatKey:
    scale = v.get("scale")
    if scale in ("sqrt", "log"):
        return ("range", v["field"], scale)
    return ("range", v["field"])


def _valid(model: Any, node: Any) -> bool:
    """Whether a part passes its model. Only valid parts are computed, so an error
    blocks what it is about and nothing else (11), and a malformed part is left
    for validation to report."""
    try:
        model.model_validate(node)
    except ValidationError:
        return False
    return True


def _classifications(doc: dict[str, Any]) -> Iterator[tuple[int, dict[str, Any]]]:
    """Valid vector classifications with their index."""
    for ci, c in enumerate(as_list(doc.get("classify"))):
        if isinstance(c, dict) and _valid(Classification, c):
            yield ci, c


def _attribute_forms(
    doc: dict[str, Any],
) -> Iterator[tuple[list[str], dict[str, Any]]]:
    """Valid value forms by attribute (4.3) with their paths, zoom stops included."""
    for path, record, _ in record_places(doc):
        for vpath, v in part_values(record, path):
            if (
                isinstance(v, dict)
                and isinstance(v.get("field"), str)
                and ("range" in v or "palette" in v)
                and _valid(ByAttributeNumber if "range" in v else ByAttributeColor, v)
            ):
                yield vpath, v


def _value_forms(doc: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Value forms by attribute the server computes a domain for: those without
    an author's `domain`."""
    return (v for _, v in _attribute_forms(doc) if v.get("domain") is None)


def _raster_render(doc: dict[str, Any]) -> dict[str, Any] | None:
    """A raster file style's color range render (continuous, terrain)."""
    render = doc.get("render")
    if isinstance(render, dict) and render.get("type") in ("continuous", "terrain"):
        return render
    return None


def raster_input(render: dict[str, Any]) -> str | None:
    """The band a raster render colors, as a formula: `b<n>` or the expression."""
    band = render.get("band", 1)
    if isinstance(band, dict):
        expression = band.get("expression")
        return (
            expression if isinstance(expression, str) and expression.strip() else None
        )
    if isinstance(band, int) and not isinstance(band, bool) and band >= 1:
        return f"b{band}"
    return None


def _raster_palette(render: dict[str, Any]) -> Any:
    fallback = (
        REFERENCE_DEFAULTS["continuous.palette"]
        if render.get("type") == "continuous"
        else None
    )
    return render.get("palette", fallback)


def _raster_range_key(render: dict[str, Any]) -> StatKey | None:
    """A palette without a domain (9.2: the band's minimum and maximum)."""
    expression = raster_input(render)
    if (
        expression is None
        or _raster_palette(render) is None
        or render.get("domain") is not None
        or render.get("stops") is not None
    ):
        return None
    return ("range", expression)


def _raster_classification(render: dict[str, Any]) -> dict[str, Any] | None:
    c = render.get("classify")
    if isinstance(c, dict) and _valid(ColorClassification, c):
        return c
    return None


def _raster_breaks_key(render: dict[str, Any]) -> StatKey | None:
    c = _raster_classification(render)
    expression = raster_input(render)
    if c is None or expression is None or c.get("method") not in NUMERIC_METHODS:
        return None
    key: StatKey = ("breaks", expression, c["method"], str(_count(c) or DEFAULT_COUNT))
    domain = render.get("domain")
    if isinstance(domain, list) and len(domain) == 2:
        key += (str(domain[0]), str(domain[1]))
    return key


def _h3_render(doc: dict[str, Any]) -> dict[str, Any] | None:
    """A vector style's valid H3 render."""
    render = doc.get("render")
    if (
        doc.get("kind") == "vector"
        and isinstance(render, dict)
        and render.get("type") == "h3"
        and _valid(H3Render, render)
    ):
        return render
    return None


def _h3_keys(render: dict[str, Any]) -> dict[str, StatKey]:
    """The statistics an H3 render needs, by resolution: the breaks of a
    computed classification, or the cell values' range for continuous colors.
    Manual classes need none."""
    value = render.get("value") if isinstance(render.get("value"), dict) else {}
    op = value.get("op", "count")
    field = value.get("field", "") if op != "count" else ""
    c = render.get("classify")
    if isinstance(c, dict):
        if c.get("method") not in NUMERIC_METHODS:
            return {}
        method, count = c["method"], str(_count(c) or DEFAULT_COUNT)
    else:
        method, count = "", ""
    return {
        str(r): ("h3", op, field or "", str(r), method, count)
        for r in resolutions_of(render)
    }


def computed_missing(doc: dict[str, Any]) -> bool:
    """Whether the style needs computed values it does not have: a classification
    the server computes without `computed`, numeric classes it computed without
    the data's minimum and maximum, or a value form (a raster render) without its
    domain."""
    if not isinstance(doc, dict):
        return False
    if doc.get("kind") == "raster":
        render = _raster_render(doc)
        if render is None:
            return False
        if _raster_range_key(render) and not isinstance(render.get("computed"), dict):
            return True
        c = _raster_classification(render)
        return bool(
            _raster_breaks_key(render)
            and c is not None
            and not isinstance(c.get("computed"), dict)
        )
    for _, c in _classifications(doc):
        computed = c.get("computed")
        if _class_key(c) is not None and not isinstance(computed, dict):
            return True
        # Numeric classes the server computed (`generated`) without the data's ends;
        # a migrated or copied style keeps its classes as stamped.
        if (
            _breaks_key(c) is not None
            and isinstance(computed, dict)
            and "domain" not in computed
            and isinstance(computed.get("generated"), dict)
            and as_list(c.get("classes"))
        ):
            return True
    render = _h3_render(doc)
    if render is not None and (keys := _h3_keys(render)):
        computed = render.get("computed")
        stored = computed.get("resolutions") if isinstance(computed, dict) else None
        if not isinstance(stored, dict) or any(r not in stored for r in keys):
            return True
    return any(not isinstance(v.get("computed"), dict) for v in _value_forms(doc))


def needed_stats(doc: dict[str, Any]) -> list[StatKey]:
    """The statistics a style needs, in document order, each once."""
    if not isinstance(doc, dict):
        return []
    if doc.get("kind") == "raster":
        render = _raster_render(doc)
        if render is None:
            return []
        keys = [_raster_range_key(render), _raster_breaks_key(render)]
        return [k for k in keys if k is not None]
    keys: list[StatKey] = []
    for _, c in _classifications(doc):
        key = _class_key(c)
        if key is not None:
            keys.append(key)
    keys.extend(_range_key(v) for v in _value_forms(doc))
    render = _h3_render(doc)
    if render is not None:
        keys.extend(_h3_keys(render).values())
    return list(dict.fromkeys(keys))


def _sets(record: dict[str, Any], target: str) -> bool:
    """Whether a class record sets the target itself (or turns its part off)."""
    part, *keys = target.split(".")
    node = record.get(part)
    if node is False:
        return True
    for key in keys[:-1]:
        node = node.get(key) if isinstance(node, dict) else None
    return isinstance(node, dict) and keys[-1] in node


def _get(record: dict[str, Any], target: str) -> Any:
    node: Any = record
    for key in target.split("."):
        node = node.get(key) if isinstance(node, dict) else None
    return node


def _put(record: dict[str, Any], target: str, value: Any) -> None:
    *keys, last = target.split(".")
    node = record
    for key in keys:
        node = node.setdefault(key, {})
    node[last] = value


def _target_values(
    c: dict[str, Any], geometry: str | None, n: int
) -> tuple[str | None, list[Any] | None]:
    """The target generated classes fill, and its values for `n` classes: colors
    from the palette, numbers from the range, nothing for choices (5.4)."""
    target = c.get("target")
    if not isinstance(target, str):
        target = MAIN_COLOR.get(geometry or "")
    if target is None:
        return None, None
    kind = TARGET_KINDS.get(target)
    if kind == "color":
        categories = c.get("method") == "categories"
        palette = (
            c.get("palette")
            or DEFAULT_CLASSIFY_PALETTE["categories" if categories else "numeric"]
        )
        try:
            colors = sample_colors(
                palette,
                n,
                kind="qualitative"
                if categories and isinstance(palette, list)
                else None,
                reverse=c.get("reverse") is True,
            )
        except ValueError:  # an unknown palette, reported by the data checks
            return target, None
        return target, colors
    if kind == "number":
        r = c.get("range")
        r0, r1 = r if isinstance(r, list) and len(r) == 2 else default_range(target)
        return target, range_values(r0, r1, n, opacity=target.endswith("opacity"))
    return target, None


def _drop(record: dict[str, Any], target: str) -> None:
    """Removes the value at `target`, and a part or sub-object it leaves empty."""
    keys = target.split(".")
    nodes = [record]
    for key in keys[:-1]:
        node = nodes[-1].get(key)
        if not isinstance(node, dict):
            return
        nodes.append(node)
    nodes[-1].pop(keys[-1], None)
    for depth in range(len(keys) - 1, 0, -1):
        if nodes[depth] == {}:
            nodes[depth - 1].pop(keys[depth - 1], None)


_UNSET = object()


def _previous(c: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
    """What the server wrote into the classes last: the target and the value per
    class id (`computed.generated`)."""
    computed = c.get("computed")
    generated = computed.get("generated") if isinstance(computed, dict) else None
    if not isinstance(generated, dict):
        return None, {}
    target, values = generated.get("target"), generated.get("values")
    return (
        target if isinstance(target, str) else None,
        values if isinstance(values, dict) else {},
    )


def _ours(
    classes: list[dict[str, Any]], c: dict[str, Any], target: str | None
) -> list[bool]:
    """Per class, whether its target value is the server's to set: unset, or still
    what the server wrote last; a value someone changed stays theirs. What the
    server wrote for an earlier target is removed."""
    prev_target, prev_values = _previous(c)
    ours = []
    for k in classes:
        was = prev_values.get(k.get("id"), _UNSET)
        if prev_target and prev_target != target and _get(k, prev_target) == was:
            _drop(k, prev_target)
        ours.append(
            target is not None
            and (
                not _sets(k, target)
                or (prev_target == target and _get(k, target) == was)
            )
        )
    return ours


def _with_ids(classes: list[dict[str, Any]], ids: set[str]) -> None:
    for k in classes:
        if not isinstance(k.get("id"), str):
            k["id"] = fresh_id("c", ids)


def _generated(target: str | None, written: dict[str, Any]) -> dict[str, Any] | None:
    return {"target": target, "values": written} if target and written else None


def _numeric(
    c: dict[str, Any], b: Breaks, geometry: str | None, ids: set[str]
) -> dict[str, Any] | None:
    """Bounds by position while the number of classes stays; otherwise new classes.
    The server's values follow the palette or range by position. Returns what it
    wrote (`computed.generated`)."""
    n = len(b.breaks) + 1
    existing = as_list(c.get("classes"))
    if len(existing) == n and all(isinstance(k, dict) for k in existing):
        classes = existing
    else:
        classes = [{} for _ in range(n)]
    _with_ids(classes, ids)
    target, values = _target_values(c, geometry, n)
    ours = _ours(classes, c, target)
    written: dict[str, Any] = {}
    for i, k in enumerate(classes):
        k.pop("from", None)
        k.pop("to", None)
        if i > 0:
            k["from"] = b.breaks[i - 1]
        if i < n - 1:
            k["to"] = b.breaks[i]
        if target is not None and values is not None and ours[i]:
            _put(k, target, values[i])
            written[k["id"]] = values[i]
    c["classes"] = classes
    return _generated(target, written)


def _categories(
    c: dict[str, Any], top: list[tuple[Any, int]], geometry: str | None, ids: set[str]
) -> dict[str, Any] | None:
    """The most frequent values as classes. A class keeps everything it carries
    while one of its values is still among them; the others go, and values no class
    holds become new classes. A value the server gave a class stays with it while
    the palette still offers it. Returns what the server wrote."""
    values = [v for v, _ in top if v is not None][: _count(c)]
    if not values:
        return None
    wanted = {as_text(v) for v in values}
    kept = [
        k
        for k in as_list(c.get("classes"))
        if isinstance(k, dict)
        and any(as_text(v) in wanted for v in as_list(k.get("values")))
    ]
    held = {as_text(v) for k in kept for v in as_list(k.get("values"))}
    new = [{"values": [v]} for v in values if as_text(v) not in held]
    classes = kept + new
    _with_ids(classes, ids)
    c["classes"] = classes
    target, generated = _target_values(c, geometry, len(classes))
    ours = _ours(classes, c, target)
    if target is None or not generated:
        return None
    taken = [_get(k, target) for k, mine in zip(classes, ours) if not mine]
    staying = set()
    for k, mine in zip(classes, ours):
        value = _get(k, target)
        if mine and _sets(k, target) and value in generated and value not in taken:
            taken.append(value)
            staying.add(k["id"])
    free = [v for v in generated if v not in taken] or generated
    written: dict[str, Any] = {}
    handed_out = 0
    for k, mine in zip(classes, ours):
        if not mine:
            continue
        if k["id"] not in staying:
            _put(k, target, free[handed_out % len(free)])
            handed_out += 1
        written[k["id"]] = _get(k, target)
    return _generated(target, written)


def _no_values(path: list[str], field: str) -> Issue:
    return make_issue(
        "no_values", to_pointer(path), f'"{field}" has no values in this dataset.'
    )


def _manual_computed(
    c: dict[str, Any],
    result: Any,
    stamp: dict[str, Any],
    notes: list[Issue],
    ci: int,
) -> dict[str, Any]:
    """A manual classification's `computed`: the field's range as `domain`; without
    values (noted) or without the statistic (a field the data no longer has), the
    domain it had."""
    if isinstance(result, tuple) and len(result) == 2 and None not in result:
        return {**stamp, "domain": [result[0], result[1]]}
    if isinstance(result, tuple):
        notes.append(_no_values(["classify", item_key(c, ci)], c["field"]))
        return dict(stamp)
    previous = c.get("computed")
    domain = previous.get("domain") if isinstance(previous, dict) else None
    return {**stamp, **({"domain": domain} if domain else {})}


def apply_computed(
    doc: dict[str, Any],
    stats: StatResults,
    *,
    geometry: str | None,
    fingerprint: str,
    at: str,
) -> tuple[dict[str, Any], list[Issue]]:
    """A copy of `doc` with the statistics written in (section 12), and notes.

    Every classification and value form a statistic was given for gets
    `computed` (`at`, `data` = the fingerprint, `scope`), also when the data is
    empty: then classes and domains stay as they were. The classes of `manual`
    classifications (they get the field's range only) and value forms with an
    author's `domain` are never touched.
    """
    out = copy.deepcopy(doc)
    notes: list[Issue] = []
    if not isinstance(out, dict):
        return out, notes
    stamp = {"at": at, "data": fingerprint, "scope": "dataset"}
    if out.get("kind") == "raster":
        return out, _apply_raster(out, stats, stamp)
    ids = existing_ids(out)
    for ci, c in _classifications(out):
        if (range_key := _manual_range_key(c)) is not None:
            # Manual classes stay as they are: only the field's minimum and maximum.
            c["computed"] = _manual_computed(c, stats.get(range_key), stamp, notes, ci)
            continue
        if _breaks_key(c) is None and _top_key(c) is None:
            # Lost its count: nothing is computed any more, and only the server
            # removes what it wrote.
            c.pop("computed", None)
            continue
        breaks_key, top_key = _breaks_key(c), _top_key(c)
        breaks = stats.get(breaks_key) if breaks_key else None
        top = stats.get(top_key) if top_key else None
        previous = c.get("computed") if isinstance(c.get("computed"), dict) else {}
        # The data's minimum and maximum of numeric classes: the first and last
        # class are open, and their labels read the data's ends.
        domain: Any = None
        if isinstance(breaks, Breaks) and breaks.min is not None:
            generated = _numeric(c, breaks, geometry, ids)
            domain = [breaks.min, breaks.max]
            if breaks.merged:
                n = len(breaks.breaks) + 1
                got = "1 class" if n == 1 else f"{n} classes"
                notes.append(
                    make_issue(
                        "classes_merged",
                        to_pointer(["classify", item_key(c, ci)]),
                        f"Equal breaks merged: {got} instead of "
                        f"{_count(c) or DEFAULT_COUNT}.",
                    )
                )
        elif isinstance(top, list) and any(v is not None for v, _ in top):
            generated = _categories(c, top, geometry, ids)
        else:
            # No values, or a field the data no longer has or holds in another
            # type (left out of the statistics; the checks report it): the
            # classes, and what the server wrote, stay as they were, stamped, so
            # the style is not recomputed on every read.
            if isinstance(breaks, Breaks) or isinstance(top, list):
                notes.append(_no_values(["classify", item_key(c, ci)], c["field"]))
            generated = previous.get("generated")
            domain = previous.get("domain") if breaks_key else None
        c["computed"] = {
            **stamp,
            **({"domain": domain} if domain else {}),
            **({"generated": generated} if generated else {}),
        }
    for vpath, v in _attribute_forms(out):
        if v.get("domain") is not None:
            v.pop("computed", None)
            continue
        result = stats.get(_range_key(v))
        computed: dict[str, Any] = dict(stamp)
        if isinstance(result, tuple) and len(result) == 2 and None not in result:
            computed["domain"] = [result[0], result[1]]
        else:
            # No values, or a field the data no longer has (as for classes above).
            if isinstance(result, tuple) and len(result) == 2:
                notes.append(_no_values(vpath, v["field"]))
            previous = v.get("computed")
            if isinstance(previous, dict) and "domain" in previous:
                computed["domain"] = previous["domain"]
        v["computed"] = computed
    _apply_h3(out, stats, stamp)
    return out, notes


def _apply_h3(doc: dict[str, Any], stats: StatResults, stamp: dict[str, Any]) -> None:
    """The cell values' breaks or range per resolution into `render.computed`
    (one stamp for all, so staleness reads it like any other). A resolution the
    data has no values for is stored empty; one that was not computed (a field
    the data no longer has, left to the checks) keeps what it had."""
    render = _h3_render(doc)
    if render is None:
        return
    keys = _h3_keys(render)
    if not keys:
        render.pop("computed", None)
        return
    previous = render.get("computed")
    before = previous.get("resolutions") if isinstance(previous, dict) else None
    resolutions: dict[str, Any] = {}
    for res, key in keys.items():
        result = stats.get(key)
        if isinstance(result, Breaks) and result.min is not None:
            resolutions[res] = {
                "min": result.min,
                "max": result.max,
                "breaks": list(result.breaks),
            }
        elif isinstance(result, tuple) and len(result) == 2 and None not in result:
            resolutions[res] = {"min": result[0], "max": result[1]}
        elif isinstance(result, (Breaks, tuple)):
            resolutions[res] = {}
        elif isinstance(before, dict) and isinstance(before.get(res), dict):
            resolutions[res] = before[res]
    render["computed"] = {**stamp, "resolutions": resolutions}


def _no_band_values(path: list[str]) -> Issue:
    return make_issue(
        "no_values", to_pointer(path), "The band has no values in this raster."
    )


def _apply_raster(
    doc: dict[str, Any], stats: StatResults, stamp: dict[str, Any]
) -> list[Issue]:
    """The default domain into `render.computed`, classes into `render.classify`
    (9.4: from and to by position, colors from the classification's palette, else
    the render's); what the author set on a class stays."""
    notes: list[Issue] = []
    render = _raster_render(doc)
    if render is None:
        return notes
    range_key = _raster_range_key(render)
    if range_key is None:
        render.pop("computed", None)
    else:
        result = stats.get(range_key)
        computed: dict[str, Any] = dict(stamp)
        if isinstance(result, tuple) and len(result) == 2 and None not in result:
            computed["domain"] = [result[0], result[1]]
        else:
            if isinstance(result, tuple):
                notes.append(_no_band_values(["render", "band"]))
            previous = render.get("computed")
            if isinstance(previous, dict) and "domain" in previous:
                computed["domain"] = previous["domain"]
        render["computed"] = computed
    c = _raster_classification(render)
    if c is None:
        return notes
    breaks_key = _raster_breaks_key(render)
    if breaks_key is None:
        c.pop("computed", None)
        return notes
    breaks = stats.get(breaks_key)
    if isinstance(breaks, Breaks) and breaks.min is not None:
        generated = _raster_classes(c, render, breaks, existing_ids(doc))
        if breaks.merged:
            n = len(breaks.breaks) + 1
            got = "1 class" if n == 1 else f"{n} classes"
            notes.append(
                make_issue(
                    "classes_merged",
                    "/render/classify",
                    f"Equal breaks merged: {got} instead of {_count(c) or DEFAULT_COUNT}.",
                )
            )
    else:
        if isinstance(breaks, Breaks):
            notes.append(_no_band_values(["render", "classify"]))
        previous = c.get("computed")
        generated = previous.get("generated") if isinstance(previous, dict) else None
    c["computed"] = {**stamp, **({"generated": generated} if generated else {})}
    return notes


def _raster_classes(
    c: dict[str, Any], render: dict[str, Any], b: Breaks, ids: set[str]
) -> dict[str, Any] | None:
    """Raster classes by position (as `_numeric` for vectors) with their color."""
    n = len(b.breaks) + 1
    existing = as_list(c.get("classes"))
    if len(existing) == n and all(isinstance(k, dict) for k in existing):
        classes = existing
    else:
        classes = [{} for _ in range(n)]
    _with_ids(classes, ids)
    own = c.get("palette") is not None
    palette = c.get("palette") if own else _raster_palette(render)
    reverse = (c.get("reverse") if own else render.get("reverse")) is True
    colors: list[Any] | None = None
    if palette is not None:
        try:
            colors = sample_colors(palette, n, reverse=reverse)
        except ValueError:  # an unknown palette, reported by the data checks
            colors = None
    # A class's color is the server's while unset or still what it wrote last.
    prev_target, prev_values = _previous(c)
    ours = [
        "color" not in k
        or (prev_target == "color" and k["color"] == prev_values.get(k["id"], _UNSET))
        for k in classes
    ]
    written: dict[str, Any] = {}
    for i, k in enumerate(classes):
        k.pop("from", None)
        k.pop("to", None)
        if i > 0:
            k["from"] = b.breaks[i - 1]
        if i < n - 1:
            k["to"] = b.breaks[i]
        if colors is not None and ours[i]:
            k["color"] = colors[i]
            written[k["id"]] = colors[i]
    c["classes"] = classes
    return _generated("color" if colors is not None else None, written)


def stamp_computed(doc: dict[str, Any], fingerprint: str, at: str) -> dict[str, Any]:
    """A copy of `doc` whose computed parts that already carry their values (a
    classification the server computes, with classes; a value form with a computed
    domain) are stamped as computed from `fingerprint`: a migrated style keeps the
    classes people know. Parts without values stay unstamped, so the first read
    computes them. No `generated` record, so a later recompute keeps the classes'
    colors as the author's; the data's minimum and maximum of numeric classes stay."""
    out = copy.deepcopy(doc)
    if not isinstance(out, dict) or out.get("kind") == "raster":
        return out
    stamp = {"at": at, "data": fingerprint, "scope": "dataset"}
    for _, c in _classifications(out):
        if (_breaks_key(c) or _top_key(c)) is not None and as_list(c.get("classes")):
            previous = c.get("computed")
            domain = previous.get("domain") if isinstance(previous, dict) else None
            c["computed"] = {**stamp, **({"domain": domain} if domain else {})}
    for v in _value_forms(out):
        previous = v.get("computed")
        if isinstance(previous, dict) and previous.get("domain") is not None:
            v["computed"] = {**stamp, "domain": previous["domain"]}
    return out


def without_stamps(node: Any) -> Any:
    if isinstance(node, dict):
        return {
            k: (
                {
                    ck: without_stamps(cv)
                    for ck, cv in v.items()
                    if ck not in ("at", "data")
                }
                if k == "computed" and isinstance(v, dict)
                else without_stamps(v)
            )
            for k, v in node.items()
        }
    if isinstance(node, list):
        return [without_stamps(x) for x in node]
    return node


def same_ignoring_stamps(a: Any, b: Any) -> bool:
    """Equal once every `computed.at` and `computed.data` is left out (12, 13.1)."""
    return without_stamps(a) == without_stamps(b)

"""Validation of layer styles and map documents: structure, document rules, data rules."""

from typing import Any

from goatlib.style.check import as_list, check_document
from goatlib.style.context import DataContext, MapContext
from goatlib.style.data_check import check_against_data
from goatlib.style.issues import Issue
from goatlib.style.parse import check_version, parse_for_write, parse_map_document
from goatlib.style.pointer import to_pointer

#: Codes a later data change can cause in a stored style: reported as `damaged`.
DAMAGE_CODES = ("unknown_field", "field_type_mismatch")


def validate(doc: Any, ctx: DataContext, *, stored: bool = False) -> list[Issue]:
    """Every issue of a layer style against its dataset, sorted by path, then code.

    `stored=True` reads a style that was valid when written: data codes a later
    data change can cause get the level `damaged`.
    """
    if check_version(doc):
        return check_version(doc)
    style, issues = parse_for_write(doc)
    geometry = ctx.geometry if ctx.kind == "vector" else None
    issues = (
        issues
        + check_document(doc, style, geometry, ctx=ctx)
        + check_against_data(doc, style, ctx)
    )
    if stored:
        issues = [
            i.model_copy(update={"level": "damaged"}) if i.code in DAMAGE_CODES else i
            for i in issues
        ]
    return _tidy(issues)


def validate_map(doc: Any, ctx: MapContext) -> list[Issue]:
    """Every issue of a map document against the project's layers and the basemap's positions."""
    from goatlib.style.issues import make_issue

    _, issues = parse_map_document(doc)
    if check_version(doc):
        return issues
    seen: set[int] = set()
    stack: list[tuple[list[str], Any]] = [
        (["layers", str(i)], e) for i, e in enumerate(as_list(doc.get("layers")))
    ]
    while stack:
        path, entry = stack.pop()
        if not isinstance(entry, dict):
            continue
        if entry.get("type") == "group":
            stack.extend(
                (path + ["children", str(i)], e)
                for i, e in enumerate(as_list(entry.get("children")))
            )
            continue
        layer_id = entry.get("id")
        if not isinstance(layer_id, int):
            continue
        pointer = to_pointer(path)
        if layer_id in seen:
            issues.append(
                make_issue(
                    "duplicate_layer", pointer, f"Layer {layer_id} is in the map twice."
                )
            )
        seen.add(layer_id)
        styles = ctx.layers.get(layer_id)
        if styles is None:
            issues.append(
                make_issue(
                    "unknown_layer",
                    pointer + "/id",
                    f"The project has no layer {layer_id}.",
                )
            )
        elif isinstance(entry.get("style"), str) and entry["style"] not in styles:
            issues.append(
                make_issue(
                    "unknown_style",
                    pointer + "/style",
                    f'Layer {layer_id} has no named style "{entry["style"]}".',
                )
            )
        position = entry.get("position")
        if isinstance(position, str) and position not in ctx.positions:
            issues.append(
                make_issue(
                    "unknown_position",
                    pointer + "/position",
                    "The basemap does not offer this position.",
                    allowed=sorted(ctx.positions),
                )
            )
    return _tidy(issues)


def _tidy(issues: list[Issue]) -> list[Issue]:
    seen: set[tuple[str, str]] = set()
    out = []
    for i in sorted(issues, key=lambda x: (x.path, x.code)):
        if (i.code, i.path) not in seen:
            seen.add((i.code, i.path))
            out.append(i)
    return out

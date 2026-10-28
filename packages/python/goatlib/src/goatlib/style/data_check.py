"""Checks against the data a style draws (the specification's sections 4.3, 5, 6, 7, 8, 9, 11, 19).

They read the raw document and a `DataContext`; the context's `fields` being None
means the fields are unknown and every field check is skipped.
"""

import re
from typing import Any

from goatlib.raster.formula import FormulaError, parse_formula
from goatlib.style import cql
from goatlib.style.catalog import icon_libraries, palettes
from goatlib.style.check import as_list, part_values, record_places
from goatlib.style.context import DataContext, FieldInfo
from goatlib.style.issues import Issue, make_issue
from goatlib.style.models.classify import NUMERIC_METHODS
from goatlib.style.pointer import item_key, to_pointer
from goatlib.style.template import placeholders, problems

NUMERIC = ("number", "integer")
_LIQUID_OUT = re.compile(r"\{\{-?\s*([^\W\d][\w-]*)")
_LIQUID_TAG = re.compile(
    r"\{%-?\s*(if|unless|elsif|for|assign|capture)\s+([^\W\d][\w-]*)"
)
_LIQUID_SKIP = {"forloop", "true", "false", "nil", "empty", "blank"}


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


class _Checker:
    def __init__(self, doc: dict[str, Any], ctx: DataContext) -> None:
        self.doc = doc
        self.ctx = ctx
        self.issues: list[Issue] = []
        #: Every field name the checks looked up, known or not.
        self.seen: set[str] = set()

    def add(self, code: str, path: list[str], message: str, **kw: Any) -> None:
        self.issues.append(make_issue(code, to_pointer(path), message, **kw))

    # fields ---------------------------------------------------------------------------------------
    def field(
        self, name: Any, path: list[str], *, numeric: bool = False, why: str = ""
    ) -> FieldInfo | None:
        if isinstance(name, str):
            self.seen.add(name)
        fields = self.ctx.fields
        if fields is None or not isinstance(name, str):
            return None
        info = fields.get(name)
        if info is None:
            self.add("unknown_field", path, f'The dataset has no field "{name}".')
            return None
        if numeric and info.type not in NUMERIC:
            self.add(
                "field_type_mismatch",
                path,
                f'"{name}" is a {info.type} field; {why or "this needs numbers"}.',
            )
        return info

    def palette(self, ref: Any, path: list[str]) -> None:
        if isinstance(ref, str) and ref not in palettes():
            self.add(
                "unknown_palette",
                path,
                f'There is no palette "{ref}" in the catalogue.',
            )

    def icon(self, ref: Any, path: list[str]) -> None:
        if not isinstance(ref, str) or ":" not in ref:
            return
        library, name = ref.split(":", 1)
        if library == "asset":
            return
        names = icon_libraries().get(library)
        if names is None:
            self.add(
                "unknown_icon",
                path,
                f'There is no icon library "{library}"; GOAT\'s own is "goat".',
            )
        elif name not in names:
            self.add(
                "unknown_icon", path, f'The icon library "{library}" has no "{name}".'
            )

    # value forms ----------------------------------------------------------------------------------
    def value(self, v: Any, path: list[str], *, cluster: bool = False) -> None:
        if not isinstance(v, dict) or "field" not in v:
            return
        if cluster and v["field"] == "count":
            pass
        elif "range" in v:
            info = self.field(
                v["field"], path + ["field"], numeric=True, why="a range maps numbers"
            )
            self.domain(v.get("domain"), info, path + ["domain"])
        elif "palette" in v:
            info = self.field(
                v["field"],
                path + ["field"],
                numeric=True,
                why="a palette ramp maps numbers",
            )
            self.domain(v.get("domain"), info, path + ["domain"])
        else:
            self.field(v["field"], path + ["field"])
        if "palette" in v:
            self.palette(v["palette"], path + ["palette"])

    def domain(self, domain: Any, info: FieldInfo | None, path: list[str]) -> None:
        if not (
            isinstance(domain, list)
            and len(domain) == 2
            and all(_num(d) for d in domain)
        ):
            return
        if info is not None and _num(info.min) and _num(info.max):
            if domain[1] < info.min or domain[0] > info.max:
                self.add(
                    "domain_outside_data",
                    path,
                    f"The data runs from {info.min} to {info.max}; this domain misses it.",
                )

    def parts(
        self, record: dict[str, Any], path: list[str], *, cluster: bool = False
    ) -> None:
        for vpath, v in part_values(record, path):
            self.value(v, vpath, cluster=cluster)
        for part in ("marker", "label"):
            value = record.get(part)
            if not isinstance(value, dict):
                continue
            ppath = path + [part]
            if part == "marker":
                icon = value.get("icon")
                if isinstance(icon, str):
                    self.icon(icon, ppath + ["icon"])
                elif isinstance(icon, dict) and isinstance(icon.get("zoom"), list):
                    for i, stop in enumerate(icon["zoom"]):
                        if isinstance(stop, list) and len(stop) == 2:
                            self.icon(stop[1], ppath + ["icon", "zoom", str(i), "1"])
            if part == "label":
                text = value.get("text")
                if isinstance(text, str) and not problems(text):
                    for name in placeholders(text):
                        if not (cluster and name == "count"):
                            self.field(name, ppath + ["text"])
                priority = value.get("priority")
                if isinstance(priority, dict):
                    self.field(priority.get("field"), ppath + ["priority", "field"])

    # sections -------------------------------------------------------------------------------------
    def vector(self) -> None:
        doc, ctx = self.doc, self.ctx
        if (
            isinstance(doc.get("geometry"), str)
            and ctx.geometry
            and doc["geometry"] != ctx.geometry
        ):
            self.add(
                "geometry_mismatch",
                ["geometry"],
                f"The dataset's geometry is {ctx.geometry}.",
            )
        for path, record, _ in record_places(doc):
            self.parts(record, path)
        for ci, c in enumerate(as_list(doc.get("classify"))):
            if isinstance(c, dict):
                self.classification(c, ["classify", item_key(c, ci)])
        for ri, r in enumerate(as_list(doc.get("rules"))):
            if isinstance(r, dict):
                self.rule(r.get("when"), ["rules", item_key(r, ri), "when"])
        order = doc.get("order")
        if isinstance(order, dict) and "field" in order:
            self.field(order["field"], ["order", "field"])
        time_ = doc.get("time")
        if isinstance(time_, dict):
            info = self.field(time_.get("field"), ["time", "field"])
            if info is not None and not _time_field(info):
                self.add(
                    "field_type_mismatch",
                    ["time", "field"],
                    f'"{info.name}" is not a whole-number or date field.',
                )
        self.popup(doc.get("popup"))
        self.render(doc.get("render"))

    def classification(self, c: dict[str, Any], path: list[str]) -> None:
        method = c.get("method")
        numeric = method in NUMERIC_METHODS or method == "manual"
        info = self.field(
            c.get("field"),
            path + ["field"],
            numeric=numeric,
            why=f"{method} classes need numbers",
        )
        self.palette(c.get("palette"), path + ["palette"])
        colors = c.get("palette") if isinstance(c.get("palette"), list) else None
        classes = [k for k in as_list(c.get("classes")) if isinstance(k, dict)]
        needed = len(classes) or (
            c.get("count") if isinstance(c.get("count"), int) else 0
        )
        if colors is not None and needed > len(colors):
            self.add(
                "palette_too_short",
                path + ["palette"],
                f"{needed} classes need {needed} colors; the palette has {len(colors)}.",
            )
        if method == "categories" and info is not None and info.values is not None:
            known = {cql.as_text(v) for v in info.values}
            for ki, k in enumerate(classes):
                missing = [
                    v for v in as_list(k.get("values")) if cql.as_text(v) not in known
                ]
                if missing:
                    self.add(
                        "unknown_category",
                        path + ["classes", item_key(k, ki), "values"],
                        f"No feature has {', '.join(repr(str(v)) for v in missing)}.",
                    )

    def rule(self, when: Any, path: list[str]) -> None:
        if not isinstance(when, dict) or cql.depth(when) > cql.MAX_DEPTH:
            return
        stack = [when]
        while stack:
            node = stack.pop()
            if not isinstance(node, dict):
                continue
            args = node.get("args") if isinstance(node.get("args"), list) else []
            if node.get("op") in cql.LOGICAL:
                stack.extend(args)
                continue
            prop = (
                args[0].get("property") if args and isinstance(args[0], dict) else None
            )
            info = self.field(prop, path)
            if info is None or len(args) < 2:
                continue
            op, literal = node.get("op"), args[1]
            literals = literal if isinstance(literal, list) else [literal]
            if op in ("<", ">", "<=", ">=") and info.type not in NUMERIC + (
                "date",
                "datetime",
            ):
                self.add(
                    "operator_type_mismatch",
                    path,
                    f'"{op}" compares numbers or dates; "{prop}" is a {info.type} field.',
                )
            elif (
                op in ("=", "<>", "in")
                and info.type in NUMERIC
                and any(isinstance(x, str) for x in literals)
            ):
                self.add(
                    "operator_type_mismatch",
                    path,
                    f'"{prop}" is a number field; compare it with a number, not a text.',
                )
            elif (
                op in ("=", "<>", "in")
                and info.type == "boolean"
                and any(not isinstance(x, bool) for x in literals)
            ):
                self.add(
                    "operator_type_mismatch",
                    path,
                    f'"{prop}" is true or false; compare it with true or false.',
                )

    def popup(self, popup: Any) -> None:
        if not isinstance(popup, dict):
            return
        self.liquid(popup.get("html"), ["popup", "html"])
        for bi, b in enumerate(as_list(popup.get("blocks"))):
            if not isinstance(b, dict):
                continue
            bpath = ["popup", "blocks", item_key(b, bi)]
            for ai, a in enumerate(as_list(b.get("attributes"))):
                if isinstance(a, dict):
                    self.field(a.get("field"), bpath + ["attributes", str(ai), "field"])
            if b.get("type") in ("badge", "image") and isinstance(b.get("field"), str):
                if b.get("type") == "badge" or b.get("source") == "field":
                    self.field(b["field"], bpath + ["field"])
            for key in ("html", "url_template"):
                self.liquid(b.get(key), bpath + [key])

    def liquid(self, text: Any, path: list[str]) -> None:
        if not isinstance(text, str):
            return
        defined = {
            m.group(2)
            for m in _LIQUID_TAG.finditer(text)
            if m.group(1) in ("for", "assign", "capture")
        }
        names = {m.group(1) for m in _LIQUID_OUT.finditer(text)}
        names |= {
            m.group(2)
            for m in _LIQUID_TAG.finditer(text)
            if m.group(1) in ("if", "unless", "elsif")
        }
        for name in sorted(names - defined - _LIQUID_SKIP):
            self.field(name, path)

    def render(self, render: Any) -> None:
        if not isinstance(render, dict):
            return
        rtype = render.get("type")
        self.palette(render.get("palette"), ["render", "palette"])
        if rtype == "heatmap" and isinstance(render.get("weight"), dict):
            self.field(
                render["weight"].get("field"),
                ["render", "weight", "field"],
                numeric=True,
                why="a weight is a number",
            )
        if rtype == "cluster":
            count = self.ctx.feature_count
            if count is not None and count > self.ctx.cluster_feature_limit:
                self.add(
                    "too_many_features_for_render",
                    ["render", "type"],
                    f"Clusters are computed in the browser for up to {self.ctx.cluster_feature_limit:,} features; "
                    f"this layer has {count:,}. Use H3 hexagons instead.",
                )
            if isinstance(render.get("symbol"), dict):
                self.parts(render["symbol"], ["render", "symbol"], cluster=True)
        if rtype == "h3":
            self.capability("h3", ["render", "type"], "H3 hexagons")
            value = render.get("value")
            if isinstance(value, dict) and value.get("op") in ("sum", "mean"):
                self.field(
                    value.get("field"),
                    ["render", "value", "field"],
                    numeric=True,
                    why=f"{value['op']} adds numbers",
                )
            if isinstance(render.get("classify"), dict):
                self.palette(
                    render["classify"].get("palette"), ["render", "classify", "palette"]
                )

    def capability(self, name: str, path: list[str], what: str) -> None:
        if name not in self.ctx.capabilities:
            self.add(
                "not_supported_yet",
                path,
                f"{what} cannot be drawn on this deployment yet.",
            )

    # rasters --------------------------------------------------------------------------------------
    def raster(self) -> None:
        doc, ctx = self.doc, self.ctx
        render = doc.get("render") if isinstance(doc.get("render"), dict) else {}
        rtype = render.get("type", "image")
        if ctx.is_service:
            if rtype != "image":
                self.add(
                    "render_not_for_source",
                    ["render", "type"],
                    "A map service sends finished pictures; only image renders apply.",
                )
                return
            for key in ("bands", "no_data"):
                if key in render:
                    self.add(
                        "render_not_for_source",
                        ["render", key],
                        f"A map service has no {key} to choose.",
                    )
            style = render.get("service_style")
            # The service's styles are known only when the caller read its capabilities.
            if (
                style is not None
                and ctx.service_styles
                and style not in ctx.service_styles
            ):
                allowed = list(ctx.service_styles)
                self.add(
                    "invalid_value",
                    ["render", "service_style"],
                    "The service does not offer this style.",
                    allowed=allowed or None,
                )
            popup = doc.get("popup")
            if isinstance(popup, dict) and popup.get("enabled", True):
                self.capability("service_popups", ["popup"], "Map service popups")
            return
        if "service_style" in render:
            self.add(
                "render_not_for_source",
                ["render", "service_style"],
                "Only map services offer service styles.",
            )
        # Values computed from the band's values need the raster service (spec 19).
        classify = render.get("classify")
        if isinstance(classify, dict) and classify.get("method", "manual") != "manual":
            self.capability(
                "raster_service",
                ["render", "classify", "method"],
                "Raster classes computed from the band",
            )
        if (
            rtype in ("continuous", "terrain")
            and render.get(
                "palette", "goat:elevation" if rtype == "continuous" else None
            )
            is not None
            and render.get("domain") is None
            and render.get("stops") is None
        ):
            self.capability(
                "raster_service", ["render", "domain"], "A range computed from the band"
            )
        self.bands(render, rtype)
        self.palette(render.get("palette"), ["render", "palette"])
        if isinstance(render.get("classify"), dict):
            self.palette(
                render["classify"].get("palette"), ["render", "classify", "palette"]
            )
        band = render.get("band", 1)
        if (
            ctx.bands
            and isinstance(render.get("domain"), list)
            and isinstance(band, int)
        ):
            b = next((x for x in ctx.bands if x.index == band), None)
            if b is not None:
                self.domain(
                    render["domain"],
                    FieldInfo("band", "number", min=b.min, max=b.max),
                    ["render", "domain"],
                )
        integer = (ctx.data_type or "").startswith(
            ("int", "uint")
        ) or ctx.data_type == "integer"
        if rtype == "terrain" and (len(ctx.bands) > 1 or ctx.color_table):
            self.add(
                "render_type_mismatch",
                ["render", "type"],
                "Terrain needs a single-band elevation raster.",
            )
        elif rtype == "continuous" and ctx.color_table and integer:
            self.add(
                "render_type_mismatch",
                ["render", "type"],
                "This raster holds class codes with a color table; use categorical or image.",
            )
        elif rtype == "categorical" and ctx.data_type is not None and not integer:
            self.add(
                "render_type_mismatch",
                ["render", "type"],
                "Categories need a raster of whole-number codes.",
            )
        if rtype == "categorical" and ctx.bands:
            self.raster_classes(render)

    def bands(self, render: dict[str, Any], rtype: str) -> None:
        count = len(self.ctx.bands)
        band = render.get("band")
        if isinstance(band, int) and not isinstance(band, bool):
            if count and band > count:
                self.add(
                    "unknown_band",
                    ["render", "band"],
                    f"The raster has {count} band{'s' if count != 1 else ''}.",
                )
        elif isinstance(band, dict):
            self.capability("band_formulas", ["render", "band"], "Band formulas")
            expression = band.get("expression")
            if isinstance(expression, str) and not _valid_formula(expression, count):
                self.add(
                    "invalid_band_expression",
                    ["render", "band", "expression"],
                    f"A band formula uses b1 to b{count or 'N'}, numbers and + - * / ( ).",
                )
        for i, b in enumerate(as_list(render.get("bands"))):
            if isinstance(b, int) and count and b > count:
                self.add(
                    "unknown_band",
                    ["render", "bands", str(i)],
                    f"The raster has {count} bands.",
                )

    def raster_classes(self, render: dict[str, Any]) -> None:
        band = self.ctx.bands[0]
        values = [
            k.get("value")
            for k in as_list(render.get("classes"))
            if isinstance(k, dict)
        ]
        for i, v in enumerate(values):
            if _num(v) and not band.min <= v <= band.max:
                self.add(
                    "unknown_category",
                    ["render", "classes", str(i), "value"],
                    f"No cell has the value {v}.",
                )
        if band.max - band.min <= 256 and not render.get("other_color"):
            missing = [
                v
                for v in range(int(band.min), int(band.max) + 1)
                if v not in values and v != self.ctx.no_data
            ]
            if missing and values:
                self.add(
                    "unclassified_values",
                    ["render", "classes"],
                    f"Values without a class: {missing[:10]}.",
                )


def _valid_formula(expression: str, bands: int) -> bool:
    try:
        parse_formula(expression, bands or None)
    except FormulaError:
        return False
    return True


def _time_field(info: FieldInfo) -> bool:
    if info.type in ("integer", "date", "datetime"):
        return True
    return info.type == "number" and all(
        _num(x) and x == int(x) for x in (info.min, info.max)
    )


def check_against_data(
    doc: dict[str, Any], style: Any, ctx: DataContext
) -> list[Issue]:
    """Rules that need the data: fields and their types, catalogues, bands, sources, limits, capabilities."""
    if not isinstance(doc, dict):
        return []
    checker = _Checker(doc, ctx)
    kind = doc.get("kind")
    if kind in ("vector", "raster") and kind != ctx.kind:
        checker.add("invalid_value", ["kind"], f"This dataset is a {ctx.kind} layer.")
        return checker.issues
    if kind == "raster":
        checker.raster()
    else:
        checker.vector()
    return checker.issues


def referenced_fields(doc: dict[str, Any]) -> set[str]:
    """Every field a vector style reads, as the checks above find them:
    classifications, value forms, rules, labels, order, time, popup, render."""
    checker = _Checker(doc, DataContext(kind="vector"))
    checker.vector()
    return checker.seen

"""Today's GOAT styles (version 0) to GOAT Style 1 (the specification's section 17).

Today's styles were never validated by the server, so the converter reads every
value defensively: what it cannot read is dropped with a `LossyNote`, it never
raises. Map state (`visibility`, `legend.collapsed`) leaves the style and is
returned separately. Today's defaults are written where a key is absent, so the
conversion does not change how a layer looks.
"""

import re
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlsplit

from goatlib.style import limits
from goatlib.style.catalog import icon_names
from goatlib.style.colors import parse_color
from goatlib.style.context import DataContext
from goatlib.style.cql import as_text

#: What today's renderer draws when a key is absent (it reads the stored
#: properties as they are, without the web form's defaults).
TODAY_OPACITY = 1
TODAY_STROKE_WIDTH = 1
TODAY_ICON_SIZE = 100
TODAY_LABEL_SIZE = 14
TODAY_RESAMPLING = "nearest"
TODAY_CLUSTER_MAX_ZOOM = 14
TODAY_UNMATCHED_COLOR = "#aaaaaa"

_METHODS = {
    "quantile": "quantile",
    "equal_interval": "equal_interval",
    "standard_deviation": "std_dev",
    "heads_and_tails": "heads_and_tails",
    "custom_breaks": "manual",
    "ordinal": "categories",
}
_LINE_PLACEMENT = {"start_and_end": "both_ends"}
_POINT_LABEL_PLACEMENT = {"center": "center", "bottom": "above"}
#: Label keys GOAT Style does not have, with today's defaults (not a loss when unchanged).
_LABEL_DEFAULTS: dict[str, Any] = {
    "alignment": "center",
    "background": False,
    "font_family": ["Open Sans Regular", "Arial Unicode MS Regular"],
    "background_color": [0, 0, 0, 0],
}
_ASSET_ID = re.compile(r"^[A-Za-z0-9._-]+$")
_LIBRARY_URL = re.compile(r"/icons/maki/([A-Za-z0-9._-]+)\.svg$")
_UPLOAD_URL = re.compile(r"/users/[^/]+/icon/[^/]+$")


@dataclass(frozen=True)
class LossyNote:
    key: str
    note: str


@dataclass(frozen=True)
class UpgradeResult:
    document: dict[str, Any]
    map_state: dict[str, Any]
    lossy: tuple[LossyNote, ...]
    version_from: int


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v


def _dict(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def _field_name(props: dict[str, Any], prefix: str) -> str | None:
    name = _dict(props.get(f"{prefix}_field")).get("name")
    return name if isinstance(name, str) and name else None


class _Converter:
    def __init__(
        self,
        props: dict[str, Any],
        ctx: DataContext,
        asset_for_url: Callable[[str], str | None] | None = None,
    ) -> None:
        self.props = props
        self.ctx = ctx
        self.asset_for_url = asset_for_url
        self.lossy: list[LossyNote] = []
        self.map_state: dict[str, Any] = {}

    def lose(self, key: str, note: str) -> None:
        self.lossy.append(LossyNote(key=key, note=note))

    # common ---------------------------------------------------------------------------------------
    def common(self, doc: dict[str, Any]) -> None:
        p = self.props
        if isinstance(p.get("visibility"), bool):
            self.map_state["visible"] = p["visibility"]
        legend = _dict(p.get("legend"))
        if isinstance(legend.get("collapsed"), bool):
            self.map_state["legend_expanded"] = not legend["collapsed"]
        out = {
            k: legend[k]
            for k in ("show", "caption")
            if isinstance(legend.get(k), (bool, str))
        }
        if out:
            doc["legend"] = out
        zooms = {k: _num(p.get(k)) for k in ("min_zoom", "max_zoom")}
        lo, hi = zooms["min_zoom"], zooms["max_zoom"]
        if lo is not None and hi is not None and lo >= hi:
            self.lose(
                "min_zoom",
                f"The zoom range {lo} to {hi} drew nothing; the layer is hidden instead.",
            )
            self.map_state["visible"] = False
            return
        for key, z in zooms.items():
            if z is not None and 0 <= z <= 24:
                doc[key] = z

    # vector ---------------------------------------------------------------------------------------
    def vector(self) -> dict[str, Any]:
        p, geometry = self.props, self.ctx.geometry
        doc: dict[str, Any] = {"version": 1, "kind": "vector"}
        symbol: dict[str, Any] = {}
        classify: list[dict[str, Any]] = []
        opacity = _num(p.get("opacity"))
        opacity = TODAY_OPACITY if opacity is None or not 0 <= opacity <= 1 else opacity
        filled = p.get("filled") is True
        stroked = p.get("stroked") is True

        if geometry == "polygon":
            if filled:
                fill: dict[str, Any] = {"opacity": opacity}
                self.color_into(fill, classify, "color", "fill.color")
                symbol["fill"] = fill
            else:
                symbol["fill"] = False
            if stroked:
                outline: dict[str, Any] = {}
                self.color_into(outline, classify, "stroke_color", "outline.color")
                self.size_into(
                    outline,
                    classify,
                    "stroke_width",
                    "outline.width",
                    TODAY_STROKE_WIDTH,
                )
                symbol["outline"] = outline
            else:
                symbol["outline"] = False
        elif geometry == "line":
            line: dict[str, Any] = {"opacity": opacity}
            self.color_into(line, classify, "stroke_color", "line.color")
            self.size_into(
                line, classify, "stroke_width", "line.width", TODAY_STROKE_WIDTH
            )
            self.line_style(line)
            symbol["line"] = line
            self.arrows(symbol)
        elif geometry == "point":
            self.marker(symbol, classify, opacity, filled, stroked)

        label = self.label(geometry)
        if label:
            symbol["label"] = label
        if symbol:
            doc["symbol"] = symbol
        if classify:
            doc["classify"] = classify
        self.common(doc)
        if geometry == "point":
            self.cluster(doc)
        popup = self.popup()
        if popup is not None:
            doc["popup"] = popup
        return doc

    def color_into(
        self,
        part: dict[str, Any],
        classify: list[dict[str, Any]],
        prefix: str,
        target: str,
    ) -> None:
        p = self.props
        base = parse_color(p.get(prefix))
        key = target.split(".")[1]
        if base:
            part[key] = base
        elif p.get(prefix) is not None:
            self.lose(prefix, "Unreadable color; the part takes its default.")
        field_name = _field_name(p, prefix)
        if not field_name:
            return
        scale = p.get(f"{prefix}_scale")
        rng = _dict(p.get(f"{prefix}_range"))
        colors = (
            [c for c in (parse_color(x) for x in rng.get("colors")) if c]
            if isinstance(rng.get("colors"), list)
            else []
        )
        color_map = (
            rng.get("color_map") if isinstance(rng.get("color_map"), list) else []
        )
        legends = _dict(rng.get("color_legends"))
        method = _METHODS.get(scale) if isinstance(scale, str) else None
        part_name = target.split(".")[0]
        classes: list[dict[str, Any]] = []
        c: dict[str, Any] = {"field": field_name}

        if method == "categories" and color_map:
            seen: set[str] = set()
            for values, color in _pairs(color_map):
                clean = _first_seen(values, seen)
                if clean and parse_color(color):
                    classes.append(
                        {"values": clean, part_name: {key: parse_color(color)}}
                    )
            c.update(
                {
                    "method": "categories",
                    "target": target,
                    "classes": classes,
                    "other": {part_name: {key: TODAY_UNMATCHED_COLOR}},
                }
            )
        elif method == "manual" and color_map:
            bounds = []
            for values, color in _pairs(color_map):
                lower = _num(_to_float(values[0])) if values else None
                if lower is not None and parse_color(color):
                    bounds.append((lower, parse_color(color), values[0]))
            bounds = _dedupe_bounds(bounds)
            for i, (lower, color, raw) in enumerate(bounds):
                record: dict[str, Any] = {}
                if i > 0:
                    record["from"] = lower
                if i < len(bounds) - 1:
                    record["to"] = bounds[i + 1][0]
                name = legends.get(str(raw))
                if isinstance(name, str):
                    record["name"] = name
                record[part_name] = {key: color}
                classes.append(record)
            c.update({"method": "manual", "target": target, "classes": classes})
        elif method and method not in ("categories", "manual"):
            breaks = [
                b
                for b in (
                    _num(x)
                    for x in _dict(p.get(f"{prefix}_scale_breaks")).get("breaks") or []
                )
                if b is not None
            ]
            if not colors or len(breaks) != len(colors) - 1:
                self.lose(
                    f"{prefix}_scale",
                    "The classification was incomplete and drew in one color; it is left out.",
                )
                return
            scale_breaks = _dict(p.get(f"{prefix}_scale_breaks"))
            bounds = breaks + (
                [scale_breaks["max"]]
                if _num(scale_breaks.get("max")) is not None
                else []
            )
            pairs = _keep_last(list(zip(bounds, colors)))
            for i, (upper, color) in enumerate(pairs):
                record = {}
                if i > 0:
                    record["from"] = pairs[i - 1][0]
                if i < len(pairs) - 1:
                    record["to"] = upper
                record[part_name] = {key: color}
                classes.append(record)
            c.update(
                {
                    "method": method,
                    "count": len(classes),
                    "target": target,
                    "classes": classes,
                }
            )
        else:
            self.lose(
                f"{prefix}_field",
                "A field without a readable classification; drawn in one color.",
            )
            return
        if not classes:
            self.lose(f"{prefix}_range", "No readable classes; drawn in one color.")
            return
        palette = palette_id_for_v0(rng) if colors else None
        if palette is not None and (
            isinstance(palette, str) or 2 <= len(palette) <= 12
        ):
            c["palette"] = palette
        if rng.get("reversed") is True:
            c["reverse"] = True
        if target == {
            "polygon": "fill.color",
            "line": "line.color",
            "point": "marker.color",
        }.get(self.ctx.geometry or ""):
            c.pop("target")
        no_data = p.get(f"{prefix}_no_data")
        if no_data == "transparent":
            c["no_data"] = {part_name: {key: "#00000000"}}
        elif parse_color(no_data):
            c["no_data"] = {part_name: {key: parse_color(no_data)}}
        elif "other" in c:
            # Today's match reads a missing value as "" and draws it like an unmatched value.
            c["no_data"] = {part_name: {key: TODAY_UNMATCHED_COLOR}}
        classify.append(c)

    def size_into(
        self,
        part: dict[str, Any],
        classify: list[dict[str, Any]],
        prefix: str,
        target: str,
        default: float,
        factor: float = 1,
    ) -> None:
        p = self.props
        key = target.split(".")[1]
        value = _num(p.get(prefix))
        part[key] = (value if value is not None and value >= 0 else default) * factor
        field_name = _field_name(p, prefix)
        if not field_name:
            return
        part_name = target.split(".")[0]
        scale = p.get(f"{prefix}_scale")
        if scale == "ordinal":
            pairs = [
                x
                for x in p.get(f"{prefix}_ordinal_map") or []
                if isinstance(x, list) and len(x) == 2 and _num(x[1]) is not None
            ]
            if pairs:
                classes = [
                    {"values": [str(v)], part_name: {key: s * factor}} for v, s in pairs
                ]
                classify.append(
                    {
                        "field": field_name,
                        "method": "categories",
                        "target": target,
                        "classes": classes,
                    }
                )
            return
        rng = p.get(f"{prefix}_range")
        breaks = [
            b
            for b in (
                _num(x)
                for x in _dict(p.get(f"{prefix}_scale_breaks")).get("breaks") or []
            )
            if b is not None
        ]
        method = _METHODS.get(scale) if isinstance(scale, str) else None
        if not (
            isinstance(rng, list)
            and len(rng) == 2
            and all(_num(x) is not None for x in rng)
            and breaks
            and method
        ):
            self.lose(
                f"{prefix}_field",
                "A size by field without readable classes; drawn in one size.",
            )
            return
        breaks = [b for i, b in enumerate(breaks) if i == 0 or b != breaks[i - 1]]
        n = len(breaks) + 1
        sizes = [
            round((rng[0] + (rng[1] - rng[0]) * i / (n - 1)) * factor, 2)
            for i in range(n)
        ]
        classes = []
        for i in range(n):
            record: dict[str, Any] = {}
            if i > 0:
                record["from"] = breaks[i - 1]
            if i < n - 1:
                record["to"] = breaks[i]
            record[part_name] = {key: sizes[i]}
            classes.append(record)
        classify.append(
            {
                "field": field_name,
                "method": "manual" if method == "categories" else method,
                "count": n,
                "target": target,
                "range": [rng[0] * factor, rng[1] * factor],
                "classes": classes,
            }
        )

    def line_style(self, line: dict[str, Any]) -> None:
        p = self.props
        if p.get("stroke_pattern") in ("dashed", "dotted", "dash_dot"):
            line["dash"] = p["stroke_pattern"]
        if p.get("stroke_dash_density") not in (None, "normal"):
            self.lose(
                "stroke_dash_density",
                "Dash density is not part of GOAT Style; the default spacing applies.",
            )
        if p.get("stroke_cap") in ("round", "square"):
            line["cap"] = p["stroke_cap"]
        line["join"] = (
            p["stroke_join"]
            if p.get("stroke_join") in ("round", "bevel", "miter")
            else "miter"
        )
        offset = _num(p.get("stroke_offset"))
        if offset:
            line["offset"] = offset

    def arrows(self, symbol: dict[str, Any]) -> None:
        p = self.props
        if p.get("decoration_type") != "arrow":
            return
        arrows: dict[str, Any] = {}
        placement = p.get("decoration_placement")
        if placement in ("repeat", "start", "end", "center", "start_and_end"):
            arrows["placement"] = _LINE_PLACEMENT.get(placement, placement)
        if p.get("decoration_direction") in ("forward", "backward", "both"):
            arrows["direction"] = p["decoration_direction"]
        for src, dst in (
            ("decoration_spacing", "spacing"),
            ("decoration_size", "size"),
        ):
            v = _num(p.get(src))
            if v is not None and v >= 0:
                arrows[dst] = limits.inside(f"arrows.{dst}", v)
        if p.get("decoration_allow_overlap") is False:
            self.lose(
                "decoration_allow_overlap", "Arrows always overlap in GOAT Style."
            )
        symbol["arrows"] = arrows

    def marker(
        self,
        symbol: dict[str, Any],
        classify: list[dict[str, Any]],
        opacity: float,
        filled: bool,
        stroked: bool,
    ) -> None:
        p = self.props
        marker: dict[str, Any] = {}
        if p.get("custom_marker") is True:
            base_icon = self.icon(_dict(p.get("marker")), "marker")
            by_value = self.icon_classes()
            if not base_icon and not by_value:
                self.lose(
                    "marker",
                    "A custom marker without an icon drew nothing; the marker is switched off.",
                )
                symbol["marker"] = False
                return
            marker["shape"] = "icon"
            if base_icon:
                marker["icon"] = base_icon
            self.size_into(
                marker, classify, "marker_size", "marker.size", TODAY_ICON_SIZE
            )
            if filled:
                marker["opacity"] = opacity
                self.color_into(marker, classify, "color", "marker.color")
            else:
                marker["color"] = "#000000"
            anchor = p.get("marker_anchor")
            if isinstance(anchor, str) and anchor:
                marker["anchor"] = anchor.replace("-", "_")
            offset = p.get("marker_offset")
            if (
                isinstance(offset, list)
                and len(offset) == 2
                and all(_num(x) is not None for x in offset)
                and any(offset)
            ):
                # MapLibre scales icon-offset by icon-size (marker_size / 200).
                scale = (_num(p.get("marker_size")) or TODAY_ICON_SIZE) / 200
                marker["offset"] = [round(x * scale, 2) for x in offset]
            if p.get("marker_allow_overlap") is True:
                marker["allow_overlap"] = True
            if by_value:
                if not base_icon:
                    by_value["other"] = {"visible": False}
                    by_value["no_data"] = {"visible": False}
                classify.append(by_value)
            symbol["marker"] = marker
            return
        marker["shape"] = "circle"
        marker["opacity"] = opacity
        if not filled:
            marker["fill"] = False
        self.color_into(marker, classify, "color", "marker.color")
        self.size_into(marker, classify, "radius", "marker.size", 5, factor=2)
        symbol["marker"] = marker
        if stroked:
            outline: dict[str, Any] = {}
            self.color_into(outline, classify, "stroke_color", "outline.color")
            self.size_into(
                outline, classify, "stroke_width", "outline.width", TODAY_STROKE_WIDTH
            )
            symbol["outline"] = outline

    def icon(self, marker: dict[str, Any], key: str) -> str | None:
        name = marker.get("name") if isinstance(marker.get("name"), str) else ""
        asset_id = marker.get("id") if isinstance(marker.get("id"), str) else ""
        url = marker.get("url") if isinstance(marker.get("url"), str) else ""
        if not name and not asset_id and not url:
            return None
        library = _LIBRARY_URL.search(url)
        if library and marker.get("source") != "custom":
            return f"goat:{library.group(1)}"
        if marker.get("source") == "custom" or _UPLOAD_URL.search(url):
            if asset_id and _ASSET_ID.match(asset_id):
                return f"asset:{asset_id}"
            found = (
                self.asset_for_url(_url_path(url))
                if self.asset_for_url and url
                else None
            )
            if found:
                return f"asset:{found}"
        elif name in icon_names():
            return f"goat:{name}"
        self.lose(
            key,
            f"Icon {name or asset_id or url!r} is neither in GOAT's library nor a known upload; it is left out.",
        )
        return None

    def icon_classes(self) -> dict[str, Any] | None:
        p = self.props
        field_name = _field_name(p, "marker")
        mapping = p.get("marker_mapping")
        if not field_name or not isinstance(mapping, list):
            return None
        classes = []
        seen: set[str] = set()
        for values, marker in _pairs(mapping):
            icon = self.icon(_dict(marker), "marker_mapping")
            clean = _first_seen(values, seen)
            if icon and clean:
                classes.append({"values": clean, "marker": {"icon": icon}})
        if not classes:
            return None
        return {
            "field": field_name,
            "method": "categories",
            "target": "marker.icon",
            "classes": classes,
        }

    def label(self, geometry: str | None) -> dict[str, Any] | None:
        tl = self.props.get("text_label")
        if (
            not isinstance(tl, dict)
            or not isinstance(tl.get("field"), str)
            or not tl["field"]
        ):
            return None
        size = _num(tl.get("size")) or TODAY_LABEL_SIZE
        label: dict[str, Any] = {
            "text": "{" + tl["field"].replace("{", "\\{").replace("}", "\\}") + "}",
            "size": size,
            "color": parse_color(tl.get("color")) or "#000000",
            "halo": {
                "color": parse_color(tl.get("outline_color")) or "#ffffff",
                "width": _num(tl.get("outline_width"))
                if _num(tl.get("outline_width")) is not None
                else 1,
            },
        }
        if geometry == "point":
            anchor = tl.get("anchor") if isinstance(tl.get("anchor"), str) else "top"
            label["placement"] = _POINT_LABEL_PLACEMENT.get(anchor, "auto")
            if anchor not in _POINT_LABEL_PLACEMENT:
                self.lose(
                    "text_label.anchor",
                    f'Label anchor "{anchor}" becomes automatic placement.',
                )
        elif geometry == "line":
            label["placement"] = "line"
        elif geometry == "polygon":
            label["placement"] = "inside"
        offset = tl.get("offset")
        if (
            isinstance(offset, list)
            and len(offset) == 2
            and all(_num(x) is not None for x in offset)
            and any(offset)
        ):
            label["offset"] = [round(x * size, 2) for x in offset]
        if tl.get("allow_overlap") is True:
            label["allow_overlap"] = True
        for key, today in _LABEL_DEFAULTS.items():
            if key in tl and tl[key] != today:
                self.lose(f"text_label.{key}", "Not part of GOAT Style 1.0.")
        return label

    def cluster(self, doc: dict[str, Any]) -> None:
        cl = self.props.get("cluster")
        if not isinstance(cl, dict) or cl.get("enabled") is not True:
            return
        max_zoom = _num(cl.get("max_zoom"))
        render: dict[str, Any] = {
            "type": "cluster",
            "cluster_until_zoom": (
                max_zoom if max_zoom is not None else TODAY_CLUSTER_MAX_ZOOM
            )
            + 1,
        }
        radius = _num(cl.get("radius"))
        if radius is not None:
            render["radius"] = radius
        min_points = _num(cl.get("min_points"))
        if min_points is not None and min_points >= 2:
            render["min_points"] = int(min_points)
        symbol: dict[str, Any] = {}
        if parse_color(cl.get("color")):
            symbol["marker"] = {"color": parse_color(cl.get("color"))}
        if parse_color(cl.get("text_color")):
            symbol["label"] = {
                "text": "{count}",
                "color": parse_color(cl.get("text_color")),
            }
        if symbol:
            render["symbol"] = symbol
        doc["render"] = render

    def popup(self) -> dict[str, Any] | bool | None:
        p = self.props
        popup = p.get("popup")
        if isinstance(popup, dict):
            return _popup_v1(popup, self)
        interaction = p.get("interaction")
        if isinstance(interaction, dict):
            return _popup_from_interaction(interaction)
        return None

    # raster ---------------------------------------------------------------------------------------
    def raster(self) -> dict[str, Any]:
        p = self.props
        doc: dict[str, Any] = {"version": 1, "kind": "raster"}
        style = _dict(p.get("style"))
        opacity = _num(p.get("opacity"))
        style_opacity = _num(style.get("opacity"))
        if opacity is not None or style_opacity is not None:
            doc["opacity"] = round(
                (opacity if opacity is not None else 1)
                * (style_opacity if style_opacity is not None else 1),
                4,
            )
        self.common(doc)
        resampling = p.get("resampling")
        doc["resampling"] = (
            resampling if resampling in ("linear", "nearest") else TODAY_RESAMPLING
        )
        if self.ctx.is_service:
            doc["render"] = {"type": "image"}
            if style.get("style_type") not in (None, "image"):
                self.lose(
                    "style",
                    "A map service draws its own pictures; the raster style is left out.",
                )
            return doc
        style_type = style.get("style_type", "image")
        band = _num(style.get("band"))
        band = int(band) if band is not None and band >= 1 else None
        if style_type == "color_range":
            render: dict[str, Any] = {"type": "continuous"}
            if band:
                render["band"] = band
            stops = [
                {"value": values[0], "color": parse_color(c)}
                for values, c in _pairs(style.get("color_map"))
                if len(values) == 1 and _num(values[0]) is not None and parse_color(c)
            ]
            stops.sort(key=lambda s: s["value"])
            render["stops"] = stops
            render["interpolate"] = (
                "linear" if style.get("interpolate") is not False else "nearest"
            )
            if style.get("no_data_color") not in (None, "transparent"):
                self.lose(
                    "style.no_data_color",
                    "No-data cells are transparent in GOAT Style.",
                )
            labels = {
                k: style[k]
                for k in ("min_label", "max_label")
                if isinstance(style.get(k), str)
            }
            if labels:
                doc["legend"] = {**doc.get("legend", {}), **labels}
        elif style_type == "categories":
            render = {"type": "categorical"}
            if band:
                render["band"] = band
            classes = []
            for cat in style.get("categories") or []:
                if (
                    isinstance(cat, dict)
                    and _num(cat.get("value")) is not None
                    and parse_color(cat.get("color"))
                ):
                    record: dict[str, Any] = {
                        "value": cat["value"],
                        "color": parse_color(cat["color"]),
                    }
                    if isinstance(cat.get("label"), str):
                        record["name"] = cat["label"]
                    classes.append(record)
            render["classes"] = classes
            if parse_color(style.get("default_color")):
                render["other_color"] = parse_color(style.get("default_color"))
        elif style_type == "hillshade":
            render = {"type": "terrain"}
            if band:
                render["band"] = band
            for src, dst in (("azimuth", "direction"), ("altitude", "altitude")):
                v = _num(style.get(src))
                if v is not None:
                    render[dst] = limits.inside(f"terrain.{dst}", v)
            z = _num(style.get("z_factor"))
            if z is not None:
                render["exaggeration"] = limits.inside(
                    "terrain.exaggeration", round(z / 2, 4)
                )
                if z > 2:
                    self.lose(
                        "style.z_factor",
                        f"z_factor {z} is above what terrain shading shows; exaggeration is capped at 1.",
                    )
        else:
            render = {"type": "image"}
            lo, hi = (
                _num(style.get("brightness_min")),
                _num(style.get("brightness_max")),
            )
            brightness = None
            if lo is not None and lo > 0:
                brightness = lo
                if hi is not None and hi < 1:
                    self.lose(
                        "style.brightness_max",
                        "Only one brightness is kept when both ends were moved.",
                    )
            elif hi is not None and hi < 1:
                brightness = round(hi - 1, 4)
            if brightness:
                doc["brightness"] = brightness
            for key in ("contrast", "saturation"):
                v = _num(style.get(key))
                if v:
                    doc[key] = v
            gamma = _num(style.get("gamma"))
            if gamma is not None and gamma != 1:
                self.lose("style.gamma", "Gamma is not part of GOAT Style 1.0.")
        doc["render"] = render
        return doc


def _url_path(url: str) -> str:
    """A URL's path without the leading slash: the object key uploads are stored under."""
    return urlsplit(url).path.lstrip("/")


def _keep_last(pairs: list[tuple[Any, Any]]) -> list[tuple[Any, Any]]:
    """Pairs whose value repeats keep only the last one, as today's renderer does."""
    out: list[tuple[Any, Any]] = []
    seen: set[Any] = set()
    for value, color in reversed(pairs):
        if value not in seen:
            seen.add(value)
            out.append((value, color))
    return out[::-1]


def _first_seen(values: list[Any], seen: set[str]) -> list[str]:
    """Category values as text, without values an earlier class has (today's renderer keeps the first)."""
    out = []
    for v in values:
        text = as_text(v) if v is not None else None
        if text is not None and text not in seen:
            seen.add(text)
            out.append(text)
    return out


def _to_float(v: Any) -> Any:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _pairs(items: Any) -> list[tuple[list[Any], Any]]:
    """`[[values, x], ...]` entries, with a single value read as a one-element list."""
    out = []
    for entry in items if isinstance(items, list) else []:
        if isinstance(entry, (list, tuple)) and len(entry) == 2:
            values = entry[0] if isinstance(entry[0], list) else [entry[0]]
            out.append((values, entry[1]))
    return out


def _dedupe_bounds(bounds: list[tuple[Any, Any, Any]]) -> list[tuple[Any, Any, Any]]:
    """Equal consecutive lower bounds collapse to the last one, as today's renderer does."""
    out: list[tuple[Any, Any, Any]] = []
    for b in bounds:
        if out and out[-1][0] == b[0] and b[0] is not None:
            out[-1] = b
        else:
            out.append(b)
    return out


def _format_from_v0(attribute: dict[str, Any]) -> dict[str, Any] | None:
    fmt = {
        k: v
        for k, v in _dict(attribute.get("format_config")).items()
        if k in ("decimals", "thousands_separator", "abbreviate", "always_show_sign")
    }
    for key in ("prefix", "suffix"):
        if isinstance(attribute.get(key), str) and attribute[key]:
            fmt[key] = attribute[key]
    return fmt or None


def _attributes(attrs: Any) -> list[dict[str, Any]]:
    out = []
    for a in attrs if isinstance(attrs, list) else []:
        if not isinstance(a, dict) or not isinstance(a.get("name"), str):
            continue
        item: dict[str, Any] = {"field": a["name"]}
        if isinstance(a.get("label"), str) and a["label"]:
            item["label"] = a["label"]
        if a.get("type") in ("string", "number", "boolean"):
            item["type"] = a["type"]
        fmt = _format_from_v0(a)
        if fmt:
            item["format"] = fmt
        out.append(item)
    return out


_BLOCK_KEYS = {
    "text": ("html",),
    "image": ("source", "field", "url", "sizing", "height", "aspect"),
    "button": ("label", "url_template", "style", "color"),
    "badge": ("field", "mode", "color", "palette", "labels", "full_width"),
    "divider": ("thickness", "color"),
}


def _popup_v1(popup: dict[str, Any], conv: "_Converter") -> dict[str, Any] | bool:
    if popup.get("enabled") is False:
        return False
    out: dict[str, Any] = {}
    for key in (
        "trigger",
        "mode",
        "html",
        "layout",
        "anchor",
        "header",
        "highlight_active_feature",
    ):
        if key in popup and popup[key] is not None:
            out[key] = popup[key]
    for key in ("width", "max_height"):
        size = _num(popup.get(key))
        if size is not None and size >= 1:
            out[key] = min(int(size), 4000)
    if popup.get("position") == "fixed" and "layout" not in out:
        out["layout"] = "pinned"
    if popup.get("show_layer_header") is False and "header" not in out:
        out["header"] = "none"
    blocks = []
    for b in popup.get("blocks") or []:
        if not isinstance(b, dict):
            continue
        btype = "field_list" if b.get("type") == "fieldList" else b.get("type")
        block: dict[str, Any] = {"type": btype}
        if isinstance(b.get("id"), str):
            block["id"] = b["id"]
        if btype == "field_list":
            if b.get("layout") in ("table", "list"):
                block["layout"] = b["layout"]
            attributes = _attributes(b.get("attributes"))
            if attributes:
                block["attributes"] = attributes
            if isinstance(b.get("collapse_after"), int):
                block["collapse_after"] = b["collapse_after"]
        elif btype in _BLOCK_KEYS:
            for key in _BLOCK_KEYS[btype]:
                if b.get(key) is not None:
                    block[key] = b[key]
        else:
            conv.lose("popup.blocks", f"Unknown popup block {btype!r} left out.")
            continue
        blocks.append(block)
    if blocks:
        out["blocks"] = blocks
    return out


def _popup_from_interaction(interaction: dict[str, Any]) -> dict[str, Any] | bool:
    trigger = interaction.get("type", "click")
    if trigger == "none":
        return False
    out: dict[str, Any] = {
        "trigger": trigger if trigger in ("click", "hover") else "click"
    }
    blocks = []
    for content in interaction.get("content") or []:
        if not isinstance(content, dict):
            continue
        if (
            content.get("type") == "image"
            and isinstance(content.get("url"), str)
            and content["url"]
        ):
            blocks.append({"type": "image", "source": "static", "url": content["url"]})
        elif content.get("type", "field_list") == "field_list":
            attributes = _attributes(content.get("attributes"))
            block: dict[str, Any] = {"type": "field_list"}
            if attributes:
                block["attributes"] = attributes
            blocks.append(block)
    if blocks:
        out["blocks"] = blocks
    return out


def convert_v0(
    properties: dict[str, Any],
    ctx: DataContext,
    *,
    asset_for_url: Callable[[str], str | None] | None = None,
) -> "UpgradeResult":
    """Today's `properties` of a layer or project layer as a GOAT Style 1 document.

    `asset_for_url` resolves an uploaded icon's object key (its URL path) to the
    uploaded asset's id, for icons stored with a URL but without an id.
    """
    conv = _Converter(
        properties if isinstance(properties, dict) else {}, ctx, asset_for_url
    )
    try:
        document = conv.raster() if ctx.kind == "raster" else conv.vector()
    except Exception as exc:  # a shape no rule foresaw: keep what is safe, report it
        conv.lose("*", f"Conversion stopped early: {type(exc).__name__}: {exc}")
        document = {"version": 1, "kind": ctx.kind}
    return UpgradeResult(
        document=document,
        map_state=conv.map_state,
        lossy=tuple(conv.lossy),
        version_from=0,
    )


def palette_id_for_v0(color_range: dict[str, Any]) -> str | list[str]:
    from goatlib.style.upgrade import palette_id_for_v0 as impl

    return impl(color_range)


__all__ = ["LossyNote", "UpgradeResult", "convert_v0"]

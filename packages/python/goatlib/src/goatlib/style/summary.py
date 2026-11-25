"""A layer style in one line of plain words, for lists the AI reads.

`summarize` reads the plain document, not the models, so a damaged document
gives a shorter summary instead of an error: "fill by density, quantile,
5 classes, colorbrewer:Blues; labels name".
"""

from typing import Any

from goatlib.style.check import MAIN_COLOR, MAIN_PART
from goatlib.style.template import placeholders

MAX_LENGTH = 200

_GEOMETRIES = ("polygon", "line", "point")
_POINT_RENDERS = {"heatmap": "heatmap", "cluster": "clusters", "h3": "hexagons"}
_RASTER_RENDERS = ("image", "continuous", "categorical", "hillshade")
_HEIGHT = "extrude.height"
_ZOOMS = ("min_zoom", "max_zoom")
_MAX_RECORD_KEYS = 4


def summarize(document: dict[str, Any]) -> str:
    """The style's look, labels, height and rules, joined by "; "."""
    if not isinstance(document, dict):
        return ""
    render = _dict(document.get("render"))
    kind = document.get("kind")
    render_type = _text(render.get("type"))
    if kind == "raster" or (kind is None and render_type in _RASTER_RENDERS):
        parts = [_raster(render)]
    else:
        parts = _vector(document, render_type)
    text = "; ".join(p for p in parts if p)
    if len(text) > MAX_LENGTH:
        text = text[: MAX_LENGTH - 3] + "..."
    return text


def _vector(document: dict[str, Any], render_type: str | None) -> list[str]:
    symbol = document.get("symbol")
    symbol = symbol if isinstance(symbol, dict) else None
    classify = [c for c in _list(document.get("classify")) if isinstance(c, dict)]
    geometry = _geometry(document, symbol)
    main_part = MAIN_PART[geometry] if geometry else None
    main_color = MAIN_COLOR[geometry] if geometry else None

    if render_type in _POINT_RENDERS:
        parts = [_POINT_RENDERS[render_type]]
    else:
        parts = [_look(symbol, classify, main_part, main_color)]

    height = _height(symbol)
    for c in classify:
        if _on_main_color(c, main_part, main_color):
            continue
        field = _name(c.get("field"))
        target = c.get("target")
        if target == _HEIGHT:
            if height is not None:
                height = f"height by {field}" if field else "height"
            continue
        if isinstance(target, str):
            words = target.replace(".", " ")
        else:
            words = ", ".join(_record_keys(c)[:_MAX_RECORD_KEYS])
        parts.append(f"{words} by {field}" if field else words)
    if symbol is not None:
        parts.extend(_value_forms(symbol, main_part))
    parts.append(_labels(symbol))
    parts.append(height or "")
    rules = sum(isinstance(r, dict) for r in _list(document.get("rules")))
    if rules:
        parts.append(_plural(rules, "rule", "rules"))
    return parts


def _geometry(document: dict[str, Any], symbol: dict[str, Any] | None) -> str | None:
    geometry = _text(document.get("geometry"))
    if geometry in MAIN_PART:
        return geometry
    for geometry in _GEOMETRIES:
        if symbol is not None and MAIN_PART[geometry] in symbol:
            return geometry
    return None


def _look(
    symbol: dict[str, Any] | None,
    classify: list[dict[str, Any]],
    main_part: str | None,
    main_color: str | None,
) -> str:
    """The main part: the classification that colors it, else its color.

    Of several classifications on the main color the last one that covers
    every feature wins (5.7), else the last one.
    """
    on_main = [c for c in classify if _on_main_color(c, main_part, main_color)]
    covering = [c for c in on_main if _covers_all(c)]
    winner = (covering or on_main or [None])[-1]
    if winner is not None:
        return _classification(main_part or "color", winner)
    if main_part is None or symbol is None:
        return ""
    value = symbol.get(main_part)
    if value is False:
        return f"no {main_part}"
    color = value.get("color") if isinstance(value, dict) else None
    return _color(main_part, color)


def _on_main_color(
    c: dict[str, Any], main_part: str | None, main_color: str | None
) -> bool:
    """Whether a classification sets the main color.

    Without a `target` it does when it has a palette, when its records change
    nothing, or when one of its records sets the main color.
    """
    target = c.get("target")
    if isinstance(target, str):
        return target == main_color
    if main_part is None or "palette" in c or not _record_keys(c):
        return True
    return any(
        isinstance(r.get(main_part), dict) and "color" in r[main_part]
        for r in _records(c)
    )


def _covers_all(c: dict[str, Any]) -> bool:
    """Numeric classes cover the whole range; categories need an `other`."""
    return c.get("method") != "categories" or isinstance(c.get("other"), dict)


def _records(c: dict[str, Any]) -> list[dict[str, Any]]:
    classes = [r for r in _list(c.get("classes")) if isinstance(r, dict)]
    rest = [c.get("other"), c.get("no_data")]
    return classes + [r for r in rest if isinstance(r, dict)]


def _record_keys(c: dict[str, Any]) -> list[str]:
    """What the records of a classification change: `line dash`, `casing`."""
    keys: list[str] = []
    for record in _records(c):
        for part, value in record.items():
            if part == "visible" or part in _ZOOMS:
                found = ["visibility"]
            elif part == "extrude":
                found = ["height"]
            elif isinstance(value, dict):
                found = [f"{part} {k}" for k in value if k not in _ZOOMS]
            elif value is False and part != "legend":
                found = [str(part)]
            else:
                found = []
            keys.extend(k for k in found if k not in keys)
    return keys


def _classification(part: str, c: dict[str, Any]) -> str:
    field = _name(c.get("field"))
    words = [f"{part} by {field}" if field else part]
    count = _count(c)
    if c.get("method") == "categories":
        if count:
            words.append(_plural(count, "category", "categories"))
        if isinstance(c.get("other"), dict):
            words.append("rest grouped")
        return ", ".join(words)
    method = _name(c.get("method"))
    if method:
        words.append(method)
    if count:
        words.append(_plural(count, "class", "classes"))
    palette = _palette(c.get("palette"), c.get("reverse"))
    if palette:
        words.append(palette)
    return ", ".join(words)


def _color(part: str, color: Any) -> str:
    if isinstance(color, str):
        return f"{part} {_flat(color)}"
    if not isinstance(color, dict):
        return part
    if "zoom" in color:
        stop = _attribute_stop(color)
        return _color(part, stop) if stop is not None else f"{part} by zoom"
    field = _name(color.get("field"))
    if not field:
        return part
    if "palette" not in color:
        return f"{part} color from {field}"
    palette = _palette(color.get("palette"), color.get("reverse"))
    return ", ".join(w for w in (f"{part} by {field}", "smooth", palette) if w)


def _value_forms(symbol: dict[str, Any], main_part: str | None) -> list[str]:
    """`<part> <key> by <field>` for every property by attribute but the main color.

    The height has a part of its own and a label's `priority` is no look.
    """
    found = []
    for part, value in symbol.items():
        if part == "extrude" or not isinstance(value, dict):
            continue
        for key, v in value.items():
            if (part == main_part and key == "color") or (
                part == "label" and key == "priority"
            ):
                continue
            field = _field_of(v)
            if field:
                found.append(f"{part} {key} by {field}")
            elif isinstance(v, dict) and "zoom" not in v:
                found.extend(
                    f"{part} {key} {sub} by {f}"
                    for sub, inner in v.items()
                    if (f := _field_of(inner))
                )
    return found


def _labels(symbol: dict[str, Any] | None) -> str:
    label = symbol.get("label") if symbol is not None else None
    if not isinstance(label, dict):
        return ""
    text = label.get("text")
    if isinstance(text, str):
        texts = [text]
    elif isinstance(text, dict):
        texts = [s[1] for s in _stops(text) if isinstance(s[1], str)]
    else:
        texts = []
    fields: list[str] = []
    for t in texts:
        for field in placeholders(t):
            name = _flat(field)
            if name and name not in fields:
                fields.append(name)
    return f"labels {', '.join(fields)}" if fields else "labels"


def _height(symbol: dict[str, Any] | None) -> str | None:
    """The height part, or None when the symbol switches it off."""
    extrude = symbol.get("extrude") if symbol is not None else None
    if extrude is False:
        return None
    if not isinstance(extrude, dict):
        return ""
    height = extrude.get("height")
    field = _field_of(height)
    if field:
        return f"height by {field}"
    if isinstance(height, (int, float)) and not isinstance(height, bool):
        return f"height {height:g} m"
    if isinstance(height, dict) and "zoom" in height:
        return "height by zoom"
    return "height"


def _raster(render: dict[str, Any]) -> str:
    kind = render.get("type")
    if kind == "image":
        return "image"
    if kind == "categorical":
        return "categories"
    if kind == "hillshade":
        return "hillshade"
    if kind != "continuous":
        return ""
    band = _band(render.get("band"))
    classify = render.get("classify")
    if isinstance(classify, dict):
        count = _count(classify)
        classes = _plural(count, "class", "classes") if count else "classes"
        return f"{classes} {band}" if band else classes
    palette = _palette(render.get("palette"), render.get("reverse"))
    if not palette and isinstance(render.get("stops"), list):
        palette = "custom colors"
    head = f"color range {band}" if band else "color range"
    return f"{head}, {palette}" if palette else head


def _band(band: Any) -> str:
    if isinstance(band, int) and not isinstance(band, bool):
        return f"band {band}"
    if isinstance(band, dict) and (name := _name(band.get("name"))):
        return f"band {name}"
    return ""


def _count(c: dict[str, Any]) -> int | None:
    """Classes as listed, else the `count` the server will fill."""
    classes = c.get("classes")
    if isinstance(classes, list) and classes:
        return len(classes)
    count = c.get("count")
    if isinstance(count, int) and not isinstance(count, bool) and count > 0:
        return count
    return None


def _palette(palette: Any, reverse: Any) -> str | None:
    if isinstance(palette, str) and palette.strip():
        name = _flat(palette)
    elif isinstance(palette, list):
        name = "custom colors"
    else:
        return None
    return f"{name} reversed" if reverse is True else name


def _field_of(value: Any) -> str | None:
    """The field a value by attribute reads, also inside zoom stops."""
    if not isinstance(value, dict):
        return None
    if "zoom" in value:
        stop = _attribute_stop(value)
        return _field_of(stop) if stop is not None else None
    return _name(value.get("field"))


def _attribute_stop(value: dict[str, Any]) -> dict[str, Any] | None:
    for stop in _stops(value):
        if isinstance(stop[1], dict) and _name(stop[1].get("field")):
            return stop[1]
    return None


def _stops(value: dict[str, Any]) -> list[list[Any]]:
    return [s for s in _list(value.get("zoom")) if isinstance(s, list) and len(s) >= 2]


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def _name(value: Any) -> str | None:
    return _flat(value) or None if isinstance(value, str) else None


def _flat(text: str) -> str:
    return " ".join(text.split())


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []

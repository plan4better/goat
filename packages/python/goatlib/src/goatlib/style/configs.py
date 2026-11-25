"""The GOAT Style documents workflow and report layout configs hold: an export
node's `outputStyle` (the look a saved result gets) and a print layout's
`locked_layer_styles`. Core's save routes and the project import check and
stamp them like any other style (spec 14)."""

from collections.abc import Callable
from typing import Any

from goatlib.style.version import stamp


def map_config_styles(
    node: Any, fn: Callable[[Any, list[str]], Any], path: tuple[str, ...] = ()
) -> Any:
    """A workflow or report layout config with `fn` applied to every GOAT Style
    document it holds: its `outputStyle` values and the values of its
    `locked_layer_styles`. `fn` gets the document and where it sits in the
    config (the segments of a JSON pointer). `node` is not changed."""
    if isinstance(node, list):
        return [
            map_config_styles(item, fn, (*path, str(i))) for i, item in enumerate(node)
        ]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key == "outputStyle":
            out[key] = fn(value, [*path, key])
        elif key == "locked_layer_styles" and isinstance(value, dict):
            out[key] = {k: fn(v, [*path, key, k]) for k, v in value.items()}
        else:
            out[key] = map_config_styles(value, fn, (*path, key))
    return out


def config_styles(node: Any) -> list[Any]:
    """The GOAT Style documents a workflow or report layout config holds."""
    found: list[Any] = []

    def collect(document: Any, _: list[str]) -> Any:
        found.append(document)
        return document

    map_config_styles(node, collect)
    return found


def versioned(document: Any) -> bool:
    """Whether a style in a config is a GOAT Style document: one without
    `version` is today's format, converted where it is used."""
    return isinstance(document, dict) and "version" in document


def stamp_config_styles(node: Any) -> Any:
    """A config with every GOAT Style document it holds at the lowest version its
    keys need (`stamp`); a style in today's format stays as it is."""
    return map_config_styles(node, lambda doc, _: stamp(doc) if versioned(doc) else doc)

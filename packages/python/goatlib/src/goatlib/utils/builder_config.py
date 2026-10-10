"""Layer references in a project's ``builder_config`` (dashboard widgets).

Widgets point at project entries (``layer_project`` link ids) in two shapes:
a ``layer_project_id`` field, and a few lists of link ids named in
``LAYER_PROJECT_ID_LISTS``. A project copy or import gives every entry a new
id, so these are rewritten; nothing else is. Every other number in the config
(shadow, opacity, font sizes, axis ticks) stays as it is, even when it equals
an old link id.
"""

from typing import Any

# Lists of link ids in widget options (apps/web/lib/validations/widget.ts).
LAYER_PROJECT_ID_LISTS = frozenset(
    {
        "downloadable_layers",
        "excluded_layers",
        "legend_hidden_layers",
        "legend_simple_layers",
    }
)


def _new_id(value: Any, lp_id_map: dict[int, int]) -> Any:
    if isinstance(value, int) and not isinstance(value, bool):
        return lp_id_map.get(value, value)
    return value


def remap_layer_project_ids(node: Any, lp_id_map: dict[int, int]) -> Any:
    """Return ``node`` with its link-id references mapped through ``lp_id_map``.

    Walks the tree once, so an id is mapped at most once: an old id that
    equals another entry's new id is not rewritten twice. Ids with no mapping
    are kept.
    """
    if isinstance(node, dict):
        out: dict[str, Any] = {}
        for key, value in node.items():
            if key == "layer_project_id":
                out[key] = _new_id(value, lp_id_map)
            elif key in LAYER_PROJECT_ID_LISTS and isinstance(value, list):
                out[key] = [_new_id(item, lp_id_map) for item in value]
            else:
                out[key] = remap_layer_project_ids(value, lp_id_map)
        return out
    if isinstance(node, list):
        return [remap_layer_project_ids(item, lp_id_map) for item in node]
    return node

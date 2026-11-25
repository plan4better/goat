"""Where a project layer is used besides the map, which core does not change
when the layer is removed: the dashboard's widgets, the project's workflows,
its print layouts and its custom basemaps name the layer by its number.

- A dashboard widget is an item of a panel's ``widgets`` in the project's
  ``builder_config``. It names the layer where goatlib's own walker for the
  config (``goatlib.utils.builder_config``) would rewrite the layer's number:
  a ``layer_project_id`` key or one of its lists of layer numbers.
- A workflow names it in a node's ``data.projectLayerId``.
- A print layout names it as the coverage of a switched-on atlas, or among
  the layers a map element locks (``locked_layer_ids`` while ``lock_layers``
  is set, as the print page reads them).
- A custom basemap names it as the ``target`` of a layer setting: the
  layer's number as text, never ``all``.

Everything is read from what core answered; nothing here reads a service.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from goatlib.utils.builder_config import remap_layer_project_ids

#: Names said per kind of use; the rest are counted.
MAX_NAMED = 3
INCOMPLETE = "Where it is used could not be read in full."


def _joined(parts: Sequence[str]) -> str:
    if len(parts) < 2:
        return "".join(parts)
    return f"{', '.join(parts[:-1])} and {parts[-1]}"


def _named(kind: str, names: Sequence[str]) -> list[str]:
    """``the workflow "A"``, or ``the workflows "A", "B", "C" and 2 more``."""
    if not names:
        return []
    quoted = [f'"{name}"' for name in names[:MAX_NAMED]]
    if len(names) > MAX_NAMED:
        quoted.append(f"{len(names) - MAX_NAMED} more")
    return [f"the {kind}{'s' if len(names) > 1 else ''} {_joined(quoted)}"]


@dataclass(frozen=True)
class Uses:
    dashboard_widgets: int
    #: Names, in the order core lists them.
    workflows: tuple[str, ...]
    layouts: tuple[str, ...]
    basemaps: tuple[str, ...]
    #: False when the workflows or the print layouts could not be read.
    complete: bool = True

    def sentence(self) -> str:
        """Where the layer is used, in one sentence; "" when it is used
        nowhere. A list that could not be read is said so."""
        parts = []
        if self.dashboard_widgets:
            count = self.dashboard_widgets
            parts.append(f"the dashboard ({count} widget{'s' if count > 1 else ''})")
        parts += _named("workflow", self.workflows)
        parts += _named("print layout", self.layouts)
        parts += _named("custom basemap", self.basemaps)
        said = f"It is used in {_joined(parts)}." if parts else ""
        if not self.complete:
            said = f"{said} {INCOMPLETE}".strip()
        return said


def _number(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _dicts(value: Any) -> list[Mapping[str, Any]]:
    return (
        [item for item in value if isinstance(item, dict)]
        if isinstance(value, list)
        else []
    )


def _name(row: Mapping[str, Any]) -> str:
    return str(row.get("name") or "without a name")


def _names_layer(widget: Mapping[str, Any], layer_project_id: int) -> bool:
    """Whether goatlib's walker finds the layer's number in a widget: mapped
    to a marker no stored value equals, the widget comes back changed."""
    marker: Any = object()
    return bool(remap_layer_project_ids(widget, {layer_project_id: marker}) != widget)


def _widgets(builder_config: Any) -> list[Mapping[str, Any]]:
    if not isinstance(builder_config, dict):
        return []
    return [
        widget
        for panel in _dicts(builder_config.get("interface"))
        for widget in _dicts(panel.get("widgets"))
    ]


def _in_workflow(workflow: Mapping[str, Any], layer_project_id: int) -> bool:
    config = workflow.get("config")
    nodes = config.get("nodes") if isinstance(config, dict) else None
    return any(
        isinstance(data := node.get("data"), dict)
        and _number(data.get("projectLayerId")) == layer_project_id
        for node in _dicts(nodes)
    )


def _in_layout(layout: Mapping[str, Any], layer_project_id: int) -> bool:
    config = layout.get("config")
    if not isinstance(config, dict):
        return False
    atlas = config.get("atlas")
    coverage = atlas.get("coverage") if isinstance(atlas, dict) else None
    if (
        isinstance(atlas, dict)
        and atlas.get("enabled") is True
        and isinstance(coverage, dict)
        and coverage.get("type") == "feature"
        and _number(coverage.get("layer_project_id")) == layer_project_id
    ):
        return True
    for element in _dicts(config.get("elements")):
        settings = element.get("config")
        if (
            element.get("type") == "map"
            and isinstance(settings, dict)
            and settings.get("lock_layers") is True
            and isinstance(settings.get("locked_layer_ids"), list)
            and layer_project_id in settings["locked_layer_ids"]
        ):
            return True
    return False


def _in_basemap(basemap: Mapping[str, Any], layer_project_id: int) -> bool:
    settings = basemap.get("layer_config")
    if basemap.get("type", "vector") != "vector" or not isinstance(settings, dict):
        return False
    return any(
        isinstance(setting, dict) and setting.get("target") == str(layer_project_id)
        for setting in settings.values()
    )


def layer_uses(
    layer_project_id: int,
    *,
    builder_config: Any,
    workflows: Sequence[Any] | None,
    layouts: Sequence[Any] | None,
    custom_basemaps: Any,
) -> Uses:
    """Where the layer is used: ``builder_config`` and ``custom_basemaps`` as
    the project row holds them, ``workflows`` and ``layouts`` as core lists
    them for the project; None for a list that could not be read."""
    link = layer_project_id
    return Uses(
        dashboard_widgets=sum(
            _names_layer(widget, link) for widget in _widgets(builder_config)
        ),
        workflows=tuple(
            _name(row) for row in _dicts(workflows) if _in_workflow(row, link)
        ),
        layouts=tuple(_name(row) for row in _dicts(layouts) if _in_layout(row, link)),
        basemaps=tuple(
            _name(row) for row in _dicts(custom_basemaps) if _in_basemap(row, link)
        ),
        complete=workflows is not None and layouts is not None,
    )

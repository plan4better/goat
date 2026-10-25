"""What the model learns about a GOAT tool from its process description
(``GET /processes/{id}`` on processes), in short (spec §3).

A description is the JSON schema the editor builds its forms from. The model
needs less: which inputs take a layer (the editor's handles), and each
setting's name, type, choices, default (and how the form derives it from
other settings), when it is shown and which layer input a field setting
reads. And what a value means: a name and type do not say that step_sizes are
band edges rather than the width of each band, so each setting carries its
description and, where the tool gives one, an example. Pure: the tools of ``assistant.tools.workflow_tools``
fetch the descriptions.
"""

import json
from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel

#: The prefix the join tool gives the fields it carries over from the joined
#: layer: its field ``x`` is ``join_x`` in the result.
JOINED_PREFIX = "join_"
#: Inputs the editor draws as handles: connections, not settings.
LAYER_WIDGETS = frozenset({"layer-selector", "starting-points"})
#: Not settings a step keeps: layer inputs, and the names the runner gives results.
NOT_SETTING_WIDGETS = LAYER_WIDGETS | {"layer-name-input"}
NOT_SETTING_SECTIONS = frozenset({"output", "result", "opportunities"})
FIELD_WIDGETS = frozenset({"field-selector", "field-statistics-selector"})
#: A heatmap's list of opportunities; on the canvas it is numbered handles.
OPPORTUNITIES = "opportunities"
#: An opportunity's own fields that are no settings: its layer, the layer's
#: filter and display name come from the numbered connection.
OPPORTUNITY_PLUMBING = frozenset(
    {"input_path", "input_layer_filter", "name", "layer_project_id"}
)
#: An opportunity's own layer field, and the numbered handle the model
#: connects it to.
OPPORTUNITY_LAYER = {"input_path": "opportunity_layer_<N>_id"}
OPPORTUNITY_NOTE = (
    "Connect one to three opportunity layers to opportunity_layer_1_id, "
    "opportunity_layer_2_id and opportunity_layer_3_id. Set the settings of each "
    "(per_opportunity) as opportunity_<N>_<name>, e.g. opportunity_1_max_cost."
)
#: Widget options with which the form fills a setting in from other
#: settings (``_default_hint``). The tool resolves such a setting itself when
#: a step leaves it out, not always to the form's value, so its static
#: default is not what runs.
DERIVED_DEFAULTS = frozenset(
    {"default_by_field", "default_from", "compute_from", "default_all"}
)
#: A network selector, and what it answers for the default network (the web's
#: ``DEFAULT_NETWORK_BUNDLE``, also in ``goatlib.tools.schemas``).
BUNDLE_WIDGET = "bundle-selector"
DEFAULT_NETWORK_BUNDLE = "default"
_SUMMARY_CHARS = 160
#: A setting's description is kept whole up to this length: its meaning often
#: lies in an example that a cut at the first sentence would drop.
_SETTING_CHARS = 240
_OPS = {"$eq": "=", "$ne": "!=", "$gt": ">", "$gte": ">=", "$lt": "<", "$lte": "<="}


class LayerInputInfo(BaseModel):
    name: str
    title: str
    required: bool
    #: Geometry types the input takes, when it says.
    geometry_types: list[str] | None = None
    #: When the input is used, in short form.
    visible_when: str | None = None


class SettingInfo(BaseModel):
    name: str
    title: str
    #: What a value means, as the tool describes it; left out when it only
    #: repeats the title.
    description: str | None = None
    #: A value the tool gives as an example.
    example: Any = None
    #: ``string``, ``integer``, ``number``, ``boolean``, ``choice`` (one of
    #: ``choices``), ``choices`` (several), ``list`` (of ``items``) or
    #: ``list of <type>``.
    type: str
    #: True for a setting the tool needs; left out otherwise.
    required: bool | None = None
    default: Any = None
    choices: list[Any] | None = None
    visible_when: str | None = None
    hidden_when: str | None = None
    #: The value the form fills in from other settings, in short, e.g.
    #: ``5 if routing_mode = "walking", else 15 if routing_mode = "bicycle"``.
    #: A step that leaves the setting out gets what the tool resolves, not
    #: always this value: a travel cost matrix's street ``max_cost`` is then
    #: unbounded (``DERIVED_DEFAULTS``).
    default_hint: str | None = None
    #: A field setting: the layer input whose fields it takes.
    reads_layer: str | None = None
    field_types: list[str] | None = None
    #: A list of objects: each object's settings.
    items: list["SettingInfo"] | None = None


def _ui(schema: Mapping[str, Any]) -> dict[str, Any]:
    ui = schema.get("x-ui")
    return ui if isinstance(ui, dict) else {}


def _resolve(schema: Any, defs: Mapping[str, Any]) -> dict[str, Any]:
    """The schema a value follows: a ``$ref`` resolved, the one non-null
    branch of an optional value taken, the outer keys (description, default,
    x-ui) kept."""
    current: Any = schema
    for _ in range(8):
        if not isinstance(current, dict):
            return {}
        ref = current.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            target = defs.get(ref.removeprefix("#/$defs/"))
            outer = {key: value for key, value in current.items() if key != "$ref"}
            current = {**(target if isinstance(target, dict) else {}), **outer}
            continue
        branches = current.get("anyOf")
        if isinstance(branches, list):
            kept = [
                branch
                for branch in branches
                if not (isinstance(branch, dict) and branch.get("type") == "null")
            ]
            if len(kept) == 1:
                outer = {key: value for key, value in current.items() if key != "anyOf"}
                current = {**kept[0], **outer}
                continue
        return current
    return current if isinstance(current, dict) else {}


def _kind(
    schema: Mapping[str, Any], defs: Mapping[str, Any]
) -> tuple[str, list[Any] | None, dict[str, Any] | None]:
    """``(type, choices, item schema)``; the item schema only for a list of
    objects."""
    resolved = _resolve(schema, defs)
    if isinstance(resolved.get("enum"), list):
        return "choice", list(resolved["enum"]), None
    kind = resolved.get("type")
    if kind == "array":
        items = _resolve(resolved.get("items") or {}, defs)
        if isinstance(items.get("enum"), list):
            return "choices", list(items["enum"]), None
        if items.get("type") == "object" or isinstance(items.get("properties"), dict):
            return "list", None, items
        return f"list of {items.get('type') or 'values'}", None, None
    if isinstance(kind, str):
        return kind, None, None
    return "value", None, None


def _literal(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _field_condition(name: str, value: Any) -> str:
    if isinstance(value, dict) and value and all(str(k).startswith("$") for k in value):
        terms: list[str] = []
        for op, operand in value.items():
            if op in _OPS:
                terms.append(f"{name} {_OPS[op]} {_literal(operand)}")
            elif op == "$in":
                terms.append(f"{name} in {_literal(operand)}")
            elif op == "$nin":
                terms.append(f"{name} not in {_literal(operand)}")
            elif op == "$exists":
                terms.append(f"{name} is set" if operand else f"{name} is not set")
            else:
                terms.append(f"{name} {op} {_literal(operand)}")
        return " and ".join(terms)
    return f"{name} = {_literal(value)}"


def _renamed(condition: Any, names: Mapping[str, str]) -> Any:
    """A condition whose fields named in ``names`` carry their new names, in
    nested ``$and`` / ``$or`` too; operands stay as they are."""
    if not isinstance(condition, dict):
        return condition
    renamed: dict[str, Any] = {}
    for key, value in condition.items():
        if key in ("$and", "$or") and isinstance(value, list):
            renamed[key] = [_renamed(item, names) for item in value]
        else:
            renamed[names.get(str(key), str(key))] = value
    return renamed


def short_condition(condition: Any, nested: bool = False) -> str:
    """A ``visible_when`` / ``hidden_when`` condition as one line, e.g.
    ``routing_mode = "pt" and show_advanced = true``."""
    if not isinstance(condition, dict):
        return _literal(condition)
    terms: list[str] = []
    for key, value in condition.items():
        if key in ("$and", "$or") and isinstance(value, list):
            word = " and " if key == "$and" else " or "
            joined = word.join(short_condition(item, nested=True) for item in value)
            terms.append(f"({joined})" if nested or len(condition) > 1 else joined)
        else:
            terms.append(_field_condition(str(key), value))
    text = " and ".join(terms)
    return f"({text})" if nested and len(terms) > 1 else text


def _condition(ui: Mapping[str, Any], key: str, names: Mapping[str, str]) -> str | None:
    return short_condition(_renamed(ui[key], names)) if ui.get(key) else None


def _reads_layer(
    ui: Mapping[str, Any], options: Mapping[str, Any], names: Mapping[str, str]
) -> str | None:
    """The layer input a field setting takes its fields from, by the name the
    model connects to: ``source_layer`` can be a path into the input
    (``starting_points.layer_id``), and the input is the part before the dot."""
    source = options.get("source_layer") if ui.get("widget") in FIELD_WIDGETS else None
    if not source:
        return None
    layer = str(source).split(".", 1)[0]
    return names.get(layer, layer)


def _chain(entries: list[tuple[str | None, Any]]) -> str | None:
    """``(condition, value)`` pairs, the first that holds wins, as one line:
    ``30 if routing_mode = "pt", else 15``. A pair without a condition is the
    fallback."""
    terms = [
        f"{_literal(value)} if {condition}" if condition else _literal(value)
        for condition, value in entries
    ]
    return ", else ".join(terms) or None


def _default_hint(options: Mapping[str, Any], names: Mapping[str, str]) -> str | None:
    """How the form derives a setting's value from other settings, from the
    widget options that do it: ``default_by_field`` (one setting's value picks
    it), ``default_from`` (the first matching condition across settings),
    ``compute_from`` (step sizes from a step count and a limit) and
    ``default_all`` (every field of a layer)."""
    hints: list[str] = []
    by_field = options.get("default_by_field")
    if isinstance(by_field, dict) and isinstance(by_field.get("values"), dict):
        field = str(by_field.get("field"))
        field = names.get(field, field)
        hint = _chain(
            [
                (_field_condition(field, choice), value)
                for choice, value in by_field["values"].items()
            ]
        )
        if hint:
            hints.append(hint)
    default_from = options.get("default_from")
    entries = default_from.get("fields") if isinstance(default_from, dict) else None
    if isinstance(entries, list):
        hint = _chain(
            [
                (
                    short_condition(_renamed(entry["when"], names))
                    if entry.get("when")
                    else None,
                    entry.get("value"),
                )
                for entry in entries
                if isinstance(entry, dict)
            ]
        )
        if hint:
            hints.append(hint)
    compute = options.get("compute_from")
    if isinstance(compute, dict) and compute.get("steps_field"):
        limits = [
            str(entry.get("field") if isinstance(entry, dict) else entry)
            for entry in compute.get("limit_fields") or []
        ]
        if limits:
            steps = str(compute["steps_field"])
            limit = " or ".join(names.get(item, item) for item in limits)
            hints.append(
                f"{limit} split into {names.get(steps, steps)} equal steps, rounded"
            )
    if options.get("default_all") is True and options.get("source_layer"):
        layer = str(options["source_layer"]).split(".", 1)[0]
        hints.append(f"every field of {names.get(layer, layer)}")
    return "; ".join(hints) or None


def _setting(
    name: str,
    schema: Mapping[str, Any],
    *,
    title: str,
    required: bool,
    defs: Mapping[str, Any],
    names: Mapping[str, str] | None = None,
    description: Any = None,
) -> SettingInfo:
    """``names`` renames fields the setting's conditions and ``reads_layer``
    refer to (an opportunity's ``input_path`` is a numbered handle).
    ``description`` is the input's own, when it has one beside its schema's."""
    names = names or {}
    ui = _ui(schema)
    kind, choices, items = _kind(schema, defs)
    options = ui.get("widget_options")
    options = options if isinstance(options, dict) else {}
    field_types = options.get("field_types")
    sub: list[SettingInfo] | None = None
    if items is not None:
        needed = set(items.get("required") or [])
        sub = [
            _setting(
                item_name,
                item_schema,
                title=str(item_schema.get("title") or item_name),
                required=item_name in needed,
                defs=defs,
                names=names,
            )
            for item_name, item_schema in (items.get("properties") or {}).items()
            if isinstance(item_schema, dict) and not _ui(item_schema).get("hidden")
        ] or None
    examples = schema.get("examples")
    return SettingInfo(
        name=name,
        title=title,
        description=_meaning(description or schema.get("description"), title),
        example=examples[0] if isinstance(examples, list) and examples else None,
        type=kind,
        required=True if required else None,
        default=schema.get("default"),
        choices=choices,
        visible_when=_condition(ui, "visible_when", names),
        hidden_when=_condition(ui, "hidden_when", names),
        default_hint=_default_hint(options, names),
        reads_layer=_reads_layer(ui, options, names),
        field_types=[str(t) for t in field_types]
        if isinstance(field_types, list)
        else None,
        items=sub,
    )


def _meaning(text: Any, title: str) -> str | None:
    """A setting's description on one line, or None when it says no more
    than the title."""
    if not isinstance(text, str):
        return None
    line = " ".join(text.split())
    if not line or line.rstrip(".").casefold() == title.rstrip(".").casefold():
        return None
    return line if len(line) <= _SETTING_CHARS else line[: _SETTING_CHARS - 1] + "…"


def _inputs(description: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    inputs = description.get("inputs")
    if not isinstance(inputs, dict):
        return {}
    return {
        str(name): value for name, value in inputs.items() if isinstance(value, dict)
    }


def _schema(described: Mapping[str, Any]) -> dict[str, Any]:
    schema = described.get("schema")
    return schema if isinstance(schema, dict) else {}


def layer_inputs(description: Mapping[str, Any]) -> list[LayerInputInfo]:
    """Every input the editor draws as a handle, hidden or not: a heatmap's
    numbered opportunity handles are hidden from the form, not from the canvas."""
    found: list[LayerInputInfo] = []
    for name, described in _inputs(description).items():
        ui = _ui(_schema(described))
        if ui.get("widget") not in LAYER_WIDGETS:
            continue
        options = ui.get("widget_options")
        types = options.get("geometry_types") if isinstance(options, dict) else None
        found.append(
            LayerInputInfo(
                name=name,
                title=str(described.get("title") or name),
                required=int(described.get("minOccurs") or 0) > 0,
                geometry_types=[str(t) for t in types]
                if isinstance(types, list)
                else None,
                visible_when=_condition(ui, "visible_when", {}),
            )
        )
    return found


def field_inputs(description: Mapping[str, Any]) -> dict[str, str]:
    """Each field setting (a top-level input with a field widget) and the
    layer input it takes its fields from, as processes' check pairs them: the
    input ``source_layer`` names, else ``<name without _field>_layer_id`` for
    a name ending in ``_field``, else the tool's only layer input. A field setting whose
    input is not known is left out."""
    handles = [info.name for info in layer_inputs(description)]
    only = handles[0] if len(handles) == 1 else None
    found: dict[str, str] = {}
    for name, described in _inputs(description).items():
        ui = _ui(_schema(described))
        if ui.get("widget") not in FIELD_WIDGETS:
            continue
        options = ui.get("widget_options")
        reads = _reads_layer(ui, options if isinstance(options, dict) else {}, {})
        if reads is None and name.endswith("_field"):
            reads = f"{name.removesuffix('_field')}_layer_id"
        reads = reads or only
        if reads:
            found[name] = reads
    return found


def _is_item_field(name: str, ui: Mapping[str, Any]) -> bool:
    """A list item's field setting, as processes' check finds one: a field
    widget, or no widget and a name ending in ``_field``."""
    widget = ui.get("widget")
    return widget == "field-selector" or (not widget and name.endswith("_field"))


def _source_layer(ui: Mapping[str, Any]) -> str | None:
    """The layer input a widget names (``source_layer``), before any dot."""
    options = ui.get("widget_options")
    source = options.get("source_layer") if isinstance(options, dict) else None
    return str(source).split(".", 1)[0] if source else None


def list_field_inputs(description: Mapping[str, Any]) -> dict[str, frozenset[str]]:
    """Each list setting whose items hold a field setting, and the layer
    inputs those fields are read from, as processes' check pairs them: the
    input the item's own widget names (``source_layer``, before any dot),
    else the list setting's pairing (as ``field_inputs``), e.g.
    aggregate_polygon's ``column_statistics`` reads ``source_layer_id``. A
    heatmap's opportunities are not among them: an opportunity reads its
    numbered handle."""
    defs = description.get("$defs") or {}
    handles = [info.name for info in layer_inputs(description)]
    only = handles[0] if len(handles) == 1 else None
    found: dict[str, frozenset[str]] = {}
    for name, described in _inputs(description).items():
        schema = _schema(described)
        ui = _ui(schema)
        if name == OPPORTUNITIES or ui.get("widget") in FIELD_WIDGETS:
            continue
        _, _, items = _kind(schema, defs)
        if items is None:
            continue
        outer = _source_layer(ui)
        if outer is None and name.endswith("_field"):
            outer = f"{name.removesuffix('_field')}_layer_id"
        outer = outer or only
        reads: set[str] = set()
        for item_name, item_schema in (items.get("properties") or {}).items():
            item_ui = _ui(item_schema) if isinstance(item_schema, dict) else {}
            if _is_item_field(str(item_name), item_ui):
                read = _source_layer(item_ui) or outer
                if read:
                    reads.add(read)
        if reads:
            found[name] = frozenset(reads)
    return found


def opportunity_fields(description: Mapping[str, Any]) -> list[str]:
    """Every field of an opportunity, its layer's own fields included: the
    names a step keeps an opportunity's settings under, and processes'
    check reports them, as ``opportunity_<N>_<name>``. Empty for a tool
    without opportunities."""
    described = _inputs(description).get(OPPORTUNITIES)
    if described is None:
        return []
    items = _resolve(
        _schema(described).get("items") or {}, description.get("$defs") or {}
    )
    return [str(name) for name in items.get("properties") or {}]


def _is_setting(ui: Mapping[str, Any]) -> bool:
    """An input a step stores as a setting: not hidden, no layer input, no
    result name."""
    return not (
        ui.get("hidden")
        or ui.get("widget") in NOT_SETTING_WIDGETS
        or ui.get("section") in NOT_SETTING_SECTIONS
    )


def form_values(
    description: Mapping[str, Any], config: Mapping[str, Any]
) -> dict[str, Any]:
    """The values the editor decides a setting's visibility on: each input's
    static default, the step's settings over them, and for each network
    selector the flag the form computes, ``_<name>_is_custom`` (a network
    other than the default one is chosen). The project's flags
    (``_project_has_*``) and ``_all_layers_have_geometry`` are not known
    here, so a setting shown only through one of them counts as hidden."""
    inputs = _inputs(description)
    values: dict[str, Any] = {
        name: _schema(described)["default"]
        for name, described in inputs.items()
        if "default" in _schema(described)
    }
    values.update(config)
    for name, described in inputs.items():
        if _ui(_schema(described)).get("widget") == BUNDLE_WIDGET:
            chosen = values.get(name)
            values[f"_{name}_is_custom"] = isinstance(chosen, str) and chosen not in (
                "",
                DEFAULT_NETWORK_BUNDLE,
            )
    return values


def static_defaults(
    description: Mapping[str, Any],
) -> list[tuple[str, Any, dict[str, Any]]]:
    """Each setting's static default with the setting's ``x-ui``, in the
    form's order: the value the tool applies when a step leaves the setting
    out. Not listed: a default of None, and a setting whose form value
    follows other settings (``DERIVED_DEFAULTS``)."""
    found: list[tuple[str, Any, dict[str, Any]]] = []
    for name, described in _inputs(description).items():
        schema = _schema(described)
        ui = _ui(schema)
        options = ui.get("widget_options")
        derived = isinstance(options, dict) and not DERIVED_DEFAULTS.isdisjoint(options)
        if _is_setting(ui) and not derived and schema.get("default") is not None:
            found.append((name, schema["default"], ui))
    return found


def settings(description: Mapping[str, Any]) -> list[SettingInfo]:
    """The settings a step stores in its config, in the form's order: no
    hidden ones, no layer inputs, no result names."""
    defs = description.get("$defs") or {}
    found: list[SettingInfo] = []
    for name, described in _inputs(description).items():
        schema = _schema(described)
        if not _is_setting(_ui(schema)):
            continue
        found.append(
            _setting(
                name,
                schema,
                title=str(described.get("title") or name),
                required=int(described.get("minOccurs") or 0) > 0,
                defs=defs,
                description=described.get("description"),
            )
        )
    return found


def opportunity_settings(description: Mapping[str, Any]) -> list[SettingInfo] | None:
    """A heatmap's settings for each opportunity, stored as
    ``opportunity_<N>_<name>``; None for a tool without opportunities."""
    described = _inputs(description).get(OPPORTUNITIES)
    if described is None:
        return None
    defs = description.get("$defs") or {}
    items = _resolve(_schema(described).get("items") or {}, defs)
    needed = set(items.get("required") or [])
    found: list[SettingInfo] = []
    for name, schema in (items.get("properties") or {}).items():
        if not isinstance(schema, dict) or name in OPPORTUNITY_PLUMBING:
            continue
        ui = _ui(schema)
        if ui.get("hidden") or ui.get("widget") in LAYER_WIDGETS:
            continue
        found.append(
            _setting(
                name,
                schema,
                title=str(schema.get("title") or name),
                required=name in needed,
                defs=defs,
                names=OPPORTUNITY_LAYER,
            )
        )
    return found


def summary(text: Any) -> str | None:
    """A description's first sentence, on one line."""
    if not isinstance(text, str) or not text.strip():
        return None
    line = " ".join(text.split())
    first = line.split(". ")[0].rstrip(".") + "."
    return first if len(first) <= _SUMMARY_CHARS else first[: _SUMMARY_CHARS - 1] + "…"

"""The issues of a project workflow, checked the way a run would see it.

`check_workflow` lists what stops a workflow from running (level "error") and
what may surprise (level "warning"), step by step, on the steps the editor
holds, saved or not. Nothing runs: tool settings are validated by each tool's
parameter model with the arguments the run itself would build
(`goatlib.tools.workflow_arguments`), and field settings are compared with the
columns of the layer they read or with the predicted output of the step
before. Codes, levels and params are the shared list of
`goatlib.workflows.checks`; texts and labels follow `language`.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any

from cachetools import LRUCache
from fastapi import HTTPException
from goatlib.analysis.accessibility.heatmap_v2 import MAX_SEED_POINTS_TOTAL
from goatlib.tools._opportunity_handles import (
    NUMBERED_OPPORTUNITY_ID_FIELDS,
    NumberedOpportunityLayersMixin,
)
from goatlib.tools.heatmap_v2 import HeatmapV2WindmillParams
from goatlib.tools.if_node import (
    IF_FALSE_HANDLE,
    IF_TRUE_HANDLE,
    _statistic_row_to_sql_term,
)
from goatlib.tools.schema_prediction import predict_node_output_schema
from goatlib.tools.workflow_arguments import build_check_arguments
from goatlib.tools.workflow_runner import (
    VARIABLE_PATTERN,
    convert_filter_to_cql,
    mark_skipped_descendants,
    resolve_variables,
    variable_map,
)
from goatlib.utils.layer import InvalidLayerIdError, normalize_layer_id
from goatlib.workflows.checks import (
    Issue,
    dangling_edges,
    find_loops,
    node_list,
    shape_issues,
)
from goatlib.workflows.visibility import is_shown
from pydantic import BaseModel, ValidationError

from processes.config import settings
from processes.models.processes import InputDescription, ProcessDescription
from processes.services.access import _get_pool, refused_workflow_nodes
from processes.services.analytics_service import analytics_service
from processes.services.tool_registry import tool_registry

logger = logging.getLogger(__name__)

# Layer id -> the field names a person sees, None when they are not known.
LayerFields = Callable[[str], Awaitable[list[str] | None]]
# Layer id -> how many features it has, None when that is not known without
# counting them.
LayerFeatureCount = Callable[[str], Awaitable[int | None]]

LAYER_WIDGETS = frozenset({"layer-selector", "starting-points"})
# Not settings a person fills in on a workflow step: layer inputs are
# connections, results are named by the runner, opportunity layers come from
# the numbered handles.
NOT_SETTING_WIDGETS = LAYER_WIDGETS | {"layer-name-input"}
NOT_SETTING_SECTIONS = frozenset({"output", "result", "opportunities"})
# The input the runner feeds from a connection that names none.
DEFAULT_TARGET_HANDLE = "input_layer_id"
# What the editor's form holds for a connected layer input, so a setting
# shown once that input has a layer counts as shown.
CONNECTED = "__connected__"
# Logical If rows that compare with nothing (`_convert_expression_to_cql`).
VALUELESS_EXPRESSIONS = frozenset(
    {"is_blank", "is_not_blank", "is_empty_string", "is_not_empty_string"}
)
# Pydantic puts the kind of a validator's error before its text.
VALIDATOR_PREFIXES = ("Value error, ", "Assertion failed, ")
FIELD_WIDGET = "field-selector"
FIELD_STATISTICS_WIDGET = "field-statistics-selector"
# The handle id the editor gives a step whose inputs it does not know.
EDITOR_DEFAULT_HANDLE = "input"
# A layer's geometry column, by the names GOAT's layers use.
GEOMETRY_COLUMNS = frozenset({"geometry", "geom"})
# The heatmap input whose area can stand in for the travel budget.
REFERENCE_AREA_INPUT = "reference_area_layer_id"
# The join tool, and what it puts before the name of each field it adds from
# the join layer (goatlib's `analysis/data_management/join.py`).
JOIN_TOOL = "join"
JOINED_FIELD_PREFIX = "join_"


@lru_cache(maxsize=512)
def _describe(process_id: str, language: str) -> ProcessDescription | None:
    """A tool's process description in `language`, as the editor reads it.

    Cached: building it walks the tool's whole JSON schema, and a check runs
    on every edit. Descriptions only change with a deployment.
    """
    return tool_registry.get_process_description(process_id, "", language=language)


def _data(node: dict[str, Any]) -> dict[str, Any]:
    data = node.get("data")
    return data if isinstance(data, dict) else {}


def _config(node: dict[str, Any]) -> dict[str, Any]:
    config = _data(node).get("config")
    return config if isinstance(config, dict) else {}


def _kind(node: dict[str, Any]) -> str:
    """The step type the runner dispatches on (`data.type`)."""
    return str(_data(node).get("type") or node.get("type") or "")


def _handle(edge: dict[str, Any]) -> str:
    """The tool input a connection feeds, as the runner reads it."""
    return str(edge.get("targetHandle") or DEFAULT_TARGET_HANDLE)


def _description(process_id: Any, language: str) -> ProcessDescription | None:
    if not isinstance(process_id, str) or not process_id:
        return None
    return _describe(process_id, language)


def step_name(node: dict[str, Any], *, language: str) -> str:
    """The name a person sees on a step: a label they gave it, else its
    tool's title in `language`, else its type.

    The editor labels a new tool step with the tool's id and shows the
    tool's title instead, so on a tool step a label equal to its processId
    is not a name of its own.
    """
    data = _data(node)
    label = data.get("label")
    named = isinstance(label, str) and bool(label.strip())
    if _kind(node) != "tool":
        return str(label) if named else _kind(node)
    process_id = data.get("processId")
    if named and label != process_id:
        return str(label)
    description = _description(process_id, language)
    if description is not None:
        return description.title
    return str(label) if named else "tool"


def _ui(schema: dict[str, Any]) -> dict[str, Any]:
    """A setting's x-ui block, also when it sits on the non-null variant of
    an optional type (the editor's `uiOf`)."""
    ui = schema.get("x-ui")
    if ui is None:
        variant = next(
            (
                v
                for v in schema.get("anyOf") or []
                if isinstance(v, dict) and v.get("type") != "null"
            ),
            None,
        )
        ui = variant.get("x-ui") if variant else None
    return ui if isinstance(ui, dict) else {}


def _is_empty(value: Any) -> bool:
    return value is None or value == "" or value == []


def _layer_inputs(description: ProcessDescription) -> dict[str, InputDescription]:
    """The inputs a step gets through connections (its canvas handles)."""
    return {
        name: entry
        for name, entry in description.inputs.items()
        if _ui(entry.schema_).get("widget") in LAYER_WIDGETS
    }


def _form_values(
    description: ProcessDescription, config: dict[str, Any], handles: set[str]
) -> dict[str, Any]:
    """The values the editor's form decides visibility on: schema defaults,
    the step's settings, and a marker in every connected layer input.

    The form also computes context flags (`_project_has_*_bundle`,
    `_all_layers_have_geometry`, `_pt_network_bundle_id_is_custom`) and keeps
    `show_advanced` outside the settings; here they are missing, so a setting
    shown only through one of them counts as hidden. No such setting is
    required.
    """
    values = {
        name: entry.schema_["default"]
        for name, entry in description.inputs.items()
        if "default" in entry.schema_
    }
    values.update(config)
    for name, entry in _layer_inputs(description).items():
        if name in handles:
            starting_points = _ui(entry.schema_).get("widget") == "starting-points"
            values[name] = {"layer_id": CONNECTED} if starting_points else CONNECTED
    return values


def _variable_names(value: Any) -> list[str]:
    """Every `{{@name}}` reference in a value, at any depth."""
    if isinstance(value, str):
        return [str(name) for name in VARIABLE_PATTERN.findall(value)]
    if isinstance(value, dict):
        return [name for item in value.values() for name in _variable_names(item)]
    if isinstance(value, list):
        return [name for item in value for name in _variable_names(item)]
    return []


def _row_complete(row: Any) -> bool:
    """Whether one row of an If step's simple condition can be evaluated.

    Statistic rows follow `if_node._statistic_row_to_sql_term`, which drops a
    row without method, operator, value or (except for a count) field. A
    logical row needs its operator and field (`_convert_expression_to_cql`)
    and, unless the operator compares with nothing, a value: without one the
    row compares with NULL and the If silently takes its false branch.
    """
    if not isinstance(row, dict):
        return False
    if row.get("kind") == "statistic":
        return _statistic_row_to_sql_term(row) is not None and not _is_empty(
            row.get("value")
        )
    if not row.get("expression") or not row.get("attribute"):
        return False
    return row.get("expression") in VALUELESS_EXPRESSIONS or not _is_empty(
        row.get("value")
    )


def _condition_complete(data: dict[str, Any]) -> bool:
    if (data.get("mode") or "simple") != "simple":
        expression = data.get("customExpression")
        return isinstance(expression, str) and bool(expression.strip())
    condition = data.get("condition")
    rows = condition.get("expressions") if isinstance(condition, dict) else None
    return isinstance(rows, list) and bool(rows) and all(map(_row_complete, rows))


def _effective(schema: dict[str, Any]) -> dict[str, Any]:
    """The non-null variant of an optional type, else the schema itself."""
    variant = next(
        (
            v
            for v in schema.get("anyOf") or []
            if isinstance(v, dict) and v.get("type") != "null"
        ),
        None,
    )
    return variant or schema


def _title(description: ProcessDescription, name: str) -> str:
    entry = description.inputs.get(name)
    return (entry.title if entry else None) or name


def _item_properties(
    schema: dict[str, Any], defs: dict[str, Any]
) -> dict[str, Any] | None:
    items = schema.get("items")
    if not isinstance(items, dict):
        return None
    ref = items.get("$ref")
    item = defs.get(ref.removeprefix("#/$defs/"), {}) if isinstance(ref, str) else items
    properties = item.get("properties") if isinstance(item, dict) else None
    return properties if isinstance(properties, dict) else None


def _reason(message: str) -> str:
    for prefix in VALIDATOR_PREFIXES:
        if message.startswith(prefix):
            return message[len(prefix) :]
    return message


def _caps_destinations(params_class: type[BaseModel]) -> bool:
    """Whether a tool's run refuses more than MAX_SEED_POINTS_TOTAL seed
    points over its opportunity layers: the heatmaps of `heatmap_v2` that take
    them (gravity, closest average, 2SFCA). Connectivity caps its area
    instead; the legacy heatmaps read a precomputed matrix."""
    return issubclass(params_class, HeatmapV2WindmillParams) and issubclass(
        params_class, NumberedOpportunityLayersMixin
    )


def _filtered(node: dict[str, Any]) -> bool:
    """Whether a dataset step's filter is a condition: the runner passes it on
    with the layer to the tool the step feeds, directly or through If steps,
    which pass the layer on with it (`workflow_runner.dataset_filter_for_source`).
    A filter that does not convert counts as one: how many features it keeps
    is unknown either way."""
    raw = _data(node).get("filter")
    if not raw:
        return False
    try:
        return convert_filter_to_cql(raw) is not None
    except Exception:
        return True


@dataclass(frozen=True)
class _FieldRef:
    """One field name a step's settings point at."""

    setting: str  # the setting holding it (the issue's field)
    label: str
    field: str
    source_input: str | None  # the layer input it is read from, if known


def _is_field_widget(name: str, ui: dict[str, Any]) -> bool:
    widget = ui.get("widget")
    return widget == FIELD_WIDGET or (not widget and name.endswith("_field"))


def _field_refs(
    description: ProcessDescription, config: dict[str, Any], handles: set[str]
) -> list[_FieldRef]:
    """Every field name a tool step's settings point at, and the layer input
    each is read from: the editor's `fieldRefsOf`
    (`apps/web/lib/utils/workflowDatasets.ts`).

    Both read a list item's field from the input the item's own widget names
    (`column_statistics[].field` reads `source_layer_id`). Also read, which
    the editor's version leaves out: every name of a multi-select field
    setting, every entry of a field-statistics list, a `source_layer` naming
    a nested input (`starting_points.layer_id`), and the per-opportunity
    settings (`opportunity_{N}_{name}`) a workflow step keeps for the
    opportunity layer on handle N.
    """
    layer_inputs = list(_layer_inputs(description))
    sole_input = layer_inputs[0] if len(layer_inputs) == 1 else None

    def declared_source(ui: dict[str, Any]) -> str | None:
        declared = (ui.get("widget_options") or {}).get("source_layer")
        return declared.split(".")[0] if isinstance(declared, str) else None

    def source_for(name: str, ui: dict[str, Any]) -> str | None:
        declared = declared_source(ui)
        if declared is not None:
            return declared
        if name.endswith("_field"):
            return f"{name.removesuffix('_field')}_layer_id"
        return sole_input

    refs: list[_FieldRef] = []
    for name, entry in description.inputs.items():
        ui = _ui(entry.schema_)
        label = entry.title or name
        value = config.get(name)
        if ui.get("widget") == FIELD_STATISTICS_WIDGET:
            entries = value if isinstance(value, list) else [value]
            for item in entries:
                field = item.get("field") if isinstance(item, dict) else None
                if isinstance(field, str) and field:
                    refs.append(_FieldRef(name, label, field, source_for(name, ui)))
            continue
        if _is_field_widget(name, ui):
            names = value if isinstance(value, list) else [value]
            for field in names:
                if isinstance(field, str) and field:
                    refs.append(_FieldRef(name, label, field, source_for(name, ui)))
            continue
        schema = _effective(entry.schema_)
        properties = _item_properties(schema, description.schema_defs)
        if schema.get("type") != "array" or properties is None:
            continue
        if name == "opportunities":
            for number, handle in enumerate(NUMBERED_OPPORTUNITY_ID_FIELDS, start=1):
                if handle not in handles:
                    continue
                for prop, prop_schema in properties.items():
                    prop_ui = _ui(prop_schema)
                    field = config.get(f"opportunity_{number}_{prop}")
                    if (
                        _is_field_widget(prop, prop_ui)
                        and isinstance(field, str)
                        and field
                    ):
                        prop_label = (
                            prop_ui.get("label") or prop_schema.get("title") or prop
                        )
                        refs.append(
                            _FieldRef(
                                f"opportunity_{number}_{prop}",
                                f"{label} {number} · {prop_label}",
                                field,
                                handle,
                            )
                        )
        if not isinstance(value, list):
            continue
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                continue
            for prop, prop_schema in properties.items():
                prop_ui = _ui(prop_schema)
                field = item.get(prop)
                if not _is_field_widget(prop, prop_ui):
                    continue
                if not isinstance(field, str) or not field:
                    continue
                if name == "opportunities":
                    source = (
                        NUMBERED_OPPORTUNITY_ID_FIELDS[index]
                        if index < len(NUMBERED_OPPORTUNITY_ID_FIELDS)
                        else None
                    )
                else:
                    source = declared_source(prop_ui) or source_for(name, ui)
                prop_label = prop_ui.get("label") or prop
                refs.append(_FieldRef(name, f"{label} · {prop_label}", field, source))
    return refs


class _WorkflowCheck:
    """One check of one workflow; holds what several steps look up."""

    def __init__(
        self,
        nodes: list[dict[str, Any]],
        edges: list[dict[str, Any]],
        variables: list[dict[str, Any]],
        language: str,
        unreadable_layer_ids: frozenset[str],
        layer_fields: LayerFields,
        layer_feature_count: LayerFeatureCount | None,
    ) -> None:
        self.nodes = nodes
        self.edges = edges
        self.variables = variables
        self.var_map = variable_map(variables)
        self.language = language
        self.unreadable_layer_ids = unreadable_layer_ids
        self.layer_fields = layer_fields
        self.layer_feature_count = layer_feature_count
        self.by_id = {str(node["id"]): node for node in nodes}
        self.incoming: dict[str, list[dict[str, Any]]] = {i: [] for i in self.by_id}
        self.connected: set[str] = set()
        for edge in edges:
            source, target = edge.get("source"), edge.get("target")
            if source in self.by_id and target in self.by_id:
                self.incoming[str(target)].append(edge)
                self.connected.update((str(source), str(target)))
        self._arguments: dict[str, dict[str, Any] | None] = {}
        self._fields: dict[str, list[str] | None] = {}
        self._feature_counts: dict[str, int | None] = {}
        self._columns: dict[str, set[str] | None] = {}
        self.unreadable_steps = self._unreadable_steps()

    async def run(self) -> list[Issue]:
        issues = self._graph_issues()
        for node in self.nodes:
            kind = _kind(node)
            if kind == "tool":
                issues += await self._tool_issues(node)
            elif kind == "dataset":
                issues += self._dataset_issues(node)
            elif kind == "if":
                issues += self._if_issues(node)
            elif kind == "export":
                issues += self._export_issues(node)
            if str(node["id"]) in self.unreadable_steps:
                step = self._step_name(node)
                issues.append(
                    Issue(
                        "layer_not_readable",
                        "error",
                        f"{step}: the layer cannot be read with your access.",
                        (str(node["id"]),),
                        params={"step": step},
                    )
                )
        return issues + self._unconnected_steps(issues)

    # -- names -----------------------------------------------------------------

    def _description(self, process_id: Any) -> ProcessDescription | None:
        return _description(process_id, self.language)

    def _step_name(self, node: dict[str, Any]) -> str:
        return step_name(node, language=self.language)

    # -- the whole graph -------------------------------------------------------

    def _graph_issues(self) -> list[Issue]:
        issues: list[Issue] = []
        for loop in find_loops(self.nodes, self.edges):
            steps = [self._step_name(self.by_id[node_id]) for node_id in loop]
            issues.append(
                Issue(
                    "loop",
                    "error",
                    f"These steps form a loop: {', '.join(steps)}.",
                    tuple(loop),
                    params={"steps": steps},
                )
            )
        if dangling_edges(self.nodes, self.edges):
            issues.append(
                Issue(
                    "connection_to_removed_step",
                    "error",
                    "A connection points to a step that does not exist.",
                )
            )
        return issues

    def _unconnected_steps(self, issues: list[Issue]) -> list[Issue]:
        """A step without any connection, when nothing else is said about it."""
        concerned = {node_id for issue in issues for node_id in issue.node_ids}
        found: list[Issue] = []
        for node in self.nodes:
            node_id = str(node["id"])
            if _kind(node) == "textAnnotation" or node_id in self.connected:
                continue
            if node_id in concerned:
                continue
            step = self._step_name(node)
            found.append(
                Issue(
                    "step_not_connected",
                    "warning",
                    f"{step}: the step is not connected.",
                    (node_id,),
                    params={"step": step},
                )
            )
        return found

    # -- steps -----------------------------------------------------------------

    def _dataset_issues(self, node: dict[str, Any]) -> list[Issue]:
        data = _data(node)
        if data.get("unresolved") is True or not data.get("layerId"):
            step = self._step_name(node)
            return [
                Issue(
                    "layer_not_chosen",
                    "error",
                    f"{step}: no layer is chosen.",
                    (str(node["id"]),),
                    params={"step": step},
                )
            ]
        return []

    def _export_issues(self, node: dict[str, Any]) -> list[Issue]:
        """An export with nothing connected saves nothing and a run passes it
        by: a warning, and its name is not judged until something is
        connected. An export adding the rows to an existing dataset
        (`destination` "existing") saves no new dataset: it needs that
        dataset, and has no name to judge."""
        node_id, step, data = str(node["id"]), self._step_name(node), _data(node)
        if not self.incoming[node_id]:
            return [
                Issue(
                    "export_not_connected",
                    "warning",
                    f"{step}: nothing is connected to it.",
                    (node_id,),
                    params={"step": step},
                )
            ]
        if data.get("destination") == "existing":
            if data.get("targetLayerId"):
                return []
            return [
                Issue(
                    "export_target_missing",
                    "error",
                    f"{step}: the dataset to add the rows to is not chosen.",
                    (node_id,),
                    "targetLayerId",
                    {"step": step},
                )
            ]
        name = data.get("datasetName")
        if not isinstance(name, str) or not name.strip():
            return [
                Issue(
                    "export_name_missing",
                    "error",
                    f"{step}: the dataset name is missing.",
                    (node_id,),
                    "datasetName",
                    {"step": step},
                )
            ]
        return []

    def _if_issues(self, node: dict[str, Any]) -> list[Issue]:
        node_id, step, data = str(node["id"]), self._step_name(node), _data(node)
        issues: list[Issue] = []
        count = len(self.incoming[node_id])
        if count != 1:
            issues.append(
                Issue(
                    "if_input_count",
                    "error",
                    f"{step}: needs exactly one incoming connection, has {count}.",
                    (node_id,),
                    params={"step": step, "count": count},
                )
            )
        if not _condition_complete(data):
            issues.append(
                Issue(
                    "if_condition_incomplete",
                    "error",
                    f"{step}: the condition is incomplete.",
                    (node_id,),
                    params={"step": step},
                )
            )
        if (data.get("mode") or "simple") == "simple":
            used = _variable_names(data.get("condition"))
        else:
            used = _variable_names(data.get("customExpression"))
        for name in dict.fromkeys(used):
            if name not in self.var_map:
                issues.append(self._undefined(node_id, step, None, name))
        return issues

    def _undefined(
        self, node_id: str, step: str, setting: str | None, name: str
    ) -> Issue:
        return Issue(
            "variable_undefined",
            "error",
            f"{step}: the variable {name} does not exist.",
            (node_id,),
            setting,
            {"step": step, "variable": name},
        )

    async def _tool_issues(self, node: dict[str, Any]) -> list[Issue]:
        node_id, step, data = str(node["id"]), self._step_name(node), _data(node)
        process_id = data.get("processId")
        if not isinstance(process_id, str) or not process_id.strip():
            return [
                Issue(
                    "tool_missing",
                    "error",
                    f"{step}: no tool is chosen.",
                    (node_id,),
                    params={"step": step},
                )
            ]
        description = self._description(process_id)
        if description is None:
            return [
                Issue(
                    "tool_removed",
                    "error",
                    f"{step}: the tool {process_id} does not exist.",
                    (node_id,),
                    params={"step": step, "tool": process_id},
                )
            ]
        config = _config(node)
        incoming = self.incoming[node_id]
        handles = {_handle(edge) for edge in incoming}
        layer_inputs = _layer_inputs(description)
        values = _form_values(description, config, handles)
        issues: list[Issue] = []

        named = [edge.get("targetHandle") for edge in incoming]
        for handle in dict.fromkeys(h for h in named if isinstance(h, str) and h):
            # The editor's name for a tool's input until the tool has loaded:
            # a run passes such a connection on, and the tool never reads it.
            if handle not in layer_inputs and handle != EDITOR_DEFAULT_HANDLE:
                issues.append(
                    Issue(
                        "connection_to_unknown_input",
                        "error",
                        f"{step}: a connection ends at {handle}, "
                        "which the tool does not have.",
                        (node_id,),
                        handle,
                        {"step": step, "input": handle},
                    )
                )
        for name, entry in layer_inputs.items():
            if entry.minOccurs > 0 and name not in handles:
                label = entry.title or name
                issues.append(
                    Issue(
                        "input_not_connected",
                        "error",
                        f"{step}: {label} is not connected.",
                        (node_id,),
                        name,
                        {"step": step, "label": label},
                    )
                )
        numbered = [
            h for h in NUMBERED_OPPORTUNITY_ID_FIELDS if h in description.inputs
        ]
        if numbered and not handles.intersection(numbered):
            issues.append(
                Issue(
                    "opportunity_not_connected",
                    "error",
                    f"{step}: no opportunity layer is connected.",
                    (node_id,),
                    params={"step": step},
                )
            )
        for name, entry in description.inputs.items():
            ui = _ui(entry.schema_)
            if ui.get("widget") in NOT_SETTING_WIDGETS:
                continue
            if ui.get("section") in NOT_SETTING_SECTIONS:
                continue
            if (
                entry.minOccurs > 0
                and is_shown(ui, values)
                and _is_empty(config.get(name))
            ):
                label = entry.title or name
                issues.append(
                    Issue(
                        "setting_required",
                        "error",
                        f"{step}: {label} is required.",
                        (node_id,),
                        name,
                        {"step": step, "label": label},
                    )
                )
        for setting, value in config.items():
            for name in dict.fromkeys(_variable_names(value)):
                if name not in self.var_map:
                    issues.append(self._undefined(node_id, step, setting, name))
        issues += self._invalid_settings(node, description, step, values, issues)
        issues += await self._field_issues(node, description, step, values, handles)
        issues += await self._destination_issues(node, description, step, handles)
        return issues

    # -- valid values ----------------------------------------------------------

    def _arguments_of(self, node: dict[str, Any]) -> dict[str, Any] | None:
        """The arguments the run would give the step's tool, None when they
        cannot be built (a missing variable, reported on its own)."""
        node_id = str(node["id"])
        if node_id not in self._arguments:
            try:
                arguments: dict[str, Any] | None = build_check_arguments(
                    node, self.nodes, self.edges, self.variables
                )
            except ValueError:
                arguments = None
            except Exception:
                logger.warning(
                    "Could not build the arguments of workflow step %s",
                    node_id,
                    exc_info=True,
                )
                arguments = None
            self._arguments[node_id] = arguments
        return self._arguments[node_id]

    def _invalid_settings(
        self,
        node: dict[str, Any],
        description: ProcessDescription,
        step: str,
        values: dict[str, Any],
        issues: list[Issue],
    ) -> list[Issue]:
        """`setting_invalid`: what the tool's parameter model rejects in the
        arguments the run would build, as the tool's job builds the model
        (`codegen.generate_windmill_script`).

        Left out: errors on a setting or input already reported as missing
        (an input not connected, a required setting, a missing variable,
        no opportunity layer), and "missing" errors of settings the form
        hides (`setting_required` reports them once they are shown).
        """
        arguments = self._arguments_of(node)
        tool = tool_registry.get_tool(description.id)
        if arguments is None or tool is None:
            return []
        try:
            tool.params_class(**arguments)
            return []
        except ValidationError as error:
            errors = error.errors(include_url=False)
        except Exception:
            logger.warning(
                "Validating workflow step %s failed", node["id"], exc_info=True
            )
            return []
        reported = {
            issue.field
            for issue in issues
            if issue.field is not None
            and issue.code
            in ("input_not_connected", "setting_required", "variable_undefined")
        }
        if any(issue.code == "opportunity_not_connected" for issue in issues):
            reported.add("opportunities")
        hidden = {
            name
            for name, entry in description.inputs.items()
            if not is_shown(_ui(entry.schema_), values)
        }
        found: list[Issue] = []
        seen: set[tuple[str | None, str]] = set()
        for error_ in errors:
            loc = tuple(error_.get("loc") or ())
            name = loc[0] if loc and isinstance(loc[0], str) else None
            if name in reported or (error_.get("type") == "missing" and name in hidden):
                continue
            field, label = self._invalid_setting(node, description, name, loc)
            reason = _reason(str(error_.get("msg", "")))
            # One issue per setting; on the step, one per distinct reason.
            key = (field, "") if field is not None else (None, reason)
            if key in seen:
                continue
            seen.add(key)
            message = (
                f"{step}: {label}: {reason}"
                if field is not None
                else f"{step}: {reason}"
            )
            found.append(
                Issue(
                    "setting_invalid",
                    "error",
                    message,
                    (str(node["id"]),),
                    field,
                    {"step": step, "label": label, "reason": reason},
                )
            )
        return found

    def _invalid_setting(
        self,
        node: dict[str, Any],
        description: ProcessDescription,
        name: str | None,
        loc: tuple[Any, ...],
    ) -> tuple[str | None, str]:
        """The setting a parameter error belongs to, and its label; (None, "")
        for an error on the whole step.

        A workflow step keeps an opportunity layer's settings as
        `opportunity_{N}_{name}`; the runner folds the connected handles,
        in handle order, into the `opportunities` list the error points into.
        """
        if (
            name == "opportunities"
            and len(loc) >= 3
            and isinstance(loc[1], int)
            and isinstance(loc[2], str)
        ):
            handles = {_handle(edge) for edge in self.incoming[str(node["id"])]}
            numbers = [
                number
                for number, handle in enumerate(NUMBERED_OPPORTUNITY_ID_FIELDS, start=1)
                if handle in handles
            ]
            if loc[1] < len(numbers):
                number, prop = numbers[loc[1]], loc[2]
                schema = _effective(description.inputs["opportunities"].schema_)
                properties = _item_properties(schema, description.schema_defs) or {}
                prop_schema = properties.get(prop) or {}
                prop_label = (
                    _ui(prop_schema).get("label") or prop_schema.get("title") or prop
                )
                label = (
                    f"{_title(description, 'opportunities')} {number} · {prop_label}"
                )
                return f"opportunity_{number}_{prop}", label
        if name is not None and name in description.inputs:
            return name, _title(description, name)
        return None, ""

    # -- fields and access -----------------------------------------------------

    def _unreadable_steps(self) -> set[str]:
        """Steps naming a layer (or bundle) the caller may not read: a dataset
        by its layer, a tool by any of its own settings
        (`access.refused_workflow_nodes`). A setting a connection feeds is
        left out: the runner replaces it with the connected layer."""
        if not self.unreadable_layer_ids:
            return set()
        visible: list[dict[str, Any]] = []
        for node in self.nodes:
            fed = {_handle(edge) for edge in self.incoming[str(node["id"])]}
            config = {k: v for k, v in _config(node).items() if k not in fed}
            visible.append({**node, "data": {**_data(node), "config": config}})
        denied = [{"kind": "layer", "id": i} for i in sorted(self.unreadable_layer_ids)]
        return set(refused_workflow_nodes(visible, denied))

    async def _field_issues(
        self,
        node: dict[str, Any],
        description: ProcessDescription,
        step: str,
        values: dict[str, Any],
        handles: set[str],
    ) -> list[Issue]:
        """Field settings naming a field their layer does not have
        (`field_not_in_layer`) or the step before may not produce
        (`field_maybe_missing`). A field the step before is predicted to have
        only as `join_<field>`, the name a join gives the fields it adds, is
        an error (`field_renamed_by_join`) when a join step lies upstream:
        the join's prediction follows its run, so the run fails on that name.
        A setting the form hides is not judged: the tool does not read it."""
        issues: list[Issue] = []
        for ref in _field_refs(description, _config(node), handles):
            entry = description.inputs.get(ref.setting)
            if entry is not None and not is_shown(_ui(entry.schema_), values):
                continue
            field_name = self._resolved(ref.field)
            if field_name is None:
                continue
            origin = self._origin(self._source_for(node, ref.source_input))
            if origin is None:
                continue
            params: dict[str, Any] = {
                "step": step,
                "label": ref.label,
                "field_name": field_name,
            }
            joined = f"{JOINED_FIELD_PREFIX}{field_name}"
            if _kind(origin) == "dataset":
                fields = await self._dataset_fields(origin)
                code, level = "field_not_in_layer", "error"
                message = f"{step}: {ref.label} names the field {field_name}, which the layer does not have."
            else:
                predicted = await self._output_columns(origin)
                fields = sorted(predicted) if predicted is not None else None
                code, level = "field_maybe_missing", "warning"
                message = f"{step}: {ref.label} names the field {field_name}, which the step before may not produce."
                if (
                    predicted is not None
                    and joined in predicted
                    and self._join_upstream(origin)
                ):
                    code, level = "field_renamed_by_join", "error"
                    message = (
                        f"{step}: {ref.label} names the field {field_name}, which "
                        f"the step before does not produce: the join names it {joined}."
                    )
                    params["joined_field"] = joined
            if fields is None or field_name in fields:
                continue
            issues.append(
                Issue(
                    code,
                    level,
                    message,
                    (str(node["id"]),),
                    ref.setting,
                    params,
                )
            )
        return issues

    async def _destination_issues(
        self,
        node: dict[str, Any],
        description: ProcessDescription,
        step: str,
        handles: set[str],
    ) -> list[Issue]:
        """`too_many_destinations`: the dataset layers without a filter on a
        heatmap's opportunity inputs have more features together than its run
        takes (`_caps_destinations`). The run counts seed points: one per
        point, one per covered cell of a polygon, so a feature count above the
        limit means more seeds than that, features without a geometry aside.

        What the check cannot count adds nothing, which the run counts itself:
        a layer the run filters (`_filtered`), a step's result, a layer whose
        count is not known. A step whose run trims the destinations to its
        reference area's reach first is left to the run as a whole
        (`_trimmed_to_reference_area`). A heatmap an If step may skip
        (`_may_be_skipped`) gets the issue as a warning: the run may never
        reach the limit, so it is not refused.
        """
        tool = tool_registry.get_tool(description.id)
        if self.layer_feature_count is None or tool is None:
            return []
        if not _caps_destinations(tool.params_class):
            return []
        if self._trimmed_to_reference_area(node, tool.params_class, handles):
            return []
        total = 0
        for handle in NUMBERED_OPPORTUNITY_ID_FIELDS:
            if handle not in handles:
                continue
            source = self._source_for(node, handle)
            origin = self._origin(source)
            if origin is None or _kind(origin) != "dataset":
                continue
            if _filtered(origin):
                continue
            total += await self._dataset_feature_count(origin) or 0
        if total <= MAX_SEED_POINTS_TOTAL:
            return []
        return [
            Issue(
                "too_many_destinations",
                "warning" if self._may_be_skipped(str(node["id"])) else "error",
                f"{step}: the opportunity layers without a filter have {total:,} "
                f"features together, more than the {MAX_SEED_POINTS_TOTAL:,} the "
                "heatmap takes. Limit them to an area or with a filter.",
                (str(node["id"]),),
                params={
                    "step": step,
                    "features": total,
                    "limit": MAX_SEED_POINTS_TOTAL,
                },
            )
        ]

    def _may_be_skipped(self, node_id: str) -> bool:
        """Whether a run may skip the step: an If step skips each step that
        only the branch it does not take reaches, whatever else the step
        reads (`workflow_runner.mark_skipped_descendants`, the run's own
        rule). A step both branches reach always runs."""
        return any(
            node_id in mark_skipped_descendants(str(step["id"]), self.edges, taken, {})
            for step in self.nodes
            if _kind(step) == "if"
            for taken in (IF_TRUE_HANDLE, IF_FALSE_HANDLE)
        )

    def _trimmed_to_reference_area(
        self, node: dict[str, Any], params_class: type[BaseModel], handles: set[str]
    ) -> bool:
        """Whether the step's run drops the destinations beyond its reference
        area's reach before it applies the limit: the tool's own rule
        (`budget_replaced_by_reference_area`, closest average on a street
        mode), on the arguments a run would build. A step with a reference
        area whose arguments cannot be read that way counts as trimmed."""
        if REFERENCE_AREA_INPUT not in handles and not _config(node).get(
            REFERENCE_AREA_INPUT
        ):
            return False
        arguments = self._arguments_of(node)
        if arguments is None:
            return True
        if not issubclass(params_class, HeatmapV2WindmillParams):
            return True
        try:
            # Unvalidated: the rule reads two settings, which a step that
            # fails validation elsewhere may still have.
            params: HeatmapV2WindmillParams = params_class.model_construct(**arguments)
            return bool(params.budget_replaced_by_reference_area())
        except Exception:
            return True

    async def _dataset_feature_count(self, node: dict[str, Any]) -> int | None:
        """A dataset step's feature count; None for a layer the caller may not
        read (never looked up), one not chosen yet, or one whose count is not
        known."""
        data = _data(node)
        layer_id = data.get("layerId")
        if self.layer_feature_count is None or data.get("unresolved") is True:
            return None
        if not isinstance(layer_id, str) or not layer_id:
            return None
        if str(node["id"]) in self.unreadable_steps:
            return None
        if layer_id not in self._feature_counts:
            self._feature_counts[layer_id] = await self.layer_feature_count(layer_id)
        return self._feature_counts[layer_id]

    def _resolved(self, field: str) -> str | None:
        """A field setting's value with its variables resolved, as a run
        would; None when that is not a field name."""
        if not VARIABLE_PATTERN.search(field):
            return field
        try:
            resolved = resolve_variables(field, self.var_map)
        except ValueError:
            return None
        return resolved if isinstance(resolved, str) and resolved else None

    def _source_for(
        self, node: dict[str, Any], source_input: str | None
    ) -> dict[str, Any] | None:
        """The step connected to `source_input` (the editor's
        `sourceDatasetFor`, for any kind of step)."""
        incoming = self.incoming[str(node["id"])]
        if source_input:
            exact = next(
                (e for e in incoming if e.get("targetHandle") == source_input), None
            )
            if exact is not None:
                return self.by_id.get(str(exact["source"]))
        unnamed = [
            e
            for e in incoming
            if not e.get("targetHandle")
            or e.get("targetHandle") == EDITOR_DEFAULT_HANDLE
        ]
        if len(unnamed) == 1:
            return self.by_id.get(str(unnamed[0]["source"]))
        if not source_input and len(incoming) == 1:
            return self.by_id.get(str(incoming[0]["source"]))
        return None

    def _join_upstream(self, node: dict[str, Any]) -> bool:
        """Whether the step is a join or reads, through any steps, from one."""
        seen: set[str] = set()
        waiting = [str(node["id"])]
        while waiting:
            node_id = waiting.pop()
            if node_id in seen or node_id not in self.by_id:
                continue
            seen.add(node_id)
            if _data(self.by_id[node_id]).get("processId") == JOIN_TOOL:
                return True
            waiting += [str(edge["source"]) for edge in self.incoming[node_id]]
        return False

    def _origin(self, node: dict[str, Any] | None) -> dict[str, Any] | None:
        """The step whose result reaches a tool through `node`: an If passes
        its single input through unchanged."""
        seen: set[str] = set()
        while node is not None and _kind(node) == "if":
            node_id = str(node["id"])
            incoming = self.incoming[node_id]
            if node_id in seen or len(incoming) != 1:
                return None
            seen.add(node_id)
            node = self.by_id.get(str(incoming[0]["source"]))
        return node if node is not None and _kind(node) in ("dataset", "tool") else None

    async def _dataset_fields(self, node: dict[str, Any]) -> list[str] | None:
        """A dataset step's fields; None for a layer the caller may not read
        (never looked up) or whose fields are unknown."""
        layer_id = _data(node).get("layerId")
        if not isinstance(layer_id, str) or not layer_id:
            return None
        if str(node["id"]) in self.unreadable_steps:
            return None
        if layer_id not in self._fields:
            self._fields[layer_id] = await self.layer_fields(layer_id)
        return self._fields[layer_id]

    async def _output_columns(self, node: dict[str, Any]) -> set[str] | None:
        """The fields a dataset step has or a tool step is predicted to
        produce. Upstream steps are predicted first, so the steps are walked
        in the order a run takes them; a failed prediction, an unknown input
        or a step inside a loop gives None."""
        node_id = str(node["id"])
        if node_id in self._columns:
            return self._columns[node_id]
        self._columns[node_id] = None
        columns: set[str] | None = None
        if _kind(node) == "dataset":
            fields = await self._dataset_fields(node)
            columns = set(fields) if fields is not None else None
        else:
            columns = await self._predicted_columns(node)
        self._columns[node_id] = columns
        return columns

    async def _predicted_columns(self, node: dict[str, Any]) -> set[str] | None:
        process_id = _data(node).get("processId")
        description = self._description(process_id)
        incoming = self.incoming[str(node["id"])]
        if description is None or not incoming:
            return None
        input_schemas: dict[str, dict[str, str]] = {}
        for edge in incoming:
            origin = self._origin(self.by_id.get(str(edge["source"])))
            upstream = await self._output_columns(origin) if origin else None
            if upstream is None:
                return None
            # Only the names are known. The predictors copy types through or
            # skip geometry by its type; custom SQL builds tables of them.
            input_schemas[_handle(edge)] = {
                name: "GEOMETRY" if name in GEOMETRY_COLUMNS else "VARCHAR"
                for name in sorted(upstream)
            }
        defaults = {
            name: entry.schema_["default"]
            for name, entry in description.inputs.items()
            if "default" in entry.schema_
        }
        params = {**defaults, **(self._arguments_of(node) or _config(node))}
        # Custom SQL predictions run the query in DuckDB.
        predicted = await asyncio.to_thread(
            predict_node_output_schema, str(process_id), input_schemas, params
        )
        # A step always produces columns; none means the prediction failed.
        if predicted is None or not predicted.columns:
            return None
        return set(predicted.columns)


def _runs_something(steps: list[dict[str, Any]], edges: list[dict[str, Any]]) -> bool:
    """Whether a run of the workflow does anything: it runs each tool step,
    and saves what is connected to an export step, a dataset's rows too
    (`workflow_runner`)."""
    if any(_kind(step) == "tool" for step in steps):
        return True
    ids = {str(step["id"]) for step in steps}
    exports = {str(step["id"]) for step in steps if _kind(step) == "export"}
    return any(
        str(edge.get("source")) in ids and str(edge.get("target")) in exports
        for edge in edges
    )


async def check_workflow(
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    variables: list[dict[str, Any]],
    *,
    language: str,
    unreadable_layer_ids: frozenset[str],
    layer_fields: LayerFields,
    layer_feature_count: LayerFeatureCount | None = None,
) -> list[Issue]:
    """Every issue of a workflow, in the order: the workflow as a whole, then
    each step in the order of `nodes`, then steps without any connection.

    A damaged workflow gets only its damaged issues. A workflow whose run
    does nothing has none (`_runs_something`). `unreadable_layer_ids` are
    the layers (and bundles) the caller may not read, from the access check;
    `layer_fields` looks up a dataset's fields and `layer_feature_count` its
    feature count, and neither is asked about those. Without
    `layer_feature_count` no count is known.
    """
    damaged: list[Issue] = shape_issues({"nodes": nodes, "edges": edges})
    if damaged:
        return damaged
    steps = node_list({"nodes": nodes, "edges": edges})
    if not _runs_something(steps, edges):
        return []
    check = _WorkflowCheck(
        steps,
        edges,
        variables,
        language,
        unreadable_layer_ids,
        layer_fields,
        layer_feature_count,
    )
    return await check.run()


# -- the fields of a layer -----------------------------------------------------

# (layer id, last change) -> field names. Touched only on the event loop.
_field_cache: LRUCache[tuple[str, datetime], tuple[str, ...]] = LRUCache(maxsize=2048)


async def _last_change(layer_id: str) -> datetime | None:
    """When the layer last changed; None when there is no such layer."""
    pool = await _get_pool()
    changed: datetime | None = await pool.fetchval(
        f"SELECT updated_at FROM {settings.CUSTOMER_SCHEMA}.layer WHERE id = $1::uuid",
        layer_id,
    )
    return changed


def _settled(changed: datetime) -> bool:
    """Whether this process's DuckLake snapshot shows the change yet.

    Reads see a snapshot refreshed every DUCKLAKE_SNAPSHOT_REFRESH_SECONDS,
    so right after a change they may still show the old columns; those are
    not cached under the new key.
    """
    if changed.tzinfo is None:
        changed = changed.replace(tzinfo=timezone.utc)
    settle = timedelta(seconds=settings.DUCKLAKE_SNAPSHOT_REFRESH_SECONDS + 1)
    return datetime.now(timezone.utc) - changed > settle


async def ducklake_layer_fields(layer_id: str) -> list[str] | None:
    """`LayerFields` for the service: a layer's columns, the ones every layer
    carries included (a join on geometry, an id field), None when they are
    not known (no such layer, no table behind it, a read that failed), so
    the check judges nothing.

    The check runs on every edit, so the fields are cached in the process,
    keyed by the layer and its last change (`customer.layer.updated_at`,
    which core, geoapi's column edits and a layer replacement move forward).
    The read goes through the analytics service's DuckDB connection in a
    worker thread; that connection closes the pending result whenever it is
    handed back (`BaseDuckLakeManager.connection`), so no catalog
    connection stays idle in a transaction.
    """
    try:
        layer_id = normalize_layer_id(layer_id)
    except InvalidLayerIdError:
        return None
    try:
        changed = await _last_change(layer_id)
        if changed is None:
            return None
        key = (layer_id, changed)
        cached = _field_cache.get(key)
        if cached is not None:
            return list(cached)
        columns = await asyncio.to_thread(analytics_service.column_names, layer_id)
    except HTTPException:
        # No table behind the layer (`AnalyticsService._get_table_name`).
        return None
    except Exception:
        logger.warning("Could not read the fields of layer %s", layer_id, exc_info=True)
        return None
    fields = tuple(columns)
    if _settled(changed):
        _field_cache[key] = fields
    return list(fields)


# -- the feature count of a layer ---------------------------------------------


async def recorded_feature_count(layer_id: str) -> int | None:
    """`LayerFeatureCount` for the service: the feature count a catalog
    dataset's copy recorded (`other_properties.catalog_materialize`), the one
    core shows the assistant too. None for any other layer, and whenever it
    cannot be read: nothing else keeps a count, and the check runs on every
    edit, so it never counts a table's rows.
    """
    try:
        layer_id = normalize_layer_id(layer_id)
    except InvalidLayerIdError:
        return None
    try:
        pool = await _get_pool()
        stored: str | None = await pool.fetchval(
            "SELECT other_properties #>> '{catalog_materialize,feature_count}' "
            f"FROM {settings.CUSTOMER_SCHEMA}.layer WHERE id = $1::uuid",
            layer_id,
        )
    except Exception:
        logger.warning(
            "Could not read the feature count of layer %s", layer_id, exc_info=True
        )
        return None
    if stored is None or not (stored.isascii() and stored.isdigit()):
        return None
    return int(stored)

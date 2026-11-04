"""The arguments a workflow run would hand a tool step, built for a check.

The workflow check (processes `services/workflow_checks.py`) validates each
tool step with the tool's parameter model, which needs the arguments the
step's job would get. They are built by the run's own code
(`workflow_runner.tool_arguments` and `add_run_context`), so a check never
judges different values than a run sees. What only a run knows is replaced:
an upstream step's result by a temp-layer-shaped placeholder, a dataset step
without a layer by a placeholder id (`layer_not_chosen` reports that step),
and the run's ids by placeholders. An If step delivers what it passes on, as
in a run.

Imports the runner, so it needs the worker's dependencies (wmill, asyncpg):
processes has them, core's base install does not.
"""

from typing import Any

from goatlib.tools.workflow_runner import (
    add_run_context,
    passed_on_step,
    tool_arguments,
)

PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000"


def placeholder_layer_id(
    source_node: dict[str, Any],
    edges: list[dict[str, Any]],
    nodes: list[dict[str, Any]],
) -> str | None:
    """The layer an upstream node delivers, as far as a check can tell.

    An If step delivers the layer of the step before it
    (`workflow_runner.passed_on_step`). One without an input is judged as a
    step with a result: `if_input_count` reports it.
    """
    node = passed_on_step(source_node, edges, nodes) or source_node
    data = node.get("data") or {}
    kind = data.get("type")
    if kind == "dataset":
        return str(data.get("layerId") or PLACEHOLDER_ID)
    if kind in ("tool", "if"):
        # The shape a run's temp layer ids have: workflow:node:file.
        return f"{PLACEHOLDER_ID}:{node['id']}:{PLACEHOLDER_ID}"
    return None


def build_check_arguments(
    node: dict[str, Any],
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    variables: list[dict[str, Any]],
) -> dict[str, Any]:
    """The keyword arguments the step's tool job would build its parameter
    model from.

    Variables resolve to their default values, as in a run. Raises
    ValueError for a reference to a variable that does not exist.
    """
    inputs = tool_arguments(
        node,
        edges,
        nodes,
        variables,
        lambda source_node: placeholder_layer_id(source_node, edges, nodes),
    )
    inputs = add_run_context(
        inputs,
        node,
        user_id=PLACEHOLDER_ID,
        project_id=PLACEHOLDER_ID,
        folder_id=PLACEHOLDER_ID,
        workflow_id=PLACEHOLDER_ID,
    )
    # The generated tool script drops every argument that is None before it
    # builds the parameter model (`codegen.generate_windmill_script`), so
    # a None here is a default there.
    return {key: value for key, value in inputs.items() if value is not None}

"""A workflow's dataset nodes read the layer their project entry shows now.

A dataset node added from the project carries the layer id picked in the
editor (``layerId``) and the project entry it came from (``projectLayerId``).
The entry is the stable handle: a workflow re-run can put a new layer behind
it (copy-on-write, see ``workflow_export_target``). When it does, finalize
rewrites the saved ``layerId`` of the nodes reading that entry
(``retarget_dataset_nodes``) — the editor reads it for field lists and
geometry checks. A browser may still save an older copy of a workflow, so the
runner also resolves every such node through its entry in the running
project, and falls back to ``layerId`` when the entry is not there (removed,
trashed, or another project's).

Nodes that carry only a ``layerId`` (saved before entries were recorded, or
copied from such a project) are retargeted by layer instead
(``retarget_unlinked_dataset_nodes``), when no other entry of the project
could be the one they mean.

An export saves a dataset node's rows in the style the layer has where the
node found it (``dataset_style``): its entry's in the running project, else
the layer's own.
"""

import copy
import json
import uuid
from typing import Any


def _link_id(node: dict[str, Any]) -> int | None:
    data = node.get("data") or {}
    if data.get("type") != "dataset":
        return None
    link_id = data.get("projectLayerId")
    return (
        link_id if isinstance(link_id, int) and not isinstance(link_id, bool) else None
    )


def project_layer_ids(nodes: list[dict[str, Any]]) -> list[int]:
    """The project entries the dataset nodes name, in node order."""
    return [link_id for node in nodes if (link_id := _link_id(node)) is not None]


def with_current_layer_ids(
    nodes: list[dict[str, Any]], current: dict[int, str]
) -> list[dict[str, Any]]:
    """A copy of ``nodes`` with each dataset node's ``layerId`` set to the
    layer its entry shows now, where ``current`` knows the entry."""
    resolved = []
    for node in nodes:
        link_id = _link_id(node)
        if link_id is not None and link_id in current:
            node = copy.deepcopy(node)
            node["data"]["layerId"] = current[link_id]
        resolved.append(node)
    return resolved


async def current_layer_ids(
    conn: Any, schema: str, *, user_id: str, project_id: str, link_ids: list[int]
) -> dict[int, str]:
    """The layer behind each of ``link_ids`` that is a live entry of the
    project, if ``user_id`` may read the project.

    The run names its project in the request and entry ids are small
    integers, so without the read check enumerating them would hand the tools
    layer ids of a project the runner cannot see.
    """
    rows = await conn.fetch(
        f"""
        SELECT lp.id, l.id::text AS layer_id
        FROM {schema}.layer_project lp
        JOIN {schema}.layer l ON l.id = lp.layer_id
        WHERE lp.project_id = $1
          AND lp.id = ANY($2::int[])
          AND l.deleted_at IS NULL
          AND {schema}.can('project', $1, $3, 'read')
        """,
        uuid.UUID(project_id),
        link_ids,
        uuid.UUID(user_id),
    )
    return {row["id"]: row["layer_id"] for row in rows}


def _style(raw: Any) -> dict[str, Any] | None:
    """A style column's value as a style, None when it holds none."""
    style = json.loads(raw) if isinstance(raw, str) else raw
    return style if isinstance(style, dict) and style else None


async def dataset_style(
    conn: Any, schema: str, *, user_id: str, project_id: str, node: dict[str, Any]
) -> dict[str, Any] | None:
    """The style of a dataset node's layer, for the rows an export saves
    from it; None when there is none to read (the saved layer then gets the
    default style).

    The node's project entry has the style the project shows the layer in,
    when it is an entry of the running project that shows this layer and
    ``user_id`` may read the project (as in ``current_layer_ids``). Else the
    layer's own style, if ``user_id`` may read the layer. Visibility is view
    state, not style, so the saved layer is shown even when the dataset is
    hidden in the project (as core's ``initial_link_properties`` does for a
    layer added to a project a second time).
    """
    data = node.get("data") or {}
    row = await conn.fetchrow(
        f"""
        SELECT
            (SELECT lp.properties::text
             FROM {schema}.layer_project lp
             WHERE lp.id = $3::int
               AND lp.project_id = $1::uuid
               AND lp.layer_id = $4::uuid
               AND {schema}.can('project', $1::uuid, $2::uuid, 'read')
            ) AS entry_style,
            (SELECT l.properties::text
             FROM {schema}.layer l
             WHERE l.id = $4::uuid
               AND l.deleted_at IS NULL
               AND {schema}.can('layer', $4::uuid, $2::uuid, 'read')
            ) AS layer_style
        """,
        uuid.UUID(project_id),
        uuid.UUID(user_id),
        _link_id(node),
        uuid.UUID(str(data.get("layerId"))),
    )
    style = _style(row["entry_style"]) or _style(row["layer_style"])
    return {**style, "visibility": True} if style else None


def _swap_tool_config_ids(
    nodes: list[dict[str, Any]], old_ids: set[str], layer_id: str
) -> None:
    """Rewrite tool configs' copies of ``old_ids`` to ``layer_id`` in place,
    as the editor's "Replace datasets" does."""

    def swap(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: swap(item) for key, item in value.items()}
        if isinstance(value, list):
            return [swap(item) for item in value]
        return layer_id if isinstance(value, str) and value in old_ids else value

    for node in nodes:
        data = node.get("data") if isinstance(node, dict) else None
        if isinstance(data, dict) and data.get("type") == "tool":
            data["config"] = swap(data.get("config"))


def _retargeted(
    config: dict[str, Any], link_id: int, layer_id: str
) -> dict[str, Any] | None:
    """``config`` with the dataset nodes reading ``link_id`` pointed at
    ``layer_id``, and tool configs' copies of their old layer id with them
    (as the editor's "Replace datasets" does), or None if nothing changed."""
    config = copy.deepcopy(config)
    nodes = config.get("nodes") or []
    old_ids: set[str] = set()
    for node in nodes:
        if _link_id(node) == link_id and node["data"].get("layerId") != layer_id:
            old = node["data"].get("layerId")
            if isinstance(old, str):
                old_ids.add(old)
            node["data"]["layerId"] = layer_id
    if not old_ids:
        return None
    _swap_tool_config_ids(nodes, old_ids, layer_id)
    return config


def _unlinked_retargeted(
    config: dict[str, Any],
    *,
    source_layer_id: str,
    layer_id: str,
    link_id: int,
    project_link_ids: set[int],
) -> dict[str, Any] | None:
    """``config`` with the dataset nodes that read ``source_layer_id`` through
    no entry of the project (no ``projectLayerId``, or one of another
    project) pointed at ``layer_id`` and given ``link_id`` as their entry, and
    tool configs' copies of the old id with them; None if nothing changed."""
    config = copy.deepcopy(config)
    nodes = config.get("nodes") or []
    changed = False
    for node in nodes:
        data = node.get("data") if isinstance(node, dict) else None
        if not isinstance(data, dict) or data.get("type") != "dataset":
            continue
        if data.get("layerId") != source_layer_id:
            continue
        if _link_id(node) in project_link_ids:
            continue
        data["layerId"] = layer_id
        data["projectLayerId"] = link_id
        changed = True
    if not changed:
        return None
    _swap_tool_config_ids(nodes, {source_layer_id}, layer_id)
    return config


async def retarget_dataset_nodes(
    conn: Any, schema: str, *, project_id: str, link_id: int, layer_id: str
) -> None:
    """Point the saved dataset nodes reading ``link_id`` at ``layer_id``, in
    every workflow of the project.

    Called when a re-run puts a new layer behind an existing entry: the
    runner resolves nodes through the entry anyway, but the editor reads the
    saved ``layerId`` (field lists, geometry checks). Rows are locked, so run
    it inside the caller's transaction.
    """
    rows = await conn.fetch(
        f"""
        SELECT id, config FROM {schema}.workflow
        WHERE project_id = $1
          AND jsonb_path_exists(
              config,
              '$.nodes[*] ? (@.data.projectLayerId == $link)',
              jsonb_build_object('link', $2::int)
          )
        FOR UPDATE
        """,
        uuid.UUID(project_id),
        link_id,
    )
    for row in rows:
        config = row["config"]
        if isinstance(config, str):
            config = json.loads(config)
        retargeted = _retargeted(config, link_id, layer_id)
        if retargeted is not None:
            await conn.execute(
                f"UPDATE {schema}.workflow SET config = $2::jsonb, updated_at = NOW() "
                "WHERE id = $1",
                row["id"],
                json.dumps(retargeted),
            )


async def retarget_unlinked_dataset_nodes(
    conn: Any,
    schema: str,
    *,
    project_id: str,
    source_layer_id: str,
    layer_id: str,
    link_id: int,
) -> int:
    """Point the saved dataset nodes that name ``source_layer_id`` without an
    entry of the project at ``layer_id`` and at entry ``link_id``, in every
    workflow of the project. Returns how many workflows changed.

    Many saved nodes carry only a ``layerId`` (nodes made before entries
    were recorded, and every node copied from such a project), so
    ``retarget_dataset_nodes`` cannot find them when a new layer is put
    behind the entry that shows their layer. Only safe while the project has
    no other entry still showing ``source_layer_id``: such a node could mean
    that entry instead, so then nothing is changed. Rows are locked; run it
    inside the caller's transaction.
    """
    rows = await conn.fetch(
        f"""
        SELECT w.id, w.config,
               ARRAY(SELECT lp.id FROM {schema}.layer_project lp
                     WHERE lp.project_id = w.project_id) AS link_ids
        FROM {schema}.workflow w
        WHERE w.project_id = $1
          AND NOT EXISTS (
              SELECT 1 FROM {schema}.layer_project lp
              WHERE lp.project_id = $1 AND lp.layer_id = $2
          )
          AND jsonb_path_exists(
              w.config,
              '$.nodes[*] ? (@.data.layerId == $layer)',
              jsonb_build_object('layer', $2::text)
          )
        FOR UPDATE OF w
        """,
        uuid.UUID(project_id),
        uuid.UUID(source_layer_id),
    )
    changed = 0
    for row in rows:
        config = row["config"]
        if isinstance(config, str):
            config = json.loads(config)
        retargeted = _unlinked_retargeted(
            config,
            source_layer_id=source_layer_id,
            layer_id=layer_id,
            link_id=link_id,
            project_link_ids=set(row["link_ids"] or []),
        )
        if retargeted is not None:
            await conn.execute(
                f"UPDATE {schema}.workflow SET config = $2::jsonb, updated_at = NOW() "
                "WHERE id = $1",
                row["id"],
                json.dumps(retargeted),
            )
            changed += 1
    return changed

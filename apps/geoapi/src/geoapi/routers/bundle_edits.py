"""Batch edits to a bundle's editable member layer.

One request, one transaction, because the edges layer and the nodes layer only
make sense together: the edge query in the artifact build inner-joins them, so an
edge naming a node that was never written is dropped and the street silently
disappears from routing.

The client draws edges. Everything about the nodes layer is decided here —
reuse a node within tolerance, split the edge the endpoint landed on, or mint a
node — so a user never has to keep source_node and target_node honest by hand.
"""

import asyncio
import logging
import math
from dataclasses import dataclass
from typing import Annotated, Any
from uuid import UUID

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from goatlib.bundles.topology import (
    DegenerateEdgeError,
    DrawnSegment,
    EdgeCandidate,
    MintNode,
    NodeCandidate,
    ReuseNode,
    SplitEdge,
    interior_join,
    resolve_endpoint,
    segments_from_breaks,
    validate_edge_endpoints,
)
from goatlib.models.bundle import (
    CLASS_DEFAULT_MAXSPEED,
    BundleTypeName,
    RoleSpec,
    get_spec,
)
from pydantic import BaseModel, Field
from pyproj import Transformer
from shapely.geometry import LineString, Point, shape
from shapely.ops import substring
from shapely.ops import transform as shapely_transform

from geoapi.config import settings
from geoapi.dependencies import LayerInfo, LayerInfoDep, get_layer_info_sync
from geoapi.deps.auth import get_user_id
from geoapi.ducklake_write import ducklake_write_manager
from geoapi.routers.features_write import (
    _invalidate_caches_and_pmtiles,
    _load_field_config,
    get_write_authorized_metadata,
)
from geoapi.services import bundle_edit_service as writer
from geoapi.services.computed_columns import (
    apply_defaults,
    validate_allowed_values,
)
from geoapi.services.layer_service import layer_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Bundle Edits"])

UserIdDep = Annotated[UUID, Depends(get_user_id)]

# Ground metres. An endpoint this close to a node is taken to mean that node.
#
# Distances are measured in EPSG:3857, where a unit is a ground metre only at
# the equator and shrinks as 1/cos(latitude) away from it — so this has to be
# scaled per edit or the tolerance quietly tightens with latitude: 0.67 m at
# Munich, 0.50 m at 60 degrees. See `_mercator_scale`.
SNAP_TOLERANCE_M = 1.0

# How far beyond the edit's own extent to look for snap candidates, in ground
# metres. Overshooting costs a few extra rows; undershooting would hide a node
# the endpoint should have snapped to.
CANDIDATE_PAD_M = 50.0

# Module-level: constructing a Transformer hits the PROJ database, so per-call
# construction would dominate small batches. Transformers are thread-safe for
# ``transform``.
_TRANSFORM_TO_3857 = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
_TRANSFORM_TO_4326 = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)


class EdgeCreate(BaseModel):
    geometry: dict[str, Any]
    properties: dict[str, Any] = Field(default_factory=dict)


class EdgeUpdate(BaseModel):
    id: str
    geometry: dict[str, Any]
    properties: dict[str, Any] = Field(default_factory=dict)


class BundleEditBatch(BaseModel):
    base_revision: int
    create: list[EdgeCreate] = Field(default_factory=list)
    update: list[EdgeUpdate] = Field(default_factory=list)
    delete: list[str] = Field(default_factory=list)


class EdgeSplit(BaseModel):
    original_id: str
    halves: list[str]


class EdgeChanges(BaseModel):
    created: list[str] = Field(default_factory=list)
    updated: list[str] = Field(default_factory=list)
    deleted: list[str] = Field(default_factory=list)
    split: list[EdgeSplit] = Field(default_factory=list)


class NodeChanges(BaseModel):
    created: list[str] = Field(default_factory=list)
    removed: list[str] = Field(default_factory=list)


class BundleEditResponse(BaseModel):
    revision: int
    bundle_id: str
    # The client has to refresh this layer's tiles too — the server may have
    # minted or pruned nodes — and cannot know which layer it is otherwise.
    nodes_layer_id: str
    # The queued artifact rebuild, for job tracking. None when the dispatch
    # failed — the layers are saved either way, and the bundle page's Update
    # button is the recovery path.
    rebuild_job_id: str | None = None
    edges: EdgeChanges
    nodes: NodeChanges


async def authorize_edit(layer_info: LayerInfo, user_id: UUID) -> Any:
    """The same write rule the per-feature endpoints apply — owner, or a
    non-owner who shares an editable project with the owner — minus their
    bundle-member refusal, which is exactly what this endpoint exists to
    bypass. Returns the layer's metadata (the owner check below needs the
    edges layer's owner)."""
    return await get_write_authorized_metadata(layer_info, user_id)


def _pool() -> Any:
    """The Postgres pool, or a 503 if the app has not finished starting.

    Every helper below needs it, so the check lives in one place rather than
    being remembered four times.
    """
    pool = layer_service._pool
    if not pool:
        raise HTTPException(status_code=503, detail="Database pool not initialized")
    return pool


async def resolve_bundle_member(layer_id: str) -> dict[str, Any] | None:
    """The bundle, type and role of a layer, or None if it is not a member."""
    row = await _pool().fetchrow(
        """
        SELECT bl.bundle_id, bl.role, b.bundle_type, b.user_id
        FROM customer.bundle_layer bl
        JOIN customer.bundle b ON b.id = bl.bundle_id
        WHERE bl.layer_id = $1::uuid
        """,
        layer_id,
    )
    return dict(row) if row else None


async def read_bundle_revision(bundle_id: str) -> int:
    """The bundle's current layers_revision."""
    row = await _pool().fetchrow(
        "SELECT layers_revision FROM customer.bundle WHERE id = $1::uuid", bundle_id
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Bundle not found")
    return int(row["layers_revision"])


async def member_layer_of_role(bundle_id: str, role: str) -> dict[str, Any] | None:
    """A sibling member layer of the same bundle, by role."""
    row = await _pool().fetchrow(
        """
        SELECT bl.layer_id, l.user_id
        FROM customer.bundle_layer bl
        JOIN customer.layer l ON l.id = bl.layer_id
        WHERE bl.bundle_id = $1::uuid AND bl.role = $2
        """,
        bundle_id,
        role,
    )
    return dict(row) if row else None


async def claim_bundle_revision(bundle_id: str, base_revision: int) -> int:
    """Atomically advance ``layers_revision`` from the client's base.

    Compare-and-swap, and done BEFORE the layer write on purpose: two saves
    from the same base race here and exactly one wins — the loser gets the 409
    instead of silently overwriting. It is also what makes the artifacts
    outdated, since a consumer compares their revision to this one, and it moves
    the revision past any in-flight rebuild so a build started earlier can no
    longer publish over the edit.
    """
    row = await _pool().fetchrow(
        """
        UPDATE customer.bundle
        SET layers_revision = layers_revision + 1, updated_at = NOW()
        WHERE id = $1::uuid AND layers_revision = $2
        RETURNING layers_revision
        """,
        bundle_id,
        base_revision,
    )
    if row is not None:
        return int(row["layers_revision"])
    current = await read_bundle_revision(bundle_id)  # 404 when the bundle is gone
    raise HTTPException(
        status_code=409,
        detail=(
            f"This network changed while you were editing (revision "
            f"{current}, you started from {base_revision}). "
            "Reload before saving."
        ),
    )


async def release_bundle_revision(bundle_id: str, claimed_revision: int) -> None:
    """Roll a claim back after a failed write, so the client's base revision
    stays valid and its retry is not a false conflict."""
    await _pool().execute(
        """
        UPDATE customer.bundle
        SET layers_revision = layers_revision - 1, updated_at = NOW()
        WHERE id = $1::uuid AND layers_revision = $2
        """,
        bundle_id,
        claimed_revision,
    )


async def dispatch_rebuild(bundle_id: str, authorization: str | None) -> str | None:
    """Queue the artifact rebuild that turns an edit into a routable graph.

    Dispatched here rather than by the browser because the graph's return to
    ``ready`` must not depend on the client surviving the save. Best-effort:
    the artifacts are already outdated either way, and the bundle page's Update
    button covers a dispatch that failed.
    """
    if not settings.PROCESSES_URL:
        logger.warning(
            "GOAT_PROCESSES_URL is not set; bundle %s stays outdated until "
            "rebuilt from its bundle page",
            bundle_id,
        )
        return None
    headers = {"Content-Type": "application/json"}
    if authorization:
        headers["Authorization"] = authorization
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                f"{settings.PROCESSES_URL}/processes/bundle_artifact_rebuild/execution",
                json={"inputs": {"bundle_id": bundle_id}},
                headers=headers,
            )
        if response.status_code in (200, 201):
            job_id = response.json().get("jobID")
            logger.info("Queued rebuild of bundle %s as job %s", bundle_id, job_id)
            return str(job_id) if job_id else None
        logger.error(
            "Rebuild dispatch for bundle %s failed: %s %s",
            bundle_id,
            response.status_code,
            response.text[:500],
        )
    except Exception as e:
        logger.error("Rebuild dispatch for bundle %s failed: %s", bundle_id, e)
    return None


def _validate_line(geometry: dict[str, Any]) -> None:
    """Refuse anything that is not a usable line, before shapely sees it.

    Checked here rather than left to ``shape()``, which raises a GEOS error for
    a one-point line — a bad request that would surface as a server fault.
    """
    if not isinstance(geometry, dict) or geometry.get("type") != "LineString":
        raise HTTPException(
            status_code=400, detail="An edge must be a GeoJSON LineString."
        )
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        raise HTTPException(
            status_code=400, detail="An edge needs at least two points."
        )
    for point in coordinates:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            raise HTTPException(
                status_code=400,
                detail="Every point of an edge needs a longitude and a latitude.",
            )
        if len(point) > 2:
            # Refused rather than flattened. Everything downstream is 2D — the
            # snap tolerance is measured in projected metres, a split is a
            # fraction along a 2D line, and a resolved vertex is read back from
            # the nodes layer as ST_X/ST_Y — so an elevation would be dropped
            # somewhere between the drawn line and the stored row either way.
            # Dropping it here silently would also mix 2- and 3-tuples in one
            # coordinate list and fail mid-transaction with "Inconsistent
            # coordinate dimensionality"; saying so is a 400 the client can act
            # on.
            raise HTTPException(
                status_code=400,
                detail=(
                    "An edge must be a 2D LineString: a street network stores "
                    "longitude and latitude only."
                ),
            )


def _to_3857(geometry: dict[str, Any]) -> Any:
    """Project a 4326 GeoJSON geometry into metres for measuring distances."""
    return shapely_transform(_TRANSFORM_TO_3857.transform, shape(geometry))


def _mercator_scale(latitude: float) -> float:
    """Projected units per ground metre at a latitude.

    EPSG:3857 is conformal, so one number covers both axes, and over a single
    edit the latitude spread is far too small for it to vary meaningfully.
    """
    return 1.0 / math.cos(math.radians(max(-89.5, min(89.5, latitude))))


def _bbox_to_4326(
    bbox_3857: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    """The same box in 4326 — exact, since Mercator keeps the axes aligned."""
    xmin, ymin, xmax, ymax = bbox_3857
    lon_min, lat_min = _TRANSFORM_TO_4326.transform(xmin, ymin)
    lon_max, lat_max = _TRANSFORM_TO_4326.transform(xmax, ymax)
    return (lon_min, lat_min, lon_max, lat_max)


def _batch_bbox_3857(
    geometries: list[dict[str, Any]],
) -> tuple[float, float, float, float]:
    """Bounding box of everything being written, padded for the candidate scan."""
    bounds = [_to_3857(g).bounds for g in geometries]
    xmin = min(b[0] for b in bounds)
    ymin = min(b[1] for b in bounds)
    xmax = max(b[2] for b in bounds)
    ymax = max(b[3] for b in bounds)
    pad = CANDIDATE_PAD_M * _mercator_scale(
        _TRANSFORM_TO_4326.transform(xmin, (ymin + ymax) / 2)[1]
    )
    return (xmin - pad, ymin - pad, xmax + pad, ymax + pad)


# The edges layer's per-direction speed limits, filled from the class above.
# Named here because the derivation below is the only thing that writes them.
SPEED_COLUMNS = ("speed_limit_kph_forward", "speed_limit_kph_backward")


def _fill_class_defaults(
    properties: dict[str, Any], field_config: dict[str, Any] | None
) -> dict[str, Any]:
    """Give a drawn edge the layer's defaults, and the speeds its class implies.

    The plain defaults come from ``field_config`` through the same
    ``apply_defaults`` the per-feature endpoints use, under its
    blank-counts-as-absent rule: this endpoint replaces the row whole and the
    editor sends "" (or null) for a field the user cleared, so an unclassified
    edge gets its ``class`` rather than saving as blank. Classifying a street is
    a judgement the user can make later and the engine has a meaning for
    "unknown".

    The speeds cannot come from there: they follow from whichever class ended up
    on the edge, so they are derived rather than declared, and only a street
    network has them.

    They matter more than they look. The artifact build coalesces a null speed
    to 0 and the engine treats maxspeed <= 0 as impassable, so an edge saved
    without them would be walkable but invisible to car routing.
    """
    filled = apply_defaults(field_config, properties, blank_is_absent=True)
    default = CLASS_DEFAULT_MAXSPEED.get(filled.get("class"))
    for column in SPEED_COLUMNS:
        if filled.get(column) is None and default is not None:
            filled[column] = default
    return filled


def _with_role_contract(
    field_config: dict[str, Any] | None, role_spec: RoleSpec
) -> dict[str, Any]:
    """The layer's own field_config over the bundle type's contract.

    A member layer carries the role's vocabularies and defaults in its
    field_config, written there at import so the constraint travels with the
    layer. Only the current importer writes them: a network imported before it,
    a filtered copy that lost the metadata, or a deployment whose PG pool is not
    configured all present an empty config, and the type's contract still holds
    for those. So the role's own declaration is the floor — ``class`` keeps its
    vocabulary, so a typo is a 400 rather than a road the artifact build maps to
    a drivable default, and keeps its default, so an edge drawn without one is
    "unknown" instead of NULL with NULL speeds, which the build turns into speed
    0: impassable for cars while looking like a street.

    Merged key by key, so whatever the layer states wins — a user may have
    narrowed the vocabulary or changed the default on their own copy.
    """
    merged: dict[str, Any] = {
        name: dict(entry) if isinstance(entry, dict) else entry
        for name, entry in (field_config or {}).items()
    }
    for column, values in role_spec.allowed_values.items():
        entry = merged.setdefault(column, {})
        if isinstance(entry, dict) and not entry.get("allowed_values"):
            entry["allowed_values"] = list(values)
            entry.setdefault("allow_other", False)
    for column, value in role_spec.default_values.items():
        entry = merged.setdefault(column, {})
        if isinstance(entry, dict) and entry.get("default_value") is None:
            entry["default_value"] = value
    return merged


@router.post(
    "/collections/{collectionId}/edits",
    summary="Apply a batch of edits to a bundle's editable member layer",
    response_model=BundleEditResponse,
    status_code=200,
)
async def apply_bundle_edits(
    request: Request,
    layer_info: LayerInfoDep,
    user_id: UserIdDep,
    body: BundleEditBatch = Body(...),
) -> BundleEditResponse:
    """Write an edge batch, derive the nodes it implies, advance the revision
    that makes the graph outdated, and queue the rebuild that renews it."""
    edges_metadata = await authorize_edit(layer_info, user_id)

    member = await resolve_bundle_member(layer_info.layer_id)
    if member is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "This layer is not part of a bundle. Use the ordinary feature "
                "endpoints instead."
            ),
        )

    bundle_id = str(member["bundle_id"])
    role = member["role"]
    spec_role = get_spec(BundleTypeName(member["bundle_type"])).role(role or "")
    if not (spec_role and spec_role.editable):
        raise HTTPException(
            status_code=400,
            detail=f"The '{role}' role of this bundle is not editable.",
        )

    if not (body.create or body.update or body.delete):
        raise HTTPException(status_code=400, detail="The batch contains no edits.")

    # One edit per feature. Two edits naming the same edge would both be
    # applied, the first one's derived nodes stranded by the second, and only
    # one of them is what the user meant.
    targeted = [e.id for e in body.update] + list(body.delete)
    repeated = {fid for fid in targeted if targeted.count(fid) > 1}
    if repeated:
        raise HTTPException(
            status_code=400,
            detail=(
                "The batch edits the same feature more than once: "
                f"{', '.join(sorted(repeated))}."
            ),
        )

    for edit in (*body.create, *body.update):
        _validate_line(edit.geometry)

    nodes_member = await member_layer_of_role(bundle_id, "nodes")
    if nodes_member is None:
        raise HTTPException(
            status_code=400,
            detail="This bundle has no nodes layer, so edges cannot be edited.",
        )
    # One save writes both member layers, but only the edges layer went
    # through write authorization — the nodes write is safe only while every
    # owner involved is the same person. Compare all three (edges layer, nodes
    # layer, bundle): any divergence means an inconsistent bundle nobody
    # should be writing into.
    owners = {
        str(edges_metadata.user_id).replace("-", ""),
        str(nodes_member["user_id"]).replace("-", ""),
        str(member["user_id"]).replace("-", ""),
    }
    if len(owners) != 1:
        raise HTTPException(
            status_code=403,
            detail="This bundle's member layers have different owners.",
        )

    loop = asyncio.get_event_loop()
    nodes_info: LayerInfo = await loop.run_in_executor(
        None, get_layer_info_sync, str(nodes_member["layer_id"])
    )

    # Claiming the revision is what makes every artifact outdated: a consumer
    # compares the artifact's revision to this one, so there is no second flag
    # to write and none to forget.
    revision = await claim_bundle_revision(bundle_id, body.base_revision)
    authorization = request.headers.get("Authorization")

    try:
        # The layer's own field_config, exactly as the per-feature endpoints
        # read it, over the bundle type's contract: the role's vocabularies and
        # defaults are written into the layer at import, and the type's own
        # declaration stands in for a layer that predates that. It carries two
        # things — the computed columns the writer refreshes after every
        # geometry write, and the constraint the editor was offering.
        field_config = _with_role_contract(
            await _load_field_config(layer_info), spec_role
        )
        for edit in (*body.create, *body.update):
            # Validated as it will be written, defaults and all: a cleared
            # field takes the layer's default here, so refusing the raw value
            # would refuse exactly what the editor sends for a field the user
            # emptied. A value outside the vocabulary is still refused, because
            # the artifact build maps an unknown street class to a drivable
            # road rather than reporting the mistake.
            validate_allowed_values(
                field_config, _fill_class_defaults(edit.properties, field_config)
            )
        changes = await loop.run_in_executor(
            None, _apply, layer_info, nodes_info, body, field_config
        )
    except (DegenerateEdgeError, ValueError) as e:
        # The layers are unchanged, so handing the claim back is the whole
        # repair: the artifacts are current again at the revision they were
        # built from, and no rebuild has to run to say so.
        await release_bundle_revision(bundle_id, revision)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        await release_bundle_revision(bundle_id, revision)
        raise

    # Once per layer, not once per feature: PMTiles are deleted so tiles fall
    # back to dynamic generation, and doing that per edge would rebuild them
    # for every stroke of an edit.
    await _invalidate_caches_and_pmtiles(layer_info)
    await _invalidate_caches_and_pmtiles(nodes_info)

    rebuild_job_id = await dispatch_rebuild(bundle_id, authorization)

    return BundleEditResponse(
        revision=revision,
        bundle_id=bundle_id,
        nodes_layer_id=str(nodes_member["layer_id"]),
        rebuild_job_id=rebuild_job_id,
        edges=changes[0],
        nodes=changes[1],
    )


@dataclass
class _Batch:
    """The state one save's writes have to agree on.

    Two kinds of knowledge about the same nodes, kept apart because they answer
    different questions. ``candidate_edges`` is what a vertex may snap to, and
    excludes the rows this batch is rewriting — an edge must not snap to its own
    former self. ``references`` is which edges hold each node, and counts those
    rows, because that is what makes a node a junction rather than a leftover.
    """

    con: Any
    edges_table: str
    nodes_table: str
    edge_columns: list[str]
    node_columns: list[str]
    candidate_nodes: list[NodeCandidate]
    candidate_edges: list[EdgeCandidate]
    references: dict[str, set[str]]
    # SNAP_TOLERANCE_M in the projected units distances are measured in, scaled
    # once for the edit's latitude so a metre means a ground metre.
    tolerance: float
    field_config: dict[str, Any] | None
    edges: EdgeChanges
    nodes: NodeChanges

    def is_junction(self, node_id: str) -> bool:
        """Whether anything else meets at this node."""
        return bool(self.references.get(node_id))

    def record(
        self, edge_id: str, source_node: str, target_node: str, geometry: Any
    ) -> None:
        """A row this batch just wrote, in EPSG:3857.

        Both a snap target and a junction for the lines still to come, so two
        streets drawn in one save connect to each other and not only to what was
        already there.
        """
        self.references.setdefault(source_node, set()).add(edge_id)
        self.references.setdefault(target_node, set()).add(edge_id)
        self.candidate_edges.append(
            EdgeCandidate(
                edge_id=edge_id,
                source_node=source_node,
                target_node=target_node,
                geometry=geometry,
            )
        )

    def forget(self, edge_id: str) -> None:
        """A row that is gone — a split replaced it, or it is being rewritten.

        Also drops it from the reported changes: a split of a row this batch
        created would otherwise hand the client an id that no longer resolves.
        """
        for holders in self.references.values():
            holders.discard(edge_id)
        self.candidate_edges[:] = [
            e for e in self.candidate_edges if e.edge_id != edge_id
        ]
        for reported in (self.edges.created, self.edges.updated):
            if edge_id in reported:
                reported.remove(edge_id)


def _apply(
    edges_info: LayerInfo,
    nodes_info: LayerInfo,
    body: BundleEditBatch,
    field_config: dict[str, Any] | None = None,
) -> tuple[EdgeChanges, NodeChanges]:
    """Derive and write, in one transaction."""
    edges_table = edges_info.full_table_name
    nodes_table = nodes_info.full_table_name
    edge_changes = EdgeChanges()
    node_changes = NodeChanges()

    written = [e.geometry for e in body.create] + [e.geometry for e in body.update]

    with ducklake_write_manager.connection() as con:
        columns = writer.column_names(con, edges_table)
        node_columns = writer.column_names(con, nodes_table)
        con.execute("BEGIN")
        try:
            touched = list(body.delete) + [e.id for e in body.update]
            resolved = writer.resolve_feature_ids(con, edges_table, touched)

            def own_id(feature_id: str) -> str:
                """The layer's own id for a feature the editor referred to."""
                if not str(feature_id).isdigit():
                    # Already a layer id: an edge this session created.
                    return feature_id
                own = resolved.get(str(feature_id))
                if own is None:
                    # Falling back to the raw value would target whatever row
                    # happened to carry it as an id — usually none, which used to
                    # make the whole edit a silent no-op.
                    raise ValueError(
                        "Part of this edit refers to a feature that is no longer "
                        "in the layer. Reload before saving."
                    )
                return own

            delete_ids = [own_id(fid) for fid in body.delete]
            update_ids = {e.id: own_id(e.id) for e in body.update}

            candidate_nodes: list[NodeCandidate] = []
            candidate_edges: list[EdgeCandidate] = []
            bbox_3857 = _batch_bbox_3857(written) if written else (0.0, 0.0, 0.0, 0.0)
            if written:
                candidate_nodes, candidate_edges = writer.fetch_candidates(
                    con,
                    edges_table,
                    nodes_table,
                    _bbox_to_4326(bbox_3857),
                    exclude_edge_ids=set(delete_ids) | set(update_ids.values()),
                    edge_columns=columns,
                    node_columns=node_columns,
                )

            batch = _Batch(
                con=con,
                edges_table=edges_table,
                nodes_table=nodes_table,
                edge_columns=columns,
                node_columns=node_columns,
                candidate_nodes=candidate_nodes,
                candidate_edges=candidate_edges,
                # Which edges hold each nearby node, so a vertex reaching one
                # can tell a junction from a dead end. Rows being deleted are
                # left out; rows being rewritten are not, because they still
                # hold their nodes until the rewrite reaches them.
                references=writer.node_references(
                    con,
                    edges_table,
                    [node.node_id for node in candidate_nodes],
                    exclude_edge_ids=delete_ids,
                ),
                field_config=field_config,
                tolerance=SNAP_TOLERANCE_M
                * _mercator_scale(_bbox_to_4326(bbox_3857)[1] if written else 0.0),
                edges=edge_changes,
                nodes=node_changes,
            )

            # Nodes the save might orphan: the endpoints of everything it
            # removes or moves.
            release_candidates = writer.edge_endpoints(
                con, edges_table, delete_ids + list(update_ids.values())
            )

            def write_segment(
                segment: DrawnSegment,
                properties: dict[str, Any],
                coordinates: list[Any],
                projected: list[Any],
            ) -> None:
                """Write one piece of a drawn line as a new edge.

                A create writes every piece this way; an update keeps its first
                piece on the row the client knows and writes the rest here.
                """
                new_id = writer.mint_id()
                writer.insert_edge(
                    con,
                    edges_table,
                    columns,
                    new_id,
                    _segment_geometry(coordinates, segment),
                    properties,
                    segment.source_node,
                    segment.target_node,
                    field_config,
                )
                edge_changes.created.append(new_id)
                batch.record(
                    new_id,
                    segment.source_node,
                    segment.target_node,
                    _segment_line(projected, segment),
                )

            for created in body.create:
                segments, coordinates, projected = _plan(batch, created.geometry)
                properties = _fill_class_defaults(
                    created.properties, batch.field_config
                )
                for segment in segments:
                    write_segment(segment, properties, coordinates, projected)

            for updated in body.update:
                own_id = update_ids[updated.id]
                # The row is about to be replaced, so it stops holding its old
                # nodes now. Without this, extending a street past its own dead
                # end would find the node it used to finish at still occupied
                # and break the line there, handing back two edges where the
                # user extended one.
                batch.forget(own_id)
                segments, coordinates, projected = _plan(batch, updated.geometry)
                # An update replaces the row's properties, so it needs the same
                # defaults a create gets — otherwise saving an edge without
                # restating its class would null it out.
                properties = _fill_class_defaults(
                    updated.properties, batch.field_config
                )
                # The edited row keeps the first piece, so the id the client
                # knows survives; a vertex dragged onto a junction turns the
                # rest into new edges.
                head, tail = segments[0], segments[1:]
                writer.update_edge(
                    con,
                    edges_table,
                    columns,
                    own_id,
                    _segment_geometry(coordinates, head),
                    properties,
                    head.source_node,
                    head.target_node,
                    field_config,
                )
                edge_changes.updated.append(own_id)
                batch.record(
                    own_id,
                    head.source_node,
                    head.target_node,
                    _segment_line(projected, head),
                )
                for segment in tail:
                    write_segment(segment, properties, coordinates, projected)

            if delete_ids:
                writer.delete_edges_by_id(con, edges_table, delete_ids)
                edge_changes.deleted.extend(delete_ids)

            if release_candidates:
                # The same question ``node_references`` answers for snapping,
                # asked after the writes and with nothing excluded: a candidate
                # no surviving edge holds is this save's orphan.
                held = writer.node_references(
                    con, edges_table, list(release_candidates)
                )
                orphans = {node_id for node_id, holders in held.items() if not holders}
                writer.delete_nodes_by_id(con, nodes_table, orphans)
                node_changes.removed.extend(sorted(orphans))

            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise

    return edge_changes, node_changes


def _plan(
    batch: _Batch, geometry: dict[str, Any]
) -> tuple[list[DrawnSegment], list[Any], list[Any]]:
    """The edges one drawn line becomes, with every endpoint node resolved.

    Vertices are walked in order, each resolved against the network as the ones
    before it left it: an endpoint that split an edge has to be visible to the
    interior vertex that lands on one of the halves, or the vertex would mint a
    free-floating node on a half's interior.

    Returns the segments with the line's 4326 and 3857 coordinates. The 4326
    list is the drawn line with every resolved vertex moved onto its node, which
    is what gets written; the 3857 list hands the written rows back as snap
    targets without reprojecting them again.
    """
    coordinates = [list(c) for c in shape(geometry).coords]
    projected = list(_to_3857(geometry).coords)
    last = len(projected) - 1
    if last < 1:
        raise ValueError("An edge needs at least two points.")
    # Checked here, at the one place every drawn line enters: a non-finite
    # ordinate survives everything downstream — it is a valid double to
    # DuckDB, and every length and cost derived from it is non-finite too —
    # and only shows up later as a routing failure on the whole network.
    for index, vertex in enumerate(coordinates):
        if not all(math.isfinite(ordinate) for ordinate in vertex):
            raise ValueError(
                f"Vertex {index + 1} of this edge has no usable position "
                f"({vertex}). Redraw it and save again."
            )

    def resolve(index: int, decision: Any) -> str:
        """Materialise one vertex's decision and move the vertex onto the node.

        The drawn position is only an intention: it can be up to the snap
        tolerance away from the node it resolved to, and a split puts the node on
        the crossed street rather than where the user clicked. Left alone, the
        graph would say the two streets meet while the geometry showed them
        passing within a metre of each other — the junction would be invisible
        on the map and the length would be measured along a line that stops
        short of it.
        """
        x, y = projected[index]
        node_id = _materialise(decision, batch, (float(x), float(y)))
        lon, lat = writer.node_position(batch.con, batch.nodes_table, node_id)
        coordinates[index] = [lon, lat]
        # Both lists describe the same vertex: the 4326 one is written, the 3857
        # one is handed back as a snap target for the rest of the batch.
        projected[index] = _TRANSFORM_TO_3857.transform(lon, lat)
        return node_id

    ends: dict[int, str] = {}
    breaks: list[tuple[int, str]] = []
    for index, (x, y) in enumerate(projected):
        if index in (0, last):
            # An end always takes the node it reaches, junction or not: the line
            # finishes there either way.
            ends[index] = resolve(
                index,
                resolve_endpoint(
                    Point(x, y),
                    batch.candidate_nodes,
                    batch.candidate_edges,
                    batch.tolerance,
                ),
            )
            continue
        join = interior_join(
            Point(x, y),
            batch.candidate_nodes,
            batch.candidate_edges,
            batch.tolerance,
            batch.is_junction,
        )
        if join is not None:
            breaks.append((index, resolve(index, join)))

    segments = segments_from_breaks(len(projected), ends[0], ends[last], breaks)
    for segment in segments:
        validate_edge_endpoints(segment.source_node, segment.target_node)
    return segments, coordinates, projected


def _segment_geometry(coordinates: list[Any], segment: DrawnSegment) -> dict[str, Any]:
    """The drawn line between two of its vertices, as GeoJSON."""
    return {
        "type": "LineString",
        "coordinates": [list(c) for c in coordinates[segment.start : segment.end + 1]],
    }


def _segment_line(projected: list[Any], segment: DrawnSegment) -> LineString:
    """The same slice in metres, for handing back as a snap target."""
    return LineString(projected[segment.start : segment.end + 1])


def _materialise(decision: Any, batch: _Batch, fallback: tuple[float, float]) -> str:
    """Turn one resolution into a node id, writing whatever it implies.

    Shared by the drawn line's endpoints and its interior vertices: both join
    the network the same three ways, and an interior vertex landing on a street
    has to split it for the same reason an endpoint does — otherwise the
    junction exists in the drawing and not in the graph.

    ``fallback`` is the drawn position, used for a minted node and as the
    candidate coordinate when a split cannot be measured.
    """
    if isinstance(decision, ReuseNode):
        return decision.node_id

    node_id = writer.mint_id()
    node_x, node_y = fallback
    if isinstance(decision, SplitEdge):
        writer.insert_node_on_edge(
            batch.con,
            batch.nodes_table,
            batch.node_columns,
            batch.edges_table,
            node_id,
            decision.edge_id,
            decision.fraction,
        )
        left, right = writer.mint_id(), writer.mint_id()
        writer.split_edge(
            batch.con,
            batch.edges_table,
            batch.edge_columns,
            decision.edge_id,
            decision.fraction,
            left,
            right,
            node_id,
            batch.field_config,
        )
        batch.edges.split.append(
            EdgeSplit(original_id=decision.edge_id, halves=[left, right])
        )
        original = next(
            (e for e in batch.candidate_edges if e.edge_id == decision.edge_id), None
        )
        batch.forget(decision.edge_id)
        if original is not None:
            # The halves take the original's place, so a later vertex in the
            # same batch can split or snap to them — falling through to
            # MintNode there would put a free-floating node on a half's
            # interior, a non-intersection the routing graph would publish
            # silently.
            batch.record(
                left,
                original.source_node,
                node_id,
                substring(original.geometry, 0.0, decision.fraction, normalized=True),
            )
            batch.record(
                right,
                node_id,
                original.target_node,
                substring(original.geometry, decision.fraction, 1.0, normalized=True),
            )
            # The node sits ON the split edge, not at the drawn vertex — the two
            # differ by up to the snap tolerance, and a later vertex should
            # measure against where the node really is.
            node_point = original.geometry.interpolate(
                decision.fraction, normalized=True
            )
            node_x, node_y = float(node_point.x), float(node_point.y)
    else:
        assert isinstance(decision, MintNode)
        writer.insert_node(
            batch.con,
            batch.nodes_table,
            batch.node_columns,
            node_id,
            decision.x,
            decision.y,
        )

    batch.nodes.created.append(node_id)
    batch.candidate_nodes.append(NodeCandidate(node_id=node_id, x=node_x, y=node_y))
    return node_id

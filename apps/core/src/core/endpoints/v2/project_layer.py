import logging
from typing import Any, Dict, List, Union
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, status
from pydantic import UUID4
from sqlmodel import select

from core.crud.crud_layer_project import layer_project as crud_layer_project
from core.crud.crud_layer_project_group import (
    layer_project_group as crud_layer_project_group,
)
from core.crud.crud_project import project as crud_project
from core.db.models._link_model import LayerProjectGroup, LayerProjectLink
from core.db.models.project import Project
from core.db.session import AsyncSession
from core.deps.auth import auth, auth_z
from core.endpoints.deps import get_db, get_user_id
from core.endpoints.v2.bundle import authorize_bundle
from core.schemas.project import (
    ICatalogUpdate,
    IFeatureStandardProjectRead,
    IFeatureStreetNetworkProjectRead,
    IFeatureToolProjectRead,
    ILayerProjectGroupRead,
    IRasterProjectRead,
    ITableProjectRead,
    ProjectLayerSearchPage,
)
from core.schemas.project import (
    request_examples as project_request_examples,
)
from core.services.processes import submit_each

logger = logging.getLogger("project_layer")

router = APIRouter()


async def require_project_editor(
    async_session: AsyncSession, project_id: UUID, user_id: UUID, refusal: str
) -> None:
    """404 for a trashed project, 403 unless the caller is its owner or an editor."""
    await crud_project.get_live_or_404(async_session, project_id)
    role = await crud_project.get_my_role(
        async_session, project_id=project_id, user_id=user_id
    )
    if role not in ("project-owner", "project-editor"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=refusal)


@router.post(
    "/{project_id}/layer",
    response_model=List[
        IFeatureStandardProjectRead
        | IFeatureToolProjectRead
        | IFeatureStreetNetworkProjectRead
        | ITableProjectRead
        | IRasterProjectRead
    ],
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def add_layers_to_project(
    async_session: AsyncSession = Depends(get_db),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project to get",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    layer_ids: List[UUID4] = Query(
        ...,
        description="List of layer IDs to add to the project",
        examples=[["3fa85f64-5717-4562-b3fc-2c963f66afa6"]],
    ),
    user_id: UUID = Depends(get_user_id),
) -> List[
    IFeatureStandardProjectRead
    | IFeatureToolProjectRead
    | IFeatureStreetNetworkProjectRead
    | ITableProjectRead
    | IRasterProjectRead
]:
    """Add layers to a project by its ID."""

    # 404 if the project itself is trashed.
    await require_project_editor(
        async_session,
        project_id,
        user_id,
        "Adding layers to a project requires editor access to the project",
    )

    # Add layers to project
    layers_project = await crud_layer_project.create(
        async_session=async_session,
        project_id=project_id,
        layer_ids=layer_ids,
        user_id=user_id,
    )
    assert isinstance(layers_project, List)

    return layers_project


#: The most layers one add-from-catalog request may create.
#:
#: A user picks datasets, but a dataset expands to the layers inside it — the
#: largest bundle in the catalog holds 429 — so what arrives here can be far
#: more than what was clicked. The cap is on the expanded count and is checked
#: before anything is promoted, because each layer costs a database write and a
#: materialize job: a tiling run on shared workers, which is what makes a large
#: batch everyone else's problem rather than just this request's.
#:
#: 25 admits 98.5% of the catalog's multi-layer datasets whole (3,077 of 3,125;
#: at 10 it would be 89.5%, at 100 99.9%), while keeping the worst case a user
#: can queue in one click to something the workers absorb. The remaining 48 have
#: to be added in parts.
MAX_CATALOG_LAYERS_PER_REQUEST = 25

#: Mirrors the ceiling `crud_layer_project.create` enforces, so the refusal
#: happens before the work rather than after it.
MAX_LAYERS_PER_PROJECT = 300


def catalog_batch_refusal(*, requested: int, existing: int) -> str | None:
    """Why this batch cannot go ahead, or None if it can.

    Checked up front: promoting first and refusing afterwards leaves the layers
    created and their tiling jobs queued for an add that returns an error and
    puts nothing in the project.
    """
    if requested > MAX_CATALOG_LAYERS_PER_REQUEST:
        return (
            f"{requested} layers is more than the {MAX_CATALOG_LAYERS_PER_REQUEST} "
            "a single request may add. Note that selecting a dataset adds every "
            "layer inside it. Add them in smaller batches."
        )
    if existing + requested >= MAX_LAYERS_PER_PROJECT:
        return (
            f"A project holds at most {MAX_LAYERS_PER_PROJECT} layers; this one "
            f"has {existing} and the request adds {requested}."
        )
    return None


@router.post(
    "/{project_id}/layer-catalog",
    response_model=List[
        IFeatureStandardProjectRead
        | IFeatureToolProjectRead
        | IFeatureStreetNetworkProjectRead
        | ITableProjectRead
        | IRasterProjectRead
    ],
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def add_catalog_items_to_project(
    async_session: AsyncSession = Depends(get_db),
    access_token: str = Depends(auth),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project to add the catalog items to",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    catalog_ids: List[str] = Query(
        ...,
        description="Catalog item IDs (STAC item ids) to add to the project",
    ),
    user_id: UUID = Depends(get_user_id),
) -> List[
    IFeatureStandardProjectRead
    | IFeatureToolProjectRead
    | IFeatureStreetNetworkProjectRead
    | ITableProjectRead
    | IRasterProjectRead
]:
    """Add catalog items to a project, promoting each on first use.

    Promote-on-use: an item already promoted at its current version resolves
    to the existing shared layer and only a project link is created; a first
    use creates the layer row (unowned — a catalog dataset belongs to the
    provider that published it — with data materialized asynchronously) and
    then links it.
    """
    # 404 if the project itself is trashed.
    await require_project_editor(
        async_session,
        project_id,
        user_id,
        "Adding layers to a project requires editor access to the project",
    )

    from goatlib.catalog.promote import (
        CatalogItemNotFoundError,
        read_items,
        resolve_item_ids,
        typed_datasets,
    )
    from starlette.concurrency import run_in_threadpool

    from core.services.catalog_promote import (
        bundle_versions_of,
        catalog_connection,
        catalog_mirror,
        promote_catalog_items,
        refuse_unaddable,
    )

    mirror = catalog_mirror()
    # What a user picks is a dataset; what promotes is a layer. A single-layer
    # dataset's Collection id is not its item's id, so the ids are resolved
    # against the mirror before anything is promoted.
    try:
        item_ids = await run_in_threadpool(resolve_item_ids, mirror, catalog_ids)
        # One scan for every item being added — and off the event loop, so a
        # mirror sized for a million rows does not stall every other core
        # request while it is read.
        items = await run_in_threadpool(read_items, mirror, item_ids)
        # A typed bundle (an XPlan plan) is added whole, as one shared bundle.
        typed = await run_in_threadpool(
            typed_datasets,
            mirror,
            {item["collection"] for item in items.values() if item.get("collection")},
        )
    except CatalogItemNotFoundError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    # Never a single member, nor some of them: only the plan itself.
    for catalog_id in catalog_ids:
        dataset = (items.get(catalog_id) or {}).get("collection")
        if dataset in typed and catalog_id != dataset:
            title = typed[dataset][1]
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"'{title}' is added whole, not layer by layer.",
            )
    refuse_unaddable(items, typed)
    # Each bundle version gets its own members, keyed by `bundle_version`.
    bundle_versions = bundle_versions_of(items, typed)

    # Bounded before the first promote: see `catalog_batch_refusal`.
    existing_layers = await crud_layer_project.count_by_project(
        async_session=async_session, project_id=project_id
    )
    # A bundle counts once toward the request size, its layers toward the project's.
    bundle_layers = sum(1 for item in items.values() if item.get("collection") in typed)
    refusal = catalog_batch_refusal(
        requested=len(item_ids) - bundle_layers + len(typed),
        existing=existing_layers + bundle_layers - len(typed),
    )
    if refusal:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=refusal)
    conn = await catalog_connection()
    try:
        promoted = await promote_catalog_items(
            conn,
            items,
            item_ids,
            mirror=mirror,
            typed=typed,
            bundle_versions=bundle_versions,
            project_id=project_id,
        )
    finally:
        await conn.close()

    # Enqueued server-side through the processes service (same path as bundle
    # import and layer/bundle-delete cleanup) so materialization finishes
    # whether or not the browser stays open. Best-effort: a processes hiccup
    # leaves the layer at status=pending, which the next add resolves, so it
    # must not fail the whole add. Once processes does not answer, the
    # remaining layers stay pending without another wait each.
    await submit_each(
        process_id="catalog_materialize",
        inputs=promoted.to_materialize,
        access_token=access_token,
    )

    layers_project = (
        await crud_layer_project.create(
            async_session=async_session,
            project_id=project_id,
            layer_ids=promoted.link_layer_ids,
            user_id=user_id,
        )
        if promoted.link_layer_ids
        else []
    )
    assert isinstance(layers_project, List)
    reused_link_ids = promoted.reused_link_ids
    for bundle_id, dataset in promoted.bundles.items():
        # A bundle already in the project: its entries if this add healed a copy, else 409.
        group_id = await async_session.scalar(
            select(LayerProjectGroup.id).where(
                LayerProjectGroup.project_id == project_id,
                LayerProjectGroup.bundle_id == bundle_id,
            )
        )
        if group_id is not None and dataset in promoted.healed_bundles:
            reused_link_ids += list(
                await async_session.scalars(
                    select(LayerProjectLink.id).where(
                        LayerProjectLink.layer_project_group_id == group_id
                    )
                )
            )
            continue
        _, members_project = await crud_layer_project_group.add_bundle(
            async_session,
            project_id=project_id,
            bundle_id=bundle_id,
            user_id=user_id,
        )
        layers_project = layers_project + members_project
    if reused_link_ids:
        layers_project = layers_project + await crud_layer_project.get_by_ids(
            async_session=async_session,
            ids=reused_link_ids,
            project_id=project_id,
            user_id=user_id,
        )
    return layers_project


@router.post(
    "/{project_id}/catalog-update",
    response_model=List[
        IFeatureStandardProjectRead
        | IFeatureToolProjectRead
        | IFeatureStreetNetworkProjectRead
        | ITableProjectRead
        | IRasterProjectRead
    ],
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def update_catalog_entry(
    async_session: AsyncSession = Depends(get_db),
    access_token: str = Depends(auth),
    project_id: UUID4 = Path(..., description="The ID of the project"),
    target: ICatalogUpdate = Body(...),
    user_id: UUID = Depends(get_user_id),
) -> List[
    IFeatureStandardProjectRead
    | IFeatureToolProjectRead
    | IFeatureStreetNetworkProjectRead
    | ITableProjectRead
    | IRasterProjectRead
]:
    """Move a catalog layer entry, or a catalog bundle group, to the catalog's
    newer version in place: same entries, same place, name, filter and styles."""
    from core.services.catalog_update import (
        update_catalog_bundle,
        update_catalog_layer,
    )

    await require_project_editor(
        async_session,
        project_id,
        user_id,
        "Updating layers requires editor access to the project",
    )
    if target.group_id is not None:
        link_ids = await update_catalog_bundle(
            async_session,
            project_id=project_id,
            group_id=target.group_id,
            user_id=user_id,
            access_token=access_token,
        )
    else:
        assert target.layer_project_id is not None
        link_ids = await update_catalog_layer(
            async_session,
            project_id=project_id,
            link_id=target.layer_project_id,
            user_id=user_id,
            access_token=access_token,
        )
    return await crud_layer_project.get_by_ids(
        async_session=async_session,
        ids=link_ids,
        project_id=project_id,
        user_id=user_id,
    )


@router.post(
    "/{project_id}/bundle/{bundle_id}",
    summary="Add a bundle to a project",
    response_model=ILayerProjectGroupRead,
    status_code=201,
    dependencies=[Depends(auth_z)],
)
async def add_bundle_to_project(
    async_session: AsyncSession = Depends(get_db),
    project_id: UUID4 = Path(..., description="The project to add the bundle to"),
    bundle_id: UUID4 = Path(..., description="The bundle to add"),
    user_id: UUID = Depends(get_user_id),
) -> ILayerProjectGroupRead:
    """Add a bundle to a project.

    Creates a bundle-backed layer group and places all of the bundle's member
    layers into it. The group's membership is locked (layers can't be dragged
    in/out or removed individually); removing the whole group removes the bundle
    from the project.
    """
    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    # Project write access is enforced by auth_z; the caller also needs at least
    # read access to the bundle.
    await authorize_bundle(async_session, bundle_id, user_id, "read")

    group, _ = await crud_layer_project_group.add_bundle(
        async_session, project_id=project_id, bundle_id=bundle_id, user_id=user_id
    )
    return group


@router.get(
    "/layers/search",
    summary="Search the layers of every project the caller can read",
    response_model=ProjectLayerSearchPage,
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def search_project_layers(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    search: str = Query(
        ...,
        min_length=2,
        max_length=200,
        description=(
            "Text the layer's name in the project, or its dataset's name, "
            "contains; case-insensitive, % and _ are taken literally"
        ),
    ),
    page: int = Query(1, ge=1, le=1000, description="Page number, at most 1000"),
    size: int = Query(20, ge=1, le=50, description="Hits per page, at most 50"),
) -> ProjectLayerSearchPage:
    """Find layers by name across every project the caller can read: own
    projects, projects shared with the caller directly, through a team or the
    organisation, or through a shared folder. Trashed projects and datasets
    are left out. Returns names and IDs only, never the data; a layer locked
    in the project's layer list shows no more here."""
    term = search.strip()
    if len(term) < 2:
        raise HTTPException(
            status_code=422, detail="search needs at least 2 characters besides spaces"
        )
    return await crud_layer_project.search(
        async_session, user_id=user_id, search=term, page=page, size=size
    )


@router.get(
    "/{project_id}/layer",
    response_model=list,
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def get_layers_from_project(
    async_session: AsyncSession = Depends(get_db),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project to get",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    user_id: UUID = Depends(get_user_id),
) -> List[
    IFeatureStandardProjectRead
    | IFeatureToolProjectRead
    | IFeatureStreetNetworkProjectRead
    | ITableProjectRead
    | IRasterProjectRead
]:
    """Get layers from a project by its ID.

    A layer the caller has no access to of his own — reachable here only
    through a non-shareable link (D7) — is listed as `locked`, without the
    style, filter and preference payload the map and data table read.
    """

    # 404 if the project itself is trashed — a soft delete must not
    # be worked around by reading its layer list directly.
    await crud_project.get_live_or_404(async_session, project_id)

    # Get all layers from project
    layers_project = await crud_layer_project.get_layers(
        async_session,
        project_id=project_id,
        user_id=user_id,
    )
    assert isinstance(layers_project, List)

    return layers_project


@router.get(
    "/{project_id}/layer/{layer_project_id}",
    response_model=IFeatureStandardProjectRead
    | IFeatureToolProjectRead
    | IFeatureStreetNetworkProjectRead
    | ITableProjectRead
    | IRasterProjectRead,
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def get_layer_from_project(
    async_session: AsyncSession = Depends(get_db),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project to get",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    layer_project_id: int = Path(
        ...,
        description="Layer project ID to get",
        examples=["1"],
    ),
    user_id: UUID = Depends(get_user_id),
) -> Union[
    IFeatureStandardProjectRead
    | IFeatureToolProjectRead
    | IFeatureStreetNetworkProjectRead
    | ITableProjectRead
    | IRasterProjectRead
]:
    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    # Scoped to the project in the path — `auth_z` only checked the caller's
    # role on THAT project, so a link id naming another project's link is not
    # found here. Same locking as the layer list on top of that: reading one
    # row must not hand out the style and filter of a dataset the caller has
    # no access to (D7).
    rows = await crud_layer_project.get_by_ids(
        async_session,
        ids=[layer_project_id],
        project_id=project_id,
        user_id=user_id,
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Layer project relation not found",
        )
    layer_project = rows[0]
    assert isinstance(
        layer_project,
        (
            IFeatureStandardProjectRead,
            IFeatureToolProjectRead,
            IFeatureStreetNetworkProjectRead,
            ITableProjectRead,
            IRasterProjectRead,
        ),
    )

    return layer_project


@router.put(
    "/{project_id}/layer/{layer_project_id}",
    response_model=IFeatureStandardProjectRead
    | IFeatureToolProjectRead
    | IFeatureStreetNetworkProjectRead
    | ITableProjectRead
    | IRasterProjectRead,
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def update_layer_in_project(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project to get",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    layer_project_id: int = Path(
        ...,
        description="Layer Project ID to update",
        examples=["1"],
    ),
    layer_in: Dict[str, Any] = Body(
        ...,
        examples=[project_request_examples["update_layer"]],
        description="Layer to update",
    ),
) -> Union[
    IFeatureStandardProjectRead
    | IFeatureToolProjectRead
    | IFeatureStreetNetworkProjectRead
    | ITableProjectRead
    | IRasterProjectRead
]:
    """Update layer in a project by its ID.

    The link is looked up by both ids, so a `layer_project_id` belonging to
    another project 404s: `auth_z` only checked the caller's role on the
    project in the path.

    Project write is enough to reach this route, so the caller may be someone
    the link is LOCKED for — a layer added by a member who could not share it
    (D7). `crud_layer_project.update` refuses those with 403 and builds its
    response through the same read path as `GET /project/{id}/layer`.
    """

    # 404 if the project itself is trashed — checked
    # before the mutation below, not after.
    await crud_project.get_live_or_404(async_session, project_id)

    # NOTE: Avoid getting layer_id from layer_in as the authorization is running against the query params.

    # Update layer in project
    layer_project: (
        IFeatureStandardProjectRead
        | IFeatureToolProjectRead
        | IFeatureStreetNetworkProjectRead
        | ITableProjectRead
        | IRasterProjectRead
    ) = await crud_layer_project.update(
        async_session=async_session,
        id=layer_project_id,
        layer_in=layer_in,
        project_id=project_id,
        user_id=user_id,
    )

    # Update the last updated at of the project
    # Get project to update it
    project = await crud_project.get(async_session, id=project_id)

    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Project not found"
        )

    # Update project updated_at
    await crud_project.update(
        async_session,
        db_obj=project,
        obj_in={"updated_at": layer_project.updated_at},
    )

    # Get layers in project
    return layer_project


@router.delete(
    "/{project_id}/layer",
    response_model=None,
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def delete_layer_from_project(
    async_session: AsyncSession = Depends(get_db),
    project_id: UUID4 = Path(
        ...,
        description="The ID of the project",
        examples=["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ),
    layer_project_id: int = Query(
        ...,
        description="Layer ID to delete",
        examples=["1"],
    ),
) -> None:
    """Delete layer from a project by its ID.

    The link is looked up by both ids, so a `layer_project_id` belonging to
    another project 404s: `auth_z` only checked the caller's role on the
    project in the path.
    """

    # 404 if the project itself is trashed.
    await crud_project.get_live_or_404(async_session, project_id)

    # Get layer project
    layer_project = await crud_layer_project.get_in_project(
        async_session, id=layer_project_id, project_id=project_id
    )
    if layer_project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Layer project relation not found",
        )
    assert type(layer_project) is LayerProjectLink
    assert isinstance(layer_project.id, int)

    # Layers belonging to a bundle-backed group can't be removed individually —
    # the bundle is the unit; remove the whole group instead.
    if layer_project.layer_project_group_id is not None:
        group = await async_session.get(
            LayerProjectGroup, layer_project.layer_project_group_id
        )
        if group is not None and group.bundle_id is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "Layers in a bundle can't be removed individually; "
                    "remove the bundle from the project instead."
                ),
            )

    # Delete layer from project
    await crud_layer_project.delete(
        db=async_session,
        id=layer_project.id,
    )

    # Delete layer from project layer order
    project = await crud_project.get(async_session, id=project_id)

    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Project not found"
        )
    assert type(project) is Project

    # layer_order may be None (e.g. copied projects whose source had no order),
    # so treat it as empty and only remove the id if present.
    layer_order = list(project.layer_order or [])
    if layer_project.id in layer_order:
        layer_order.remove(layer_project.id)

    await crud_project.update(
        async_session,
        db_obj=project,
        obj_in={"layer_order": layer_order},
    )

    return None

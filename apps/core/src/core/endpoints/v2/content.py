from typing import get_args
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi_pagination import Params as PaginationParams
from pydantic import UUID4

from core.crud.crud_content import content as crud_content
from core.crud.crud_trash import trash as crud_trash
from core.db.session import AsyncSession
from core.deps.auth import auth_z
from core.endpoints.deps import get_db, get_user_id
from core.schemas.content import (
    ContentOrder,
    ContentOrderBy,
    ContentPage,
    ContentSearchPage,
    ContentSearchType,
    ContentView,
    ResourceType,
    RestoreRequest,
    RestrictedUpdate,
    TrashItem,
)

router = APIRouter()


@router.get(
    "",
    summary="Unified content feed",
    response_model=ContentPage,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def read_content(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    view: ContentView = Query(
        "space", description="space | shared_with_me | shared_with_space | recent"
    ),
    space_id: UUID | None = Query(
        None,
        description="Required for view=space and view=shared_with_space; "
        "the space (or folder in it) to list",
    ),
    folder_id: UUID | None = Query(
        None,
        description="Only for view=space — the folder to list; omit for the space root",
    ),
    types: str | None = Query(
        None, description="Comma-separated: folder,project,layer,bundle"
    ),
    search: str | None = Query(None),
    order_by: ContentOrderBy = Query(
        "updated_at", description="updated_at | created_at | name | last_opened_at"
    ),
    order: ContentOrder = Query("descendent", description="ascendent | descendent"),
    page_params: PaginationParams = Depends(),
) -> ContentPage:
    """List a space (or a folder inside it), "shared with me", "shared with
    a team/organisation space" or "recent" — one feed backing the Content
    page. `view=space` sorts by section first (folders, shortcuts, projects,
    templates, datasets), then by `order_by`; every row carries the
    caller's `effective_role` as `my_role`. See `CRUDContent.list`.
    """
    type_list = [t.strip() for t in types.split(",") if t.strip()] if types else None
    return await crud_content.list(
        async_session,
        user_id=user_id,
        view=view,
        space_id=space_id,
        folder_id=folder_id,
        search=search,
        types=type_list,
        order_by=order_by,
        order=order,
        page=page_params.page,
        size=page_params.size,
    )


#: Every kind the search finds, in the order `types` lists them.
SEARCH_TYPES: tuple[ContentSearchType, ...] = get_args(ContentSearchType)


@router.get(
    "/search",
    summary="Search everything the caller can open",
    response_model=ContentSearchPage,
    response_model_exclude_none=True,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def search_content(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    search: str = Query(
        ...,
        min_length=2,
        max_length=200,
        description=(
            "Text the item's name, its project's name (workflows and layouts), "
            "a folder it sits in or its owner's name contains; case-insensitive, "
            "% and _ are taken literally"
        ),
    ),
    types: str | None = Query(
        None,
        description="Comma-separated: project,layer,bundle,workflow,layout; "
        "all of them when left out",
    ),
    page: int = Query(1, ge=1, le=1000, description="Page number, at most 1000"),
    size: int = Query(20, ge=1, le=50, description="Hits per page, at most 50"),
) -> ContentSearchPage:
    """Find projects, datasets and the workflows and print layouts of
    projects across everything the caller can open: their own, shared with
    them directly, through a team or the organisation, or through a shared
    folder, in every space. Each hit says why it matched, who owns it and
    where it sits. Trashed items and template sources are left out."""
    term = search.strip()
    if len(term) < 2:
        raise HTTPException(
            status_code=422, detail="search needs at least 2 characters besides spaces"
        )
    wanted = [t.strip() for t in types.split(",") if t.strip()] if types else []
    unknown = sorted(set(wanted) - set(SEARCH_TYPES))
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"unknown types {unknown}; choose from {list(SEARCH_TYPES)}",
        )
    return await crud_content.search(
        async_session,
        user_id=user_id,
        search=term,
        types=[t for t in SEARCH_TYPES if not wanted or t in wanted],
        page=page,
        size=size,
    )


@router.get(
    "/trash",
    summary="List trashed items the caller may restore",
    response_model=list[TrashItem],
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def read_trash(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    space_id: UUID = Query(..., description="The space to list trash for"),
) -> list[TrashItem]:
    """List the trashed folders/projects/layers/bundles in this space the
    caller may restore — space owner/admin only, per `effective_role`."""
    # Assigned to an explicitly-typed local first: mypy cannot otherwise infer
    # the return type of a method literally named `list` across module
    # boundaries (it shadows the builtin `list` in attribute lookup).
    items: list[TrashItem] = await crud_trash.list(
        async_session, user_id=user_id, space_id=space_id
    )
    return items


@router.post(
    "/restore",
    summary="Restore trashed items",
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def restore_content(
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    body: RestoreRequest = Body(...),
) -> None:
    """Restore one or more trashed items — for a folder, its whole subtree."""
    await crud_trash.restore(
        async_session,
        user_id=user_id,
        items=[(item.type, item.id) for item in body.items],
    )
    return None


@router.patch(
    "/{resource_type}/{resource_id}/restricted",
    summary="Restrict or un-restrict a folder or item (space owner/admin only)",
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def set_restricted(
    resource_type: ResourceType,
    resource_id: UUID,
    body: RestrictedUpdate = Body(...),
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
) -> None:
    """Mark a folder or item Restricted, or lift it (D9).

    A restricted folder or item withholds the space default role from the
    space's members — everything below a restricted folder is closed too.
    Grants still reach it, and its space owner/admin always does.
    """
    await crud_content.set_restricted(
        async_session,
        user_id=user_id,
        resource_type=resource_type,
        resource_id=resource_id,
        restricted=body.restricted,
    )
    return None

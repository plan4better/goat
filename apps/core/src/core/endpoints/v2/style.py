"""GOAT Style routes (spec 10 and 13.1): the named styles of a project layer
and the dataset's default style.

Edit rights are the project's for named styles and the dataset's for its default.
Every error a style operation answers carries `{"detail": {"code": ...}}`; the
browser's save loop reads the code (spec 13.1).
"""

import hashlib
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
    status,
)
from pydantic import UUID4

from core.core import authz
from core.crud.crud_layer_project import layer_project as crud_layer_project
from core.crud.crud_project import project as crud_project
from core.db.models._link_model import LayerProjectLink
from core.db.session import AsyncSession
from core.deps.auth import auth, auth_z
from core.endpoints.deps import get_db, get_user_id
from core.schemas.style import (
    DefaultStyleWrite,
    GroupMapState,
    LayerMapState,
    MapResponse,
    StyleCheckRequest,
    StyleCheckResult,
    StyleCreate,
    StyleRead,
    StyleSaveRequest,
    StyleUpdate,
)
from core.services import style as style_service
from core.services.map_document import (
    map_for_project,
    published_styles_differ,
    write_group_map_state,
    write_layer_map_state,
)
from core.services.style import StyleSaveError, issues_json

router = APIRouter()

NAMED = "/project/{project_id}/layer/{layer_project_id}/style"
ONE = NAMED + "/{style_id}"


def access(
    resource: Literal["project", "layer"], action: Literal["read", "write"]
) -> Callable[..., Awaitable[None]]:
    """A dependency that runs before `auth_z` and answers what the save loop needs
    (spec 13.1): 401 only for a missing or invalid token, 403 `forbidden` when the
    caller's role on the project (or dataset) is too low for `action`, 404
    `not_found` when the caller cannot reach it at all, so its existence stays
    hidden. `auth_z` turns every refusal into 401, which the browser answers by
    renewing the session and retrying."""
    path_key = f"{resource}_id"

    async def check(
        request: Request,
        session: AsyncSession = Depends(get_db),
        _token: str = Depends(auth),
        user_id: UUID = Depends(get_user_id),
    ) -> None:
        resource_id = UUID(request.path_params[path_key])
        role = await authz.effective_role(session, resource, resource_id, user_id)
        if role is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        if action == "write" and role == "viewer":
            raise HTTPException(status_code=403, detail={"code": "forbidden"})

    check.__name__ = f"{resource}_{action}_access"
    return check


PROJECT_READ = [Depends(access("project", "read")), Depends(auth_z)]
PROJECT_WRITE = [Depends(access("project", "write")), Depends(auth_z)]
LAYER_READ = [Depends(access("layer", "read")), Depends(auth_z)]
LAYER_WRITE = [Depends(access("layer", "write")), Depends(auth_z)]


@asynccontextmanager
async def answering() -> AsyncIterator[None]:
    """A StyleSaveError as its status with `{"detail": {"code": ...}}`."""
    try:
        yield
    except StyleSaveError as error:
        raise HTTPException(status_code=error.status, detail={"code": error.code})


async def project_layer(
    session: AsyncSession, project_id: UUID, layer_project_id: int, user_id: UUID
) -> LayerProjectLink:
    """The project layer of a live project, looked up by both ids (404 otherwise).

    `auth_z` checked the caller's role on the project in the path only. A link the
    caller has no access to of his own is LOCKED (D7): its styles are refused.
    """
    await crud_project.get_live_or_404(session, project_id)
    link = await crud_layer_project.get_in_project(
        session, id=layer_project_id, project_id=project_id
    )
    if link is None:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    locked = await crud_layer_project.locked_by_layer_id(
        session, user_id, link_ids=[layer_project_id]
    )
    if locked.get(link.layer_id):
        raise HTTPException(status_code=403, detail={"code": "locked"})
    return link


@router.post(NAMED, response_model=StyleRead, dependencies=PROJECT_WRITE)
async def create_style(
    body: StyleCreate,
    project_id: UUID4 = Path(...),
    layer_project_id: int = Path(...),
    session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
) -> StyleRead:
    """A new named style: a copy of `copy_from`, else of the active style, else of
    the dataset default, else the default style (at most 10 per project layer)."""
    link = await project_layer(session, project_id, layer_project_id, user_id)
    async with answering():
        return await style_service.create_style(
            session,
            layer_project_id=layer_project_id,
            layer_id=link.layer_id,
            name=body.name,
            copy_from=body.copy_from,
            actor_id=user_id,
        )


@router.get(ONE, response_model=StyleRead, dependencies=PROJECT_READ)
async def read_style(
    project_id: UUID4 = Path(...),
    layer_project_id: int = Path(...),
    style_id: UUID4 = Path(...),
    check: bool = Query(False, description="Also report the stored style's issues"),
    session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    access_token: str = Depends(auth),
) -> StyleRead:
    """One style; recomputed first when its data changed (spec 12). `check` (the
    panel opening) adds its issues, `damaged` ones included, and stores nothing."""
    await project_layer(session, project_id, layer_project_id, user_id)
    async with answering():
        stored = await style_service.read_named(session, style_id, layer_project_id)
        return await style_service.read_style(
            session, stored, access_token=access_token, check=check
        )


@router.put(ONE, response_model=StyleRead, dependencies=PROJECT_WRITE)
async def save_style(
    body: StyleSaveRequest,
    project_id: UUID4 = Path(...),
    layer_project_id: int = Path(...),
    style_id: UUID4 = Path(...),
    session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    access_token: str = Depends(auth),
) -> StyleRead:
    """Saves the whole document (spec 13.1): merged onto the stored one when it is
    based on an older revision, checked, stored in one conditional write."""
    await project_layer(session, project_id, layer_project_id, user_id)
    async with answering():
        await style_service.read_named(session, style_id, layer_project_id)
        return await style_service.save_style(
            session,
            style_id=style_id,
            base_rev=body.base_rev,
            document=body.document,
            actor_id=user_id,
            access_token=access_token,
        )


@router.patch(ONE, response_model=StyleRead, dependencies=PROJECT_WRITE)
async def update_style(
    body: StyleUpdate,
    project_id: UUID4 = Path(...),
    layer_project_id: int = Path(...),
    style_id: UUID4 = Path(...),
    session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
) -> StyleRead:
    """Renames a style or moves it among the project layer's styles."""
    await project_layer(session, project_id, layer_project_id, user_id)
    async with answering():
        stored = await style_service.read_named(session, style_id, layer_project_id)
        return await style_service.update_style(
            session, stored, name=body.name, position=body.position
        )


@router.delete(ONE, status_code=status.HTTP_204_NO_CONTENT, dependencies=PROJECT_WRITE)
async def delete_style(
    project_id: UUID4 = Path(...),
    layer_project_id: int = Path(...),
    style_id: UUID4 = Path(...),
    session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
) -> Response:
    """Deletes a style; a project layer keeps at least one."""
    await project_layer(session, project_id, layer_project_id, user_id)
    async with answering():
        stored = await style_service.read_named(session, style_id, layer_project_id)
        await style_service.delete_style(session, stored)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(ONE + "/check", response_model=StyleCheckResult, dependencies=PROJECT_READ)
async def check_style(
    body: StyleCheckRequest,
    project_id: UUID4 = Path(...),
    layer_project_id: int = Path(...),
    style_id: UUID4 = Path(...),
    session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    access_token: str = Depends(auth),
) -> StyleCheckResult:
    """The save's checks on the stored document, or the one given; nothing is stored."""
    await project_layer(session, project_id, layer_project_id, user_id)
    async with answering():
        stored = await style_service.read_named(session, style_id, layer_project_id)
        document, issues = await style_service.check_style(
            stored, body.document, access_token
        )
    return StyleCheckResult(document=document, issues=issues_json(issues))


@router.post(
    ONE + "/set-as-default", response_model=StyleRead, dependencies=PROJECT_WRITE
)
async def set_as_default(
    project_id: UUID4 = Path(...),
    layer_project_id: int = Path(...),
    style_id: UUID4 = Path(...),
    session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    access_token: str = Depends(auth),
) -> StyleRead:
    """Copies the style over the dataset's default style; needs edit rights on the dataset."""
    link = await project_layer(session, project_id, layer_project_id, user_id)
    async with answering():
        stored = await style_service.read_named(session, style_id, layer_project_id)
        if not await authz.can(session, "layer", link.layer_id, user_id, "write"):
            raise StyleSaveError(403, "forbidden")
        return await style_service.write_default(
            session,
            layer_id=link.layer_id,
            document=stored.document,
            actor_id=user_id,
            access_token=access_token,
        )


@router.get(
    "/layer/{layer_id}/style", response_model=StyleRead, dependencies=LAYER_READ
)
async def read_default_style(
    layer_id: UUID4 = Path(...),
    check: bool = Query(False, description="Also report the stored style's issues"),
    session: AsyncSession = Depends(get_db),
    access_token: str = Depends(auth),
) -> StyleRead:
    """The dataset's default style; recomputed first when its data changed."""
    async with answering():
        stored = await style_service.read_default(session, layer_id)
        return await style_service.read_style(
            session, stored, access_token=access_token, check=check
        )


@router.put(
    "/layer/{layer_id}/style", response_model=StyleRead, dependencies=LAYER_WRITE
)
async def write_default_style(
    body: DefaultStyleWrite,
    layer_id: UUID4 = Path(...),
    session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
    access_token: str = Depends(auth),
) -> StyleRead:
    """Replaces the dataset's default style whole; a catalog layer's is read only."""
    async with answering():
        return await style_service.write_default(
            session,
            layer_id=layer_id,
            document=body.document,
            actor_id=user_id,
            access_token=access_token,
        )


@router.get(
    "/project/{project_id}/map",
    response_model=MapResponse,
    responses={304: {"description": "The map did not change (`If-None-Match`)"}},
    dependencies=PROJECT_READ,
)
async def read_map(
    request: Request,
    project_id: UUID4 = Path(...),
    session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
) -> Response:
    """The map document, the active style of every layer and the names of the
    others, in one request (spec 13.2); `304` when the ETag still matches."""
    await crud_project.get_live_or_404(session, project_id)
    result = await map_for_project(session, project_id=project_id, user_id=user_id)
    result.unpublished = await published_styles_differ(session, project_id)
    body = result.model_dump_json()
    etag = f'"{hashlib.sha256(body.encode()).hexdigest()[:32]}"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)


@router.patch(
    "/project/{project_id}/layer/{layer_project_id}/map-state",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=PROJECT_WRITE,
)
async def write_layer_state(
    body: LayerMapState,
    project_id: UUID4 = Path(...),
    layer_project_id: int = Path(...),
    session: AsyncSession = Depends(get_db),
    user_id: UUID = Depends(get_user_id),
) -> Response:
    """A project layer's map state: shown, active style, position, time, legend."""
    await project_layer(session, project_id, layer_project_id, user_id)
    async with answering():
        await write_layer_map_state(
            session, layer_project_id=layer_project_id, state=body
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch(
    "/project/{project_id}/group/{group_id}/map-state",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=PROJECT_WRITE,
)
async def write_group_state(
    body: GroupMapState,
    project_id: UUID4 = Path(...),
    group_id: int = Path(...),
    session: AsyncSession = Depends(get_db),
) -> Response:
    """A layer group's visibility."""
    await crud_project.get_live_or_404(session, project_id)
    async with answering():
        await write_group_map_state(
            session, project_id=project_id, group_id=group_id, state=body
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)

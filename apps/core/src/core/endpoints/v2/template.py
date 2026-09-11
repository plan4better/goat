"""Template Endpoints (T1, T2, T4-T6, T8): preview, save, list, read, patch,
delete, refresh."""

from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Query
from pydantic import UUID4

from core.crud.crud_template import template as crud_template
from core.db.session import AsyncSession
from core.deps.auth import auth_z, require_superuser
from core.deps.auth import user_token as get_user_token
from core.endpoints.deps import get_db, get_user_id
from core.schemas.template import (
    TemplateCategoryFacet,
    TemplateCreate,
    TemplateGrantCreate,
    TemplateGrantRead,
    TemplateGrantsResponse,
    TemplatePage,
    TemplatePreview,
    TemplatePreviewRequest,
    TemplateRead,
    TemplateUpdate,
    TemplateUseRequest,
    TemplateUseResult,
)

router = APIRouter()


@router.post(
    "/preview",
    summary="Preview a template save",
    response_model=TemplatePreview,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def preview_template(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    req: TemplatePreviewRequest = Body(...),
) -> TemplatePreview:
    """Detect what saving `req.source` into `req.folder_id` would produce,
    without writing anything: the dataset references it would declare as
    inputs (T5), the kind badges it would carry (T1), and which shipped
    datasets are not yet readable by the destination space's audience
    (T6). Requires read on the source project and write on `folder_id`.
    """
    return await crud_template.preview(async_session, req=req, user_id=user_id)


@router.post(
    "",
    summary="Save a template",
    response_model=TemplateRead,
    status_code=201,
    dependencies=[Depends(auth_z)],
)
async def create_template(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    obj_in: TemplateCreate = Body(...),
) -> TemplateRead:
    """Save a template (T8): re-reads the source config, validates
    `inputs` against what is actually detected there (422 on mismatch),
    freezes the payload (workflow/layout) or makes a hidden frozen project
    copy (T2), and writes any T6 viewer grants for `share_datasets`.
    Requires read on the source project and write on `folder_id`.
    """
    return await crud_template.create(async_session, user_id=user_id, obj_in=obj_in)


@router.get(
    "",
    summary="List templates",
    response_model=TemplatePage,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def list_templates(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    space_id: UUID | None = Query(None, description="Restrict to one space"),
    folder_id: UUID | None = Query(None, description="Restrict to one folder"),
    source: Literal["all", "goat", "mine", "team", "org"] = Query(
        "all", description="goat | mine | team | org | all"
    ),
    kind: Literal["workflow", "dashboard", "layout"] | None = Query(
        None, description="workflow | dashboard | layout"
    ),
    search: str | None = Query(None),
    categories: str | None = Query(
        None,
        description="Comma-separated categories; a template matches only when "
        "it carries every one of them (compared case-insensitively).",
    ),
    source_project_id: UUID | None = Query(
        None,
        description="Only templates saved from this project (source_ref.project_id)",
    ),
    source_workflow_id: UUID | None = Query(
        None,
        description="Only templates saved from this workflow (source_ref.workflow_id)",
    ),
    source_layout_id: UUID | None = Query(
        None, description="Only templates saved from this layout (source_ref.layout_id)"
    ),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
) -> TemplatePage:
    """List the caller's readable templates (T3/T4): `source=goat` is the
    published catalog shelf; `mine`/`team`/`org` are the caller's own
    spaces of that kind; `all` unions every scope. Every returned row
    passes `effective_role IS NOT NULL`.
    """
    return await crud_template.list_templates(
        async_session,
        user_id=user_id,
        space_id=space_id,
        folder_id=folder_id,
        source=source,
        kind=kind,
        search=search,
        categories=categories,
        source_project_id=source_project_id,
        source_workflow_id=source_workflow_id,
        source_layout_id=source_layout_id,
        page=page,
        size=size,
    )


@router.get(
    "/categories",
    summary="List the categories in use on readable templates",
    response_model=list[TemplateCategoryFacet],
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def list_template_categories(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    source: Literal["all", "goat", "mine", "team", "org"] = Query(
        "all", description="goat | mine | team | org | all"
    ),
    kind: Literal["workflow", "dashboard", "layout"] | None = Query(
        None, description="workflow | dashboard | layout"
    ),
) -> list[TemplateCategoryFacet]:
    """The categories in use on the caller's readable templates, with a
    count each — the facet behind the template browser's tag filter and the
    save dialog's tag autocomplete. `source`/`kind` narrow the same way they
    do on `GET /template`, so the counts describe exactly what that request
    would list. Grouped case-insensitively ("Mobility" and "mobility" are
    one row, named after whichever template used the spelling first),
    ordered by count descending, then name.
    """
    return await crud_template.list_categories(
        async_session, user_id=user_id, source=source, kind=kind
    )


@router.get(
    "/{template_id}",
    summary="Read a template",
    response_model=TemplateRead,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def read_template(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    template_id: UUID4,
    include_config: bool = Query(
        False, description="Include the frozen config (owner/editor only)"
    ),
) -> TemplateRead:
    """Read one template. 404 if it does not exist (or is soft-deleted),
    403 if the caller cannot read it. `include_config=true` also returns
    the frozen workflow/layout `config`, for an owner/editor caller only —
    a project payload's config lives on its frozen source project instead.
    """
    return await crud_template.get(
        async_session,
        template_id=template_id,
        user_id=user_id,
        include_config=include_config,
    )


@router.patch(
    "/{template_id}",
    summary="Update a template's metadata",
    response_model=TemplateRead,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def update_template(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    template_id: UUID4,
    obj_in: TemplateUpdate = Body(...),
) -> TemplateRead:
    """Update name/description/categories/thumbnail, or move the template to
    another folder in its own space (`folder_id`; `None` leaves it in
    place). Owner or editor only — the payload itself only changes through
    `refresh`. 404 if `folder_id` names a folder that does not exist, is
    trashed, or belongs to a different space; 403 if the caller lacks write
    on that destination folder (write on the template alone is not enough)."""
    return await crud_template.update(
        async_session, template_id=template_id, user_id=user_id, obj_in=obj_in
    )


@router.delete(
    "/{template_id}",
    summary="Delete a template",
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def delete_template(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    template_id: UUID4,
) -> None:
    """Soft-delete a template (owner only). A project payload's frozen
    source copy is soft-deleted along with it."""
    await crud_template.delete(async_session, template_id=template_id, user_id=user_id)


@router.post(
    "/{template_id}/use",
    summary="Use a template",
    response_model=TemplateUseResult,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def use_template(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    template_id: UUID4,
    req: TemplateUseRequest = Body(...),
) -> TemplateUseResult:
    """Use a template (T7). A project payload copies its frozen source
    into `target_folder_id` (any space, via `copy_project`). A
    workflow/layout payload is created into `project_id` if given, else
    into a new project created in `target_folder_id` with the same
    default view state `useHomeCreate` seeds a fresh project with; for a
    workflow, every shipped dataset the caller may read is linked into
    that project (an existing link is reused, a new one is grouped under
    the template's name) and `bindings` overrides or fills the rest.
    Nothing is executed. Requires read on the template and write on the
    target (`project_id` or `target_folder_id`).
    """
    return await crud_template.use(
        async_session, template_id=template_id, user_id=user_id, req=req
    )


@router.post(
    "/{template_id}/refresh",
    summary="Re-snapshot a template from its source",
    response_model=TemplateRead,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def refresh_template(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    template_id: UUID4,
) -> TemplateRead:
    """Re-snapshot a template's payload from its recorded source (owner
    only). 409 when the source workflow/layout/project no longer exists.
    For a workflow payload, `inputs` is reconciled against the fresh
    config (a newly-detected dataset node defaults to "ask"); a
    reconciled ship input that would now need a share into the template's
    own space is never auto-granted, only reported back in
    `datasets_needing_share` (T6)."""
    return await crud_template.refresh(
        async_session, template_id=template_id, user_id=user_id
    )


def _is_superuser(user_token: dict[str, Any]) -> bool:
    return "superuser" in (user_token.get("realm_access", {}).get("roles") or [])


@router.post(
    "/{template_id}/publish",
    summary="Publish a template to the GOAT catalog (superuser only)",
    response_model=TemplateRead,
    status_code=200,
    dependencies=[Depends(auth_z), Depends(require_superuser)],
)
async def publish_template(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    token: dict[str, Any] = Depends(get_user_token),
    template_id: UUID4,
) -> TemplateRead:
    """Publish a template to the GOAT catalog shelf (T4). Only callers with
    the `superuser` realm role may call this; v1 only supports the
    `none` -> `published` transition. 409 (`template_dataset_not_public`)
    when a shipped input is not (or no longer) a catalog dataset.
    """
    return await crud_template.publish(
        async_session,
        template_id=template_id,
        user_id=user_id,
        is_superuser=_is_superuser(token),
    )


@router.post(
    "/{template_id}/unpublish",
    summary="Unpublish a template from the GOAT catalog (superuser only)",
    response_model=TemplateRead,
    status_code=200,
    dependencies=[Depends(auth_z), Depends(require_superuser)],
)
async def unpublish_template(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    token: dict[str, Any] = Depends(get_user_token),
    template_id: UUID4,
) -> TemplateRead:
    """Unpublish a template from the GOAT catalog shelf (T4): `catalog_status`
    back to `none`. Only callers with the `superuser` realm role may call
    this."""
    return await crud_template.unpublish(
        async_session,
        template_id=template_id,
        user_id=user_id,
        is_superuser=_is_superuser(token),
    )


@router.get(
    "/{template_id}/grant",
    summary="List a template's grants",
    response_model=TemplateGrantsResponse,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def list_template_grants(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    template_id: UUID4,
) -> TemplateGrantsResponse:
    """List the direct grants on a template (T3/T6). Requires write
    (editor+) — a published template's blanket shelf viewer is not enough
    to see who else has a grant on it."""
    return await crud_template.list_grants(
        async_session, template_id=template_id, user_id=user_id
    )


@router.post(
    "/{template_id}/grant",
    summary="Add or update a grant on a template",
    response_model=TemplateGrantRead,
    status_code=201,
    dependencies=[Depends(auth_z)],
)
async def create_template_grant(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    template_id: UUID4,
    obj_in: TemplateGrantCreate = Body(...),
) -> TemplateGrantRead:
    """Grant `template-viewer` or `template-editor` on a template to a user,
    team, or organization (T3/T6). Owner only. A second grant for the same
    grantee replaces its role rather than adding a duplicate."""
    return await crud_template.add_grant(
        async_session, template_id=template_id, user_id=user_id, obj_in=obj_in
    )


@router.delete(
    "/{template_id}/grant/{grant_id}",
    summary="Remove a grant from a template",
    status_code=204,
    dependencies=[Depends(auth_z)],
)
async def delete_template_grant(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    template_id: UUID4,
    grant_id: UUID4,
) -> None:
    """Remove a grant from a template (T3/T6). Owner only."""
    await crud_template.delete_grant(
        async_session, template_id=template_id, user_id=user_id, grant_id=grant_id
    )

"""Which layer a "Save as dataset" node overwrites when its workflow re-runs.

Reported 2026-09-24: after a project duplicate, a project template, or a run
by another member of a shared project, "Overwrite on re-run" added a second
layer instead of replacing the first. The target was keyed on (runner,
workflow id, export node id); every copy path gives the workflow a new id
while the copy's project entries keep pointing at the same layer rows, and a
co-editor is a different runner.

Each scenario builds its rows through core's real copy paths and asks
goatlib's resolver, which finalize_layer calls, where the next run writes.
"""

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any
from uuid import UUID

import asyncpg
import pytest
import pytest_asyncio
from core.core.config import settings
from core.crud.crud_project_copy import copy_project
from core.crud.crud_template import template as crud_template
from core.crud.crud_workflow import workflow as crud_workflow
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.project import Project
from core.db.models.user import User
from core.db.models.workflow import Workflow
from core.schemas.template import TemplateCreate, TemplateSource, TemplateUseRequest
from goatlib.tools.authz import authorize_workflow_export
from goatlib.tools.db import ToolDatabaseService
from goatlib.tools.workflow_dataset_nodes import (
    current_layer_ids,
    retarget_dataset_nodes,
)
from goatlib.tools.workflow_export_target import (
    ExportTarget,
    claim_link,
    export_lock,
    resolve_export_target,
    restamp_layer,
)
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA
NODE = "export-3b0c6a2e-5d1f-4c1b-9a51-0d8f2c7e4a10"

MakeUser = Callable[..., Awaitable[User]]
MakeFolder = Callable[..., Awaitable[Folder]]
MakeLayer = Callable[..., Awaitable[Layer]]
MakeProject = Callable[..., Awaitable[Project]]


async def _connect() -> asyncpg.Connection:
    assert settings.ASYNC_SQLALCHEMY_DATABASE_URI is not None
    url = make_url(settings.ASYNC_SQLALCHEMY_DATABASE_URI)
    return await asyncpg.connect(
        host=url.host,
        port=url.port,
        user=url.username,
        password=url.password,
        database=url.database,
    )


@pytest_asyncio.fixture
async def pg() -> AsyncIterator[asyncpg.Connection]:
    """A plain asyncpg connection, the kind finalize_layer resolves with."""
    conn = await _connect()
    try:
        yield conn
    finally:
        await conn.close()


def _config(*node_ids: str) -> dict[str, Any]:
    return {
        "nodes": [
            {
                "id": node_id,
                "type": "export",
                "position": {"x": 0, "y": 0},
                "data": {
                    "type": "export",
                    "label": "Export Dataset",
                    "datasetName": "Result",
                    "addToProject": True,
                    "overwritePrevious": True,
                },
            }
            for node_id in (node_ids or (NODE,))
        ],
        "edges": [],
    }


async def _workflow(
    db: AsyncSession, project_id: UUID, *node_ids: str, name: str = "wf"
) -> UUID:
    wf = Workflow(project_id=project_id, name=name, config=_config(*node_ids))
    db.add(wf)
    await db.flush()
    assert wf.id is not None
    return wf.id


def _stamp(workflow_id: UUID, node_id: str = NODE) -> str:
    return json.dumps(
        {
            "workflow_export": {
                "workflow_id": str(workflow_id),
                "export_node_id": node_id,
            }
        }
    )


async def _link(
    db: AsyncSession,
    layer_id: UUID,
    project_id: UUID,
    *,
    stamp: UUID | None = None,
    node_id: str = NODE,
) -> int:
    return (
        await db.execute(
            text(
                f"INSERT INTO {S}.layer_project "
                '(layer_id, project_id, name, "order", other_properties, updated_at) '
                "VALUES (:l, :p, 'Result', 0, CAST(:o AS jsonb), now()) RETURNING id"
            ),
            {
                "l": layer_id,
                "p": project_id,
                "o": _stamp(stamp, node_id) if stamp else None,
            },
        )
    ).scalar_one()


async def _output(
    db: AsyncSession,
    make_layer: MakeLayer,
    owner: User,
    folder: Folder,
    *,
    project_id: UUID,
    workflow_id: UUID,
    node_id: str = NODE,
    link_stamp: bool = True,
) -> tuple[UUID, int]:
    """A layer as an export run leaves it: stamped with the workflow and
    node that produced it, shown in the project. ``link_stamp=False`` is a
    project entry written before project entries carried the stamp."""
    layer = await make_layer(owner, folder)
    await db.execute(
        text(
            f"UPDATE {S}.layer SET other_properties = CAST(:o AS jsonb) WHERE id = :id"
        ),
        {"o": _stamp(workflow_id, node_id), "id": layer.id},
    )
    link_id = await _link(
        db,
        layer.id,
        project_id,
        stamp=workflow_id if link_stamp else None,
        node_id=node_id,
    )
    return layer.id, link_id


async def _grant(
    db: AsyncSession,
    rtype: str,
    rid: UUID,
    user: User,
    role_id: UUID,
    granted_by: UUID,
) -> None:
    await db.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES (:t, :r, 'user', :u, :role, :by)"
        ),
        {"t": rtype, "r": rid, "u": user.id, "role": role_id, "by": granted_by},
    )


async def _workflow_in(db: AsyncSession, project_id: UUID, name: str = "wf") -> UUID:
    return (
        await db.execute(
            text(f"SELECT id FROM {S}.workflow WHERE project_id = :p AND name = :n"),
            {"p": project_id, "n": name},
        )
    ).scalar_one()


async def _link_of(db: AsyncSession, project_id: UUID, layer_id: UUID) -> int:
    return (
        await db.execute(
            text(
                f"SELECT id FROM {S}.layer_project "
                "WHERE project_id = :p AND layer_id = :l"
            ),
            {"p": project_id, "l": layer_id},
        )
    ).scalar_one()


async def _target(
    pg: asyncpg.Connection,
    *,
    user: User,
    project_id: UUID,
    workflow_id: UUID,
    node_id: str = NODE,
) -> ExportTarget | None:
    return await resolve_export_target(
        pg,
        S,
        user_id=str(user.id),
        project_id=str(project_id),
        workflow_id=str(workflow_id),
        export_node_id=node_id,
    )


# ---------------------------------------------------------------------------
# Same project
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("link_stamp", [True, False], ids=["stamped", "pre-stamp"])
async def test_rerun_of_the_same_workflow_overwrites_its_layer(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
    link_stamp: bool,
) -> None:
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    wf = await _workflow(db_session, project.id)
    layer_id, link_id = await _output(
        db_session,
        make_layer,
        owner,
        folder,
        project_id=project.id,
        workflow_id=wf,
        link_stamp=link_stamp,
    )
    await db_session.commit()

    assert await _target(
        pg, user=owner, project_id=project.id, workflow_id=wf
    ) == ExportTarget(layer_id=str(layer_id), link_id=link_id, mode="in_place")


@pytest.mark.asyncio
async def test_co_editor_overwrites_the_layer_another_member_created(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """Cyrine's case 3: the workflow is one unit, whoever runs it."""
    anna, ben = await make_user(), await make_user()
    folder = await make_folder(anna)
    project = await make_project(anna, folder)
    await _grant(
        db_session, "project", project.id, ben, roles["project-editor"], anna.id
    )
    wf = await _workflow(db_session, project.id)
    layer_id, link_id = await _output(
        db_session, make_layer, anna, folder, project_id=project.id, workflow_id=wf
    )
    await db_session.commit()

    assert await _target(
        pg, user=ben, project_id=project.id, workflow_id=wf
    ) == ExportTarget(layer_id=str(layer_id), link_id=link_id, mode="in_place")


@pytest.mark.asyncio
async def test_workflow_duplicate_in_the_same_project_gets_its_own_layer(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """Cyrine's case 4: the duplicate must never touch the original's layer."""
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    wf = await _workflow(db_session, project.id)
    await _output(
        db_session, make_layer, owner, folder, project_id=project.id, workflow_id=wf
    )
    await db_session.commit()

    duplicate = await crud_workflow.duplicate(
        db_session, project_id=project.id, workflow_id=wf
    )
    assert duplicate is not None and duplicate.id is not None

    assert (
        await _target(pg, user=owner, project_id=project.id, workflow_id=duplicate.id)
        is None
    )


@pytest.mark.asyncio
async def test_output_removed_from_the_project_is_attached_again(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    wf = await _workflow(db_session, project.id)
    layer_id, link_id = await _output(
        db_session, make_layer, owner, folder, project_id=project.id, workflow_id=wf
    )
    await db_session.execute(
        text(f"DELETE FROM {S}.layer_project WHERE id = :id"), {"id": link_id}
    )
    await db_session.commit()

    assert await _target(
        pg, user=owner, project_id=project.id, workflow_id=wf
    ) == ExportTarget(layer_id=str(layer_id), link_id=None, mode="in_place")


@pytest.mark.asyncio
async def test_output_in_the_trash_is_not_overwritten(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """Trashing keeps the project entry but hides it; writing into the
    trashed layer made every later run look like it produced nothing."""
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    wf = await _workflow(db_session, project.id)
    layer_id, _ = await _output(
        db_session, make_layer, owner, folder, project_id=project.id, workflow_id=wf
    )
    await db_session.execute(
        text(f"UPDATE {S}.layer SET deleted_at = now() WHERE id = :id"),
        {"id": layer_id},
    )
    await db_session.commit()

    assert await _target(pg, user=owner, project_id=project.id, workflow_id=wf) is None


@pytest.mark.asyncio
async def test_newest_of_several_outputs_in_one_project_is_overwritten(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """Projects already hold one output per member from before the fix."""
    anna, ben = await make_user(), await make_user()
    folder = await make_folder(anna)
    project = await make_project(anna, folder)
    await _grant(
        db_session, "project", project.id, ben, roles["project-editor"], anna.id
    )
    wf = await _workflow(db_session, project.id)
    await _output(
        db_session,
        make_layer,
        anna,
        folder,
        project_id=project.id,
        workflow_id=wf,
        link_stamp=False,
    )
    newest_layer, newest_link = await _output(
        db_session,
        make_layer,
        ben,
        folder,
        project_id=project.id,
        workflow_id=wf,
        link_stamp=False,
    )
    await db_session.commit()

    assert await _target(
        pg, user=anna, project_id=project.id, workflow_id=wf
    ) == ExportTarget(layer_id=str(newest_layer), link_id=newest_link, mode="in_place")


# ---------------------------------------------------------------------------
# Copies: project duplicate, project template
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("link_stamp", [True, False], ids=["stamped", "pre-stamp"])
async def test_project_duplicate_writes_a_new_layer_into_the_copy(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
    link_stamp: bool,
) -> None:
    """Cyrine's case 1. The copy shares the layer row with the original, so
    whichever of the two runs puts a new layer behind its own entry: the copy
    is an independent snapshot in both directions."""
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    wf = await _workflow(db_session, project.id)
    layer_id, link_id = await _output(
        db_session,
        make_layer,
        owner,
        folder,
        project_id=project.id,
        workflow_id=wf,
        link_stamp=link_stamp,
    )
    await db_session.commit()

    copy = await copy_project(db_session, project_id=project.id, user_id=owner.id)
    assert copy.id is not None
    copy_wf = await _workflow_in(db_session, copy.id)

    assert await _target(
        pg, user=owner, project_id=copy.id, workflow_id=copy_wf
    ) == ExportTarget(
        layer_id=str(layer_id),
        link_id=await _link_of(db_session, copy.id, layer_id),
        mode="copy_on_write",
    )
    assert await _target(
        pg, user=owner, project_id=project.id, workflow_id=wf
    ) == ExportTarget(layer_id=str(layer_id), link_id=link_id, mode="copy_on_write")


@pytest.mark.asyncio
async def test_copy_made_before_the_fix_still_inherits_its_output(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """Copies that already exist carry no stamp on their project entries;
    the one workflow in the copy holding the node inherits the output, and
    the original still recognises the copy's entry as a copy."""
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    wf = await _workflow(db_session, project.id)
    layer_id, link_id = await _output(
        db_session,
        make_layer,
        owner,
        folder,
        project_id=project.id,
        workflow_id=wf,
        link_stamp=False,
    )
    await db_session.commit()
    copy = await copy_project(db_session, project_id=project.id, user_id=owner.id)
    assert copy.id is not None
    await db_session.execute(
        text(
            f"UPDATE {S}.layer_project "
            "SET other_properties = other_properties - 'workflow_export' "
            "WHERE project_id = :p AND jsonb_typeof(other_properties) = 'object'"
        ),
        {"p": copy.id},
    )
    await db_session.commit()
    copy_wf = await _workflow_in(db_session, copy.id)

    assert await _target(
        pg, user=owner, project_id=copy.id, workflow_id=copy_wf
    ) == ExportTarget(
        layer_id=str(layer_id),
        link_id=await _link_of(db_session, copy.id, layer_id),
        mode="copy_on_write",
    )
    assert await _target(
        pg, user=owner, project_id=project.id, workflow_id=wf
    ) == ExportTarget(layer_id=str(layer_id), link_id=link_id, mode="copy_on_write")


@pytest.mark.asyncio
async def test_layer_added_by_hand_to_another_project_keeps_updating_in_place(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """Someone put the workflow's result into another project on purpose (no
    copy of the workflow there): that project follows the re-runs."""
    owner = await make_user()
    folder = await make_folder(owner)
    project, report = (
        await make_project(owner, folder),
        await make_project(owner, folder),
    )
    wf = await _workflow(db_session, project.id)
    layer_id, link_id = await _output(
        db_session, make_layer, owner, folder, project_id=project.id, workflow_id=wf
    )
    await _link(db_session, layer_id, report.id)
    await db_session.commit()

    assert await _target(
        pg, user=owner, project_id=project.id, workflow_id=wf
    ) == ExportTarget(layer_id=str(layer_id), link_id=link_id, mode="in_place")


@pytest.mark.asyncio
async def test_output_removed_from_the_project_but_shown_by_a_copy_is_not_attached_again(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    wf = await _workflow(db_session, project.id)
    layer_id, link_id = await _output(
        db_session, make_layer, owner, folder, project_id=project.id, workflow_id=wf
    )
    await db_session.commit()
    await copy_project(db_session, project_id=project.id, user_id=owner.id)
    await db_session.execute(
        text(f"DELETE FROM {S}.layer_project WHERE id = :id"), {"id": link_id}
    )
    await db_session.commit()

    assert await _target(pg, user=owner, project_id=project.id, workflow_id=wf) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("link_stamp", [True, False], ids=["stamped", "pre-stamp"])
async def test_copy_of_a_project_with_a_duplicated_workflow_keeps_each_output_with_its_workflow(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
    link_stamp: bool,
) -> None:
    """Both workflows hold the same export node (one is a duplicate of the
    other) and the copy creates both in one transaction, so nothing but the
    stamp tells which copied workflow owns which output."""
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    first = await _workflow(db_session, project.id, name="first")
    second = await _workflow(db_session, project.id, name="second")
    first_layer, _ = await _output(
        db_session,
        make_layer,
        owner,
        folder,
        project_id=project.id,
        workflow_id=first,
        link_stamp=link_stamp,
    )
    second_layer, _ = await _output(
        db_session,
        make_layer,
        owner,
        folder,
        project_id=project.id,
        workflow_id=second,
        link_stamp=link_stamp,
    )
    await db_session.commit()

    copy = await copy_project(db_session, project_id=project.id, user_id=owner.id)
    assert copy.id is not None

    for name, layer_id in (("first", first_layer), ("second", second_layer)):
        assert await _target(
            pg,
            user=owner,
            project_id=copy.id,
            workflow_id=await _workflow_in(db_session, copy.id, name),
        ) == ExportTarget(
            layer_id=str(layer_id),
            link_id=await _link_of(db_session, copy.id, layer_id),
            mode="copy_on_write",
        ), name


@pytest.mark.asyncio
async def test_duplicate_of_a_workflow_inside_a_copied_project_does_not_inherit(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    wf = await _workflow(db_session, project.id)
    layer_id, _ = await _output(
        db_session, make_layer, owner, folder, project_id=project.id, workflow_id=wf
    )
    await db_session.commit()
    copy = await copy_project(db_session, project_id=project.id, user_id=owner.id)
    assert copy.id is not None
    copy_wf = await _workflow_in(db_session, copy.id)
    duplicate = await crud_workflow.duplicate(
        db_session, project_id=copy.id, workflow_id=copy_wf
    )
    assert duplicate is not None and duplicate.id is not None

    assert (
        await _target(pg, user=owner, project_id=copy.id, workflow_id=duplicate.id)
        is None
    )
    assert await _target(
        pg, user=owner, project_id=copy.id, workflow_id=copy_wf
    ) == ExportTarget(
        layer_id=str(layer_id),
        link_id=await _link_of(db_session, copy.id, layer_id),
        mode="copy_on_write",
    )


@pytest.mark.asyncio
async def test_project_template_used_by_another_user_writes_a_new_layer(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """Cyrine's case 2. The template's layer belongs to its author; the user's
    run replaces the entry in their own project and leaves the template's
    data alone, and the author's re-run leaves the template (and the user's
    project) alone too."""
    author, user = await make_user(), await make_user()
    author_folder = await make_folder(author)
    user_folder = await make_folder(user)
    project = await make_project(author, author_folder)
    wf = await _workflow(db_session, project.id)
    layer_id, link_id = await _output(
        db_session,
        make_layer,
        author,
        author_folder,
        project_id=project.id,
        workflow_id=wf,
    )
    await db_session.commit()

    template = await crud_template.create(
        db_session,
        user_id=author.id,
        obj_in=TemplateCreate(
            name="Accessibility study",
            folder_id=author_folder.id,
            source=TemplateSource(kind="project", project_id=project.id),
        ),
    )
    await _grant(
        db_session, "template", template.id, user, roles["template-viewer"], author.id
    )
    await db_session.commit()
    used = await crud_template.use(
        db_session,
        template_id=template.id,
        user_id=user.id,
        req=TemplateUseRequest(target_folder_id=user_folder.id),
    )
    used_wf = await _workflow_in(db_session, used.project_id)

    assert await _target(
        pg, user=user, project_id=used.project_id, workflow_id=used_wf
    ) == ExportTarget(
        layer_id=str(layer_id),
        link_id=await _link_of(db_session, used.project_id, layer_id),
        mode="copy_on_write",
    )
    assert await _target(
        pg, user=author, project_id=project.id, workflow_id=wf
    ) == ExportTarget(layer_id=str(layer_id), link_id=link_id, mode="copy_on_write")


@pytest.mark.asyncio
async def test_workflow_template_used_in_its_own_source_project_gets_its_own_layer(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    wf = await _workflow(db_session, project.id)
    await _output(
        db_session, make_layer, owner, folder, project_id=project.id, workflow_id=wf
    )
    await db_session.commit()

    template = await crud_template.create(
        db_session,
        user_id=owner.id,
        obj_in=TemplateCreate(
            name="Buffer",
            folder_id=folder.id,
            source=TemplateSource(
                kind="workflow", project_id=project.id, workflow_id=wf
            ),
        ),
    )
    used = await crud_template.use(
        db_session,
        template_id=template.id,
        user_id=owner.id,
        req=TemplateUseRequest(project_id=project.id),
    )
    assert used.workflow_id is not None

    assert (
        await _target(
            pg, user=owner, project_id=project.id, workflow_id=used.workflow_id
        )
        is None
    )


# ---------------------------------------------------------------------------
# Outputs whose stamp names a workflow of another project
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_layer_only_this_project_uses_is_taken_over_in_place(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """Imports made before 2026-05-08 kept the source workflow's id in the
    stamp. The imported layer is the runner's and in no other project, so
    there is nothing to protect: overwrite it and fix its stamp."""
    owner = await make_user()
    folder = await make_folder(owner)
    source = await make_project(owner, folder)
    source_wf = await _workflow(db_session, source.id)
    imported = await make_project(owner, folder)
    imported_wf = await _workflow(db_session, imported.id)
    layer_id, link_id = await _output(
        db_session,
        make_layer,
        owner,
        folder,
        project_id=imported.id,
        workflow_id=source_wf,
        link_stamp=False,
    )
    await db_session.commit()

    assert await _target(
        pg, user=owner, project_id=imported.id, workflow_id=imported_wf
    ) == ExportTarget(layer_id=str(layer_id), link_id=link_id, mode="adopt")


@pytest.mark.asyncio
async def test_inherited_layer_the_runner_may_not_write_is_replaced_not_taken_over(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """Only this project shows it, but it belongs to someone else."""
    author, user = await make_user(), await make_user()
    author_folder = await make_folder(author)
    user_folder = await make_folder(user)
    source = await make_project(author, author_folder)
    source_wf = await _workflow(db_session, source.id)
    mine = await make_project(user, user_folder)
    my_wf = await _workflow(db_session, mine.id)
    layer_id, link_id = await _output(
        db_session,
        make_layer,
        author,
        author_folder,
        project_id=mine.id,
        workflow_id=source_wf,
        link_stamp=False,
    )
    await db_session.commit()

    assert await _target(
        pg, user=user, project_id=mine.id, workflow_id=my_wf
    ) == ExportTarget(layer_id=str(layer_id), link_id=link_id, mode="copy_on_write")


@pytest.mark.asyncio
async def test_old_copy_where_two_workflows_hold_the_node_inherits_nothing(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """A pre-fix copy of a project that held a workflow and its duplicate
    cannot tell which copied workflow owns the output; each run creates a
    layer rather than guess."""
    owner = await make_user()
    folder = await make_folder(owner)
    source = await make_project(owner, folder)
    source_wf = await _workflow(db_session, source.id)
    copy = await make_project(owner, folder)
    first = await _workflow(db_session, copy.id, name="first")
    second = await _workflow(db_session, copy.id, name="second")
    await _output(
        db_session,
        make_layer,
        owner,
        folder,
        project_id=copy.id,
        workflow_id=source_wf,
        link_stamp=False,
    )
    await db_session.commit()

    for wf in (first, second):
        assert await _target(pg, user=owner, project_id=copy.id, workflow_id=wf) is None


# ---------------------------------------------------------------------------
# What finalize_layer writes once it knows the target
# ---------------------------------------------------------------------------


async def _link_row(db: AsyncSession, link_id: int) -> Any:
    return (
        await db.execute(
            text(
                f'SELECT layer_id, name, "order", properties, other_properties '
                f"FROM {S}.layer_project WHERE id = :id"
            ),
            {"id": link_id},
        )
    ).one()


@pytest.mark.asyncio
async def test_claiming_a_project_entry_points_it_at_the_layer_and_keeps_its_settings(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """Copy-on-write keeps the entry, so its name, style, position and
    dashboard widgets stay; only the layer behind it changes."""
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    wf = await _workflow(db_session, project.id)
    inherited = await make_layer(owner, folder)
    fresh = await make_layer(owner, folder)
    link_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer_project "
                '(layer_id, project_id, name, "order", properties, other_properties, updated_at) '
                "VALUES (:l, :p, 'My catchments', 3, CAST(:props AS jsonb), "
                "CAST(:other AS jsonb), now()) RETURNING id"
            ),
            {
                "l": inherited.id,
                "p": project.id,
                "props": json.dumps({"color": [255, 0, 0]}),
                "other": json.dumps({"table_config": {"hidden": ["id"]}}),
            },
        )
    ).scalar_one()
    await db_session.commit()

    await claim_link(
        pg,
        S,
        project_id=str(project.id),
        link_id=link_id,
        layer_id=str(fresh.id),
        workflow_id=str(wf),
        export_node_id=NODE,
    )

    row = await _link_row(db_session, link_id)
    assert row.layer_id == fresh.id
    assert (row.name, row.order, row.properties) == (
        "My catchments",
        3,
        {"color": [255, 0, 0]},
    )
    assert row.other_properties == {
        "table_config": {"hidden": ["id"]},
        "workflow_export": {"workflow_id": str(wf), "export_node_id": NODE},
    }


@pytest.mark.asyncio
async def test_claiming_a_project_entry_carries_the_layers_description_over(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """The first run in a project copy or template writes a new layer; it
    keeps the description, tags and column settings the template's author
    gave the output, as an overwrite in place does. The source's layer is
    left as it was."""
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    wf = await _workflow(db_session, project.id)
    inherited = await make_layer(owner, folder)
    inherited.description = "Wohnlagen, die das Vorhaben versorgen würde."
    inherited.tags = ["Nahversorgung", "Ergebnis"]
    inherited.field_config = {"einwohner": {"display_config": {"decimals": 0}}}
    fresh = await make_layer(owner, folder)
    db_session.add(inherited)
    link_id = await _link(db_session, inherited.id, project.id)
    await db_session.commit()

    await claim_link(
        pg,
        S,
        project_id=str(project.id),
        link_id=link_id,
        layer_id=str(fresh.id),
        workflow_id=str(wf),
        export_node_id=NODE,
    )

    rows = {
        r.id: r
        for r in (
            await db_session.execute(
                text(
                    f"SELECT id, description, tags, field_config FROM {S}.layer "
                    "WHERE id IN (:a, :b)"
                ),
                {"a": inherited.id, "b": fresh.id},
            )
        ).all()
    }
    expected = (
        "Wohnlagen, die das Vorhaben versorgen würde.",
        ["Nahversorgung", "Ergebnis"],
        {"einwohner": {"display_config": {"decimals": 0}}},
    )
    for layer_id in (fresh.id, inherited.id):
        row = rows[layer_id]
        assert (row.description, row.tags, row.field_config) == expected


@pytest.mark.asyncio
async def test_claiming_an_entry_whose_other_properties_is_json_null(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """copy_project stores an empty `other_properties` as JSON null, a
    scalar that jsonb operators refuse to merge into."""
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    wf = await _workflow(db_session, project.id)
    layer = await make_layer(owner, folder)
    link_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer_project "
                '(layer_id, project_id, name, "order", other_properties, updated_at) '
                "VALUES (:l, :p, 'Result', 0, 'null'::jsonb, now()) RETURNING id"
            ),
            {"l": layer.id, "p": project.id},
        )
    ).scalar_one()
    await db_session.commit()

    await claim_link(
        pg,
        S,
        project_id=str(project.id),
        link_id=link_id,
        layer_id=str(layer.id),
        workflow_id=str(wf),
        export_node_id=NODE,
    )

    assert (await _link_row(db_session, link_id)).other_properties == {
        "workflow_export": {"workflow_id": str(wf), "export_node_id": NODE}
    }


@pytest.mark.asyncio
async def test_claiming_refuses_an_entry_of_another_project(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """The run was authorized for one project; an entry id from another must
    not be repointed, and refusing (rather than updating nothing) rolls back
    the copy-on-write that asked for it."""
    owner = await make_user()
    folder = await make_folder(owner)
    mine, theirs = await make_project(owner, folder), await make_project(owner, folder)
    wf = await _workflow(db_session, mine.id)
    shown, fresh = await make_layer(owner, folder), await make_layer(owner, folder)
    their_entry = await _link(db_session, shown.id, theirs.id)
    await db_session.commit()

    with pytest.raises(ValueError, match="not in project"):
        await claim_link(
            pg,
            S,
            project_id=str(mine.id),
            link_id=their_entry,
            layer_id=str(fresh.id),
            workflow_id=str(wf),
            export_node_id=NODE,
        )

    row = await _link_row(db_session, their_entry)
    assert (row.layer_id, row.other_properties) == (shown.id, None)


@pytest.mark.asyncio
async def test_restamping_a_taken_over_layer_names_the_new_workflow(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    old_wf = await _workflow(db_session, project.id, name="old")
    new_wf = await _workflow(db_session, project.id, name="new")
    layer = await make_layer(owner, folder)
    await db_session.execute(
        text(
            f"UPDATE {S}.layer SET other_properties = CAST(:o AS jsonb) WHERE id = :id"
        ),
        {
            "o": json.dumps(
                {
                    "legend_urls": ["https://example.org/legend.png"],
                    "workflow_export": {
                        "workflow_id": str(old_wf),
                        "export_node_id": NODE,
                    },
                }
            ),
            "id": layer.id,
        },
    )
    await db_session.commit()

    await restamp_layer(
        pg, S, layer_id=str(layer.id), workflow_id=str(new_wf), export_node_id=NODE
    )

    other = (
        await db_session.execute(
            text(f"SELECT other_properties FROM {S}.layer WHERE id = :id"),
            {"id": layer.id},
        )
    ).scalar_one()
    assert other == {
        "legend_urls": ["https://example.org/legend.png"],
        "workflow_export": {"workflow_id": str(new_wf), "export_node_id": NODE},
    }


@pytest.mark.asyncio
async def test_runs_of_the_same_export_node_wait_for_each_other(
    pg: asyncpg.Connection,
) -> None:
    """Two members running one workflow at once would both replace the same
    table, or both find nothing and create two layers."""
    second = await _connect()
    workflow_id = "8d0d6a8e-1111-4c4c-9c9c-000000000001"
    try:
        async with export_lock(pg, workflow_id=workflow_id, export_node_id=NODE):
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(_hold(second, workflow_id, NODE), timeout=0.5)
            # Another export node of the same workflow is not held up.
            await asyncio.wait_for(
                _hold(second, workflow_id, "export-other"), timeout=5
            )
        await asyncio.wait_for(_hold(second, workflow_id, NODE), timeout=5)
    finally:
        await second.close()


async def _hold(conn: asyncpg.Connection, workflow_id: str, node_id: str) -> None:
    async with export_lock(conn, workflow_id=workflow_id, export_node_id=node_id):
        pass


# ---------------------------------------------------------------------------
# Who may save a workflow's result into a project
# ---------------------------------------------------------------------------


async def _authorize(
    pg: asyncpg.Connection, *, user: User, project_id: UUID, workflow_id: UUID
) -> None:
    await authorize_workflow_export(
        ToolDatabaseService(pg, schema=S),
        user_id=str(user.id),
        project_id=str(project_id),
        workflow_id=str(workflow_id),
    )


@pytest.mark.asyncio
async def test_project_editors_may_save_a_workflow_result(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_project: MakeProject,
) -> None:
    anna, ben = await make_user(), await make_user()
    folder = await make_folder(anna)
    project = await make_project(anna, folder)
    await _grant(
        db_session, "project", project.id, ben, roles["project-editor"], anna.id
    )
    wf = await _workflow(db_session, project.id)
    await db_session.commit()

    await _authorize(pg, user=anna, project_id=project.id, workflow_id=wf)
    await _authorize(pg, user=ben, project_id=project.id, workflow_id=wf)


@pytest.mark.asyncio
async def test_viewers_and_strangers_may_not_save_a_workflow_result(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_project: MakeProject,
) -> None:
    """processes starts a run for anyone signed in; saving the result is
    the write, and nothing checked it: whoever knew a project's id could add
    layers to it, and with overwrite no longer tied to layer ownership they
    could replace its workflow results."""
    anna, viewer, stranger = await make_user(), await make_user(), await make_user()
    folder = await make_folder(anna)
    project = await make_project(anna, folder)
    await _grant(
        db_session, "project", project.id, viewer, roles["project-viewer"], anna.id
    )
    wf = await _workflow(db_session, project.id)
    await db_session.commit()

    for user in (viewer, stranger):
        with pytest.raises(ValueError, match="cannot be saved"):
            await _authorize(pg, user=user, project_id=project.id, workflow_id=wf)


@pytest.mark.asyncio
async def test_a_workflow_result_is_only_saved_into_the_workflows_own_project(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_project: MakeProject,
) -> None:
    """The overwrite target is looked up in the named project for the named
    workflow; a mismatched pair would let one project's run claim another's
    results."""
    owner = await make_user()
    folder = await make_folder(owner)
    home, elsewhere = (
        await make_project(owner, folder),
        await make_project(owner, folder),
    )
    wf = await _workflow(db_session, home.id)
    await db_session.commit()

    with pytest.raises(ValueError, match="cannot be saved"):
        await _authorize(pg, user=owner, project_id=elsewhere.id, workflow_id=wf)


# ---------------------------------------------------------------------------
# Dataset nodes follow their project entry
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dataset_nodes_read_the_layer_their_entry_in_this_project_shows(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    owner = await make_user()
    folder = await make_folder(owner)
    project, other = (
        await make_project(owner, folder),
        await make_project(owner, folder),
    )
    shown, trashed, elsewhere = [await make_layer(owner, folder) for _ in range(3)]
    shown_link = await _link(db_session, shown.id, project.id)
    trashed_link = await _link(db_session, trashed.id, project.id)
    other_link = await _link(db_session, elsewhere.id, other.id)
    await db_session.execute(
        text(f"UPDATE {S}.layer SET deleted_at = now() WHERE id = :id"),
        {"id": trashed.id},
    )
    await db_session.commit()

    assert await current_layer_ids(
        pg,
        S,
        user_id=str(owner.id),
        project_id=str(project.id),
        link_ids=[shown_link, trashed_link, other_link],
    ) == {shown_link: str(shown.id)}


@pytest.mark.asyncio
async def test_dataset_nodes_of_a_project_the_runner_cannot_read_stay_as_sent(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """A run names its project in the request, and entry ids are small
    integers: without the check, enumerating them would turn someone else's
    project entries into layer ids for the tools to read."""
    owner, stranger = await make_user(), await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    layer = await make_layer(owner, folder)
    link_id = await _link(db_session, layer.id, project.id)
    await db_session.commit()

    assert (
        await current_layer_ids(
            pg,
            S,
            user_id=str(stranger.id),
            project_id=str(project.id),
            link_ids=[link_id],
        )
        == {}
    )


@pytest.mark.asyncio
async def test_project_duplicate_points_dataset_nodes_at_the_copys_entries(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """A copied dataset node that still names the source project's entry
    cannot follow the copy's entry to a new layer."""
    owner = await make_user()
    folder = await make_folder(owner)
    project = await make_project(owner, folder)
    layer = await make_layer(owner, folder)
    link_id = await _link(db_session, layer.id, project.id)
    db_session.add(
        Workflow(
            project_id=project.id,
            name="wf",
            config={
                "nodes": [
                    {
                        "id": "dataset-1",
                        "type": "dataset",
                        "data": {
                            "type": "dataset",
                            "layerId": str(layer.id),
                            "projectLayerId": link_id,
                        },
                    },
                    {
                        "id": "tool-1",
                        "type": "tool",
                        "data": {
                            "type": "tool",
                            "config": {"layer_project_id": link_id, "distance": 500},
                        },
                    },
                ],
                "edges": [],
            },
        )
    )
    await db_session.commit()

    copy = await copy_project(db_session, project_id=project.id, user_id=owner.id)
    assert copy.id is not None
    copy_link_id = await _link_of(db_session, copy.id, layer.id)

    config = (
        await db_session.execute(
            text(f"SELECT config FROM {S}.workflow WHERE project_id = :p"),
            {"p": copy.id},
        )
    ).scalar_one()
    assert config["nodes"][0]["data"] == {
        "type": "dataset",
        "layerId": str(layer.id),
        "projectLayerId": copy_link_id,
    }
    # Tool configs keep copies of the node's entry id (the editor's direct
    # layer pick); they follow it, other numbers stay.
    assert config["nodes"][1]["data"]["config"] == {
        "layer_project_id": copy_link_id,
        "distance": 500,
    }


@pytest.mark.asyncio
async def test_moving_an_entry_to_a_new_layer_retargets_the_dataset_nodes_reading_it(
    db_session: AsyncSession,
    pg: asyncpg.Connection,
    roles: dict[str, UUID],
    make_user: MakeUser,
    make_folder: MakeFolder,
    make_layer: MakeLayer,
    make_project: MakeProject,
) -> None:
    """Copy-on-write puts a new layer behind an entry; the editor reads a
    dataset node's saved `layerId` (fields, geometry checks), so the saved
    workflows follow the entry too."""
    owner = await make_user()
    folder = await make_folder(owner)
    project, other = (
        await make_project(owner, folder),
        await make_project(owner, folder),
    )
    old, new, unrelated = [await make_layer(owner, folder) for _ in range(3)]
    entry = await _link(db_session, old.id, project.id)
    unrelated_entry = await _link(db_session, unrelated.id, project.id)
    other_entry = await _link(db_session, old.id, other.id)

    def consumer(link_id: int) -> dict[str, Any]:
        return {
            "nodes": [
                {
                    "id": "dataset-1",
                    "type": "dataset",
                    "data": {
                        "type": "dataset",
                        "layerId": str(old.id),
                        "projectLayerId": link_id,
                    },
                },
                {
                    "id": "dataset-2",
                    "type": "dataset",
                    "data": {
                        "type": "dataset",
                        "layerId": str(unrelated.id),
                        "projectLayerId": unrelated_entry,
                    },
                },
                {
                    "id": "tool-1",
                    "type": "tool",
                    "data": {
                        "type": "tool",
                        "config": {"input_layer_id": str(old.id), "distance": 5},
                    },
                },
            ],
            "edges": [],
        }

    here = Workflow(project_id=project.id, name="consumer", config=consumer(entry))
    there = Workflow(project_id=other.id, name="consumer", config=consumer(other_entry))
    db_session.add_all([here, there])
    await db_session.commit()

    async with pg.transaction():
        await retarget_dataset_nodes(
            pg, S, project_id=str(project.id), link_id=entry, layer_id=str(new.id)
        )

    async def nodes(workflow: Workflow) -> list[dict[str, Any]]:
        return (
            await db_session.execute(
                text(f"SELECT config FROM {S}.workflow WHERE id = :id"),
                {"id": workflow.id},
            )
        ).scalar_one()["nodes"]

    moved = await nodes(here)
    assert moved[0]["data"]["layerId"] == str(new.id)
    assert moved[1]["data"]["layerId"] == str(unrelated.id)
    assert moved[2]["data"]["config"] == {"input_layer_id": str(new.id), "distance": 5}
    assert await nodes(there) == consumer(other_entry)["nodes"]

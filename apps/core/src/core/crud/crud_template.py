"""CRUD + business logic for the template API (T1, T2, T4, T5, T6, T8).

A template is a saved, reusable starting point for a workflow, layout or
project. Saving one detects the dataset references in the source config
(T5), lets the author decide ship/ask/copy for each, freezes the payload
(``core.templates.snapshot``) and, for a project payload, points at a
hidden frozen copy made via ``copy_project(mark_template_source=True)``
(T2). Publishing beyond the team space widens who can read a shipped
dataset, so saving into (or refreshing within) a team/organisation space
can require viewer grants on the datasets it ships (T6).

A "copy" input (workflow or project payload) gives every user of the
template their own editable copy of the dataset: ``use`` links the author's
dataset as for "ship", then starts one ``layer_copy`` job per copied dataset
through the processes service, which writes the copy and points the new
project entries at it (``goatlib.tools.layer_copy``). Core never touches the
data itself.
"""

import json
import logging
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from datetime import datetime, timezone
from typing import Any, Literal, cast
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from core.core import authz
from core.core.config import settings
from core.crud.crud_folder import folder as crud_folder
from core.crud.crud_layer_project import layer_project as crud_layer_project
from core.crud.crud_project import project as crud_project
from core.crud.crud_project_copy import copy_project
from core.crud.crud_report_layout import report_layout as crud_report_layout
from core.crud.crud_share import share as crud_share
from core.crud.crud_workflow import workflow as crud_workflow
from core.db.models._link_model import LayerProjectGroup
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.project import Project
from core.db.models.report_layout import ReportLayout
from core.db.models.space import Space, SpaceKind
from core.db.models.team import Team
from core.db.models.template import Template, TemplateCatalogStatus
from core.db.models.user import User
from core.db.models.workflow import Workflow
from core.schemas.content import ContentCreator
from core.schemas.error import FolderNotFoundError
from core.schemas.report_layout import ReportLayoutCreate
from core.schemas.share import (
    LayerShareRoleEnum,
    ShareLayerSchema,
    ShareLayerWithTeamOrOrganizationSchema,
    ShareWithUserSchema,
)
from core.schemas.template import (
    DATASET_MODES,
    DatasetShareLine,
    DetectedInput,
    TemplateCategoryFacet,
    TemplateCopyJob,
    TemplateCreate,
    TemplateGrantCreate,
    TemplateGrantRead,
    TemplateGrantsResponse,
    TemplateInput,
    TemplatePage,
    TemplatePreview,
    TemplatePreviewRequest,
    TemplateRead,
    TemplateSource,
    TemplateSourceInfo,
    TemplateUpdate,
    TemplateUsePreview,
    TemplateUsePreviewRequest,
    TemplateUseRequest,
    TemplateUseResult,
)
from core.schemas.workflow import WorkflowCreate
from core.services.initial_view_state import resolve_initial_view_state
from core.services.processes import execute_process
from core.templates.snapshot import (
    _rewrite_tool_configs,
    bind_workflow_config,
    detect_workflow_inputs,
    freeze_workflow_config,
    kinds_for,
    layout_page_mm,
    strip_layout_bindings,
    with_output_styles,
)

logger = logging.getLogger(__name__)

# The processes tool that writes a "copy" input's dataset for its user
# (`goatlib.tools.layer_copy`), and the stamp it and core keep on the project
# entries of a copy (`COPY_STAMP` there).
LAYER_COPY_PROCESS = "layer_copy"
COPY_STAMP = "template_copy"

# The layer types a "copy" input can name: the ones whose rows live in a
# table the `layer_copy` job can copy.
COPYABLE_LAYER_TYPES = ("feature", "table")

# The grants each narrower source filter of the template list takes in, as a
# condition on a `resource_grant` row `rg`: to one of the caller's teams, to
# the caller's organisation, or to the caller alone.
_SHARED_THROUGH = {
    "team": """rg.grantee_type = 'team' AND EXISTS (
                   SELECT 1 FROM {schema}.user_team ut
                    WHERE ut.team_id = rg.grantee_id AND ut.user_id = :user_id)""",
    "org": """rg.grantee_type = 'organization' AND EXISTS (
                  SELECT 1 FROM {schema}."user" u
                   WHERE u.id = :user_id AND u.organization_id = rg.grantee_id)""",
    "shared": "rg.grantee_type = 'user' AND rg.grantee_id = :user_id",
}


def _shared_through_sql(schema: str, grantee_condition: str) -> str:
    """A template `t` reached through a grant matching `grantee_condition`,
    on the template itself or on a folder above it."""
    return f"""EXISTS (
        SELECT 1 FROM {schema}.resource_grant rg
         WHERE ((rg.resource_type = 'template' AND rg.resource_id = t.id)
             OR (rg.resource_type = 'folder' AND rg.resource_id IN (
                     SELECT fc FROM {schema}.folder_chain(t.folder_id) AS fc)))
           AND {grantee_condition.format(schema=schema)})"""


@dataclass
class _CopyPlan:
    """A "copy" dataset of a template being used: the input(s) naming it,
    the dataset, and the target project's entries the copy will replace it
    behind."""

    keys: list[str]
    source_layer_id: UUID
    link_ids: list[int] = dataclass_field(default_factory=list)
    copy_content: bool = True


class CRUDTemplate:
    """Save, list, read, patch, delete and refresh templates."""

    # ------------------------------------------------------------------
    # Shared helpers
    # ------------------------------------------------------------------

    async def _destination_space(self, db: AsyncSession, folder_id: UUID) -> Space:
        """The space a destination folder belongs to, 404 if either is gone."""
        folder = await db.get(Folder, folder_id)
        if folder is None or folder.deleted_at is not None or folder.space_id is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
            )
        space = await db.get(Space, folder.space_id)
        if space is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Space not found"
            )
        return space

    async def _space_kind(self, db: AsyncSession, space_id: UUID | None) -> str:
        if space_id is None:
            return "personal"
        space = await db.get(Space, space_id)
        if space is None:
            return "personal"
        # `Space.kind` comes back as a plain str from a row loaded straight
        # off the Text column (not always re-validated into the SpaceKind
        # enum), so `.value` isn't safe to assume — normalise either shape.
        kind = space.kind
        return kind.value if isinstance(kind, SpaceKind) else str(kind)

    async def _needs_share(
        self, db: AsyncSession, layer: Layer, destination_space: Space
    ) -> bool:
        """T6's exact rule: does shipping ``layer`` into ``destination_space``
        widen who can read it?

        A catalog or public dataset → never (every signed-in user already
        reads it). Same space as the destination → never (the audience
        already has whatever access it has today). Otherwise:
        needs share unless a grant to the destination's own
        team/organisation already exists — a personal destination has no
        team/organisation to grant to, so it never needs one either.
        """
        assert layer.id is not None
        if layer.public_read or layer.catalog_external_uid is not None:
            return False
        if layer.space_id is not None and layer.space_id == destination_space.id:
            return False
        if destination_space.kind == SpaceKind.team:
            grantee_id = destination_space.team_id
            grants = await crud_share.get_grants(
                db=db, resource_type="layer", resource_id=layer.id
            )
            existing = {g.id for g in (grants.teams or [])}
        elif destination_space.kind == SpaceKind.organization:
            grantee_id = destination_space.organization_id
            grants = await crud_share.get_grants(
                db=db, resource_type="layer", resource_id=layer.id
            )
            existing = {g.id for g in (grants.organizations or [])}
        else:
            return False
        return grantee_id is None or str(grantee_id) not in existing

    async def _project_kinds(self, db: AsyncSession, project_id: UUID) -> list[str]:
        """T1's kind derivation for a project payload's frozen source:
        Project, plus Dashboard if it has a builder config and Workflow/Layout
        for any workflow/report_layout row it holds."""
        schema = settings.SCHEMA
        flags = (
            await db.execute(
                text(
                    "SELECT p.builder_config IS NOT NULL AS has_builder, "
                    f"EXISTS (SELECT 1 FROM {schema}.workflow w WHERE w.project_id = p.id) AS has_workflows, "
                    f"EXISTS (SELECT 1 FROM {schema}.report_layout rl WHERE rl.project_id = p.id) AS has_layouts "
                    f"FROM {schema}.project p WHERE p.id = :id"
                ),
                {"id": project_id},
            )
        ).first()
        if flags is None:
            return ["project"]
        return kinds_for(
            "project",
            has_builder=bool(flags.has_builder),
            has_workflows=bool(flags.has_workflows),
            has_layouts=bool(flags.has_layouts),
        )

    async def _kinds_for_row(self, db: AsyncSession, row: Template) -> list[str]:
        if row.payload_kind == "workflow":
            return ["workflow"]
        if row.payload_kind == "layout":
            return ["layout"]
        if row.source_project_id is None:
            return ["project"]
        return await self._project_kinds(db, row.source_project_id)

    async def _to_read(
        self,
        db: AsyncSession,
        row: Template,
        *,
        my_role: str,
        datasets_needing_share: list[DatasetShareLine] | None = None,
    ) -> TemplateRead:
        kinds = await self._kinds_for_row(db, row)
        creator: ContentCreator | None = None
        if row.user_id is not None:
            user = await db.get(User, row.user_id)
            if user is not None and user.id is not None:
                creator = ContentCreator(
                    id=user.id,
                    name=" ".join(
                        part for part in (user.firstname, user.lastname) if part
                    ),
                    avatar=user.avatar or None,
                )
        inputs = [TemplateInput(**i) for i in (row.inputs or [])]
        ships_data = any(
            i.mode in DATASET_MODES and (i.from_catalog or i.public_read)
            for i in inputs
        )
        assert row.id is not None
        page_mm = layout_page_mm(row.config) if row.payload_kind == "layout" else None
        return TemplateRead(
            id=row.id,
            name=row.name,
            description=row.description,
            categories=list(row.categories or []),
            thumbnail_url=row.thumbnail_url,
            page_size=row.page_size,
            page_orientation=row.page_orientation,  # type: ignore[arg-type]
            page_width_mm=page_mm[0] if page_mm else None,
            page_height_mm=page_mm[1] if page_mm else None,
            space_id=row.space_id,
            folder_id=row.folder_id,
            created_by=creator,
            payload_kind=row.payload_kind,  # type: ignore[arg-type]
            kinds=kinds,
            inputs=inputs,
            ships_data=ships_data,
            catalog_status=row.catalog_status,  # type: ignore[arg-type]
            source_ref=dict(row.source_ref or {}),
            my_role=my_role,  # type: ignore[arg-type]
            created_at=row.created_at,  # type: ignore[arg-type]
            updated_at=row.updated_at,  # type: ignore[arg-type]
            datasets_needing_share=datasets_needing_share or [],
        )

    async def _resolve_source(
        self, db: AsyncSession, row: Template, user_id: UUID
    ) -> TemplateSourceInfo | None:
        """Names and availability of the recorded source, for the caller:
        the project must be live and readable, the workflow/layout must
        still exist. Resolved on the single read only — a list row never
        pays for it."""
        ref = row.source_ref or {}
        project_id_raw = ref.get("project_id")
        if project_id_raw is None:
            return None
        project_id = UUID(str(project_id_raw))
        project = await db.get(Project, project_id)
        project_live = project is not None and project.deleted_at is None
        readable = project_live and await authz.can(
            db, "project", project_id, user_id, "read"
        )
        info = TemplateSourceInfo(
            kind=row.payload_kind,  # type: ignore[arg-type]
            project_id=project_id,
            project_name=project.name if readable and project is not None else None,
            available=bool(readable),
        )
        if row.payload_kind == "workflow" and ref.get("workflow_id"):
            info.workflow_id = UUID(str(ref["workflow_id"]))
            wf = (
                await crud_workflow.get_by_project_and_id(
                    db, project_id=project_id, workflow_id=info.workflow_id
                )
                if readable
                else None
            )
            info.workflow_name = wf.name if wf is not None else None
            info.available = bool(readable and wf is not None)
        elif row.payload_kind == "layout" and ref.get("layout_id"):
            info.layout_id = UUID(str(ref["layout_id"]))
            layout = (
                await crud_report_layout.get_by_project_and_id(
                    db, project_id=project_id, layout_id=info.layout_id
                )
                if readable
                else None
            )
            info.layout_name = layout.name if layout is not None else None
            info.available = bool(readable and layout is not None)
        return info

    @staticmethod
    def _layer_flags(layer: Layer | None) -> dict[str, bool]:
        """The two dataset flags of `TemplateInput`, read off the layer row
        (both False for a missing layer)."""
        if layer is None:
            return {"from_catalog": False, "public_read": False}
        return {
            "from_catalog": layer.catalog_external_uid is not None,
            "public_read": bool(layer.public_read),
        }

    async def _with_layer_flags(
        self, db: AsyncSession, inputs: list[TemplateInput]
    ) -> list[TemplateInput]:
        """Recompute `from_catalog` / `public_read` server-side
        from the layer row — the author's declared values (if any) are never
        trusted. An "ask" input also has its `layer_id` cleared here
        regardless of what the client submitted: an ask slot carries no
        dataset reference (T5), so a client-supplied `layer_id` on one is
        dropped, not just ignored. `copy_content` is only meaningful on a
        "copy" input and is reset to its default everywhere else, so the
        stored inputs never carry a choice nobody can act on."""
        out: list[TemplateInput] = []
        for i in inputs:
            if i.mode == "ask":
                out.append(
                    i.model_copy(
                        update={
                            "layer_id": None,
                            "copy_content": True,
                            **self._layer_flags(None),
                        }
                    )
                )
                continue
            layer = await db.get(Layer, i.layer_id) if i.layer_id is not None else None
            update: dict[str, Any] = dict(self._layer_flags(layer))
            if i.mode != "copy":
                update["copy_content"] = True
            out.append(i.model_copy(update=update))
        return out

    async def _assert_ship_inputs_readable(
        self, db: AsyncSession, inputs: list[TemplateInput], user_id: UUID
    ) -> None:
        """Every "ship" or "copy" input's dataset must be one the caller
        may read (B3): the source project/workflow being readable does not
        imply every layer it references is — a shared project can point at
        a layer the sharer never granted the caller access to on its own.
        422s (``template_input_not_readable``) naming the first offending
        layer rather than silently shipping an unreadable dataset. A copy
        is made from the very same dataset, so it needs the same read.
        """
        for i in inputs:
            if i.mode not in DATASET_MODES or i.layer_id is None:
                continue
            if not await authz.can(db, "layer", i.layer_id, user_id, "read"):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail={
                        "code": "template_input_not_readable",
                        "layer_id": str(i.layer_id),
                    },
                )

    async def _assert_copy_inputs_copyable(
        self, db: AsyncSession, inputs: list[TemplateInput]
    ) -> None:
        """Every "copy" input must name a live dataset whose rows GOAT holds:
        a feature or table layer stored in DuckLake (or a catalog dataset).
        A raster, or a layer read from an external service (WFS, MVT, WMS…),
        has no table to copy, so asking for a copy of one is refused with 422
        ``template_input_not_copyable`` naming the layer, instead of a
        template whose copy job could only ever fail.
        """
        for i in inputs:
            if i.mode != "copy":
                continue
            layer = await db.get(Layer, i.layer_id) if i.layer_id is not None else None
            if (
                layer is None
                or layer.deleted_at is not None
                or str(getattr(layer.type, "value", layer.type))
                not in COPYABLE_LAYER_TYPES
                or layer.data_type is not None
            ):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail={
                        "code": "template_input_not_copyable",
                        "layer_id": str(i.layer_id) if i.layer_id else None,
                    },
                )

    @staticmethod
    def _apply_project_choices(
        detected: list[TemplateInput], chosen: list[TemplateInput]
    ) -> list[TemplateInput]:
        """A project payload's inputs with the author's per-dataset choice
        applied: each detected ``layer:<id>`` input takes the ``mode`` and
        ``copy_content`` the author sent for its key, and stays "ship" when
        nothing was sent — so a client that sends no inputs (or one written
        before "copy" existed) saves exactly what it always did.

        There is no "ask" for a project payload (the frozen copy already
        shows a real layer for each dataset): an "ask" is read as "ship",
        which is what the save dialog's "share this dataset" checkbox sends
        when it is cleared. A key that names no dataset of the project is a
        422, like a mismatched workflow input.
        """
        by_key = {i.key: i for i in detected}
        unknown = [i.key for i in chosen if i.key not in by_key]
        if unknown:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="inputs do not match the datasets of the source project",
            )
        choice = {i.key: i for i in chosen}
        out: list[TemplateInput] = []
        for d in detected:
            c = choice.get(d.key)
            if c is None or c.mode != "copy":
                out.append(d)
                continue
            out.append(
                d.model_copy(update={"mode": "copy", "copy_content": c.copy_content})
            )
        return out

    async def _project_inputs(
        self, db: AsyncSession, project_id: UUID
    ) -> list[TemplateInput]:
        """T5's project-payload inputs (v1): every distinct layer linked to
        `project_id` via a `layer_project` link becomes a ship-only input —
        there is no ask option for a project payload in v1 (the frozen copy
        already holds a real, working project layer for each one)."""
        schema = settings.SCHEMA
        rows = (
            await db.execute(
                text(
                    "SELECT DISTINCT l.id, l.name, l.type, "
                    "l.feature_layer_geometry_type, l.catalog_external_uid, "
                    "l.public_read "
                    f"FROM {schema}.layer_project lp "
                    f"JOIN {schema}.layer l ON l.id = lp.layer_id "
                    "WHERE lp.project_id = :project_id"
                ),
                {"project_id": project_id},
            )
        ).all()
        return [
            TemplateInput(
                key=f"layer:{r.id}",
                label=r.name or "",
                mode="ship",
                layer_id=r.id,
                layer_type=r.type,  # type: ignore[arg-type]
                geometry_type=r.feature_layer_geometry_type,
                from_catalog=r.catalog_external_uid is not None,
                public_read=bool(r.public_read),
            )
            for r in rows
        ]

    async def _share_lines_for_ship_inputs(
        self,
        db: AsyncSession,
        inputs: list[TemplateInput],
        destination_space: Space,
    ) -> list[DatasetShareLine]:
        """T6's `datasets_needing_share`: every ship or copy input whose
        layer needs a viewer grant (`_needs_share`) into `destination_space`
        — a copy is made from the author's dataset, so its users need to
        read it just like a shipped one. An empty copy needs no read of the
        dataset (`TemplateInput.empty_copy`), so it is never listed."""
        lines: list[DatasetShareLine] = []
        for i in inputs:
            if i.mode not in DATASET_MODES or i.layer_id is None or i.empty_copy:
                continue
            layer = await db.get(Layer, i.layer_id)
            if layer is None:
                continue
            if await self._needs_share(db, layer, destination_space):
                lines.append(
                    DatasetShareLine(
                        layer_id=i.layer_id,
                        name=layer.name or "",
                        from_catalog=i.from_catalog,
                        current_audience=await self._space_kind(db, layer.space_id),  # type: ignore[arg-type]
                    )
                )
        return lines

    async def _add_viewer_grant(
        self,
        db: AsyncSession,
        *,
        layer_id: UUID,
        destination_space: Space,
        user_id: UUID,
    ) -> None:
        """Add a viewer grant on `layer_id` for `destination_space`'s own
        team/organisation (T6). A personal destination has no team/organisation
        to grant to and is a no-op."""
        if destination_space.kind == SpaceKind.team:
            grantee_type, grantee_id = "team", destination_space.team_id
        elif destination_space.kind == SpaceKind.organization:
            grantee_type, grantee_id = "organization", destination_space.organization_id
        else:
            return
        if grantee_id is None:
            return
        await self._add_viewer_grant_to(
            db,
            layer_id=layer_id,
            grantee_type=grantee_type,
            grantee_id=str(grantee_id),
            user_id=user_id,
        )

    async def _add_viewer_grant_to(
        self,
        db: AsyncSession,
        *,
        layer_id: UUID,
        grantee_type: str,
        grantee_id: str,
        user_id: UUID,
    ) -> None:
        """Add a viewer grant on `layer_id` for one grantee, preserving every
        OTHER existing grant on that family.

        `crud_share.share_resource` prunes every row of a grantee family
        (teams/organizations/users) that is present in its payload but not
        named there — so a payload naming only this grantee would silently
        delete every other team/org/user this layer was already shared with.
        The existing grants for the affected family are therefore read first
        and carried forward unchanged; the grantee is added only if it is not
        already there (never downgrading an existing higher role — this call
        only ever wants "at least viewer").
        """
        family = {"team": "teams", "organization": "organizations", "user": "users"}[
            grantee_type
        ]
        existing = await crud_share.get_grants(
            db=db, resource_type="layer", resource_id=layer_id
        )
        items = list(getattr(existing, family) or [])
        if any(item.id == grantee_id for item in items):
            return
        if family == "users":
            items.append(
                ShareWithUserSchema(id=grantee_id, role=LayerShareRoleEnum.layer_viewer)
            )
        else:
            items.append(
                ShareLayerWithTeamOrOrganizationSchema(
                    id=grantee_id, role=LayerShareRoleEnum.layer_viewer
                )
            )
        shared_with = ShareLayerSchema(**{family: items})
        await crud_share.share_resource(
            db=db,
            resource_type="layer",
            resource_id=layer_id,
            shared_with=shared_with,
            granted_by=user_id,
        )

    async def _share_shipped_datasets_with(
        self,
        db: AsyncSession,
        *,
        row: Template,
        grantee_type: str,
        grantee_id: str,
        user_id: UUID,
    ) -> None:
        """Let a template's grantee read the datasets it ships.

        A "ship" input is resolved on use only if the user may read that
        layer, so a template shared without its datasets arrives as an empty
        workflow; a "copy" input is copied from that same layer, so it needs
        the same read. Saving into a team or organisation space already grants the
        datasets to that space (T6); a grant on the template does the same for
        its grantee. Catalog layers are readable by everyone, and a layer the
        owner may not share is left alone — the template then resolves that
        input as unbound for the grantee, exactly as before.
        """
        for raw in row.inputs or []:
            i = TemplateInput(**raw)
            if (
                i.mode not in DATASET_MODES
                or i.layer_id is None
                or i.public_read
                or i.from_catalog
                or i.empty_copy  # its users never read the dataset itself
            ):
                continue
            layer = await db.get(Layer, i.layer_id)
            if layer is None or layer.deleted_at is not None:
                continue
            if layer.public_read or layer.catalog_external_uid is not None:
                continue
            if not await authz.can(db, "layer", i.layer_id, user_id, "share"):
                continue
            await self._add_viewer_grant_to(
                db,
                layer_id=i.layer_id,
                grantee_type=grantee_type,
                grantee_id=grantee_id,
                user_id=user_id,
            )

    async def _caller_spaces(
        self, db: AsyncSession, user_id: UUID
    ) -> dict[str, list[UUID]]:
        """The caller's personal/team/organisation spaces, bucketed by kind."""
        schema = settings.SCHEMA
        rows = (
            await db.execute(
                text(
                    f"""
                    SELECT s.id, s.kind FROM {schema}.space s
                     WHERE (s.kind = 'personal' AND s.user_id = :u)
                        OR (s.kind = 'team' AND EXISTS (
                                SELECT 1 FROM {schema}.user_team ut
                                 WHERE ut.team_id = s.team_id AND ut.user_id = :u))
                        OR (s.kind = 'organization' AND EXISTS (
                                SELECT 1 FROM {schema}."user" usr
                                 WHERE usr.id = :u AND usr.organization_id = s.organization_id))
                    """
                ),
                {"u": user_id},
            )
        ).all()
        buckets: dict[str, list[UUID]] = {
            "personal": [],
            "team": [],
            "organization": [],
        }
        for r in rows:
            buckets[r.kind].append(r.id)
        return buckets

    async def _shared_into_spaces(
        self, db: AsyncSession, user_id: UUID, rows: list[Template]
    ) -> dict[UUID, UUID | None]:
        """`TemplateRead.shared_into_space_id` for each row: for a template
        outside the caller's spaces, the caller's team space (or, failing
        that, organisation space) whose team or organisation holds a grant on
        the template or on a folder above it. None for the caller's own
        spaces and for a template shared with the caller alone."""
        buckets = await self._caller_spaces(db, user_id)
        own = {space for kind in buckets.values() for space in kind}
        outside = [row.id for row in rows if row.space_id not in own]
        result: dict[UUID, UUID | None] = {row.id: None for row in rows if row.id}
        if not outside:
            return result
        schema = settings.SCHEMA
        found = (
            await db.execute(
                text(
                    f"""
                    SELECT t.id, (
                        SELECT s.id FROM {schema}.resource_grant rg
                          JOIN {schema}.space s ON s.id = ANY(:own) AND (
                                 (rg.grantee_type = 'team' AND s.kind = 'team'
                                  AND s.team_id = rg.grantee_id)
                              OR (rg.grantee_type = 'organization'
                                  AND s.kind = 'organization'
                                  AND s.organization_id = rg.grantee_id))
                         WHERE (rg.resource_type = 'template' AND rg.resource_id = t.id)
                            OR (rg.resource_type = 'folder' AND rg.resource_id IN (
                                    SELECT fc FROM {schema}.folder_chain(t.folder_id) AS fc))
                         ORDER BY s.kind = 'organization', s.id
                         LIMIT 1
                    ) AS space_id
                    FROM {schema}.template t
                    WHERE t.id = ANY(:ids)
                    """
                ),
                {"own": list(own), "ids": outside},
            )
        ).all()
        for r in found:
            result[r.id] = r.space_id
        return result

    # ------------------------------------------------------------------
    # Preview
    # ------------------------------------------------------------------

    async def _detected_to_inputs(
        self, db: AsyncSession, detected: list[DetectedInput], user_id: UUID
    ) -> list[TemplateInput]:
        """Turn workflow-config detections into declared inputs: mode
        defaults to "ship" when the caller may read the layer, else "ask"."""
        inputs: list[TemplateInput] = []
        for d in detected:
            layer = await db.get(Layer, d.layer_id)
            may_read = await authz.can(db, "layer", d.layer_id, user_id, "read")
            mode: Literal["ship", "ask"] = "ship" if may_read else "ask"
            inputs.append(
                TemplateInput(
                    key=d.key,
                    label=d.label,
                    mode=mode,
                    layer_id=d.layer_id if mode == "ship" else None,
                    layer_type=d.layer_type,
                    geometry_type=d.geometry_type,
                    **self._layer_flags(layer),
                )
            )
        return inputs

    async def preview(
        self, db: AsyncSession, *, req: TemplatePreviewRequest, user_id: UUID
    ) -> TemplatePreview:
        await authz.require(db, "project", req.source.project_id, user_id, "read")
        await authz.require(db, "folder", req.folder_id, user_id, "write")
        destination_space = await self._destination_space(db, req.folder_id)

        if req.source.kind == "workflow":
            wf = await self._load_workflow(db, req.source)
            detected = detect_workflow_inputs(dict(wf.config or {}))
            kinds = ["workflow"]
            inputs = await self._detected_to_inputs(db, detected, user_id)
        elif req.source.kind == "layout":
            await self._load_layout(db, req.source)
            kinds = ["layout"]
            inputs = []
        else:
            kinds = await self._project_kinds(db, req.source.project_id)
            inputs = await self._project_inputs(db, req.source.project_id)

        share_lines = await self._share_lines_for_ship_inputs(
            db, inputs, destination_space
        )
        return TemplatePreview(
            detected_inputs=inputs, kinds=kinds, datasets_needing_share=share_lines
        )

    async def _load_workflow(
        self, db: AsyncSession, source: TemplateSource
    ) -> Workflow:
        if source.workflow_id is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="workflow_id is required for a workflow source",
            )
        wf = await crud_workflow.get_by_project_and_id(
            db, project_id=source.project_id, workflow_id=source.workflow_id
        )
        if wf is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found"
            )
        return wf

    async def _load_layout(
        self, db: AsyncSession, source: TemplateSource
    ) -> ReportLayout:
        if source.layout_id is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="layout_id is required for a layout source",
            )
        layout = await crud_report_layout.get_by_project_and_id(
            db, project_id=source.project_id, layout_id=source.layout_id
        )
        if layout is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Layout not found"
            )
        return layout

    # ------------------------------------------------------------------
    # Create
    # ------------------------------------------------------------------

    async def _export_styles(
        self, db: AsyncSession, project_id: UUID, workflow_id: UUID
    ) -> dict[str, dict[str, Any]]:
        """The style each of the workflow's export nodes' results has in the
        project: the entry stamped with the workflow and node (see goatlib's
        ``workflow_export_target``), the most recently changed one first."""
        rows = await db.execute(
            text(
                "SELECT other_properties->'workflow_export'->>'export_node_id' AS node, "
                "properties "
                f"FROM {settings.SCHEMA}.layer_project "
                "WHERE project_id = :p "
                "AND other_properties->'workflow_export'->>'workflow_id' = :w "
                "AND properties IS NOT NULL "
                "ORDER BY updated_at DESC"
            ),
            {"p": project_id, "w": str(workflow_id)},
        )
        styles: dict[str, dict[str, Any]] = {}
        for row in rows:
            if row.node and isinstance(row.properties, dict):
                styles.setdefault(row.node, row.properties)
        return styles

    async def create(
        self, db: AsyncSession, *, user_id: UUID, obj_in: TemplateCreate
    ) -> TemplateRead:
        await authz.require(db, "project", obj_in.source.project_id, user_id, "read")
        await authz.require(db, "folder", obj_in.folder_id, user_id, "write")
        destination_space = await self._destination_space(db, obj_in.folder_id)

        payload_kind = obj_in.source.kind
        config: dict[str, Any] | None = None
        source_project_id: UUID | None = None
        thumbnail_url = obj_in.thumbnail_url
        inputs = list(obj_in.inputs)

        if payload_kind == "workflow":
            wf = await self._load_workflow(db, obj_in.source)
            detected = detect_workflow_inputs(dict(wf.config or {}))
            detected_by_key = {d.key: d for d in detected}
            if {i.key for i in inputs} != set(detected_by_key):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="inputs do not match the dataset references detected in the source config",
                )
            for i in inputs:
                if (
                    i.mode in DATASET_MODES
                    and i.layer_id != detected_by_key[i.key].layer_id
                ):
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                        detail=f"input {i.key!r} layer_id does not match the detected reference",
                    )
            inputs = await self._with_layer_flags(db, inputs)
            config = freeze_workflow_config(dict(wf.config or {}), inputs)
            config = with_output_styles(
                config, await self._export_styles(db, obj_in.source.project_id, wf.id)
            )
            if thumbnail_url is None:
                thumbnail_url = wf.thumbnail_url
        elif payload_kind == "layout":
            if inputs:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="a layout template carries no dataset references",
                )
            layout = await self._load_layout(db, obj_in.source)
            config = strip_layout_bindings(dict(layout.config or {}))
            if thumbnail_url is None:
                thumbnail_url = layout.thumbnail_url
        else:
            source_project = await crud_project.get_live_or_404(
                db, obj_in.source.project_id
            )
            # The author's choices are checked against the source before the
            # frozen copy is written: the engine autocommits, so a refusal
            # after `copy_project` would leave a hidden copy nothing uses.
            # The frozen copy links the very same layers, so the keys match.
            planned = self._apply_project_choices(
                await self._project_inputs(db, obj_in.source.project_id),
                list(obj_in.inputs),
            )
            await self._assert_ship_inputs_readable(db, planned, user_id)
            await self._assert_copy_inputs_copyable(db, planned)
            try:
                frozen = await copy_project(
                    db,
                    project_id=obj_in.source.project_id,
                    user_id=user_id,
                    target_folder_id=source_project.folder_id,
                    mark_template_source=True,
                )
            except FolderNotFoundError as exc:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
                ) from exc
            source_project_id = frozen.id
            if thumbnail_url is None:
                thumbnail_url = source_project.thumbnail_url
            assert frozen.id is not None
            # T5 v1: every layer linked to the FROZEN copy (not the source —
            # the frozen copy is what the template actually points at) is an
            # input, shipped unless the author chose a copy for it; there is
            # no ask option for a project payload.
            inputs = self._apply_project_choices(
                await self._project_inputs(db, frozen.id), list(obj_in.inputs)
            )

        await self._assert_ship_inputs_readable(db, inputs, user_id)
        await self._assert_copy_inputs_copyable(db, inputs)

        ship_layer_ids = {
            i.layer_id for i in inputs if i.mode in DATASET_MODES and i.layer_id
        }
        for layer_id in obj_in.share_datasets:
            if layer_id not in ship_layer_ids:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail=f"share_datasets layer {layer_id} is not a shipped input",
                )
            # B3: sharing a dataset widens who can read it — the caller must
            # hold "share" on the layer itself, not just have it as a
            # readable shipped input.
            await authz.require(db, "layer", layer_id, user_id, "share")

        source_ref = {
            "kind": obj_in.source.kind,
            "project_id": str(obj_in.source.project_id),
            "workflow_id": str(obj_in.source.workflow_id)
            if obj_in.source.workflow_id
            else None,
            "layout_id": str(obj_in.source.layout_id)
            if obj_in.source.layout_id
            else None,
            "seed_id": None,
        }
        template = Template(
            name=obj_in.name,
            description=obj_in.description,
            categories=list(obj_in.categories),
            thumbnail_url=thumbnail_url,
            space_id=destination_space.id,
            folder_id=obj_in.folder_id,
            user_id=user_id,
            payload_kind=payload_kind,
            config=config,
            page_size=obj_in.page_size,
            page_orientation=obj_in.page_orientation,
            source_project_id=source_project_id,
            source_ref=source_ref,
            inputs=[i.model_dump(mode="json") for i in inputs],
        )
        db.add(template)
        await db.flush()
        assert template.id is not None

        # T6: viewer grants for shipped datasets the author kept opted-in,
        # to the destination space's own team/organisation. A personal
        # destination has no wider audience to grant to. Each layer is
        # handled through `_add_viewer_grant`, which reads that layer's own
        # existing grants first so a grant already held by some OTHER team/
        # organisation is never pruned by this write.
        if obj_in.share_datasets and destination_space.kind != SpaceKind.personal:
            for layer_id in obj_in.share_datasets:
                await self._add_viewer_grant(
                    db,
                    layer_id=layer_id,
                    destination_space=destination_space,
                    user_id=user_id,
                )

        await db.commit()
        await db.refresh(template)
        my_role = await authz.effective_role(db, "template", template.id, user_id)
        assert my_role is not None
        return await self._to_read(db, template, my_role=my_role)

    # ------------------------------------------------------------------
    # List
    # ------------------------------------------------------------------

    @staticmethod
    def parse_categories(raw: str | None) -> list[str]:
        """Parse a `categories=` query value into the lowercase tags a
        template must ALL carry to match.

        The wire format is one comma-separated string ("Mobility,Transit");
        blanks are dropped and duplicates collapsed, so an empty or
        whitespace-only value means "no category filter".
        """
        if not raw:
            return []
        return sorted({part.strip().lower() for part in raw.split(",") if part.strip()})

    async def _readable_conditions(
        self,
        db: AsyncSession,
        *,
        user_id: UUID,
        source: str,
        kind: str | None,
        categories: str | None,
        source_project_id: UUID | None = None,
        source_workflow_id: UUID | None = None,
        source_layout_id: UUID | None = None,
    ) -> tuple[list[str], dict[str, Any]] | None:
        """The WHERE conditions and bound parameters shared by every query
        over the caller's readable templates.

        Returns None when the caller has no scope at all to look in (the
        query would match nothing). `effective_role IS NOT NULL` is left to
        the caller, which applies it outside the candidate set.
        """
        buckets = await self._caller_spaces(db, user_id)
        scoped_space_ids: list[UUID] = []
        include_goat = False
        if source in ("mine", "all"):
            scoped_space_ids += buckets["personal"]
        if source in ("team", "all"):
            scoped_space_ids += buckets["team"]
        if source in ("org", "all"):
            scoped_space_ids += buckets["organization"]
        if source in ("goat", "all"):
            include_goat = True

        schema = settings.SCHEMA
        # A template shared with the caller (T3) lives in someone else's space,
        # so no space bucket reaches it; it comes in through its grant — a
        # direct user grant, or one to a team or the organisation the caller
        # belongs to. `effective_role` still decides afterwards whether the
        # grant actually confers read.
        # A template reaches a non-member through a grant on the template
        # itself or on any folder above it — the same walk `effective_role`
        # makes for a single read, so the list agrees with what a read would
        # allow. Most templates travel that way: a folder shared with a team
        # or an organisation, not a grant on each template. `all` takes every
        # such grant; `team` and `org` take the ones to the caller's teams or
        # organisation, so a template shared with the organisation is listed
        # under Organization, and `shared` the ones to the caller alone.
        if source == "all":
            granted = f"""({schema}.direct_grant_rank('template', t.id, :user_id) > 0
                 OR EXISTS (SELECT 1 FROM {schema}.folder_chain(t.folder_id) AS fc(folder_id)
                             WHERE {schema}.direct_grant_rank('folder', fc.folder_id, :user_id) > 0))"""
        elif source in _SHARED_THROUGH:
            granted = _shared_through_sql(schema, _SHARED_THROUGH[source])
        else:
            granted = "FALSE"
        if not scoped_space_ids and not include_goat and granted == "FALSE":
            return None
        conditions = [
            "t.deleted_at IS NULL",
            "(t.space_id = ANY(:space_ids)"
            " OR (:include_goat AND t.catalog_status = 'published')"
            f" OR {granted})",
        ]
        params: dict[str, Any] = {
            "space_ids": scoped_space_ids,
            "include_goat": include_goat,
            "user_id": user_id,
        }
        # The three filterable kinds are the three payload kinds, so the
        # filter is exact in SQL; the extra badges a project payload carries
        # (`kinds_for`) describe what it includes and are not filters.
        if kind in ("workflow", "layout", "project"):
            conditions.append("t.payload_kind = :kind")
            params["kind"] = kind
        # The save dialog's "templates already saved from this source": one
        # exact condition per given id on the stored source reference.
        for column, value in (
            ("project_id", source_project_id),
            ("workflow_id", source_workflow_id),
            ("layout_id", source_layout_id),
        ):
            if value is not None:
                conditions.append(f"t.source_ref->>'{column}' = :source_{column}")
                params[f"source_{column}"] = str(value)
        wanted = self.parse_categories(categories)
        if wanted:
            # All-of, case-insensitive: the row's lowercased categories must
            # contain every requested tag. A template with no categories
            # aggregates to NULL and is therefore never matched.
            conditions.append(
                "(SELECT array_agg(lower(c)) FROM unnest(t.categories) AS c)"
                " @> CAST(:categories AS text[])"
            )
            params["categories"] = wanted
        return conditions, params

    async def list_templates(
        self,
        db: AsyncSession,
        *,
        user_id: UUID,
        space_id: UUID | None,
        folder_id: UUID | None,
        source: str,
        kind: str | None,
        search: str | None,
        categories: str | None = None,
        source_project_id: UUID | None = None,
        source_workflow_id: UUID | None = None,
        source_layout_id: UUID | None = None,
        page: int,
        size: int,
    ) -> TemplatePage:
        schema = settings.SCHEMA
        prepared = await self._readable_conditions(
            db,
            user_id=user_id,
            source=source,
            kind=kind,
            categories=categories,
            source_project_id=source_project_id,
            source_workflow_id=source_workflow_id,
            source_layout_id=source_layout_id,
        )
        if prepared is None:
            return TemplatePage(items=[], total=0)
        conditions, params = prepared

        # Built as raw SQL (rather than the ORM query builder) to match this
        # codebase's convention for content-listing queries — see
        # `crud_content.py`'s module docstring for why. `effective_role` is
        # computed once per candidate row in the `candidates` CTE (not once
        # per row in a Python loop, which was an N+1 round trip per row
        # regardless of page size); `role IS NOT NULL` and the pagination
        # (`LIMIT`/`OFFSET`, `count(*) OVER ()` for `total`) both happen in
        # the outer query, so only `size` rows are ever hydrated afterwards.
        params["limit"] = size
        params["offset"] = (page - 1) * size
        if space_id is not None:
            conditions.append("t.space_id = :filter_space_id")
            params["filter_space_id"] = space_id
        if folder_id is not None:
            conditions.append("t.folder_id = :filter_folder_id")
            params["filter_folder_id"] = folder_id
        if search:
            conditions.append("(t.name ILIKE :search OR t.description ILIKE :search)")
            params["search"] = f"%{search}%"
        where_sql = " AND ".join(conditions)

        rows = (
            await db.execute(
                text(
                    f"""
                    WITH candidates AS (
                        SELECT t.id, t.updated_at,
                               {schema}.effective_role('template', t.id, :user_id) AS role
                        FROM {schema}.template t
                        WHERE {where_sql}
                    )
                    SELECT id, role, count(*) OVER () AS total
                    FROM candidates
                    WHERE role IS NOT NULL
                    ORDER BY updated_at DESC
                    LIMIT :limit OFFSET :offset
                    """
                ),
                params,
            )
        ).all()

        total = rows[0].total if rows else 0
        hydrated: list[tuple[Template, str]] = []
        for r in rows:
            row = await db.get(Template, r.id)
            if row is not None:
                hydrated.append((row, r.role))
        shared_into = await self._shared_into_spaces(
            db, user_id, [row for row, _ in hydrated]
        )
        items: list[TemplateRead] = []
        for row, role in hydrated:
            read = await self._to_read(db, row, my_role=role)
            read.shared_into_space_id = shared_into.get(row.id)
            items.append(read)

        return TemplatePage(items=items, total=total)

    async def list_categories(
        self,
        db: AsyncSession,
        *,
        user_id: UUID,
        source: str,
        kind: str | None,
    ) -> list[TemplateCategoryFacet]:
        """The categories in use on the caller's readable templates, with a
        count each (`GET /template/categories`).

        Same visibility and same `source`/`kind` narrowing as
        `list_templates`, so the counts describe exactly the templates the
        same request would list. Categories are free-form strings grouped
        case-insensitively; the reported `name` is the spelling of the
        template that first used it (earliest `created_at`, template id as
        the tie-break), and a template carrying two spellings of one
        category counts once. Ordered by count descending, then name.
        """
        schema = settings.SCHEMA
        prepared = await self._readable_conditions(
            db, user_id=user_id, source=source, kind=kind, categories=None
        )
        if prepared is None:
            return []
        conditions, params = prepared
        where_sql = " AND ".join(conditions)

        rows = (
            await db.execute(
                text(
                    f"""
                    WITH candidates AS (
                        SELECT t.id, t.created_at, t.categories,
                               {schema}.effective_role('template', t.id, :user_id) AS role
                        FROM {schema}.template t
                        WHERE {where_sql}
                    ), tags AS (
                        SELECT c.id, c.created_at, btrim(tag) AS name
                        FROM candidates c, unnest(c.categories) AS tag
                        WHERE c.role IS NOT NULL AND btrim(tag) <> ''
                    ), grouped AS (
                        SELECT (array_agg(name ORDER BY created_at, id))[1] AS name,
                               count(DISTINCT id) AS cnt
                        FROM tags
                        GROUP BY lower(name)
                    )
                    SELECT name, cnt FROM grouped
                    ORDER BY cnt DESC, lower(name) ASC
                    """
                ),
                params,
            )
        ).all()
        return [TemplateCategoryFacet(name=r.name, count=r.cnt) for r in rows]

    # ------------------------------------------------------------------
    # Read / update / delete / refresh
    # ------------------------------------------------------------------

    async def _get_live(self, db: AsyncSession, template_id: UUID) -> Template:
        row = await db.get(Template, template_id)
        if row is None or row.deleted_at is not None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Template not found"
            )
        return row

    async def get(
        self,
        db: AsyncSession,
        *,
        template_id: UUID,
        user_id: UUID,
        include_config: bool,
    ) -> TemplateRead:
        await authz.require(db, "template", template_id, user_id, "read")
        row = await self._get_live(db, template_id)
        my_role = await authz.effective_role(db, "template", template_id, user_id)
        assert my_role is not None
        read = await self._to_read(db, row, my_role=my_role)
        read.shared_into_space_id = (
            await self._shared_into_spaces(db, user_id, [row])
        ).get(template_id)
        read.source = await self._resolve_source(db, row, user_id)
        if (
            include_config
            and my_role in ("owner", "editor")
            and row.payload_kind != "project"
        ):
            read.config = row.config
        return read

    async def update(
        self,
        db: AsyncSession,
        *,
        template_id: UUID,
        user_id: UUID,
        obj_in: TemplateUpdate,
    ) -> TemplateRead:
        await authz.require(db, "template", template_id, user_id, "write")
        row = await self._get_live(db, template_id)
        data = obj_in.model_dump(exclude_unset=True)
        data.pop("folder_id", None)
        for field, value in data.items():
            setattr(row, field, value)
        if obj_in.folder_id is not None:
            # Mirrors the layer-move guard (endpoints/v2/layer.py): same-space
            # check first (`assert_same_space` also covers the space's
            # root/home folder — it is a live `Folder` row like any other,
            # just with no parent), then a separate write check on the
            # DESTINATION folder — write on the template alone is not enough
            # to drop it into a folder the caller may not write into (e.g. a
            # restricted folder in the same space).
            try:
                await crud_folder.assert_same_space(
                    db, folder_id=obj_in.folder_id, space_id=row.space_id
                )
            except FolderNotFoundError as exc:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
                ) from exc
            await authz.require(db, "folder", obj_in.folder_id, user_id, "write")
            row.folder_id = obj_in.folder_id
        db.add(row)
        await db.commit()
        await db.refresh(row)
        my_role = await authz.effective_role(db, "template", template_id, user_id)
        assert my_role is not None
        return await self._to_read(db, row, my_role=my_role)

    async def delete(
        self, db: AsyncSession, *, template_id: UUID, user_id: UUID
    ) -> None:
        # Owner-only (rank 3): the same tier `authz.can`/`can()` calls "delete".
        await authz.require(db, "template", template_id, user_id, "delete")
        row = await self._get_live(db, template_id)
        now = datetime.now(timezone.utc)
        row.deleted_at = now
        db.add(row)
        if row.source_project_id is not None:
            source_project = await db.get(Project, row.source_project_id)
            if source_project is not None and source_project.deleted_at is None:
                source_project.deleted_at = now
                db.add(source_project)
        await db.commit()

    async def refresh(
        self, db: AsyncSession, *, template_id: UUID, user_id: UUID
    ) -> TemplateRead:
        # Owner-only (rank 3), same tier as delete.
        await authz.require(db, "template", template_id, user_id, "delete")
        row = await self._get_live(db, template_id)
        source_ref = row.source_ref or {}
        project_id_raw = source_ref.get("project_id")
        if project_id_raw is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Template has no recorded source to refresh from",
            )
        project_id = UUID(project_id_raw)
        # A refresh re-snapshots the source project's current contents into the
        # template, so it needs `read` on that project — the same check
        # `create` and `preview` make. Owning the template is not enough: the
        # source can have been shared with the template's owner at create time
        # and unshared since, or the template can have changed hands.
        await authz.require(db, "project", project_id, user_id, "read")
        datasets_needing_share: list[DatasetShareLine] = []

        if row.payload_kind == "workflow":
            workflow_id_raw = source_ref.get("workflow_id")
            wf = (
                await crud_workflow.get_by_project_and_id(
                    db, project_id=project_id, workflow_id=UUID(workflow_id_raw)
                )
                if workflow_id_raw
                else None
            )
            if wf is None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="The source workflow no longer exists",
                )
            # B2: the stored `inputs` were frozen at save time and can go
            # stale — a dataset node added to the source since is invisible
            # to the old list, so it would freeze with the author's raw
            # `layerId` and no `templateInput` marker (never read-checked,
            # never counted by the publish guard). Reconcile against a fresh
            # detection instead of reusing the stored list as-is: a
            # surviving key keeps its author-chosen mode (and has its
            # dataset flags recomputed live, since the layer's catalog
            # registration and visibility can have changed); a newly-detected key has no
            # prior author decision, so it defaults to "ask"; a key that no
            # longer appears in the source is dropped. A surviving key keeps
            # its `copy_content` too, so a "copy" input stays a copy.
            old_by_key = {i["key"]: TemplateInput(**i) for i in (row.inputs or [])}
            detected = detect_workflow_inputs(dict(wf.config or {}))
            reconciled: list[TemplateInput] = []
            for d in detected:
                old = old_by_key.get(d.key)
                if old is not None:
                    reconciled.append(
                        old.model_copy(
                            update={
                                "label": d.label,
                                "layer_type": d.layer_type,
                                "geometry_type": d.geometry_type,
                            }
                        )
                    )
                else:
                    reconciled.append(
                        TemplateInput(
                            key=d.key,
                            label=d.label,
                            mode="ask",
                            layer_id=None,
                            layer_type=d.layer_type,
                            geometry_type=d.geometry_type,
                        )
                    )
            reconciled = await self._with_layer_flags(db, reconciled)
            await self._assert_ship_inputs_readable(db, reconciled, user_id)
            await self._assert_copy_inputs_copyable(db, reconciled)
            row.inputs = [i.model_dump(mode="json") for i in reconciled]
            row.config = freeze_workflow_config(dict(wf.config or {}), reconciled)
            # T6: a reconciled ship input can newly need a share into the
            # template's own space (the fresh node may ship a dataset the
            # old snapshot never carried) — refresh never auto-grants this,
            # it only reports it back for the caller to act on.
            destination_space = await db.get(Space, row.space_id)
            if destination_space is not None:
                datasets_needing_share = await self._share_lines_for_ship_inputs(
                    db, reconciled, destination_space
                )
        elif row.payload_kind == "layout":
            layout_id_raw = source_ref.get("layout_id")
            layout = (
                await crud_report_layout.get_by_project_and_id(
                    db, project_id=project_id, layout_id=UUID(layout_id_raw)
                )
                if layout_id_raw
                else None
            )
            if layout is None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="The source layout no longer exists",
                )
            row.config = strip_layout_bindings(dict(layout.config or {}))
        else:
            source_project = await db.get(Project, project_id)
            if source_project is None or source_project.deleted_at is not None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="The source project no longer exists",
                )
            old_copy_id = row.source_project_id
            # Each dataset keeps the author's ship/copy choice across the
            # re-snapshot (keys are `layer:<id>`, the same layer in the new
            # frozen copy); a dataset added to the source since is shipped,
            # as on a first save, and one removed from it is dropped.
            old_by_key = {i["key"]: TemplateInput(**i) for i in (row.inputs or [])}
            source_inputs = await self._project_inputs(db, project_id)
            kept_choices = [
                old_by_key[i.key] for i in source_inputs if i.key in old_by_key
            ]
            planned = self._apply_project_choices(source_inputs, kept_choices)
            await self._assert_ship_inputs_readable(db, planned, user_id)
            await self._assert_copy_inputs_copyable(db, planned)
            new_copy = await copy_project(
                db,
                project_id=project_id,
                user_id=user_id,
                target_folder_id=source_project.folder_id,
                mark_template_source=True,
            )
            row.source_project_id = new_copy.id
            assert new_copy.id is not None
            new_inputs = self._apply_project_choices(
                await self._project_inputs(db, new_copy.id), kept_choices
            )
            await self._assert_ship_inputs_readable(db, new_inputs, user_id)
            row.inputs = [i.model_dump(mode="json") for i in new_inputs]
            if old_copy_id is not None and old_copy_id != new_copy.id:
                old_copy = await db.get(Project, old_copy_id)
                if old_copy is not None and old_copy.deleted_at is None:
                    old_copy.deleted_at = datetime.now(timezone.utc)
                    db.add(old_copy)

        db.add(row)
        await db.commit()
        await db.refresh(row)
        my_role = await authz.effective_role(db, "template", template_id, user_id)
        assert my_role is not None
        return await self._to_read(
            db,
            row,
            my_role=my_role,
            datasets_needing_share=datasets_needing_share,
        )

    # ------------------------------------------------------------------
    # Use (T7)
    # ------------------------------------------------------------------

    async def _new_project_for_use(
        self,
        db: AsyncSession,
        *,
        folder_id: UUID,
        user_id: UUID,
        name: str,
        headers: Any = None,
        peer: str | None = None,
    ) -> UUID:
        """Create the project a workflow/layout template's "Use" lands in
        when no existing `project_id` was given: the same defaults a directly
        created project gets, starting view included. Requires `write`
        on `folder_id`."""
        await authz.require(db, "folder", folder_id, user_id, "write")
        folder = await db.get(Folder, folder_id)
        if folder is None or folder.deleted_at is not None or folder.space_id is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
            )
        project = await crud_project.create(
            db,
            project_in=Project(
                name=name,
                folder_id=folder_id,
                space_id=folder.space_id,
                user_id=user_id,
            ),
            initial_view_state=await resolve_initial_view_state(
                db, user_id=user_id, headers=headers, peer=peer
            ),
        )
        assert project.id is not None
        return project.id

    async def _resolve_workflow_inputs(
        self,
        db: AsyncSession,
        inputs: list[TemplateInput],
        *,
        target_project_id: UUID,
        user_id: UUID,
        bindings_in: dict[str, UUID],
        group_name: str,
        link: bool = True,
    ) -> tuple[dict[str, tuple[UUID | None, int | None]], list[int], list[_CopyPlan]]:
        """Resolve a workflow template's declared inputs into the target
        project (T7, step 2 of "Using a template").

        For each input: the caller's ``bindings_in[key]`` override wins
        when given; otherwise a "ship" or "copy" input falls back to its
        ``layer_id``. Either way the candidate only resolves if it is a
        live layer the caller may read — an unreadable or deleted shipped
        layer, and an "ask" input with no binding, are left unresolved
        (reported back by ``bind_workflow_config``, not by this method).

        A resolved layer that already has a ``layer_project`` link in the
        target project reuses that link (no duplicate on the map); a new
        one is created inside a ``LayerProjectGroup`` named after the
        template — created once, lazily, only if there is at least one
        layer to put in it.

        A "copy" input the caller did not bind gets a link of its own, never
        an existing one: the ``layer_copy`` job puts the caller's copy behind
        that link, and an entry the project already had keeps showing what
        it showed. Two copy inputs naming the same dataset share one link,
        and so one copy (with its rows if either asks for them). The link is
        named after the dataset. An entry an earlier use made for a copy of
        the same dataset (``template_copy`` stamp) is used again: bound to
        as it is when its copy is there, and given its job again when the
        copy never arrived.

        Returns ``(bindings, added_link_ids, copy_plans)``: ``bindings`` is
        what ``bind_workflow_config`` expects, ``key -> (layer_id,
        layer_project_id)`` with ``(None, None)`` for anything left
        unresolved; ``added_link_ids`` lists only the NEWLY created links
        (a reused, already-existing link was not "added" by this call);
        ``copy_plans`` the copies to start, one per copied dataset.

        With ``link=False`` nothing is written: a layer that would get a new
        link resolves to ``(layer_id, None)``, and no link or copy plan is
        returned (``preview_use``).
        """
        bindings: dict[str, tuple[UUID | None, int | None]] = {}
        added_ids: list[int] = []
        group_id: int | None = None
        copy_plans: dict[UUID, _CopyPlan] = {}

        existing_rows = (
            await db.execute(
                text(
                    f"SELECT layer_id, id FROM {settings.SCHEMA}.layer_project "
                    "WHERE project_id = :project_id"
                ),
                {"project_id": target_project_id},
            )
        ).all()
        existing_by_layer: dict[UUID, int] = {r.layer_id: r.id for r in existing_rows}
        # Entries an earlier use of a copy template made for its copies, by
        # source: a later use binds to that entry (and its copy) again
        # instead of adding another entry and another copy each time.
        copy_entries = (
            await db.execute(
                text(
                    f"SELECT id, layer_id, "
                    f"other_properties -> '{COPY_STAMP}' ->> 'source_layer_id' AS source "
                    f"FROM {settings.SCHEMA}.layer_project "
                    "WHERE project_id = :project_id "
                    f"AND other_properties -> '{COPY_STAMP}' ->> 'source_layer_id' IS NOT NULL "
                    "ORDER BY id"
                ),
                {"project_id": target_project_id},
            )
        ).all()
        copy_entry_by_source: dict[UUID, Any] = {}
        for r in copy_entries:
            copy_entry_by_source.setdefault(UUID(r.source), r)

        async def new_link(layer_id: UUID) -> int:
            nonlocal group_id
            if group_id is None:
                group = LayerProjectGroup(project_id=target_project_id, name=group_name)
                db.add(group)
                await db.flush()
                assert group.id is not None
                group_id = group.id
            created = await crud_layer_project.create(
                db,
                target_project_id,
                [layer_id],
                user_id=user_id,
                group_id=group_id,
            )
            assert created
            created_link: Any = created[0]
            assert created_link.id is not None
            link_id = cast(int, created_link.id)
            added_ids.append(link_id)
            return link_id

        for i in inputs:
            candidate = bindings_in.get(i.key)
            copies = i.mode == "copy" and candidate is None
            if candidate is None and i.mode in DATASET_MODES:
                candidate = i.layer_id
            layer_id: UUID | None = None
            if candidate is not None:
                layer = await db.get(Layer, candidate)
                if (
                    layer is not None
                    and layer.deleted_at is None
                    # An empty copy of the template's own dataset needs no
                    # read of it: the copy job reads it for the template.
                    and (
                        (copies and i.empty_copy)
                        or await authz.can(db, "layer", candidate, user_id, "read")
                    )
                ):
                    layer_id = candidate
            if layer_id is None:
                bindings[i.key] = (None, None)
                continue
            if copies:
                earlier = copy_entry_by_source.get(layer_id)
                if earlier is not None and earlier.layer_id != layer_id:
                    # Copied by an earlier use: bind to the copy, nothing to do.
                    bindings[i.key] = (earlier.layer_id, earlier.id)
                    continue
                if not link:
                    bindings[i.key] = (
                        layer_id,
                        cast(int, earlier.id) if earlier is not None else None,
                    )
                    continue
                plan = copy_plans.get(layer_id)
                if plan is None:
                    if earlier is not None:
                        # An earlier use's copy never arrived: start it again.
                        link_id = cast(int, earlier.id)
                    else:
                        link_id = await new_link(layer_id)
                        # The entry is named after the dataset, not the
                        # "Copy from …" a second entry of a layer gets.
                        await db.execute(
                            text(
                                f"UPDATE {settings.SCHEMA}.layer_project "
                                "SET name = :name WHERE id = :id"
                            ),
                            {
                                "name": layer.name if layer is not None else None,
                                "id": link_id,
                            },
                        )
                    plan = _CopyPlan(
                        keys=[],
                        source_layer_id=layer_id,
                        link_ids=[link_id],
                        copy_content=False,
                    )
                    copy_plans[layer_id] = plan
                plan.keys.append(i.key)
                plan.copy_content = plan.copy_content or i.copy_content
                bindings[i.key] = (layer_id, plan.link_ids[0])
                continue
            existing = existing_by_layer.get(layer_id)
            if existing is None and link:
                existing = await new_link(layer_id)
                existing_by_layer[layer_id] = existing
            bindings[i.key] = (layer_id, existing)

        return bindings, added_ids, list(copy_plans.values())

    async def _project_copy_plans(
        self, db: AsyncSession, inputs: list[TemplateInput], project_id: UUID
    ) -> list[_CopyPlan]:
        """The copies a project template's "copy" inputs need in the project
        just made from it: one per dataset, covering every entry of that
        project showing it (the frozen copy can show one dataset twice, with
        two stylings — both then show the one copy)."""
        plans: dict[UUID, _CopyPlan] = {}
        for i in inputs:
            if i.mode != "copy" or i.layer_id is None:
                continue
            plan = plans.setdefault(
                i.layer_id,
                _CopyPlan(keys=[], source_layer_id=i.layer_id, copy_content=False),
            )
            plan.keys.append(i.key)
            plan.copy_content = plan.copy_content or i.copy_content
        if not plans:
            return []
        rows = (
            await db.execute(
                text(
                    f"SELECT id, layer_id FROM {settings.SCHEMA}.layer_project "
                    "WHERE project_id = :project_id AND layer_id = ANY(:layer_ids) "
                    "ORDER BY id"
                ),
                {"project_id": project_id, "layer_ids": list(plans)},
            )
        ).all()
        for r in rows:
            plans[r.layer_id].link_ids.append(r.id)
        return [plan for plan in plans.values() if plan.link_ids]

    async def _start_copy_jobs(
        self,
        db: AsyncSession,
        plans: list[_CopyPlan],
        *,
        project_id: UUID,
        template_id: UUID,
        user_id: UUID,
        access_token: str | None,
    ) -> list[TemplateCopyJob]:
        """Start one ``layer_copy`` job per copied dataset.

        Runs after the project and its entries exist, since the job reads
        them. A job that cannot start does not fail the use: its entries
        keep showing the author's dataset (read-only, exactly like "ship"),
        and the returned row says why. The caller is asked to read the
        source once more here, as the job's own access check would: a
        project template's frozen copy links every dataset whether or not
        this caller may read it.

        v1 copies the dataset as it is now, not as it was when the template
        was saved: the job is handed the live layer. A snapshot frozen at
        save time would be a layer of the template's own, named here
        instead of ``source_layer_id``; nothing else about the job changes.
        """
        jobs: list[TemplateCopyJob] = []
        for plan in plans:
            job = TemplateCopyJob(
                key=plan.keys[0],
                source_layer_id=plan.source_layer_id,
                layer_project_ids=plan.link_ids,
                copy_content=plan.copy_content,
            )
            jobs.append(job)
            stamp = {
                "source_layer_id": str(plan.source_layer_id),
                "template_id": str(template_id),
                "copy_content": plan.copy_content,
            }
            # With its rows, the copy needs a read of the dataset; an empty
            # one only of the template (processes checks the same).
            if plan.copy_content:
                readable = await authz.can(
                    db, "layer", plan.source_layer_id, user_id, "read"
                )
            else:
                readable = await authz.can(db, "template", template_id, user_id, "read")
            if not readable:
                job.error = "source_not_readable"
                await self._stamp_copy_entries(
                    db, plan.link_ids, {**stamp, "status": "failed", "error": job.error}
                )
                continue
            await self._stamp_copy_entries(
                db, plan.link_ids, {**stamp, "status": "pending"}
            )
            entry_name = (
                await db.execute(
                    text(
                        f"SELECT name FROM {settings.SCHEMA}.layer_project WHERE id = :id"
                    ),
                    {"id": plan.link_ids[0]},
                )
            ).scalar_one_or_none()
            try:
                job_id = await execute_process(
                    process_id=LAYER_COPY_PROCESS,
                    inputs={
                        "source_layer_id": str(plan.source_layer_id),
                        "project_id": str(project_id),
                        "layer_project_ids": plan.link_ids,
                        "copy_content": plan.copy_content,
                        "template_id": str(template_id),
                        "layer_name": entry_name,
                    },
                    access_token=access_token or "",
                )
            except Exception as exc:  # noqa: BLE001 - reported, never raised
                logger.warning(
                    "Copy of layer %s for project %s did not start: %s",
                    plan.source_layer_id,
                    project_id,
                    exc,
                )
                job.error = "copy_not_started"
            else:
                if job_id:
                    job.job_id = job_id
                else:
                    job.error = "copy_not_started"
            if job.error is not None:
                await self._stamp_copy_entries(
                    db, plan.link_ids, {**stamp, "status": "failed", "error": job.error}
                )
        return jobs

    async def _stamp_copy_entries(
        self, db: AsyncSession, link_ids: list[int], stamp: dict[str, Any]
    ) -> None:
        """Record on the entries of a copy where it stands: ``pending`` once
        its job is started, ``failed`` (with why) when it could not start.
        The job sets ``done`` when it points them at the copy, or ``failed``
        when it fails. A project can thus show a copy that never arrived
        and start it again (a later use of the template does)."""
        await db.execute(
            text(
                f"UPDATE {settings.SCHEMA}.layer_project "
                "SET other_properties = (CASE WHEN jsonb_typeof(other_properties) = 'object' "
                "THEN other_properties ELSE '{}'::jsonb END) "
                f"|| jsonb_build_object('{COPY_STAMP}', CAST(:stamp AS jsonb)) "
                "WHERE id = ANY(:ids)"
            ),
            {"ids": link_ids, "stamp": json.dumps(stamp)},
        )
        await db.commit()

    async def use(
        self,
        db: AsyncSession,
        *,
        template_id: UUID,
        user_id: UUID,
        req: TemplateUseRequest,
        headers: Any = None,
        peer: str | None = None,
        access_token: str | None = None,
    ) -> TemplateUseResult:
        """Use a template (T7): create/insert its payload into a target,
        linking whatever shipped datasets the caller may read. Nothing is
        executed — a workflow/layout row is only ever created, never run —
        except one ``layer_copy`` job per "copy" dataset, started with the
        caller's ``access_token`` once everything else is in place
        (``_start_copy_jobs``); the result lists them in ``copy_jobs``.

        Requires `read` on the template, plus `write` on the target:
        `project_id` (an existing project — workflow/layout payloads
        only) or `target_folder_id` (a new project, or a project payload's
        `copy_project` destination). Exactly one of the two is required; a
        project payload always creates a new project, so it requires
        `target_folder_id`.
        """
        await authz.require(db, "template", template_id, user_id, "read")
        row = await self._get_live(db, template_id)

        if (req.project_id is None) == (req.target_folder_id is None):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Exactly one of project_id or target_folder_id is required",
            )
        if row.payload_kind == "project" and req.target_folder_id is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="A project template creates a new project; target_folder_id is required",
            )

        name = req.name or row.name

        if row.payload_kind == "project":
            if row.source_project_id is None:
                # C1: a project template whose frozen source copy is gone
                # (e.g. purged, or its restore missed the mirrored frozen
                # copy) has nothing left to copy from — 409 rather than the
                # unhandled AssertionError this used to raise.
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={"code": "template_source_missing"},
                )
            assert req.target_folder_id is not None
            try:
                new_project = await copy_project(
                    db,
                    project_id=row.source_project_id,
                    user_id=user_id,
                    target_folder_id=req.target_folder_id,
                    mark_template_source=False,
                    cross_space=True,
                )
            except FolderNotFoundError as exc:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
                ) from exc
            new_project.name = name
            db.add(new_project)
            await db.commit()
            await db.refresh(new_project)
            assert new_project.id is not None
            project_inputs = [TemplateInput(**i) for i in (row.inputs or [])]
            plans = await self._project_copy_plans(db, project_inputs, new_project.id)
            return TemplateUseResult(
                project_id=new_project.id,
                copy_jobs=await self._start_copy_jobs(
                    db,
                    plans,
                    project_id=new_project.id,
                    template_id=template_id,
                    user_id=user_id,
                    access_token=access_token,
                ),
            )

        # Workflow / layout payload: an existing project (write required),
        # or a brand-new one created in `target_folder_id`.
        if req.project_id is not None:
            await authz.require(db, "project", req.project_id, user_id, "write")
            target_project_id = req.project_id
        else:
            assert req.target_folder_id is not None
            target_project_id = await self._new_project_for_use(
                db,
                folder_id=req.target_folder_id,
                user_id=user_id,
                name=name,
                headers=headers,
                peer=peer,
            )

        if row.payload_kind == "workflow":
            inputs = [TemplateInput(**i) for i in (row.inputs or [])]
            bindings, added_ids, plans = await self._resolve_workflow_inputs(
                db,
                inputs,
                target_project_id=target_project_id,
                user_id=user_id,
                bindings_in=req.bindings,
                group_name=row.name,
            )
            bound_config, unresolved_keys = bind_workflow_config(
                dict(row.config or {}), bindings
            )
            wf = await crud_workflow.create_for_project(
                db,
                project_id=target_project_id,
                obj_in=WorkflowCreate(
                    name=name,
                    description=req.description,
                    is_default=False,
                    config=bound_config,
                ),
            )
            assert wf.id is not None
            inputs_by_key = {i.key: i for i in inputs}
            return TemplateUseResult(
                project_id=target_project_id,
                workflow_id=wf.id,
                added_layer_project_ids=added_ids,
                unresolved_inputs=[
                    inputs_by_key[k] for k in unresolved_keys if k in inputs_by_key
                ],
                copy_jobs=await self._start_copy_jobs(
                    db,
                    plans,
                    project_id=target_project_id,
                    template_id=template_id,
                    user_id=user_id,
                    access_token=access_token,
                ),
            )

        # Layout payload: inserted as is, no layers (T5 — a layout carries
        # no dataset references at all).
        layout = await crud_report_layout.create_for_project(
            db,
            project_id=target_project_id,
            obj_in=ReportLayoutCreate(
                name=name,
                description=None,
                is_default=False,
                config=dict(row.config or {}),
            ),
        )
        assert layout.id is not None
        return TemplateUseResult(project_id=target_project_id, layout_id=layout.id)

    async def preview_use(
        self,
        db: AsyncSession,
        *,
        template_id: UUID,
        user_id: UUID,
        req: TemplateUsePreviewRequest,
    ) -> TemplateUsePreview:
        """The workflow config ``use`` would write into ``req.project_id``
        with ``req.bindings``, and the inputs it would leave unresolved,
        without writing anything (``_resolve_workflow_inputs`` with
        ``link=False``), so a caller can check the workflow before it exists.
        Requires what ``use`` requires there: read on the template, write on
        the project, both checked before anything about the payload is
        answered. A workflow payload only: 422 for any other."""
        await authz.require(db, "template", template_id, user_id, "read")
        await authz.require(db, "project", req.project_id, user_id, "write")
        row = await self._get_live(db, template_id)
        if row.payload_kind != "workflow":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Only a workflow template can be previewed",
            )
        inputs = [TemplateInput(**i) for i in (row.inputs or [])]
        bindings, _, _ = await self._resolve_workflow_inputs(
            db,
            inputs,
            target_project_id=req.project_id,
            user_id=user_id,
            bindings_in=req.bindings,
            group_name=row.name,
            link=False,
        )
        frozen = dict(row.config or {})
        config, unresolved_keys = bind_workflow_config(frozen, bindings)
        # An empty copy that still reads the template's dataset gets an entry
        # of its own from the use, and the use points the tool settings
        # naming the dataset by entry at it. That entry does not exist yet:
        # the settings name the author's entry, or one that shows the
        # dataset until its copy arrives, and the user may read neither. So
        # they are cleared, as an input still to be chosen has them.
        waiting: list[tuple[int | str, int | str | None]] = []
        for i in inputs:
            layer_id, entry = bindings.get(i.key, (None, None))
            if not i.empty_copy or i.key in req.bindings or layer_id != i.layer_id:
                continue
            if entry is not None:
                waiting.append((entry, None))
                continue
            for node in frozen.get("nodes") or []:
                data = node.get("data") if isinstance(node, dict) else None
                if isinstance(data, dict) and data.get("templateInput") == i.key:
                    authors = data.get("templateSourceProjectLayerId")
                    if isinstance(authors, int):
                        waiting.append((authors, None))
        _rewrite_tool_configs(config.get("nodes") or [], waiting)
        inputs_by_key = {i.key: i for i in inputs}
        return TemplateUsePreview(
            config=config,
            unresolved_inputs=[
                inputs_by_key[k] for k in unresolved_keys if k in inputs_by_key
            ],
        )

    # ------------------------------------------------------------------
    # Publish / unpublish (T4)
    # ------------------------------------------------------------------

    async def publish(
        self, db: AsyncSession, *, template_id: UUID, user_id: UUID, is_superuser: bool
    ) -> TemplateRead:
        """Publish a template to the GOAT catalog shelf (T4). Caller must be
        a superuser — enforced by the route's `require_superuser` dependency
        (which alone gates the route), and re-checked here against
        `is_superuser` (computed by the route from that same token) as
        defence in depth against this method ever being reachable from a
        route that forgets that dependency. v1 only ever moves between
        ``none`` and ``published``.

        The caller must also at least be able to read the template — a
        superuser curating the shelf still needs some relationship to what
        they're publishing (B1); this does not widen who may publish beyond
        the superuser check above, it only narrows it further.

        Every "ship" or "copy" input's dataset must be readable by every
        signed-in user once the template is on the shelf (a copy is made
        from the author's dataset, so it needs the same read): a catalog dataset
        or a public one, checked live against the layer row (the stored
        flags are never trusted). A dataset that is neither is made public
        by the publish itself when the caller owns it (effective role
        owner — the same level the Share dialog's Public switch takes), so
        curating the shelf can never open someone else's data. Any input
        that fails raises 409 with ``{"code": "template_dataset_not_public",
        "layers": [{"id", "name"}]}`` naming every offending layer, and
        nothing is flipped.
        """
        if not is_superuser:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Superuser required"
            )
        await authz.require(db, "template", template_id, user_id, "read")
        row = await self._get_live(db, template_id)
        inputs = [TemplateInput(**i) for i in (row.inputs or [])]
        bad_layers: list[dict[str, str]] = []
        to_make_public: list[Layer] = []
        for i in inputs:
            # An empty copy is made on the template's behalf from the
            # author's dataset, which stays private (`TemplateInput.empty_copy`).
            if i.mode not in DATASET_MODES or i.layer_id is None or i.empty_copy:
                continue
            layer = await db.get(Layer, i.layer_id)
            if layer is not None and (
                layer.public_read or layer.catalog_external_uid is not None
            ):
                continue
            if (
                layer is not None
                and layer.deleted_at is None
                and await authz.effective_role(db, "layer", i.layer_id, user_id)
                == "owner"
            ):
                to_make_public.append(layer)
                continue
            bad_layers.append(
                {
                    "id": str(i.layer_id),
                    "name": (layer.name if layer is not None else None) or i.label,
                }
            )
        if bad_layers:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "template_dataset_not_public",
                    "layers": bad_layers,
                },
            )
        for layer in to_make_public:
            layer.public_read = True
            db.add(layer)
        # The stored inputs carry the flags the web reads; refresh them so
        # the response and every later read show the datasets as public.
        row.inputs = [
            i.model_dump(mode="json") for i in await self._with_layer_flags(db, inputs)
        ]

        row.catalog_status = TemplateCatalogStatus.published
        row.catalog_published_at = datetime.now(timezone.utc)
        row.catalog_reviewed_by = user_id
        db.add(row)
        await db.commit()
        await db.refresh(row)
        my_role = await authz.effective_role(db, "template", template_id, user_id)
        assert my_role is not None
        return await self._to_read(db, row, my_role=my_role)

    async def unpublish(
        self, db: AsyncSession, *, template_id: UUID, user_id: UUID, is_superuser: bool
    ) -> TemplateRead:
        """Take a template off the GOAT catalog shelf (T4): ``catalog_status``
        back to ``none``. Caller must be a superuser — enforced by the
        route's `require_superuser` dependency, re-checked here against
        `is_superuser` as defence in depth (see `publish`'s docstring) —
        plus able to read the template (B1); the shelf's blanket viewer
        access still covers a superuser with no other relationship to it,
        since this check runs before the flip below removes that access.
        """
        if not is_superuser:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Superuser required"
            )
        await authz.require(db, "template", template_id, user_id, "read")
        row = await self._get_live(db, template_id)
        # E1: read the caller's role BEFORE the flip below. Unpublishing can
        # be the caller's ONLY access to this template (a superuser whose
        # sole relationship to it was the shelf's blanket viewer role) — by
        # the time `catalog_status` is `none`, `effective_role` can come
        # back None, and the response still needs to report some role for a
        # write that already committed. Never `assert` on this.
        my_role = (
            await authz.effective_role(db, "template", template_id, user_id) or "viewer"
        )
        row.catalog_status = TemplateCatalogStatus.none
        row.catalog_reviewed_by = user_id
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return await self._to_read(db, row, my_role=my_role)

    # ------------------------------------------------------------------
    # Grants (T3/T6)
    # ------------------------------------------------------------------

    async def _grant_name(
        self, db: AsyncSession, grantee_type: str, grantee_id: UUID
    ) -> str:
        """Display name for a grant's grantee, for `TemplateGrantRead`."""
        if grantee_type == "team":
            team = await db.get(Team, grantee_id)
            return team.name if team is not None else str(grantee_id)
        if grantee_type == "organization":
            org = await db.get(Organization, grantee_id)
            return org.name if org is not None else str(grantee_id)
        user = await db.get(User, grantee_id)
        if user is None:
            return str(grantee_id)
        name = " ".join(part for part in (user.firstname, user.lastname) if part)
        return name or user.email or str(grantee_id)

    async def list_grants(
        self, db: AsyncSession, *, template_id: UUID, user_id: UUID
    ) -> TemplateGrantsResponse:
        """List the direct grants on a template (T3/T6). Requires write
        (editor+) — not merely read (E2): once a template is published,
        every authenticated user is a viewer, so a read-only gate would make
        the full grantee list (individual users included) world-readable on
        every published template. Matches bundle grants' own gate.

        Built as raw SQL, matching this file's convention for every other
        query (see `list_templates`'s docstring) — this codebase's SQLModel
        column attributes are not typed for the ORM query builder's
        comparison operators (`==`, `.in_()`), so `select(...).where(...)`
        against them is a mypy error here, not just a style choice.
        """
        await authz.require(db, "template", template_id, user_id, "write")
        rows = (
            await db.execute(
                text(
                    "SELECT rg.id, rg.grantee_type, rg.grantee_id, rg.granted_by, "
                    "rg.created_at, r.name AS role_name "
                    f"FROM {settings.SCHEMA}.resource_grant rg "
                    f"JOIN {settings.SCHEMA}.role r ON r.id = rg.role_id "
                    "WHERE rg.resource_type = 'template' AND rg.resource_id = :template_id"
                ),
                {"template_id": template_id},
            )
        ).all()
        grants = [
            TemplateGrantRead(
                id=r.id,
                grantee_type=r.grantee_type,
                grantee_id=r.grantee_id,
                grantee_name=await self._grant_name(db, r.grantee_type, r.grantee_id),
                role=r.role_name,
                granted_by=r.granted_by,
                created_at=r.created_at,
            )
            for r in rows
        ]
        return TemplateGrantsResponse(grants=grants)

    async def add_grant(
        self,
        db: AsyncSession,
        *,
        template_id: UUID,
        user_id: UUID,
        obj_in: TemplateGrantCreate,
    ) -> TemplateGrantRead:
        """Grant `template-viewer` or `template-editor` on a template to a
        user, team, or organization (T3/T6). Owner only (rank 3, same tier
        as delete/refresh). Upserts on `resource_grant`'s
        (resource_type, resource_id, grantee_type, grantee_id) unique
        constraint: a second grant for the same grantee replaces its role
        rather than adding a duplicate row.
        """
        await authz.require(db, "template", template_id, user_id, "delete")
        role_id = (
            await db.execute(
                text(f"SELECT id FROM {settings.SCHEMA}.role WHERE name = :name"),
                {"name": obj_in.role},
            )
        ).scalar_one_or_none()
        if role_id is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"Unknown role {obj_in.role!r}",
            )
        # Sharing stays inside the caller's organization (D14), settled before
        # anything is written: core's engine runs in AUTOCOMMIT, so a refusal
        # after the insert would leave the grant behind.
        await crud_share.assert_grantees_in_organization(
            db,
            granted_by=user_id,
            wanted=[(obj_in.grantee_type, obj_in.grantee_id, obj_in.role)],
        )
        row = (
            await db.execute(
                text(
                    f"""
                    INSERT INTO {settings.SCHEMA}.resource_grant
                        (resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by)
                    VALUES ('template', :template_id, :grantee_type, :grantee_id, :role_id, :granted_by)
                    ON CONFLICT ON CONSTRAINT resource_grant_resource_type_resource_id_grantee_type_grant_key
                    DO UPDATE SET role_id = EXCLUDED.role_id, granted_by = EXCLUDED.granted_by
                    RETURNING id, granted_by, created_at
                    """
                ),
                {
                    "template_id": template_id,
                    "grantee_type": obj_in.grantee_type,
                    "grantee_id": obj_in.grantee_id,
                    "role_id": role_id,
                    "granted_by": user_id,
                },
            )
        ).one()
        template_row = await db.get(Template, template_id)
        if template_row is not None:
            await self._share_shipped_datasets_with(
                db,
                row=template_row,
                grantee_type=obj_in.grantee_type,
                grantee_id=str(obj_in.grantee_id),
                user_id=user_id,
            )
        await db.commit()
        return TemplateGrantRead(
            id=row.id,
            grantee_type=obj_in.grantee_type,
            grantee_id=obj_in.grantee_id,
            grantee_name=await self._grant_name(
                db, obj_in.grantee_type, obj_in.grantee_id
            ),
            role=obj_in.role,
            granted_by=row.granted_by,
            created_at=row.created_at,
        )

    async def delete_grant(
        self,
        db: AsyncSession,
        *,
        template_id: UUID,
        user_id: UUID,
        grant_id: UUID,
    ) -> None:
        """Remove a grant from a template (T3/T6). Owner only (rank 3, same
        tier as delete/refresh)."""
        await authz.require(db, "template", template_id, user_id, "delete")
        row = (
            await db.execute(
                text(
                    f"DELETE FROM {settings.SCHEMA}.resource_grant "
                    "WHERE id = :grant_id AND resource_type = 'template' "
                    "AND resource_id = :template_id RETURNING id"
                ),
                {"grant_id": grant_id, "template_id": template_id},
            )
        ).first()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Grant not found"
            )
        await db.commit()


template = CRUDTemplate()

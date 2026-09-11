"""CRUD + business logic for the template API (T1, T2, T4, T5, T6, T8).

A template is a saved, reusable starting point for a workflow, layout or
project. Saving one detects the dataset references in the source config
(T5), lets the author decide ship/ask for each, freezes the payload
(``core.templates.snapshot``) and, for a project payload, points at a
hidden frozen copy made via ``copy_project(mark_template_source=True)``
(T2). Publishing beyond the team space widens who can read a shipped
dataset, so saving into (or refreshing within) a team/organisation space
can require viewer grants on the datasets it ships (T6).
"""

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
from core.schemas.project import InitialViewState
from core.schemas.report_layout import ReportLayoutCreate
from core.schemas.share import (
    LayerShareRoleEnum,
    ShareLayerSchema,
    ShareLayerWithTeamOrOrganizationSchema,
    ShareWithUserSchema,
)
from core.schemas.template import (
    DatasetShareLine,
    DetectedInput,
    TemplateCategoryFacet,
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
    TemplateUpdate,
    TemplateUseRequest,
    TemplateUseResult,
)
from core.schemas.workflow import WorkflowCreate
from core.templates.snapshot import (
    bind_workflow_config,
    detect_workflow_inputs,
    freeze_workflow_config,
    kinds_for,
    strip_layout_bindings,
)


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

        ``from_catalog`` → never (promote-on-use already resolves it for
        everyone). Same space as the destination → never (the audience
        already has whatever access it has today). Otherwise: needs share
        unless a grant to the destination's own team/organisation already
        exists — a personal destination has no team/organisation to grant
        to, so it never needs one either.
        """
        assert layer.id is not None
        if layer.catalog_external_uid is not None:
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
        Dashboard if it has a builder config, plus Workflow/Layout for any
        workflow/report_layout row it holds — never empty."""
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
            return ["dashboard"]
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
            return ["dashboard"]
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
        ships_sample_data = any(i.mode == "ship" and i.from_catalog for i in inputs)
        assert row.id is not None
        return TemplateRead(
            id=row.id,
            name=row.name,
            description=row.description,
            categories=list(row.categories or []),
            thumbnail_url=row.thumbnail_url,
            page_size=row.page_size,
            page_orientation=row.page_orientation,  # type: ignore[arg-type]
            space_id=row.space_id,
            folder_id=row.folder_id,
            created_by=creator,
            payload_kind=row.payload_kind,  # type: ignore[arg-type]
            kinds=kinds,
            inputs=inputs,
            ships_sample_data=ships_sample_data,
            catalog_status=row.catalog_status,  # type: ignore[arg-type]
            source_ref=dict(row.source_ref or {}),
            my_role=my_role,  # type: ignore[arg-type]
            created_at=row.created_at,  # type: ignore[arg-type]
            updated_at=row.updated_at,  # type: ignore[arg-type]
            datasets_needing_share=datasets_needing_share or [],
        )

    async def _with_from_catalog(
        self, db: AsyncSession, inputs: list[TemplateInput]
    ) -> list[TemplateInput]:
        """Recompute `from_catalog` server-side from `layer.catalog_external_uid`
        — the author's declared value (if any) is never trusted. An "ask"
        input also has its `layer_id` cleared here regardless of what the
        client submitted: an ask slot carries no dataset reference (T5), so
        a client-supplied `layer_id` on one is dropped, not just ignored."""
        out: list[TemplateInput] = []
        for i in inputs:
            if i.mode == "ask":
                out.append(
                    i.model_copy(update={"layer_id": None, "from_catalog": False})
                )
                continue
            from_catalog = False
            if i.layer_id is not None:
                layer = await db.get(Layer, i.layer_id)
                from_catalog = bool(
                    layer is not None and layer.catalog_external_uid is not None
                )
            out.append(i.model_copy(update={"from_catalog": from_catalog}))
        return out

    async def _assert_ship_inputs_readable(
        self, db: AsyncSession, inputs: list[TemplateInput], user_id: UUID
    ) -> None:
        """Every ``mode == "ship"`` input's dataset must be one the caller
        may read (B3): the source project/workflow being readable does not
        imply every layer it references is — a shared project can point at
        a layer the sharer never granted the caller access to on its own.
        422s (``template_input_not_readable``) naming the first offending
        layer rather than silently shipping an unreadable dataset.
        """
        for i in inputs:
            if i.mode != "ship" or i.layer_id is None:
                continue
            if not await authz.can(db, "layer", i.layer_id, user_id, "read"):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail={
                        "code": "template_input_not_readable",
                        "layer_id": str(i.layer_id),
                    },
                )

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
                    "l.feature_layer_geometry_type, l.catalog_external_uid "
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
            )
            for r in rows
        ]

    async def _share_lines_for_ship_inputs(
        self,
        db: AsyncSession,
        inputs: list[TemplateInput],
        destination_space: Space,
    ) -> list[DatasetShareLine]:
        """T6's `datasets_needing_share`: every ship input whose layer needs
        a viewer grant (`_needs_share`) into `destination_space`."""
        lines: list[DatasetShareLine] = []
        for i in inputs:
            if i.mode != "ship" or i.layer_id is None:
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
        workflow. Saving into a team or organisation space already grants the
        datasets to that space (T6); a grant on the template does the same for
        its grantee. Catalog layers are readable by everyone, and a layer the
        owner may not share is left alone — the template then resolves that
        input as unbound for the grantee, exactly as before.
        """
        for raw in row.inputs or []:
            i = TemplateInput(**raw)
            if i.mode != "ship" or i.layer_id is None or i.from_catalog:
                continue
            layer = await db.get(Layer, i.layer_id)
            if layer is None or layer.deleted_at is not None:
                continue
            if layer.catalog_external_uid is not None:
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
            from_catalog = bool(
                layer is not None and layer.catalog_external_uid is not None
            )
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
                    from_catalog=from_catalog,
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
                if i.mode == "ship" and i.layer_id != detected_by_key[i.key].layer_id:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                        detail=f"input {i.key!r} layer_id does not match the detected reference",
                    )
            inputs = await self._with_from_catalog(db, inputs)
            config = freeze_workflow_config(dict(wf.config or {}), inputs)
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
            # the frozen copy is what the template actually points at) is a
            # ship-only input; there is no ask option for a project payload.
            inputs = await self._project_inputs(db, frozen.id)

        await self._assert_ship_inputs_readable(db, inputs, user_id)

        ship_layer_ids = {i.layer_id for i in inputs if i.mode == "ship" and i.layer_id}
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
        if not scoped_space_ids and not include_goat:
            return None

        schema = settings.SCHEMA
        # A template shared with the caller (T3) lives in someone else's space,
        # so no space bucket reaches it; `all` takes it in through its grant —
        # a direct user grant, or one to a team or the organisation the caller
        # belongs to. `effective_role` still decides afterwards whether the
        # grant actually confers read.
        granted = (
            f"""EXISTS (
                SELECT 1 FROM {schema}.resource_grant rg
                 WHERE rg.resource_type = 'template' AND rg.resource_id = t.id
                   AND ((rg.grantee_type = 'user' AND rg.grantee_id = :user_id)
                     OR (rg.grantee_type = 'team' AND rg.grantee_id IN (
                            SELECT ut.team_id FROM {schema}.user_team ut
                             WHERE ut.user_id = :user_id))
                     OR (rg.grantee_type = 'organization' AND rg.grantee_id = (
                            SELECT usr.organization_id FROM {schema}."user" usr
                             WHERE usr.id = :user_id))))"""
            if source == "all"
            else "FALSE"
        )
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
        # A workflow/layout payload's kinds are always exactly its one
        # `payload_kind`, so that filter is exact in SQL. "dashboard" can
        # only come from a project payload, but not every project payload
        # carries it (`kinds_for`) — the SQL condition below is a superset
        # (every project row). `list_templates` applies the exact check in
        # Python on the page it already fetched, so its `total` (and the
        # counts of `list_categories`) are that superset's, not the exact
        # dashboard count (documented trade-off, not a bug).
        if kind in ("workflow", "layout"):
            conditions.append("t.payload_kind = :kind")
            params["kind"] = kind
        elif kind == "dashboard":
            conditions.append("t.payload_kind = 'project'")
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
        page: int,
        size: int,
    ) -> TemplatePage:
        schema = settings.SCHEMA
        prepared = await self._readable_conditions(
            db, user_id=user_id, source=source, kind=kind, categories=categories
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
        items: list[TemplateRead] = []
        for r in rows:
            row = await db.get(Template, r.id)
            if row is None:
                continue
            read = await self._to_read(db, row, my_role=r.role)
            if kind == "dashboard" and kind not in read.kinds:
                continue
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
            # surviving key keeps its author-chosen mode (and has
            # `from_catalog` recomputed live, since the layer's catalog
            # registration can have changed); a newly-detected key has no
            # prior author decision, so it defaults to "ask"; a key that no
            # longer appears in the source is dropped.
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
                            from_catalog=False,
                        )
                    )
            reconciled = await self._with_from_catalog(db, reconciled)
            await self._assert_ship_inputs_readable(db, reconciled, user_id)
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
            new_copy = await copy_project(
                db,
                project_id=project_id,
                user_id=user_id,
                target_folder_id=source_project.folder_id,
                mark_template_source=True,
            )
            row.source_project_id = new_copy.id
            assert new_copy.id is not None
            new_inputs = await self._project_inputs(db, new_copy.id)
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
        self, db: AsyncSession, *, folder_id: UUID, user_id: UUID, name: str
    ) -> UUID:
        """Create the project a workflow/layout template's "Use" lands in
        when no existing `project_id` was given: the same defaults
        `useHomeCreate` seeds a brand-new project with. Requires `write`
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
            initial_view_state=InitialViewState(
                latitude=48.1502132,
                longitude=11.5696284,
                zoom=12,
                min_zoom=0,
                max_zoom=20,
                bearing=0,
                pitch=0,
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
    ) -> tuple[dict[str, tuple[UUID | None, int | None]], list[int]]:
        """Resolve a workflow template's declared inputs into the target
        project (T7, step 2 of "Using a template").

        For each input: the caller's ``bindings_in[key]`` override wins
        when given; otherwise a "ship" input falls back to its shipped
        ``layer_id``. Either way the candidate only resolves if it is a
        live layer the caller may read — an unreadable or deleted shipped
        layer, and an "ask" input with no binding, are left unresolved
        (reported back by ``bind_workflow_config``, not by this method).

        A resolved layer that already has a ``layer_project`` link in the
        target project reuses that link (no duplicate on the map); a new
        one is created inside a ``LayerProjectGroup`` named after the
        template — created once, lazily, only if there is at least one
        layer to put in it.

        Returns ``(bindings, added_link_ids)``: ``bindings`` is what
        ``bind_workflow_config`` expects, ``key -> (layer_id,
        layer_project_id)`` with ``(None, None)`` for anything left
        unresolved; ``added_link_ids`` lists only the NEWLY created links
        (a reused, already-existing link was not "added" by this call).
        """
        bindings: dict[str, tuple[UUID | None, int | None]] = {}
        added_ids: list[int] = []
        group_id: int | None = None

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

        for i in inputs:
            candidate = bindings_in.get(i.key)
            if candidate is None and i.mode == "ship":
                candidate = i.layer_id
            layer_id: UUID | None = None
            if candidate is not None:
                layer = await db.get(Layer, candidate)
                if (
                    layer is not None
                    and layer.deleted_at is None
                    and await authz.can(db, "layer", candidate, user_id, "read")
                ):
                    layer_id = candidate
            if layer_id is None:
                bindings[i.key] = (None, None)
                continue
            link_id = existing_by_layer.get(layer_id)
            if link_id is None:
                if group_id is None:
                    group = LayerProjectGroup(
                        project_id=target_project_id, name=group_name
                    )
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
                new_link: Any = created[0]
                assert new_link.id is not None
                link_id = cast(int, new_link.id)
                existing_by_layer[layer_id] = link_id
                added_ids.append(link_id)
            bindings[i.key] = (layer_id, link_id)

        return bindings, added_ids

    async def use(
        self,
        db: AsyncSession,
        *,
        template_id: UUID,
        user_id: UUID,
        req: TemplateUseRequest,
    ) -> TemplateUseResult:
        """Use a template (T7): create/insert its payload into a target,
        linking whatever shipped datasets the caller may read. Nothing is
        executed — a workflow/layout row is only ever created, never run.

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
            return TemplateUseResult(project_id=new_project.id)

        # Workflow / layout payload: an existing project (write required),
        # or a brand-new one created in `target_folder_id`.
        if req.project_id is not None:
            await authz.require(db, "project", req.project_id, user_id, "write")
            target_project_id = req.project_id
        else:
            assert req.target_folder_id is not None
            target_project_id = await self._new_project_for_use(
                db, folder_id=req.target_folder_id, user_id=user_id, name=name
            )

        if row.payload_kind == "workflow":
            inputs = [TemplateInput(**i) for i in (row.inputs or [])]
            bindings, added_ids = await self._resolve_workflow_inputs(
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
                    name=name, description=None, is_default=False, config=bound_config
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

        Every ``mode == "ship"`` input's dataset must be catalog-origin.
        The author's stored ``from_catalog`` is never trusted for this: each
        such input is re-checked live against `layer.catalog_external_uid`,
        since a layer's catalog registration can change after the template
        was saved. Any input that fails raises 409 with
        ``{"code": "template_dataset_not_public", "layers": [{"id", "name"}]}``
        naming every offending layer.
        """
        if not is_superuser:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Superuser required"
            )
        await authz.require(db, "template", template_id, user_id, "read")
        row = await self._get_live(db, template_id)
        inputs = [TemplateInput(**i) for i in (row.inputs or [])]
        bad_layers: list[dict[str, str]] = []
        for i in inputs:
            if i.mode != "ship" or i.layer_id is None:
                continue
            layer = await db.get(Layer, i.layer_id)
            if layer is None or layer.catalog_external_uid is None:
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

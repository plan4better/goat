"""Shallow project copy — new metadata records sharing the same layer data."""

import copy
import json
import logging
import re
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.core import authz
from core.crud.crud_folder import folder as crud_folder
from core.crud.crud_layer_project import layer_project as crud_layer_project
from core.crud.crud_space import space as crud_space
from core.db.models._link_model import (
    LayerProjectGroup,
    LayerProjectLink,
    UserProjectLink,
)
from core.db.models.folder import Folder
from core.db.models.project import Project
from core.db.models.report_layout import ReportLayout
from core.db.models.workflow import Workflow
from core.schemas.error import FolderNotFoundError

logger = logging.getLogger(__name__)

_GROUP_ICON_KEY_RE = re.compile(r"^group_icon_(\d+)$")


async def copy_project(
    async_session: AsyncSession,
    *,
    project_id: UUID,
    user_id: UUID,
    target_folder_id: UUID | None = None,
    mark_template_source: bool = False,
    cross_space: bool = False,
) -> Project:
    """Create a shallow copy of a project.

    Creates new metadata records (Project, UserProjectLink, LayerProjectGroups,
    LayerProjectLinks, Workflows, ReportLayouts) but references the same layer
    data — no DuckLake duplication occurs.

    Each copied layer link is ``shareable`` only if the source link was and the
    copier may share that layer himself (D7), so copying a project cannot mint
    a link that hands the copy's audience access the copier never had.

    Args:
        async_session: Async SQLAlchemy session.
        project_id: Source project UUID.
        user_id: ID of the user requesting the copy (becomes owner of the copy).
        target_folder_id: Folder for the new project. Falls back to the source
            project's folder when ``None``.
        mark_template_source: Sets ``is_template_source`` on the copy (T2) — a
            hidden frozen copy backing a project-payload template, excluded
            from every listing/feed/trash/search.
        cross_space: The "Use" flow: the copy's destination folder
            can be in a different space than the source project. Requires
            `target_folder_id`. The copy's space becomes that TARGET
            folder's own space (not the source project's), and
            `assert_same_space` — whose whole point is refusing exactly
            that — is skipped.

    Returns:
        The newly created :class:`Project` instance (already flushed, not yet
        committed — caller may commit or the function commits at the end).

    Raises:
        ValueError: When the source project or its user-link cannot be
            found, or `cross_space` is True without `target_folder_id`.
        FolderNotFoundError: When `target_folder_id` is not a live folder —
            of the source project's own space (`cross_space=False`), or at
            all (`cross_space=True`).
    """
    # ------------------------------------------------------------------
    # 1. Fetch source project
    # ------------------------------------------------------------------
    source_project = await async_session.get(Project, project_id)
    if source_project is None:
        raise ValueError(f"Project {project_id} not found")

    # The copy's folder: the caller's explicit choice, or the source
    # project's own folder when none is given. Ordinarily the copy takes on
    # the SOURCE PROJECT's space (not the copier's personal space) —
    # copying a project inside a team space keeps the copy in the team
    # space — so an explicit choice must be a live folder of that same
    # space (a folder in an unrelated space 404s exactly like an
    # owner-only check would, rather than leaking that it exists via a
    # 403). `cross_space=True` inverts this on purpose: the copy is meant
    # to land in a different space than the source, so it takes on the
    # TARGET folder's own space instead.
    new_folder_id = (
        target_folder_id if target_folder_id is not None else source_project.folder_id
    )
    new_space_id: UUID | None
    if cross_space:
        if target_folder_id is None:
            raise ValueError("copy_project(cross_space=True) requires target_folder_id")
        target_folder = await async_session.get(Folder, target_folder_id)
        if (
            target_folder is None
            or target_folder.deleted_at is not None
            or target_folder.space_id is None
        ):
            raise FolderNotFoundError(f"Folder {target_folder_id} not found")
        new_space_id = target_folder.space_id
    else:
        new_space_id = source_project.space_id
        if target_folder_id is not None:
            await crud_folder.assert_same_space(
                async_session, folder_id=target_folder_id, space_id=new_space_id
            )
    if new_folder_id is not None:
        # Both the explicit choice and the default (the source project's
        # own folder) need a write check: read access to the source — what
        # let the caller copy it at all — says nothing about whether they
        # may place a NEW project into that folder. A team-space viewer can
        # read a project sitting in a folder they have no write access to.
        await authz.require(async_session, "folder", new_folder_id, user_id, "write")
    if new_space_id is None:
        new_space_id = (await crud_space.ensure_personal(async_session, user_id)).id

    # ------------------------------------------------------------------
    # 2. Fetch source UserProjectLink (initial_view_state lives here)
    # ------------------------------------------------------------------
    user_project_result = await async_session.execute(
        select(UserProjectLink).where(
            UserProjectLink.project_id == project_id,
            UserProjectLink.user_id == user_id,
        )
    )
    source_user_link = user_project_result.scalars().first()

    if source_user_link is None:
        # Requesting user has no UserProjectLink yet (e.g. shared project).
        # Fall back to the project owner's link to copy initial_view_state.
        fallback_result = await async_session.execute(
            select(UserProjectLink).where(
                UserProjectLink.project_id == project_id,
                UserProjectLink.user_id == source_project.user_id,
            )
        )
        source_user_link = fallback_result.scalars().first()
    # source_user_link may still be None — copy proceeds without initial_view_state

    # ------------------------------------------------------------------
    # 3. Fetch related records
    # ------------------------------------------------------------------
    groups_result = await async_session.execute(
        select(LayerProjectGroup)
        .where(LayerProjectGroup.project_id == project_id)
        .order_by(LayerProjectGroup.id)
    )
    source_groups = list(groups_result.scalars().all())

    links_result = await async_session.execute(
        select(LayerProjectLink).where(LayerProjectLink.project_id == project_id)
    )
    source_links = list(links_result.scalars().all())

    workflows_result = await async_session.execute(
        select(Workflow).where(Workflow.project_id == project_id)
    )
    source_workflows = list(workflows_result.scalars().all())

    layouts_result = await async_session.execute(
        select(ReportLayout).where(ReportLayout.project_id == project_id)
    )
    source_layouts = list(layouts_result.scalars().all())

    # ------------------------------------------------------------------
    # 4. Create new Project
    # ------------------------------------------------------------------
    new_name = f"{source_project.name} (Copy)"

    new_project = Project(
        user_id=user_id,
        folder_id=new_folder_id,
        space_id=new_space_id,
        name=new_name,
        description=source_project.description,
        tags=copy.deepcopy(source_project.tags) if source_project.tags else None,
        layer_order=None,  # will be updated after links are created
        basemap=source_project.basemap,
        custom_basemaps=copy.deepcopy(source_project.custom_basemaps)
        if source_project.custom_basemaps
        else [],
        thumbnail_url=source_project.thumbnail_url,
        max_extent=copy.deepcopy(source_project.max_extent)
        if source_project.max_extent
        else None,
        builder_config=copy.deepcopy(source_project.builder_config)
        if source_project.builder_config
        else None,
        is_template_source=mark_template_source,
    )
    async_session.add(new_project)
    await async_session.flush()  # populate new_project.id

    assert new_project.id is not None

    # ------------------------------------------------------------------
    # 5. Create new UserProjectLink
    # ------------------------------------------------------------------
    new_user_link = UserProjectLink(
        user_id=user_id,
        project_id=new_project.id,
        initial_view_state=copy.deepcopy(source_user_link.initial_view_state)
        if source_user_link
        else None,
    )
    async_session.add(new_user_link)

    # ------------------------------------------------------------------
    # 6. Create new LayerProjectGroups (parents first, track old→new IDs)
    # ------------------------------------------------------------------
    # Sort: roots first (parent_id is None), then children. A single pass is
    # sufficient because groups are stored with ascending IDs and parents are
    # always created before children in the product.
    old_to_new_group_id: dict[int, int] = {}

    def _sorted_groups(groups: list[LayerProjectGroup]) -> list[LayerProjectGroup]:
        roots = [g for g in groups if g.parent_id is None]
        children = [g for g in groups if g.parent_id is not None]
        return roots + children

    for source_group in _sorted_groups(source_groups):
        assert source_group.id is not None
        new_parent_id: int | None = None
        if source_group.parent_id is not None:
            new_parent_id = old_to_new_group_id.get(source_group.parent_id)

        new_group = LayerProjectGroup(
            project_id=new_project.id,
            name=source_group.name,
            order=source_group.order,
            properties=copy.deepcopy(source_group.properties)
            if source_group.properties
            else None,
            parent_id=new_parent_id,
        )
        async_session.add(new_group)
        await async_session.flush()  # populate new_group.id

        assert new_group.id is not None
        old_to_new_group_id[source_group.id] = new_group.id

    # ------------------------------------------------------------------
    # 7. Create new LayerProjectLinks (same layer_ids — no data duplication)
    # ------------------------------------------------------------------
    old_to_new_link_id: dict[int, int] = {}

    # `shareable` records that whoever put the layer into the project held
    # `share` on it (D7). On a copy that person is the copier, who may reach the
    # layer only through the project he is copying — so the flag is recomputed
    # for him and ANDed with the source link's, never widening either side.
    shareable_by_layer_id = await crud_layer_project.shareable_by_layer_id(
        async_session,
        [source_link.layer_id for source_link in source_links],
        user_id,
    )

    for source_link in source_links:
        assert source_link.id is not None
        new_group_id: int | None = None
        if source_link.layer_project_group_id is not None:
            new_group_id = old_to_new_group_id.get(source_link.layer_project_group_id)

        new_link = LayerProjectLink(
            layer_id=source_link.layer_id,
            project_id=new_project.id,
            layer_project_group_id=new_group_id,
            order=source_link.order,
            name=source_link.name,
            properties=copy.deepcopy(source_link.properties)
            if source_link.properties
            else None,
            other_properties=copy.deepcopy(source_link.other_properties)
            if source_link.other_properties
            else None,
            query=copy.deepcopy(source_link.query) if source_link.query else None,
            charts=copy.deepcopy(source_link.charts) if source_link.charts else None,
            # Never wider than the source link, never wider than what the
            # copier may share himself (D7). The copier keeps reading the
            # layer through the source project's link either way; what a
            # non-shareable copy withholds is handing that read on to the
            # copy's own audience.
            shareable=bool(source_link.shareable)
            and shareable_by_layer_id.get(source_link.layer_id, False),
        )
        async_session.add(new_link)
        await async_session.flush()

        assert new_link.id is not None
        old_to_new_link_id[source_link.id] = new_link.id

    # ------------------------------------------------------------------
    # 7b. Remap builder_config layer_project_id references
    # ------------------------------------------------------------------
    if new_project.builder_config and (old_to_new_link_id or old_to_new_group_id):
        new_project.builder_config = _remap_builder_config(
            new_project.builder_config, old_to_new_link_id, old_to_new_group_id
        )
        async_session.add(new_project)

    if new_project.custom_basemaps and old_to_new_link_id:
        new_project.custom_basemaps = _remap_basemap_layer_config(
            new_project.custom_basemaps, old_to_new_link_id
        )

    # ------------------------------------------------------------------
    # 8. Create new Workflows (deep copy config; layer refs stay valid since
    #    layers are shared)
    # ------------------------------------------------------------------
    for source_workflow in source_workflows:
        new_workflow = Workflow(
            project_id=new_project.id,
            name=source_workflow.name,
            description=source_workflow.description,
            is_default=source_workflow.is_default,
            config=copy.deepcopy(source_workflow.config),
            thumbnail_url=source_workflow.thumbnail_url,
        )
        async_session.add(new_workflow)

    # ------------------------------------------------------------------
    # 9. Create new ReportLayouts
    # ------------------------------------------------------------------
    for source_layout in source_layouts:
        new_layout = ReportLayout(
            project_id=new_project.id,
            name=source_layout.name,
            description=source_layout.description,
            is_default=source_layout.is_default,
            is_predefined=source_layout.is_predefined,
            config=copy.deepcopy(source_layout.config),
            thumbnail_url=source_layout.thumbnail_url,
        )
        async_session.add(new_layout)

    # ------------------------------------------------------------------
    # 10. Update new project's layer_order with new link IDs
    # ------------------------------------------------------------------
    if source_project.layer_order:
        new_layer_order = [
            old_to_new_link_id[old_id]
            for old_id in source_project.layer_order
            if old_id in old_to_new_link_id
        ]
        new_project.layer_order = new_layer_order
        async_session.add(new_project)

    # ------------------------------------------------------------------
    # 11. Commit
    # ------------------------------------------------------------------
    await async_session.commit()
    await async_session.refresh(new_project)

    logger.info(
        "Copied project %s -> %s (user=%s)", project_id, new_project.id, user_id
    )
    return new_project


def _remap_basemap_layer_config(
    custom_basemaps: list[dict],
    old_to_new_link_id: dict[int, int],
) -> list[dict]:
    """Rewrite layer_config target layer ids after a project copy.

    target "all" is preserved; a target referencing a remapped layer id is
    rewritten; an unmapped non-"all" target falls back to "all".
    """
    remapped: list[dict] = []
    for basemap in custom_basemaps:
        config = basemap.get("layer_config")
        if not config:
            remapped.append(basemap)
            continue
        new_config: dict = {}
        for layer_id, setting in config.items():
            target = setting.get("target", "all")
            if target != "all":
                try:
                    old_id = int(target)
                except (TypeError, ValueError):
                    old_id = None
                new_id = old_to_new_link_id.get(old_id) if old_id is not None else None
                target = str(new_id) if new_id is not None else "all"
            new_config[layer_id] = {**setting, "target": target}
        remapped.append({**basemap, "layer_config": new_config})
    return remapped


def _remap_builder_config(
    config: dict[str, Any],
    lp_id_map: dict[int, int],
    group_id_map: dict[int, int] | None = None,
) -> dict[str, Any]:
    """Remap layer_project_id and group references in builder_config.

    Widget configs reference layer_project link IDs (integers) and
    layer_project_group IDs (integers); both get new auto-increment IDs when
    a project is copied. Link IDs are rewritten on the serialized config;
    group IDs live in widget config keys (`group_icon_<id>`) and `group_info`
    object keys, which are rewritten on the deserialized tree. Mirrors the
    import path (`goatlib.tools.project_import`).
    """
    config_str = json.dumps(config)

    # Replace "layer_project_id": 66 patterns (sort by descending ID to avoid
    # partial matches, e.g. replacing "6" inside "66")
    for old_id, new_id in sorted(lp_id_map.items(), key=lambda x: -x[0]):
        config_str = config_str.replace(
            f'"layer_project_id": {old_id}', f'"layer_project_id": {new_id}'
        )
        config_str = config_str.replace(
            f'"layer_project_id":{old_id}', f'"layer_project_id":{new_id}'
        )

    # Also remap integers in arrays (e.g. downloadable_layers: [66, 67])
    for old_id, new_id in sorted(lp_id_map.items(), key=lambda x: -x[0]):
        config_str = re.sub(
            rf"(?<=[\[,\s]){old_id}(?=[,\]\s])",
            str(new_id),
            config_str,
        )

    remapped: dict[str, Any] = json.loads(config_str)
    if group_id_map:
        remapped = _remap_group_ids_in_config(remapped, group_id_map)
    return remapped


def _remap_group_ids_in_config(node: Any, group_id_map: dict[int, int]) -> Any:
    """Recursively rewrite `group_icon_<id>` keys and `group_info` keys.

    Layer-widget configs encode group IDs into dynamic keys (one per group),
    which a pure value-based remap cannot touch. Keys with no mapping are
    preserved so stale entries (e.g. for groups deleted before the copy)
    don't get silently dropped — the frontend ignores them.
    """
    if isinstance(node, dict):
        new_dict: dict[str, Any] = {}
        for key, value in node.items():
            if key == "group_info" and isinstance(value, dict):
                new_dict[key] = {
                    _remap_group_info_key(k, group_id_map): v for k, v in value.items()
                }
                continue
            match = _GROUP_ICON_KEY_RE.match(key) if isinstance(key, str) else None
            if match:
                new_gid = group_id_map.get(int(match.group(1)))
                new_key = f"group_icon_{new_gid}" if new_gid is not None else key
                new_dict[new_key] = _remap_group_ids_in_config(value, group_id_map)
            else:
                new_dict[key] = _remap_group_ids_in_config(value, group_id_map)
        return new_dict
    if isinstance(node, list):
        return [_remap_group_ids_in_config(item, group_id_map) for item in node]
    return node


def _remap_group_info_key(key: str, group_id_map: dict[int, int]) -> str:
    """Map a single group_info key (string-encoded int) to its new ID."""
    try:
        old_gid = int(key)
    except (TypeError, ValueError):
        return key
    new_gid = group_id_map.get(old_gid)
    return str(new_gid) if new_gid is not None else key

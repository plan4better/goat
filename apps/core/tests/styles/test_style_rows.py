"""core's batch style writers (the add and copy paths) and the rollout repair."""

from typing import Any

import pytest
from core.core.config import settings
from core.db.models._link_model import LayerProjectLink
from core.db.models.layer import Layer
from core.db.models.layer_style import LayerStyle
from core.services.style import (
    add_first_styles,
    copy_styles,
    ensure_styles,
    insert_dataset_default,
    layer_context,
)
from goatlib.style.context import DataContext
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld

S = settings.SCHEMA
GREEN = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "#00aa00"}}}


async def link_styles(db: AsyncSession, lp: int) -> list[Any]:
    return (
        await db.execute(
            text(
                f"SELECT s.id, s.name, s.position, s.document, s.revision, "
                f"(s.id = lp.active_style_id) AS active, lp.visible, "
                f"(SELECT count(*) FROM {S}.layer_style_revision r WHERE r.style_id = s.id) AS revisions "
                f"FROM {S}.layer_style s JOIN {S}.layer_project lp ON lp.id = s.layer_project_id "
                "WHERE s.layer_project_id = :lp ORDER BY s.position"
            ),
            {"lp": lp},
        )
    ).all()


async def new_link(db: AsyncSession, world: StyleWorld, **extra: Any) -> int:
    link = LayerProjectLink(
        project_id=world.project_id,
        layer_id=world.layer_id,
        name="x",
        properties={},
        **extra,
    )
    db.add(link)
    await db.commit()
    assert link.id is not None
    return link.id


@pytest.mark.asyncio
async def test_a_new_link_gets_an_active_default_copied_from_the_dataset_default(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    await insert_dataset_default(db_session, style_world.layer_id, GREEN)
    await add_first_styles(db_session, [style_world.layer_project_id])
    [style] = await link_styles(db_session, style_world.layer_project_id)
    assert (
        style.name,
        style.position,
        style.revision,
        style.active,
        style.revisions,
    ) == ("Default", 0, 1, True, 1)
    assert style.document == GREEN


@pytest.mark.asyncio
async def test_a_dataset_without_a_default_gets_goatlibs_default_first(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    await add_first_styles(db_session, [style_world.layer_project_id])
    [style] = await link_styles(db_session, style_world.layer_project_id)
    assert style.document["symbol"]["fill"]["opacity"] == 0.8
    default = (
        await db_session.execute(
            text(f"SELECT count(*) FROM {S}.layer_style WHERE layer_id = :l"),
            {"l": style_world.layer_id},
        )
    ).scalar_one()
    assert default == 1


@pytest.mark.asyncio
async def test_a_duplicate_add_copies_every_named_style_with_the_active_one_mapped(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    await insert_dataset_default(db_session, style_world.layer_id, GREEN)
    await add_first_styles(db_session, [style_world.layer_project_id])
    second = LayerStyle(
        layer_project_id=style_world.layer_project_id,
        name="Density",
        position=1,
        document={**GREEN, "opacity": 0.5},
    )
    db_session.add(second)
    await db_session.commit()
    await db_session.execute(
        text(
            f"UPDATE {S}.layer_project SET active_style_id = :s, visible = false WHERE id = :lp"
        ),
        {"s": second.id, "lp": style_world.layer_project_id},
    )
    await db_session.commit()
    duplicate = await new_link(db_session, style_world)
    await add_first_styles(db_session, [duplicate])
    styles = await link_styles(db_session, duplicate)
    assert [(s.name, s.position, s.revisions) for s in styles] == [
        ("Default", 0, 1),
        ("Density", 1, 1),
    ]
    assert [s.active for s in styles] == [False, True]
    assert styles[0].visible is True
    assert {s.id for s in styles}.isdisjoint({second.id})


@pytest.mark.asyncio
async def test_a_copy_keeps_names_positions_and_the_active_style_with_new_ids(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    await insert_dataset_default(db_session, style_world.layer_id, GREEN)
    await add_first_styles(db_session, [style_world.layer_project_id])
    await db_session.execute(
        text(
            f"UPDATE {S}.layer_project SET visible = false, position = 'below_labels', "
            "time_value = '2024', legend_expanded = false WHERE id = :lp"
        ),
        {"lp": style_world.layer_project_id},
    )
    await db_session.commit()
    target = await new_link(db_session, style_world)
    await copy_styles(db_session, [(style_world.layer_project_id, target)])
    [original] = await link_styles(db_session, style_world.layer_project_id)
    [copy_] = await link_styles(db_session, target)
    assert (copy_.name, copy_.document, copy_.active, copy_.revisions) == (
        "Default",
        GREEN,
        True,
        1,
    )
    assert copy_.id != original.id
    state = (
        await db_session.execute(
            text(
                f"SELECT visible, position, time_value, legend_expanded FROM {S}.layer_project WHERE id = :lp"
            ),
            {"lp": target},
        )
    ).one()
    assert tuple(state) == (False, "below_labels", 2024, False)


@pytest.mark.asyncio
async def test_ensure_styles_repairs_a_link_an_old_pod_wrote_and_a_second_call_writes_nothing(
    db_session: AsyncSession,
    style_world: StyleWorld,
    lake: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "DUCKLAKE_CATALOG_SCHEMA", lake)
    layer = await db_session.get(Layer, style_world.layer_id)
    link = await db_session.get(LayerProjectLink, style_world.layer_project_id)
    assert layer is not None and link is not None
    layer.properties = {"color": [255, 0, 0], "filled": True}
    link.properties = {"color": [0, 0, 255], "filled": True, "visibility": False}
    await db_session.commit()
    assert await ensure_styles(db_session, style_world.project_id) == 2
    [style] = await link_styles(db_session, style_world.layer_project_id)
    assert style.document["symbol"]["fill"]["color"] == "#0000ff"
    assert (style.active, style.visible, style.revisions) == (True, False, 1)
    assert await ensure_styles(db_session, style_world.project_id) == 0


def test_a_wms_layer_is_validated_as_a_map_service() -> None:
    assert layer_context("raster", None, "wms") == DataContext(
        kind="raster", source="wms"
    )
    assert layer_context("feature", "line", None) == DataContext(
        kind="vector", geometry="line"
    )


@pytest.mark.asyncio
async def test_links_are_found_by_their_active_style_through_an_index(
    db_session: AsyncSession,
) -> None:
    """Deleting a style (or a project layer, with its styles) looks up the links
    that name it active; without an index that is a scan of every link per row."""
    found = (
        await db_session.execute(
            text(
                "SELECT count(*) FROM pg_indexes WHERE schemaname = :s "
                "AND tablename = 'layer_project' AND indexdef LIKE '%(active_style_id)%'"
            ),
            {"s": S},
        )
    ).scalar_one()
    assert found == 1


@pytest.mark.asyncio
async def test_ensure_styles_gives_a_link_without_properties_its_datasets_default(
    db_session: AsyncSession,
    style_world: StyleWorld,
    lake: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An old pod linked a dataset the new release created: the link has no
    `properties` to convert, so it starts like any new link."""
    monkeypatch.setattr(settings, "DUCKLAKE_CATALOG_SCHEMA", lake)
    await insert_dataset_default(db_session, style_world.layer_id, GREEN)
    link = await db_session.get(LayerProjectLink, style_world.layer_project_id)
    assert link is not None
    link.properties = None
    await db_session.commit()
    assert await ensure_styles(db_session, style_world.project_id) == 1
    [style] = await link_styles(db_session, style_world.layer_project_id)
    assert (style.document, style.active) == (GREEN, True)


@pytest.mark.asyncio
async def test_concurrent_repairs_write_one_default(
    db_session: AsyncSession,
    style_world: StyleWorld,
    lake: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio

    from core.db.session import session_manager
    from sqlalchemy.ext.asyncio import AsyncSession as Session

    monkeypatch.setattr(settings, "DUCKLAKE_CATALOG_SCHEMA", lake)
    await insert_dataset_default(db_session, style_world.layer_id, GREEN)
    link = await db_session.get(LayerProjectLink, style_world.layer_project_id)
    assert link is not None
    link.properties = {"color": [0, 0, 255], "filled": True}
    await db_session.commit()

    async def second() -> int:
        async with session_manager.session() as session:
            return await ensure_styles(session, style_world.project_id)

    async with session_manager.transaction() as connection:
        await ensure_styles(Session(bind=connection), style_world.project_id)
        other = asyncio.create_task(second())
        await asyncio.sleep(0.5)
        assert not other.done()
    await other
    assert len(await link_styles(db_session, style_world.layer_project_id)) == 1

"""The style tables (spec 10, 13.1): a style belongs to a project layer or a dataset, one default per dataset, the
active style and the revisions go with their rows."""

import pytest
from core.core.config import settings
from core.db.models._link_model import LayerProjectLink
from core.db.models.layer_style import LayerStyle, LayerStyleRevision
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld

DOC = {"version": 1, "kind": "vector"}


@pytest.mark.asyncio
async def test_a_style_belongs_to_a_project_layer_or_a_dataset_never_both(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    db_session.add(
        LayerStyle(
            layer_project_id=style_world.layer_project_id,
            layer_id=style_world.layer_id,
            name="x",
            document=DOC,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()
    db_session.add(LayerStyle(name="nothing", document=DOC))
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_one_default_style_per_dataset(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    db_session.add(
        LayerStyle(layer_id=style_world.layer_id, name="default", document=DOC)
    )
    await db_session.commit()
    db_session.add(
        LayerStyle(layer_id=style_world.layer_id, name="second", document=DOC)
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_deleting_the_active_style_clears_active_style_id(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    style = LayerStyle(
        layer_project_id=style_world.layer_project_id, name="a", document=DOC
    )
    db_session.add(style)
    await db_session.flush()
    link = await db_session.get(LayerProjectLink, style_world.layer_project_id)
    assert link is not None
    link.active_style_id = style.id
    await db_session.commit()
    await db_session.execute(
        text(f"DELETE FROM {settings.SCHEMA}.layer_style WHERE id = :id"),
        {"id": style.id},
    )
    await db_session.commit()
    active = (
        await db_session.execute(
            text(
                f"SELECT active_style_id FROM {settings.SCHEMA}.layer_project WHERE id = :id"
            ),
            {"id": style_world.layer_project_id},
        )
    ).scalar_one()
    assert active is None


@pytest.mark.asyncio
async def test_removing_a_project_layer_removes_its_styles_and_their_revisions(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    style = LayerStyle(
        layer_project_id=style_world.layer_project_id, name="a", document=DOC
    )
    db_session.add(style)
    await db_session.flush()
    db_session.add(LayerStyleRevision(style_id=style.id, revision=1, document=DOC))
    await db_session.commit()
    await db_session.execute(
        text(f"DELETE FROM {settings.SCHEMA}.layer_project WHERE id = :id"),
        {"id": style_world.layer_project_id},
    )
    await db_session.commit()
    assert (
        await db_session.execute(select(LayerStyle).where(LayerStyle.id == style.id))
    ).first() is None
    assert (
        await db_session.execute(
            select(LayerStyleRevision).where(LayerStyleRevision.style_id == style.id)
        )
    ).first() is None


@pytest.mark.asyncio
async def test_the_map_state_columns_default(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    row = (
        await db_session.execute(
            text(
                f"SELECT visible, position, legend_expanded, time_value FROM {settings.SCHEMA}.layer_project WHERE id = :id"
            ),
            {"id": style_world.layer_project_id},
        )
    ).one()
    assert (row.visible, row.position, row.legend_expanded, row.time_value) == (
        True,
        "top",
        True,
        None,
    )
    cursor = (
        await db_session.execute(
            text(f"SELECT count(*) FROM {settings.SCHEMA}.data_snapshot_cursor")
        )
    ).scalar_one()
    assert cursor in (0, 1)

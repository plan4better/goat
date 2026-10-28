"""Migration 0013: today's styles become GOAT Style rows (spec 17).

Runs the revision's `upgrade`/`downgrade` through alembic's operations on the
per-process test schema (like `tests/unit/test_layer_serial_counter.py`), over a
world seeded with today's `properties` in every place that holds them.
"""

import copy
import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any
from uuid import uuid4

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from core.core.config import settings
from core.db.models._link_model import LayerProjectGroup, LayerProjectLink
from core.db.models.layer import Layer
from core.db.models.project import ProjectPublic
from core.db.models.report_layout import ReportLayout
from core.db.models.template import Template, TemplatePayloadKind
from core.db.models.workflow import Workflow
from core.db.session import session_manager
from core.services.map_document import map_for_project, published_styles_differ
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld

S = settings.SCHEMA
MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "alembic"
    / "versions"
    / "0013_layer_styles_data.py"
)
QUANTILE_V0: dict[str, Any] = {
    "filled": True,
    "color": [200, 200, 200],
    "color_field": {"name": "density", "type": "number"},
    "color_scale": "quantile",
    "color_range": {
        "name": "ColorBrewer OrRd-3",
        "category": "ColorBrewer",
        "colors": ["#fee8c8", "#fdbb84", "#e34a33"],
    },
    "color_scale_breaks": {
        "min": 100,
        "max": 9000,
        "mean": 3000,
        "breaks": [2800, 3600],
    },
}
LINE_V0: dict[str, Any] = {
    "color": [10, 20, 30],
    "stroke_width": 3,
    "stroke_pattern": "solid",
}


def load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("m0013", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def run(step_name: str) -> None:
    m = load()
    m.S = S

    def step(sync_conn) -> None:  # noqa: ANN001
        context = MigrationContext.configure(sync_conn)
        with Operations.context(context):
            getattr(m, step_name)()

    async with session_manager.connect() as conn:
        await conn.run_sync(step)
        await conn.commit()


@pytest.fixture(autouse=True)
def scratch_lake(lake: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "DUCKLAKE_CATALOG_SCHEMA", lake)


async def seed(db: AsyncSession, world: StyleWorld) -> dict[str, Any]:
    """Today's styles in every place: dataset, project layer, table link, group,
    workflow export, layout and template locks, a published snapshot."""
    layer = await db.get(Layer, world.layer_id)
    assert layer is not None
    layer.properties = QUANTILE_V0
    link = await db.get(LayerProjectLink, world.layer_project_id)
    assert link is not None
    link.properties = {
        **QUANTILE_V0,
        "visibility": False,
        "legend": {"collapsed": True},
    }
    table = Layer(
        id=uuid4(),
        user_id=world.user_id,
        folder_id=layer.folder_id,
        space_id=layer.space_id,
        name="t",
        type="table",
        properties={},
    )
    db.add(table)
    await db.flush()
    table_link = LayerProjectLink(
        project_id=world.project_id,
        layer_id=table.id,
        name="t",
        properties={"visibility": False},
    )
    group = LayerProjectGroup(
        name="G",
        project_id=world.project_id,
        properties={"visibility": False, "expanded": False},
    )
    workflow = Workflow(
        id=uuid4(),
        project_id=world.project_id,
        name="w",
        config={
            "nodes": [
                {"id": "n1", "data": {"outputStyle": LINE_V0}},
                {"id": "n2", "data": {"outputStyle": LINE_V0}},
            ]
        },
    )
    # The world's (polygon) layer is what export node n2 last wrote.
    layer.other_properties = {
        "workflow_export": {"workflow_id": str(workflow.id), "export_node_id": "n2"}
    }
    layout = ReportLayout(
        id=uuid4(),
        project_id=world.project_id,
        name="r",
        config={
            "elements": [
                {
                    "type": "map",
                    "config": {
                        "locked_layer_styles": {
                            str(world.layer_project_id): QUANTILE_V0
                        }
                    },
                }
            ]
        },
    )
    template = Template(
        id=uuid4(),
        name="tpl",
        space_id=layer.space_id,
        folder_id=layer.folder_id,
        user_id=world.user_id,
        payload_kind=TemplatePayloadKind.project,
        config={"nodes": [{"id": "e", "data": {"outputStyle": LINE_V0}}]},
    )
    public = ProjectPublic(
        project_id=world.project_id,
        config={
            "layers": [
                {
                    "id": world.layer_project_id,
                    "layer_id": str(world.layer_id),
                    "type": "feature",
                    "feature_layer_geometry_type": "polygon",
                    "properties": link.properties,
                    "order": 0,
                    "layer_project_group_id": None,
                    "query": None,
                },
            ],
            "layer_groups": [],
            "project": {
                "basemap": "light",
                "initial_view_state": {"latitude": 48.1, "longitude": 11.5, "zoom": 12},
            },
        },
    )
    db.add_all([table_link, group, workflow, layout, template, public])
    await db.commit()
    assert table_link.id is not None and group.id is not None
    return {
        "table_link": table_link.id,
        "group": group.id,
        "workflow": workflow.id,
        "layout": layout.id,
        "template": template.id,
        "originals": {
            "workflow": copy.deepcopy(workflow.config),
            "layout": copy.deepcopy(layout.config),
        },
    }


async def one(db: AsyncSession, sql: str, **params: Any) -> Any:
    return (await db.execute(text(sql.format(S=S)), params)).first()


@pytest.mark.asyncio
async def test_every_place_converts(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    ids = await seed(db_session, style_world)
    await run("upgrade")
    default = await one(
        db_session,
        "SELECT name, document FROM {S}.layer_style WHERE layer_id = :id",
        id=style_world.layer_id,
    )
    assert default.name == "Default" and default.document["version"] == 1
    assert default.document["classify"][0]["computed"]["data"] == "ducklake:0"
    link = await one(
        db_session,
        "SELECT lp.visible, lp.legend_expanded, s.name, s.document, s.revision, "
        "(SELECT count(*) FROM {S}.layer_style_revision r WHERE r.style_id = s.id) AS revisions "
        "FROM {S}.layer_project lp JOIN {S}.layer_style s ON s.id = lp.active_style_id WHERE lp.id = :id",
        id=style_world.layer_project_id,
    )
    assert (
        link.visible,
        link.legend_expanded,
        link.name,
        link.revision,
        link.revisions,
    ) == (False, False, "Default", 1, 1)
    assert "visibility" not in link.document
    table = await one(
        db_session,
        "SELECT visible, (SELECT count(*) FROM {S}.layer_style WHERE layer_project_id = :id) AS n "
        "FROM {S}.layer_project WHERE id = :id",
        id=ids["table_link"],
    )
    assert (table.visible, table.n) == (False, 0)
    group = await one(
        db_session,
        "SELECT visible, expanded FROM {S}.layer_project_group WHERE id = :id",
        id=ids["group"],
    )
    assert (group.visible, group.expanded) == (False, False)
    workflow = await one(
        db_session, "SELECT config FROM {S}.workflow WHERE id = :id", id=ids["workflow"]
    )
    # Without the layer an export wrote its geometry is unknown: the style stays in
    # today's format and is converted when the result is saved (finalize).
    assert workflow.config["nodes"][0]["data"]["outputStyle"] == LINE_V0
    converted = workflow.config["nodes"][1]["data"]["outputStyle"]
    assert converted["version"] == 1 and "fill" in converted["symbol"]
    layout = await one(
        db_session,
        "SELECT config FROM {S}.report_layout WHERE id = :id",
        id=ids["layout"],
    )
    locked = layout.config["elements"][0]["config"]["locked_layer_styles"][
        str(style_world.layer_project_id)
    ]
    assert locked["version"] == 1 and locked["kind"] == "vector"
    template = await one(
        db_session, "SELECT config FROM {S}.template WHERE id = :id", id=ids["template"]
    )
    assert template.config["nodes"][0]["data"]["outputStyle"] == LINE_V0
    public = await one(
        db_session,
        "SELECT config FROM {S}.project_public WHERE project_id = :id",
        id=style_world.project_id,
    )
    assert public.config["map"]["layers"][0]["id"] == style_world.layer_project_id
    [published] = public.config["styles"][str(style_world.layer_project_id)]
    assert published["document"]["version"] == 1


@pytest.mark.asyncio
async def test_a_second_upgrade_changes_nothing(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    ids = await seed(db_session, style_world)
    await run("upgrade")
    snapshot = (
        "SELECT (SELECT count(*) FROM {S}.layer_style) AS styles, "
        "(SELECT xmin::text FROM {S}.workflow WHERE id = :w) AS w, "
        "(SELECT xmin::text FROM {S}.project_public WHERE project_id = :p) AS p, "
        "(SELECT xmin::text FROM {S}.layer_project_group WHERE id = :g) AS g"
    )
    params = {"w": ids["workflow"], "p": style_world.project_id, "g": ids["group"]}
    before = await one(db_session, snapshot, **params)
    await run("upgrade")
    assert await one(db_session, snapshot, **params) == before


@pytest.mark.asyncio
async def test_downgrade_restores_the_rewritten_configs(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    ids = await seed(db_session, style_world)
    await run("upgrade")
    await run("downgrade")
    workflow = await one(
        db_session, "SELECT config FROM {S}.workflow WHERE id = :id", id=ids["workflow"]
    )
    assert workflow.config == ids["originals"]["workflow"]
    layout = await one(
        db_session,
        "SELECT config FROM {S}.report_layout WHERE id = :id",
        id=ids["layout"],
    )
    assert layout.config == ids["originals"]["layout"]
    assert (await one(db_session, "SELECT count(*) AS n FROM {S}.layer_style")).n == 0
    public = await one(
        db_session,
        "SELECT config FROM {S}.project_public WHERE project_id = :id",
        id=style_world.project_id,
    )
    assert "map" not in public.config and "styles" not in public.config
    await run("upgrade")
    mine = await one(
        db_session,
        "SELECT count(*) AS n FROM {S}.layer_style WHERE layer_id = :l OR layer_project_id = :lp",
        l=style_world.layer_id,
        lp=style_world.layer_project_id,
    )
    assert mine.n == 2


@pytest.mark.asyncio
async def test_right_after_the_migration_nothing_is_stale_or_unpublished(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    await seed(db_session, style_world)
    await run("upgrade")
    result = await map_for_project(
        db_session, project_id=style_world.project_id, user_id=style_world.user_id
    )
    assert result.styles[str(style_world.layer_project_id)].active.stale is False
    assert await published_styles_differ(db_session, style_world.project_id) == []


@pytest.mark.asyncio
async def test_a_style_that_cannot_convert_does_not_stop_the_migration(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    from goatlib.style import migrate

    def broken(*_: Any, **__: Any) -> Any:
        raise RuntimeError("unforeseen")

    await seed(db_session, style_world)
    monkeypatch.setattr(migrate, "convert_v0", broken)
    await run("upgrade")
    default = await one(
        db_session,
        "SELECT document FROM {S}.layer_style WHERE layer_id = :id",
        id=style_world.layer_id,
    )
    assert default.document["symbol"]["fill"]["opacity"] == 0.8


@pytest.mark.asyncio
async def test_without_a_ducklake_catalog_styles_are_stamped_ducklake_0(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "DUCKLAKE_CATALOG_SCHEMA", "no_such_lake")
    await seed(db_session, style_world)
    await run("upgrade")
    default = await one(
        db_session,
        "SELECT document FROM {S}.layer_style WHERE layer_id = :id",
        id=style_world.layer_id,
    )
    assert default.document["classify"][0]["computed"]["data"] == "ducklake:0"


def test_the_revision_follows_0012() -> None:
    m = load()
    assert (m.revision, m.down_revision) == (
        "0013_layer_styles_data",
        "0012_layer_styles",
    )


@pytest.mark.asyncio
async def test_rows_the_new_release_wrote_stay_visible_through_downgrade_and_upgrade(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    """A layer and a link created by the new release carry no `properties`: going
    back deletes their style rows, coming back must not make them invisible."""
    await run("upgrade")
    for table, column, value in (
        ("layer", "id", style_world.layer_id),
        ("layer_project", "id", style_world.layer_project_id),
    ):
        await db_session.execute(
            text(f"UPDATE {S}.{table} SET properties = NULL WHERE {column} = :v"),
            {"v": value},
        )
    await db_session.commit()
    await run("downgrade")
    await run("upgrade")
    default = await one(
        db_session,
        "SELECT document FROM {S}.layer_style WHERE layer_id = :id",
        id=style_world.layer_id,
    )
    assert default.document["symbol"]["fill"]["opacity"] == 0.8
    link = await one(
        db_session,
        "SELECT s.document, s.id = lp.active_style_id AS active FROM {S}.layer_style s "
        "JOIN {S}.layer_project lp ON lp.id = s.layer_project_id WHERE lp.id = :lp",
        lp=style_world.layer_project_id,
    )
    assert link.active and link.document == default.document


@pytest.mark.asyncio
async def test_classes_are_stamped_with_the_snapshot_the_tracker_found_first(
    db_session: AsyncSession, style_world: StyleWorld, lake: str
) -> None:
    await db_session.execute(
        text(f"INSERT INTO {lake}.ducklake_table VALUES (21, :name)"),
        {"name": f"t_{style_world.layer_id.hex}"},
    )
    for snapshot_id, made in ((1, ""), (7, "inserted_into_table:21")):
        await db_session.execute(
            text(f"INSERT INTO {lake}.ducklake_snapshot VALUES (:s)"),
            {"s": snapshot_id},
        )
        await db_session.execute(
            text(f"INSERT INTO {lake}.ducklake_snapshot_changes VALUES (:s, :m)"),
            {"s": snapshot_id, "m": made},
        )
    await db_session.commit()
    await seed(db_session, style_world)
    await run("upgrade")
    snapshot = await one(
        db_session,
        "SELECT data_snapshot FROM {S}.layer WHERE id = :id",
        id=style_world.layer_id,
    )
    assert snapshot.data_snapshot == 7
    for where, value in (
        ("layer_id = :v", style_world.layer_id),
        ("layer_project_id = :v", style_world.layer_project_id),
    ):
        row = await one(
            db_session, "SELECT document FROM {S}.layer_style WHERE " + where, v=value
        )
        assert row.document["classify"][0]["computed"]["data"] == "ducklake:7"
    result = await map_for_project(
        db_session, project_id=style_world.project_id, user_id=style_world.user_id
    )
    assert result.styles[str(style_world.layer_project_id)].active.stale is False


@pytest.mark.asyncio
async def test_a_published_layer_deleted_since_is_no_unpublished_style_change(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    await seed(db_session, style_world)
    await run("upgrade")
    await db_session.execute(
        text(f"DELETE FROM {S}.layer_project WHERE id = :lp"),
        {"lp": style_world.layer_project_id},
    )
    await db_session.commit()
    assert await published_styles_differ(db_session, style_world.project_id) == []

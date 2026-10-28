"""Reading one style recomputes it when its data changed (spec 12, 13.2)."""

import copy
from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models.layer_style import LayerStyle, LayerStyleRevision
from core.services import style as style_service
from core.services.processes import StyleCheckUnavailable
from core.services.style import read_stored, read_style
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld

S = settings.SCHEMA


def classified(data: str, breaks: tuple[int, ...] = (5,)) -> dict[str, Any]:
    classes: list[dict[str, Any]] = []
    bounds = [None, *breaks, None]
    for i in range(len(bounds) - 1):
        c: dict[str, Any] = {"id": f"c{i + 1}"}
        if bounds[i] is not None:
            c["from"] = bounds[i]
        if bounds[i + 1] is not None:
            c["to"] = bounds[i + 1]
        classes.append(c)
    return {
        "version": 1,
        "kind": "vector",
        "symbol": {"fill": {"color": "#111111"}},
        "classify": [
            {
                "id": "density",
                "field": "density",
                "method": "quantile",
                "count": len(classes),
                "classes": classes,
                "computed": {"at": "2026-10-25T10:00:00Z", "data": data},
            }
        ],
    }


class Recompute:
    """processes' style-check in its stored mode: new stamps, and new breaks when given."""

    def __init__(
        self, breaks: tuple[int, ...] | None = None, fail: bool = False
    ) -> None:
        self.breaks = breaks
        self.fail = fail
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        if self.fail:
            raise StyleCheckUnavailable("down")
        document = copy.deepcopy(kwargs["document"])
        if not kwargs.get("compute"):
            issue = {
                "level": "damaged",
                "code": "field_missing",
                "path": "/classify/density/field",
                "message": "gone",
            }
            return {"document": document, "issues": [issue]}
        c = document["classify"][0]
        if self.breaks is not None:
            c["classes"] = classified("x", self.breaks)["classify"][0]["classes"]
        c["computed"] = {"at": "2026-10-26T10:00:00Z", "data": kwargs["fingerprint"]}
        return {"document": document, "issues": []}


async def stale_style(db: AsyncSession, world: StyleWorld) -> UUID:
    document = classified("ducklake:0")
    style = LayerStyle(
        layer_project_id=world.layer_project_id, name="Classified", document=document
    )
    db.add(style)
    await db.flush()
    db.add(LayerStyleRevision(style_id=style.id, revision=1, document=document))
    await db.execute(
        text(f"UPDATE {S}.layer SET data_snapshot = 5 WHERE id = :id"),
        {"id": world.layer_id},
    )
    await db.commit()
    assert style.id is not None
    return style.id


async def revisions(db: AsyncSession, style_id: UUID) -> int:
    return (
        await db.execute(
            select(func.count())
            .select_from(LayerStyleRevision)
            .where(LayerStyleRevision.style_id == style_id)
        )
    ).scalar_one()


async def read(db: AsyncSession, style_id: UUID, **kwargs: Any):
    return await read_style(
        db, await read_stored(db, style_id), access_token="t", **kwargs
    )


@pytest.mark.asyncio
async def test_a_stale_style_is_recomputed_and_stored_once(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    style_id = await stale_style(db_session, style_world)
    check = Recompute(breaks=(7,))
    monkeypatch.setattr(style_service, "style_check", check)
    result = await read(db_session, style_id)
    assert result.stale is False
    assert result.revision == 2
    assert result.document["classify"][0]["classes"][0]["to"] == 7
    assert (
        check.calls[0]["stored"] is True
        and check.calls[0]["fingerprint"] == "ducklake:5"
    )
    again = await read(db_session, style_id)
    assert (again.revision, len(check.calls)) == (2, 1)
    assert await revisions(db_session, style_id) == 2


@pytest.mark.asyncio
async def test_the_same_values_update_the_stamps_without_a_revision(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    style_id = await stale_style(db_session, style_world)
    monkeypatch.setattr(style_service, "style_check", Recompute())
    result = await read(db_session, style_id)
    assert (result.revision, result.stale) == (1, False)
    stored = await read_stored(db_session, style_id)
    assert stored.revision == 1
    assert stored.document["classify"][0]["computed"]["data"] == "ducklake:5"
    assert await revisions(db_session, style_id) == 1


@pytest.mark.asyncio
async def test_two_readers_of_one_stale_style_store_one_recompute(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    style_id = await stale_style(db_session, style_world)
    monkeypatch.setattr(style_service, "style_check", Recompute(breaks=(7,)))
    first_view = await read_stored(db_session, style_id)
    second_view = await read_stored(db_session, style_id)
    first = await read_style(db_session, first_view, access_token="t")
    second = await read_style(db_session, second_view, access_token="t")
    assert first.revision == second.revision == 2
    assert second.stale is False
    assert await revisions(db_session, style_id) == 2


@pytest.mark.asyncio
async def test_processes_down_answers_the_stored_style_marked_stale(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    style_id = await stale_style(db_session, style_world)
    monkeypatch.setattr(style_service, "style_check", Recompute(fail=True))
    result = await read(db_session, style_id)
    assert (result.revision, result.stale) == (1, True)
    assert result.document == classified("ducklake:0")


@pytest.mark.asyncio
async def test_check_returns_damaged_issues_and_stores_nothing(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    style_id = await stale_style(db_session, style_world)
    await db_session.execute(
        text(f"UPDATE {S}.layer SET data_snapshot = 0 WHERE id = :id"),
        {"id": style_world.layer_id},
    )
    await db_session.commit()
    check = Recompute()
    monkeypatch.setattr(style_service, "style_check", check)
    result = await read(db_session, style_id, check=True)
    assert [i["level"] for i in result.issues] == ["damaged"]
    assert check.calls[0]["compute"] is False and check.calls[0]["stored"] is True
    assert (await read_stored(db_session, style_id)).document == classified(
        "ducklake:0"
    )


@pytest.mark.asyncio
async def test_a_recompute_that_stays_stale_says_so(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    """processes could not compute it (an older processes, a field gone): the
    answer does not claim the style is current."""
    style_id = await stale_style(db_session, style_world)

    async def unchanged(**kwargs: Any) -> dict[str, Any]:
        return {"document": copy.deepcopy(kwargs["document"]), "issues": []}

    monkeypatch.setattr(style_service, "style_check", unchanged)
    result = await read(db_session, style_id)
    assert result.stale is True


@pytest.mark.asyncio
async def test_opening_the_panel_on_a_stale_style_recomputes_it(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Spec 12: the style panel opening is a reader that recomputes."""
    style_id = await stale_style(db_session, style_world)
    check = Recompute(breaks=(7,))
    monkeypatch.setattr(style_service, "style_check", check)
    result = await read(db_session, style_id, check=True)
    assert check.calls[0]["compute"] is True
    assert (result.revision, result.stale) == (2, False)
    assert result.document["classify"][0]["classes"][0]["to"] == 7

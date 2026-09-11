"""What happens to the committed bundle shell when the dispatch fails.

`POST /bundle/import` commits the shell before it asks the processes service
to run the ingest, because the shell is the foreign key the member layers and
the dependency link point at. The compensating delete may therefore only run
when the job cannot have started: a timeout or a 502 from the ingress can
arrive after Windmill accepted the submission, and an ingest that is already
running against a deleted row means FK violations and half-written layers.
"""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.db.models.folder import Folder
from core.db.models.organization import Organization
from core.db.models.user import User
from core.endpoints.deps import get_db, session_manager
from core.endpoints.v2 import bundle as bundle_endpoints
from core.main import app
from fastapi import HTTPException, status
from goatlib.bundles.importers.base import ValidationResult
from goatlib.models.bundle import BundleTypeName
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA


def _bearer(user_id: UUID) -> dict[str, str]:
    """Authorization header making the test client act as `user_id`."""

    def _segment(payload: dict[str, str]) -> str:
        return (
            base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
        )

    token = (
        f"{_segment({'alg': 'none', 'typ': 'JWT'})}."
        f"{_segment({'sub': str(user_id)})}.sig"
    )
    return {"Authorization": f"Bearer {token}"}


class _Importer:
    """Stands in for the type's importer: the upload is valid."""

    @staticmethod
    def validate(_path: str) -> ValidationResult:
        return ValidationResult(valid=True, detected_roles=["edges", "nodes"])


def _accept_the_upload(monkeypatch: pytest.MonkeyPatch) -> None:
    """Get the request as far as the dispatch: the download and the type
    sniffing are somebody else's code. Nothing stubs validation, because the
    endpoint no longer performs any — the import job does."""
    monkeypatch.setattr(
        bundle_endpoints.s3_service,
        "download_file",
        lambda *_a, **_kw: None,
    )
    monkeypatch.setattr(
        bundle_endpoints,
        "infer_bundle_type",
        lambda *_a, **_kw: BundleTypeName.street_network,
    )


def _payload(user: User, folder: Folder) -> dict[str, Any]:
    # Imports may only consume keys from the caller's own upload prefix.
    key = (
        bundle_endpoints.s3_service.build_s3_key(
            settings.S3_BUCKET_PATH, "users", str(user.id), "imports", "uploads"
        )
        + "/overture.zip"
    )
    return {
        "s3_key": key,
        "folder_id": str(folder.id),
        "name": "imported network",
    }


async def _shells(db: AsyncSession, folder: Folder) -> int:
    return int(
        (
            await db.execute(
                text(f"SELECT count(*) FROM {S}.bundle WHERE folder_id = :f"),
                {"f": folder.id},
            )
        ).scalar_one()
    )


@pytest.mark.asyncio
async def test_an_ambiguous_dispatch_failure_keeps_the_bundle(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 502 from the ingress says nothing about whether Windmill took the
    job, so the row it would ingest into has to stay."""
    org = await make_org()
    owner = await make_user(org.id)
    folder = await make_folder(owner, "Imports")
    await db_session.commit()
    _accept_the_upload(monkeypatch)

    async def _refused(**_kw: Any) -> str:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to start 'bundle_import' job",
        )

    monkeypatch.setattr(bundle_endpoints, "execute_process", _refused)

    response = await client.post(
        f"{settings.API_V2_STR}/bundle/import",
        json=_payload(owner, folder),
        headers=_bearer(owner.id),
    )
    assert response.status_code == 502, response.text
    assert await _shells(db_session, folder) == 1, (
        "a dispatch failure that may have been accepted must leave the bundle "
        "in place — the ingest needs it as an FK target"
    )


@pytest.mark.asyncio
async def test_a_client_timeout_keeps_the_bundle(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Same for a timeout waiting on the response: the submission may well
    have gone through."""
    org = await make_org()
    owner = await make_user(org.id)
    folder = await make_folder(owner, "Imports")
    await db_session.commit()
    _accept_the_upload(monkeypatch)

    async def _timed_out(**_kw: Any) -> str:
        raise asyncio.TimeoutError

    monkeypatch.setattr(bundle_endpoints, "execute_process", _timed_out)

    with pytest.raises(asyncio.TimeoutError):
        await client.post(
            f"{settings.API_V2_STR}/bundle/import",
            json=_payload(owner, folder),
            headers=_bearer(owner.id),
        )
    assert await _shells(db_session, folder) == 1


@pytest.mark.asyncio
async def test_a_dispatch_that_never_left_removes_the_shell(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The processes service is not configured, so no request was made: there
    is nothing to resume and a bundle stuck at `processing` offers the user no
    action that would fix it."""
    org = await make_org()
    owner = await make_user(org.id)
    folder = await make_folder(owner, "Imports")
    await db_session.commit()
    _accept_the_upload(monkeypatch)

    async def _unconfigured(**_kw: Any) -> str:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Processes service (GOAT_PROCESSES_URL) is not configured",
        )

    monkeypatch.setattr(bundle_endpoints, "execute_process", _unconfigured)

    response = await client.post(
        f"{settings.API_V2_STR}/bundle/import",
        json=_payload(owner, folder),
        headers=_bearer(owner.id),
    )
    assert response.status_code == 503, response.text
    assert await _shells(db_session, folder) == 0


@pytest.mark.asyncio
async def test_a_broken_session_does_not_replace_the_original_failure(
    client: AsyncClient,
    db_session: AsyncSession,
    authz_sql: None,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the dispatch failed because the database itself is gone, the
    cleanup fails too — and the caller must still be told what actually went
    wrong, not what the compensation ran into."""
    org = await make_org()
    owner = await make_user(org.id)
    folder = await make_folder(owner, "Imports")
    await db_session.commit()
    _accept_the_upload(monkeypatch)

    async def _unconfigured(**_kw: Any) -> str:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Processes service (GOAT_PROCESSES_URL) is not configured",
        )

    monkeypatch.setattr(bundle_endpoints, "execute_process", _unconfigured)

    class _DeleteFails:
        """The session, with the compensating delete failing on it."""

        def __init__(self, session: AsyncSession) -> None:
            self._session = session

        def __getattr__(self, name: str) -> Any:
            return getattr(self._session, name)

        async def delete(self, *_a: Any, **_kw: Any) -> None:
            raise RuntimeError("connection is gone")

    async def _override() -> AsyncIterator[Any]:
        async with session_manager.session() as session:
            yield _DeleteFails(session)

    app.dependency_overrides[get_db] = _override
    try:
        response = await client.post(
            f"{settings.API_V2_STR}/bundle/import",
            json=_payload(owner, folder),
            headers=_bearer(owner.id),
        )
    finally:
        app.dependency_overrides.pop(get_db, None)

    assert response.status_code == 503, response.text
    assert "not configured" in response.text


@pytest.mark.asyncio
async def test_the_predicate_only_admits_a_dispatch_that_cannot_have_run() -> None:
    from aiohttp import ClientConnectorError, ClientOSError
    from aiohttp.client_reqrep import ConnectionKey
    from core.services.processes import dispatch_never_started

    unconfigured = HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="not configured"
    )
    assert dispatch_never_started(unconfigured) is True
    connect_failed = ClientConnectorError(
        ConnectionKey("processes", 80, False, None, None, None, 0, None),
        OSError("refused"),
    )
    assert dispatch_never_started(connect_failed) is True

    # Everything else may have been accepted.
    assert (
        dispatch_never_started(
            HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="bad gateway")
        )
        is False
    )
    assert dispatch_never_started(asyncio.TimeoutError()) is False
    assert dispatch_never_started(ClientOSError("reset while waiting")) is False
    assert dispatch_never_started(RuntimeError(str(uuid4()))) is False

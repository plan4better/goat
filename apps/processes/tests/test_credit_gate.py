import pytest
from fastapi import HTTPException

from processes.services import credit_gate


class _Resp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _Client:
    def __init__(self, resp=None, exc=None):
        self._resp, self._exc = resp, exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, *a, **k):
        if self._exc:
            raise self._exc
        return self._resp


@pytest.mark.asyncio
async def test_blocks_when_over_budget(monkeypatch):
    monkeypatch.setattr(
        credit_gate.httpx,
        "AsyncClient",
        lambda *a, **k: _Client(_Resp(200, {"over_budget": True})),
    )
    with pytest.raises(HTTPException) as ei:
        await credit_gate.assert_credits_available("tok")
    assert ei.value.status_code == 402


@pytest.mark.asyncio
async def test_allows_when_under_budget(monkeypatch):
    monkeypatch.setattr(
        credit_gate.httpx,
        "AsyncClient",
        lambda *a, **k: _Client(_Resp(200, {"over_budget": False})),
    )
    await credit_gate.assert_credits_available("tok")  # no raise


@pytest.mark.asyncio
async def test_fails_open_on_error(monkeypatch):
    monkeypatch.setattr(
        credit_gate.httpx,
        "AsyncClient",
        lambda *a, **k: _Client(exc=RuntimeError("core down")),
    )
    await credit_gate.assert_credits_available("tok")  # must NOT raise

import pytest
from fastapi import HTTPException

from processes.services import credit_gate


@pytest.fixture(autouse=True)
def billing_on(monkeypatch):
    monkeypatch.setattr(credit_gate.settings, "BILLING_ENABLED", True)


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


@pytest.mark.asyncio
async def test_checks_nothing_with_billing_off(monkeypatch):
    # Self-hosted: core is not even asked, so an over-budget answer can't block.
    monkeypatch.setattr(credit_gate.settings, "BILLING_ENABLED", False)
    monkeypatch.setattr(
        credit_gate.httpx,
        "AsyncClient",
        lambda *a, **k: _Client(_Resp(200, {"over_budget": True})),
    )
    await credit_gate.assert_credits_available("tok")  # no raise


@pytest.mark.asyncio
async def test_deleting_data_is_never_refused(monkeypatch):
    # Out of credits, an organization must still be able to free space.
    monkeypatch.setattr(
        credit_gate.httpx,
        "AsyncClient",
        lambda *a, **k: _Client(_Resp(200, {"over_budget": True})),
    )
    for process_id in ("layer_delete", "layer_delete_multi", "bundle_artifact_delete"):
        await credit_gate.assert_credits_available("tok", process_id)  # no raise
    with pytest.raises(HTTPException):
        await credit_gate.assert_credits_available("tok", "buffer")


@pytest.mark.asyncio
async def test_non_200_answers_are_allowed_but_logged(monkeypatch, caplog):
    for code in (401, 404, 500, 503):
        monkeypatch.setattr(
            credit_gate.httpx,
            "AsyncClient",
            lambda *a, code=code, **k: _Client(_Resp(code, {"over_budget": True})),
        )
        caplog.clear()
        with caplog.at_level("WARNING", logger=credit_gate.logger.name):
            await credit_gate.assert_credits_available("tok", "buffer")  # no raise
        assert any(str(code) in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_a_non_json_200_fails_open_with_a_warning(monkeypatch, caplog):
    class _Html(_Resp):
        def json(self):
            raise ValueError("not json")

    monkeypatch.setattr(
        credit_gate.httpx,
        "AsyncClient",
        lambda *a, **k: _Client(_Html(200, None)),
    )
    with caplog.at_level("WARNING", logger=credit_gate.logger.name):
        await credit_gate.assert_credits_available("tok")  # no 500
    assert any("unreadable" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_a_json_200_that_is_not_an_object_fails_open(monkeypatch):
    monkeypatch.setattr(
        credit_gate.httpx,
        "AsyncClient",
        lambda *a, **k: _Client(_Resp(200, ["over_budget"])),
    )
    await credit_gate.assert_credits_available("tok")  # list has no .get: no raise

from fastapi import FastAPI
from starlette.responses import Response
from starlette.testclient import TestClient

from geoapi.middleware import credit_metering as cm
from geoapi.services.layer_service import LayerMetadata


def test_layer_metadata_carries_org_and_owner_through_serialization():
    m = LayerMetadata(
        layer_id="L",
        name="n",
        geometry_type="point",
        bounds=[0, 0, 1, 1],
        columns=[],
        user_id="owner-1",
        organization_id="org-1",
    )
    assert m.organization_id == "org-1"
    assert m.user_id == "owner-1"
    again = LayerMetadata.from_dict(m.to_dict())
    assert again.organization_id == "org-1"  # survives the Redis cache roundtrip
    assert again.user_id == "owner-1"


def test_collection_and_service_classification():
    assert cm._collection_id_from_path("/collections/abc/tiles/x/1/2/3") == "abc"
    assert cm._collection_id_from_path("/healthz") is None
    assert cm._service_from_path("/collections/abc/tiles/x/1/2/3") == "tiles"
    assert cm._service_from_path("/collections/abc/items") == "features"
    assert cm._service_from_path("/collections/abc/items/5") == "features"
    assert cm._service_from_path("/collections/abc/download") == "downloads"


def _app(monkeypatch, *, org, owner, over_budget, recorder):
    async def _resolve(cid):
        return (org, owner)

    async def _over(o):
        return over_budget

    async def _record(*args):
        recorder.append(args)

    monkeypatch.setattr(cm, "_resolve_layer_org", _resolve)
    monkeypatch.setattr(cm, "_is_over_budget", _over)
    monkeypatch.setattr(cm, "_record", _record)

    app = FastAPI()
    app.add_middleware(cm.CreditMeteringMiddleware)

    @app.get("/collections/{cid}/items")
    def items(cid: str):
        return Response(content=b"x" * 200, media_type="application/json")

    return app


def test_records_full_dimension_when_under_budget(monkeypatch):
    rec = []
    client = TestClient(
        _app(monkeypatch, org="org1", owner="own1", over_budget=False, recorder=rec)
    )
    # anonymous (no Authorization header)
    client.get("/collections/lyr9/items")
    # _record(org, owner, layer, service, size, anonymous)
    assert rec == [("org1", "own1", "lyr9", "features", 200, True)]


def test_authenticated_request_not_anonymous(monkeypatch):
    rec = []
    client = TestClient(
        _app(monkeypatch, org="org1", owner="own1", over_budget=False, recorder=rec)
    )
    client.get("/collections/lyr9/items", headers={"Authorization": "Bearer t"})
    org, owner, layer, service, size, anonymous = rec[0]
    assert anonymous is False


def test_blocks_when_over_budget(monkeypatch):
    rec = []
    client = TestClient(
        _app(monkeypatch, org="org1", owner="own1", over_budget=True, recorder=rec)
    )
    resp = client.get("/collections/lyr9/items")
    assert resp.status_code == 402
    assert rec == []  # blocked before serving

from fastapi import FastAPI
from starlette.responses import Response
from starlette.testclient import TestClient

from geoapi.middleware import credit_metering as cm
from geoapi.services.layer_service import LayerMetadata

LYR = "0b8f3a4e-5c1d-4e6a-9f27-3d1c2b4a5e60"


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

    def _record(*args):
        recorder.append(args)

    monkeypatch.setattr(cm, "_resolve_layer_org", _resolve)
    monkeypatch.setattr(cm, "_is_over_budget", _over)
    monkeypatch.setattr(cm, "_record", _record)

    app = FastAPI()
    app.add_middleware(cm.CreditMeteringMiddleware)

    @app.get("/collections/{cid}/items")
    def items(cid: str):
        return Response(content=b"x" * 200, media_type="application/json")

    @app.get("/collections/{cid}/download")
    def download(cid: str):
        return Response(content=b"x" * 300, media_type="application/octet-stream")

    return app


def test_records_full_dimension_when_under_budget(monkeypatch):
    rec = []
    client = TestClient(
        _app(monkeypatch, org="org1", owner="own1", over_budget=False, recorder=rec)
    )
    # anonymous (no Authorization header)
    client.get(f"/collections/{LYR}/items")
    # _record(org, owner, layer, service, size, anonymous)
    assert rec == [("org1", "own1", LYR, "features", 200, True)]


def test_authenticated_request_not_anonymous(monkeypatch):
    rec = []
    client = TestClient(
        _app(monkeypatch, org="org1", owner="own1", over_budget=False, recorder=rec)
    )
    client.get(f"/collections/{LYR}/items", headers={"Authorization": "Bearer t"})
    org, owner, layer, service, size, anonymous = rec[0]
    assert anonymous is False


def test_blocks_downloads_when_over_budget(monkeypatch):
    rec = []
    client = TestClient(
        _app(monkeypatch, org="org1", owner="own1", over_budget=True, recorder=rec)
    )
    resp = client.get(f"/collections/{LYR}/download")
    assert resp.status_code == 402
    assert rec == []  # blocked before serving


def test_maps_keep_working_when_over_budget(monkeypatch):
    # A published map or dashboard must not go dark: features and tiles are
    # served (and still metered) when the organization is out of credits.
    rec = []
    client = TestClient(
        _app(monkeypatch, org="org1", owner="own1", over_budget=True, recorder=rec)
    )
    resp = client.get(f"/collections/{LYR}/items")
    assert resp.status_code == 200
    assert rec == [("org1", "own1", LYR, "features", 200, True)]


def _layer_app(monkeypatch, recorder, *, resolves=True):
    async def _resolve(cid):
        recorder.append(("resolve", cid))
        return ("org1", "own1") if resolves else (None, None)

    def _record(*args):
        recorder.append(args)

    async def _over(o):
        return False

    monkeypatch.setattr(cm, "_resolve_layer_org", _resolve)
    monkeypatch.setattr(cm, "_is_over_budget", _over)
    monkeypatch.setattr(cm, "_record", _record)

    app = FastAPI()
    app.add_middleware(cm.CreditMeteringMiddleware)

    @app.api_route("/collections/{cid}/items", methods=["GET", "HEAD"])
    def items(cid: str):
        return Response(content=b"x" * 200, headers={"content-length": "200"})

    @app.get("/collections/{cid}/status/{code}")
    def status(cid: str, code: int):
        return Response(
            content=b"x" * 50, status_code=code, headers={"content-length": "50"}
        )

    return app


def _recorded(rec):
    return [r for r in rec if r[0] != "resolve"]


def test_layer_id_variants_share_one_counter_key(monkeypatch):
    rec = []
    client = TestClient(_layer_app(monkeypatch, rec))
    for variant in (LYR, LYR.upper(), LYR.replace("-", ""), f"urn:uuid:{LYR}"):
        client.get(f"/collections/{variant}/items")
    assert {r[2] for r in _recorded(rec)} == {LYR}
    assert len(_recorded(rec)) == 4
    assert {r[1] for r in rec if r[0] == "resolve"} == {LYR}  # lookups use it too


def test_paths_that_are_not_a_layer_are_neither_resolved_nor_counted(monkeypatch):
    rec = []
    client = TestClient(_layer_app(monkeypatch, rec))
    client.get("/collections/not-a-layer/items")
    assert rec == []


def test_unknown_layers_are_not_counted(monkeypatch):
    rec = []
    client = TestClient(_layer_app(monkeypatch, rec, resolves=False))
    client.get(f"/collections/{LYR}/items")
    assert _recorded(rec) == []


def test_only_get_with_200_or_206_is_metered(monkeypatch):
    rec = []
    client = TestClient(_layer_app(monkeypatch, rec))
    client.head(f"/collections/{LYR}/items")
    assert _recorded(rec) == []
    for code in (301, 304, 404, 500):
        client.get(f"/collections/{LYR}/status/{code}", follow_redirects=False)
    assert _recorded(rec) == []
    for code in (200, 206):
        client.get(f"/collections/{LYR}/status/{code}")
    assert [r[3:5] for r in _recorded(rec)] == [("features", 50), ("features", 50)]


class _Pipe:
    def __init__(self, calls, fail=False):
        self.calls, self.fail = calls, fail

    def __getattr__(self, name):
        return lambda *a: self.calls.append((name, a))

    def execute(self):
        if self.fail:
            raise ConnectionError("redis down")
        return []


class _Client:
    def __init__(self, fail=False):
        self.calls, self.fail = [], fail

    def pipeline(self):
        return _Pipe(self.calls, self.fail)


def test_counts_are_summed_in_memory_and_written_in_one_pipeline(monkeypatch):
    import asyncio

    monkeypatch.setattr(cm, "_pending", {})
    for _ in range(3):
        cm._record("org1", "own1", LYR, "tiles", 10, True)
    cm._record("org1", None, LYR, "tiles", 5, False)
    client = _Client()
    monkeypatch.setattr(cm, "_redis", lambda: client)
    asyncio.run(cm.flush())
    key = f"meter:egress:org1:{LYR}:tiles"
    assert ("hincrby", (key, "bytes", 35)) in client.calls
    assert ("hincrby", (key, "count", 4)) in client.calls
    assert ("hincrby", (key, "anon_count", 3)) in client.calls
    assert ("hset", (key, "owner", "own1")) in client.calls
    assert ("expire", (key, 7 * 24 * 3600)) in client.calls
    assert cm._pending == {}


def test_counts_survive_a_failed_write(monkeypatch):
    import asyncio

    monkeypatch.setattr(cm, "_pending", {})
    cm._record("org1", "own1", LYR, "tiles", 10, True)
    monkeypatch.setattr(cm, "_redis", lambda: _Client(fail=True))
    asyncio.run(cm.flush())
    cm._record("org1", "own1", LYR, "tiles", 7, False)
    client = _Client()
    monkeypatch.setattr(cm, "_redis", lambda: client)
    asyncio.run(cm.flush())
    key = f"meter:egress:org1:{LYR}:tiles"
    assert ("hincrby", (key, "bytes", 17)) in client.calls
    assert ("hincrby", (key, "count", 2)) in client.calls


def test_a_response_does_not_wait_for_redis(monkeypatch):
    # The middleware only counts in memory; nothing touches Redis on the way.
    monkeypatch.setattr(cm, "_pending", {})

    async def _resolve(cid):
        return ("org1", "own1")

    def _no_redis():
        raise AssertionError("Redis used on the request path")

    monkeypatch.setattr(cm, "_resolve_layer_org", _resolve)
    monkeypatch.setattr(cm, "_redis", _no_redis)
    app = FastAPI()
    app.add_middleware(cm.CreditMeteringMiddleware)

    @app.get("/collections/{cid}/tiles/{z}/{x}/{y}")
    def tile(cid: str, z: int, x: int, y: int):
        return Response(content=b"x" * 40, headers={"content-length": "40"})

    assert TestClient(app).get(f"/collections/{LYR}/tiles/1/2/3").status_code == 200
    assert cm._pending[("org1", LYR, "tiles")][:2] == [40, 1]


def test_downloads_are_left_to_the_download_route(monkeypatch):
    rec = []
    client = TestClient(
        _app(monkeypatch, org="org1", owner="own1", over_budget=False, recorder=rec)
    )
    assert client.get(f"/collections/{LYR}/download").status_code == 200
    assert rec == []


def test_metering_counts_with_the_tile_cache_switched_off(monkeypatch):
    from geoapi import tile_cache

    sentinel = object()
    monkeypatch.setattr(tile_cache.settings, "TILE_CACHE_ENABLED", False)
    monkeypatch.setattr(tile_cache, "_redis_client", sentinel)
    assert tile_cache.get_redis_client() is None
    assert cm._redis() is sentinel

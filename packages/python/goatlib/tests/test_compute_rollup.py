from goatlib.tasks.compute_rollup import select_chargeable, tool_from_path


def _job(**o):
    base = {
        "job_id": "j1",
        "user_id": "u1",
        "runnable_path": "f/goat/tools/buffer",
        "trigger_kind": None,
        "status": "success",
        "duration_ms": 4000,
        "has_children": False,
        "parent_job": None,
        "args": {},
    }
    base.update(o)
    return base


def test_tool_from_path():
    assert tool_from_path("f/goat/tools/catchment_area_pt") == "catchment_area_pt"
    assert tool_from_path(None) == "(unknown)"


def test_charges_a_standalone_tool():
    items = select_chargeable([_job()], already_charged=set())
    assert len(items) == 1
    it = items[0]
    assert it.user_id == "u1"
    assert it.action == "buffer"
    assert it.duration_seconds == 4.0  # 4000 ms
    assert it.payload["job_id"] == "j1"


def test_excludes_scheduled_failed_orchestrator_and_already_charged():
    jobs = [
        _job(job_id="sched", trigger_kind="schedule"),
        _job(job_id="fail", status="failure"),
        _job(job_id="orch", has_children=True),  # workflow_runner parent
        _job(job_id="orch2", runnable_path="f/goat/tools/workflow_runner"),
        _job(job_id="dup"),  # already charged
        _job(job_id="ok"),
    ]
    items = select_chargeable(jobs, already_charged={"dup"})
    assert {i.job_id for i in items} == {"ok"}


def test_workflow_node_tags_run_workflow_node_and_project():
    job = _job(
        job_id="node1",
        runnable_path="f/goat/tools/oev_gueteklassen",
        parent_job="orch-job-7",
        args={
            "user_id": "u1",
            "workflow_id": "wf9",
            "node_id": "n3",
            "project_id": "p7",
        },
    )
    p = select_chargeable([job], already_charged=set())[0].payload
    assert p["workflow_id"] == "wf9"
    assert p["node_id"] == "n3"
    assert (
        p["workflow_run_id"] == "orch-job-7"
    )  # parent_job = per-execution id (counts runs)
    assert p["project_id"] == "p7"


def test_skips_job_without_user():
    assert select_chargeable([_job(user_id=None)], set()) == []


def test_housekeeping_jobs_are_free():
    from goatlib.tasks.compute_rollup import select_chargeable

    job = {
        "job_id": "j1",
        "user_id": "u1",
        "args": {},
        "runnable_path": "f/goat/tools/layer_delete",
        "trigger_kind": None,
        "status": "success",
        "has_children": False,
        "duration_ms": 4000,
    }
    assert select_chargeable([job], set()) == []
    assert (
        len(select_chargeable([{**job, "runnable_path": "f/goat/tools/buffer"}], set()))
        == 1
    )


def test_an_export_carries_its_file_size_for_data_transfer():
    layer = _job(runnable_path="f/goat/tools/layer_export", export_size="6746")
    project = _job(
        job_id="p1", runnable_path="f/goat/tools/project_export", export_size="42989205"
    )
    items = select_chargeable([layer, project], set())
    assert [i.export_bytes for i in items] == [6746, 42989205]


def test_other_tools_and_odd_sizes_carry_no_data_transfer():
    other = _job(export_size="999")  # not an export: ignored even with a size
    broken = _job(
        job_id="b1", runnable_path="f/goat/tools/layer_export", export_size="n/a"
    )
    missing = _job(job_id="m1", runnable_path="f/goat/tools/layer_export")
    assert [
        i.export_bytes for i in select_chargeable([other, broken, missing], set())
    ] == [0, 0, 0]


# --- main(): selection window and per-job transactions -----------------------


class _FakeTx:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        self.conn.tx_open += 1

    async def __aexit__(self, *exc):
        self.conn.tx_open -= 1
        return False


class _FakeCore:
    """Core connection: records charge_credits calls, fails on demand."""

    def __init__(self, failing=(), duplicates=(), charged=()):
        self.failing = set(failing)
        self.duplicates = set(duplicates)
        self.charged = set(charged)
        self.calls: list[tuple] = []
        self.tx_open = 0
        self.closed = False

    def transaction(self):
        return _FakeTx(self)

    async def fetch(self, sql, *args):
        if "credit_usage" in sql:
            return [{"job_id": j} for j in self.charged]
        return [{"uid": "u1", "oid": "org1"}]

    async def execute(self, sql, *args):
        assert self.tx_open, "charge must run inside a transaction"
        import json

        job_id = json.loads(args[-1])["job_id"]
        if job_id in self.failing:
            raise RuntimeError("boom")
        if job_id in self.duplicates:
            import asyncpg

            raise asyncpg.UniqueViolationError("duplicate")
        self.calls.append((args[2], job_id))

    async def close(self):
        self.closed = True


def _api_job(job_id, path="f/goat/tools/buffer", **extra):
    """A job as Windmill's /jobs/list returns it: no arguments."""
    return {
        "id": job_id,
        "script_path": path,
        "success": True,
        "duration_ms": 1500,
        "args": None,
        **extra,
    }


_ARGS = {"user_id": "u1", "workflow_id": "w1", "node_id": "n1"}


class _Resp:
    def __init__(self, payload, status=200):
        self.payload, self.status = payload, status

    def raise_for_status(self):
        if self.status >= 400:
            raise RuntimeError(f"HTTP {self.status}")

    def json(self):
        return self.payload


class _FakeWm:
    """Windmill's API: /jobs/list in pages, results per job."""

    def __init__(self, jobs=None, results=None, args=None, page_size=100):
        self.jobs = jobs if jobs is not None else [_api_job(j) for j in "abcd"]
        self.results = results or {}
        # Arguments per job: every listed job has _ARGS unless given otherwise.
        self.args = {j["id"]: _ARGS for j in self.jobs} | (args or {})
        self.page_size = page_size
        self.requests: list[tuple] = []
        self.closed = False

    async def get(self, path, params=None):
        self.requests.append((path, params))
        if path == "/jobs/list":
            page = params["page"]
            size = params["per_page"]
            return _Resp(self.jobs[(page - 1) * size : page * size])
        job_id = path.rsplit("/", 1)[-1]
        source = self.args if "/get_args/" in path else self.results
        if source.get(job_id) is None:
            return _Resp(None, status=500)
        return _Resp(source[job_id])

    async def aclose(self):
        self.closed = True


def _run_main(monkeypatch, core, params=None, wm=None):
    import asyncpg
    from goatlib.tasks import compute_rollup as cr

    wm = wm or _FakeWm()

    async def connect(dsn, timeout=None):
        return core

    monkeypatch.setenv("BILLING_ENABLED", "1")
    monkeypatch.setattr(asyncpg, "connect", connect)
    monkeypatch.setattr(cr, "_windmill_client", lambda: wm)
    monkeypatch.setattr(cr, "core_dsn", lambda: "core")
    return cr.main(params or cr.ComputeRollupParams()), wm


def test_selects_by_completion_time_with_a_day_of_lookback(monkeypatch):
    from datetime import datetime, timedelta, timezone

    from goatlib.tasks.compute_rollup import ComputeRollupParams

    assert ComputeRollupParams().lookback_minutes == 1440
    _, wm = _run_main(monkeypatch, _FakeCore())
    path, params = wm.requests[0]
    assert path == "/jobs/list"
    assert params["script_path_start"] == "f/goat/tools/"
    assert params["success"] == "true" and params["is_not_schedule"] == "true"
    after = datetime.strptime(params["completed_after"], "%Y-%m-%dT%H:%M:%SZ")
    day_ago = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1)
    assert abs((after - day_ago).total_seconds()) < 60
    assert wm.closed


def test_every_page_of_jobs_is_read(monkeypatch):
    from goatlib.tasks import compute_rollup as cr

    monkeypatch.setattr(cr, "_PAGE_SIZE", 2)
    core = _FakeCore()
    wm = _FakeWm(jobs=[_api_job(j) for j in "abcde"])
    summary, _ = _run_main(monkeypatch, core, wm=wm)
    assert [p["page"] for path, p in wm.requests if path == "/jobs/list"] == [1, 2, 3]
    assert sorted(j for _, j in core.calls) == list("abcde")
    assert summary["considered"] == 5


def test_a_job_is_charged_with_its_user_and_workflow_run(monkeypatch):
    core = _FakeCore()
    wm = _FakeWm(jobs=[_api_job("a", parent_job="run-1")])
    _run_main(monkeypatch, core, wm=wm)
    assert core.calls == [("buffer", "a")]


def test_only_uncharged_exports_have_their_result_read(monkeypatch):
    core = _FakeCore(charged={"old"})
    wm = _FakeWm(
        jobs=[
            _api_job("old", path="f/goat/tools/layer_export"),
            _api_job("new", path="f/goat/tools/layer_export"),
            _api_job("buf"),
        ],
        results={"old": {"file_size_bytes": 1}, "new": {"file_size_bytes": 2048}},
    )
    _run_main(monkeypatch, core, wm=wm)
    result_reads = [path for path, _ in wm.requests if "get_result" in path]
    assert result_reads == ["/jobs_u/completed/get_result/new"]
    # the export's compute, its 2048 bytes of data transfer, then the buffer run
    assert core.calls == [("layer_export", "new"), (2048, "new"), ("buffer", "buf")]


def test_only_jobs_still_to_charge_have_their_arguments_read(monkeypatch):
    core = _FakeCore(charged={"a"})
    wm = _FakeWm(
        jobs=[
            _api_job("a"),
            _api_job("b"),
            _api_job("r", path="f/goat/tools/workflow_runner"),
            _api_job("d", path="f/goat/tools/layer_delete"),
        ]
    )
    _run_main(monkeypatch, core, wm=wm)
    assert [p for p, _ in wm.requests if "get_args" in p] == ["/jobs_u/get_args/b"]
    assert core.calls == [("buffer", "b")]


def test_a_job_without_a_user_is_not_charged(monkeypatch):
    core = _FakeCore()
    wm = _FakeWm(jobs=[_api_job("s")], args={"s": {"layer_id": "x"}})
    _run_main(monkeypatch, core, wm=wm)
    assert core.calls == []


def test_a_job_whose_arguments_cannot_be_read_waits_for_the_next_run(monkeypatch):
    core = _FakeCore()
    wm = _FakeWm(jobs=[_api_job("x")], args={"x": None})
    summary, _ = _run_main(monkeypatch, core, wm=wm)
    assert core.calls == [] and summary["failed"] == 0


def test_an_export_whose_result_cannot_be_read_waits_for_the_next_run(monkeypatch):
    core = _FakeCore()
    wm = _FakeWm(jobs=[_api_job("x", path="f/goat/tools/layer_export")], results={})
    summary, _ = _run_main(monkeypatch, core, wm=wm)
    assert core.calls == []
    assert summary["charged"] == 0


def test_one_failing_job_does_not_stop_the_rest(monkeypatch):
    core = _FakeCore(failing={"b"})
    summary, _ = _run_main(monkeypatch, core)
    assert [j for _, j in core.calls] == ["a", "c", "d"]
    assert summary["charged"] == 3
    assert summary["failed"] == 1
    assert summary["considered"] == 4
    assert core.tx_open == 0


def test_unique_violation_means_already_charged_not_failed(monkeypatch):
    core = _FakeCore(duplicates={"a", "c"})
    summary, _ = _run_main(monkeypatch, core)
    assert summary["charged"] == 2
    assert summary["failed"] == 0
    assert summary["skipped"] == 2


def test_dry_run_charges_nothing(monkeypatch):
    from goatlib.tasks.compute_rollup import ComputeRollupParams

    core = _FakeCore()
    summary, _ = _run_main(monkeypatch, core, ComputeRollupParams(dry_run=True))
    assert core.calls == []
    assert summary["charged"] == 0
    assert summary["failed"] == 0

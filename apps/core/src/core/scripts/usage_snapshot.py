"""GOAT Usage snapshot — gauge emitter for the "GOAT - Usage" Grafana dashboard.

Runs as a Kubernetes CronJob (every 5 min), queries GOAT's Postgres via the
existing async session manager, and pushes a fixed set of OTel gauges through
the alloy-receiver OTLP endpoint that goatobs already speaks to. Each gauge
maps 1:1 to a panel in ``argocd/apps/o11y/grafana/dashboards/goat-usage.json``.

Invocation::

    python -m core.scripts.usage_snapshot

Env vars consumed (via ``goatobs.setup_observability`` and ``settings``):

* ``OTEL_ENABLED`` -- must be ``true`` for any metric to be exported.
* ``ENVIRONMENT`` -- ``dev`` / ``prod`` etc, used as ``deployment.environment``.
* ``OTEL_EXPORTER_OTLP_ENDPOINT`` -- gRPC endpoint of the local Alloy receiver.
* GOAT Postgres connection vars (``POSTGRES_*`` -> ``ASYNC_SQLALCHEMY_DATABASE_URI``).

Exit codes:

* ``0`` -- every query succeeded; ``goat_usage_snapshot_last_success_timestamp_seconds``
  was advanced.
* ``1`` -- at least one query failed; the gauges for failed queries keep their
  previous value in Mimir, ``goat_usage_snapshot_query_errors_total{query_name=...}``
  was incremented, and Kubernetes records the CronJob run as failed.

Each query runs in its own ``try/except`` so one broken query does not prevent
the rest from publishing.
"""

import asyncio
import datetime as dt
import logging
import os
import sys
import time
from typing import Any, Awaitable, Callable

import asyncpg
from goatlib.config.postgres import asyncpg_connect_args
from goatobs import setup_observability
from opentelemetry import metrics as otel_metrics
from opentelemetry.metrics import CallbackOptions, Observation
from opentelemetry.sdk.metrics import MeterProvider
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from core.core.config import settings
from core.db.session import session_manager

# OTel Python SDK exposes sync gauges via `meter.create_gauge(...)` but the
# public `opentelemetry.metrics` module doesn't re-export the `Gauge` /
# `Counter` types for use in annotations (only `_Gauge` is exposed, and only
# as an implementation detail). Use `Any` for instrument type hints — the
# values are still type-checked via the `meter.create_*` return type at
# the call site, and runtime calls don't care.
Instrument = Any

logger = logging.getLogger(__name__)

# Sentinel used for label values that are NULL in the DB but where
# Prometheus/Mimir dislikes empty-string labels (they round-trip as
# "missing" in PromQL). Applied to feature_subtype, geometry, and
# data_type on layers that don't have them (e.g. type=raster has no
# feature_subtype, type=table has no geometry/data_type).
MISSING_DIM = "-"

# Reusable SQL CTE that adds disambiguating suffix to org names that
# collide. Org names ARE NOT unique in the goat schema (e.g. multiple
# orgs literally called "Test"), so emitting raw `org_name` to Mimir
# would have the dashboard's Organization dropdown collapse colliding
# orgs into one entry that filters to BOTH.
#
# Strategy: suffix the name ONLY when it collides, using the owner's
# full email as the human-readable disambiguator. The owner is the
# user with the `organization-owner` role (see core/db/seed_roles.py)
# whose own `organization_id` points at this org. If the org has
# multiple owners we pick MIN(email) deterministically; if it has zero
# owners we fall back to an 8-char UUID prefix. Output shape:
#   - "Acme GmbH"                            -- unique, untouched
#   - "Test (alice@plan4better.de)"          -- collides; owner alice@…
#   - "Test (bob@example.com)"               -- the other collider
#   - "Test (a1b2c3d4)"                      -- collides + no owner record
#
# The metric label `org_id` (the actual UUID) is emitted on every
# series independently, so anyone needing exact identification can
# filter by it — the suffix only exists to make the dropdown readable.
ORG_DISAMBIG_CTE = """
    WITH org_owner_emails AS (
        SELECT
            u.organization_id,
            -- Pick a deterministic owner if there are multiple.
            MIN(u.email) AS owner_email
        FROM {schema}."user" u
        JOIN {schema}.user_role ur ON ur.user_id = u.id
        JOIN {schema}.role r ON r.id = ur.role_id
        WHERE r.name = 'organization-owner'
          AND u.email IS NOT NULL
        GROUP BY u.organization_id
    ),
    disambig_orgs AS (
        SELECT
            o.id,
            CASE WHEN COUNT(*) OVER (PARTITION BY o.name) > 1
                 THEN o.name || ' ('
                      || COALESCE(oe.owner_email, LEFT(o.id::text, 8))
                      || ')'
                 ELSE o.name
            END AS display_name
        FROM {schema}.organization o
        LEFT JOIN org_owner_emails oe ON oe.organization_id = o.id
    )
"""

# Database query names -- referenced by the per-query error counter labels.
# Keep stable: dashboards and alerts may key off these names.
Q_LAYERS = "layers"
Q_LAYER_BYTES = "layer_bytes"
Q_LAYER_SIZE_DIST = "layer_size_distribution"
Q_PROJECTS = "projects"
Q_USERS = "users"
Q_USER_PROJECTS = "user_projects"
# Layers + bytes per user share one SQL query (same join shape) so they share
# one error-counter bucket too. If the query fails, both gauges stop updating
# together, which is the cardinality we want for alerting.
Q_USER_LAYERS = "user_layers"
# Windmill query names — emit cumulative job counters/sums from the
# Windmill database (separate DB on the same Postgres cluster).
Q_WM_USER_ORG = "user_org_map"
Q_WM_JOBS = "windmill_jobs"
Q_WM_RUNNING = "windmill_running"

# Env var holding the Windmill DSN. Sourced from the windmill-secret in
# Kubernetes — mounted on the CronJob via valueFrom.secretKeyRef. Holds
# `postgres://windmill:<pw>@goat-db-rw.postgres.svc.cluster.local:5432/windmill?sslmode=disable`
WINDMILL_DSN_ENV = "WINDMILL_DATABASE_URL"

# Module-level observation cache used by sync ObservableCounter callbacks.
# Populated in `snapshot()` BEFORE we register the observable instruments;
# the OTel SDK invokes the callbacks at export time (via force_flush) and
# they return whatever's in this cache. Empty dict = nothing to emit, which
# the SDK treats as the metric being absent (correct behavior if Windmill is
# unreachable — the goat-side state metrics still publish independently).
_OBSERVATIONS: dict[str, list[Observation]] = {}

# Tool name extraction: `runnable_path` looks like "f/goat/tools/clip" or
# "f/goat/tasks/rebuild_edited_pmtiles". We take the LAST path segment
# as the `tool` label. The script filters out scheduled tasks at SQL
# level (`trigger_kind IS NULL`), so the `tasks/` paths shouldn't appear
# in the emitted metrics anyway.


def _build_meter() -> otel_metrics.Meter:
    """Return the meter for the snapshot.

    ``setup_observability`` installs the global ``MeterProvider`` whenever
    ``OTEL_ENABLED=true``; otherwise we get the no-op provider and the
    instruments below silently drop their values, which is the right
    behavior for local invocations.
    """
    return otel_metrics.get_meter("core.scripts.usage_snapshot")


def _make_instruments(meter: otel_metrics.Meter) -> dict[str, object]:
    """Construct all gauges + the error counter once per run.

    Returning a dict (rather than module-level constants) keeps the instruments
    bound to the meter created *after* ``setup_observability`` ran, which
    matters because the global ``MeterProvider`` is replaced inside that call.
    """
    return {
        "layers_total": meter.create_gauge(
            "goat_layers_total",
            description="Number of layers per org x type x feature_layer_type.",
        ),
        "layer_bytes_total": meter.create_gauge(
            "goat_layer_bytes_total",
            description="Total bytes of layer storage per org (SUM(layer.size)).",
            unit="By",
        ),
        "layer_size_distribution": meter.create_gauge(
            "goat_layer_size_distribution",
            description=(
                "Count of layers per org x type x size_bucket. "
                "Only internal layers (layer.size IS NOT NULL) — external "
                "wms/wmts/xyz/mvt/wfs layers fall into 'n/a (external)'."
            ),
        ),
        "projects_total": meter.create_gauge(
            "goat_projects_total",
            description="Number of projects per org.",
        ),
        "users_total": meter.create_gauge(
            "goat_users_total",
            description="Number of users per org x role.",
        ),
        "user_projects_total": meter.create_gauge(
            "goat_user_projects_total",
            description="Number of projects owned by each user.",
        ),
        "user_layers_total": meter.create_gauge(
            "goat_user_layers_total",
            description="Number of layers owned by each user.",
        ),
        "user_layer_bytes_total": meter.create_gauge(
            "goat_user_layer_bytes_total",
            description="Bytes of layer storage owned by each user (SUM(layer.size)).",
            unit="By",
        ),
        "snapshot_success_ts": meter.create_gauge(
            "goat_usage_snapshot_last_success_timestamp_seconds",
            description=(
                "Unix timestamp of the most recent fully-successful snapshot. "
                "Drives the snapshot-lag stat on the GOAT - Usage dashboard."
            ),
            unit="s",
        ),
        "query_errors_total": meter.create_counter(
            "goat_usage_snapshot_query_errors_total",
            description="Per-query failure counter for the GOAT usage snapshot.",
        ),
    }


# ----------------------------------------------------------------------------
# Per-query handlers. Each function runs one SQL query and writes the
# corresponding gauge(s). They MUST raise on failure so the outer orchestrator
# can record the error -- they must not swallow exceptions.
# ----------------------------------------------------------------------------


async def snapshot_layers(db: AsyncSession, gauge: Instrument) -> int:
    """Emit ``goat_layers_total`` per (org, type, feature_layer_type).

    "Org" here is the *owning* org: ``layer.user_id -> user.organization_id``.
    Sharing links (``resource_grant`` rows) intentionally do not contribute --
    otherwise a shared layer would be double-counted across every org it's
    shared into, and the dashboard's "total layers" panel would no longer
    equal ``count(*)`` over the ``layer`` table.
    """
    schema = settings.SCHEMA
    # Five dimensions on top of org:
    #   * `type`             feature / raster / table
    #   * `feature_subtype`  standard / tool / street_network / "-"
    #                        (originally called `feature_layer_type` —
    #                        renamed because its dashboard label was
    #                        mislabelled as "geometry")
    #   * `geometry`         point / line / polygon / "-"
    #                        (the actual geometry — source column is
    #                        `feature_layer_geometry_type`)
    #   * `source`           internal (locally-stored) / external
    #                        (hosted elsewhere as wms/wmts/xyz/mvt/wfs).
    #                        Derived: data_type IS NULL OR data_type='cog'
    #                        is internal; everything else external.
    #   * `data_type`        wms / wmts / xyz / cog / mvt / wfs / "-"
    #                        Raw enum from the DB so panels can filter
    #                        "external by protocol".
    query = text(
        ORG_DISAMBIG_CTE.format(schema=schema)
        + f"""
        SELECT
            o.id::text AS org_id,
            do_.display_name AS org_name,
            l.type AS type,
            COALESCE(l.feature_layer_type, :sentinel)          AS feature_subtype,
            COALESCE(l.feature_layer_geometry_type, :sentinel) AS geometry,
            CASE WHEN l.data_type IS NULL OR l.data_type = 'cog'
                 THEN 'internal' ELSE 'external' END           AS source,
            COALESCE(l.data_type, :sentinel)                   AS data_type,
            count(*) AS n
        FROM {schema}.layer l
        JOIN {schema}."user" u ON u.id = l.user_id
        JOIN {schema}.organization o ON o.id = u.organization_id
        JOIN disambig_orgs do_ ON do_.id = o.id
        GROUP BY
            o.id, do_.display_name,
            l.type, l.feature_layer_type, l.feature_layer_geometry_type,
            l.data_type
        """
    )
    result = await db.execute(query, {"sentinel": MISSING_DIM})
    rows = result.all()
    for row in rows:
        gauge.set(
            row.n,
            attributes={
                "org_id": row.org_id,
                "org_name": row.org_name,
                "type": row.type,
                "feature_subtype": row.feature_subtype,
                "geometry": row.geometry,
                "source": row.source,
                "data_type": row.data_type,
            },
        )
    return len(rows)


async def snapshot_layer_bytes(db: AsyncSession, gauge: Instrument) -> int:
    """Emit ``goat_layer_bytes_total`` per org (SUM of ``layer.size`` bytes)."""
    schema = settings.SCHEMA
    query = text(
        ORG_DISAMBIG_CTE.format(schema=schema)
        + f"""
        SELECT
            o.id::text AS org_id,
            do_.display_name AS org_name,
            COALESCE(SUM(l.size), 0)::bigint AS bytes
        FROM {schema}.layer l
        JOIN {schema}."user" u ON u.id = l.user_id
        JOIN {schema}.organization o ON o.id = u.organization_id
        JOIN disambig_orgs do_ ON do_.id = o.id
        GROUP BY o.id, do_.display_name
        """
    )
    result = await db.execute(query)
    rows = result.all()
    for row in rows:
        gauge.set(
            row.bytes,
            attributes={"org_id": row.org_id, "org_name": row.org_name},
        )
    return len(rows)


async def snapshot_layer_size_distribution(db: AsyncSession, gauge: Instrument) -> int:
    """Emit ``goat_layer_size_distribution`` per (org, type, size_bucket).

    Buckets every layer into a size class so the dashboard can render
    "how many layers fall in each size class" as a histogram. External
    layers (wms/wmts/xyz/mvt/wfs) have ``size IS NULL`` because they're
    just a URL — they get their own ``n/a (external)`` bucket so they
    stay visible in the chart but don't pollute the storage view.

    The buckets are chosen to match orders of magnitude (1 MiB, 10 MiB,
    100 MiB, 1 GiB). If real-world data is concentrated in one bucket
    we can re-cut later — buckets ARE part of the metric label so
    changing them produces new series, but the old ones go stale within
    the 5-min Prometheus staleness window.
    """
    schema = settings.SCHEMA
    query = text(
        ORG_DISAMBIG_CTE.format(schema=schema)
        + f"""
        SELECT
            o.id::text AS org_id,
            do_.display_name AS org_name,
            l.type AS type,
            CASE
                WHEN l.size IS NULL              THEN 'n/a (external)'
                WHEN l.size < 1048576            THEN '< 1 MiB'
                WHEN l.size < 10485760           THEN '1–10 MiB'
                WHEN l.size < 104857600          THEN '10–100 MiB'
                WHEN l.size < 1073741824         THEN '100 MiB – 1 GiB'
                ELSE                                  '> 1 GiB'
            END AS size_bucket,
            count(*) AS n
        FROM {schema}.layer l
        JOIN {schema}."user" u ON u.id = l.user_id
        JOIN {schema}.organization o ON o.id = u.organization_id
        JOIN disambig_orgs do_ ON do_.id = o.id
        GROUP BY o.id, do_.display_name, l.type, size_bucket
        """
    )
    result = await db.execute(query)
    rows = result.all()
    for row in rows:
        gauge.set(
            row.n,
            attributes={
                "org_id": row.org_id,
                "org_name": row.org_name,
                "type": row.type,
                "size_bucket": row.size_bucket,
            },
        )
    return len(rows)


async def snapshot_projects(db: AsyncSession, gauge: Instrument) -> int:
    """Emit ``goat_projects_total`` per org (owner-of-record interpretation)."""
    schema = settings.SCHEMA
    query = text(
        ORG_DISAMBIG_CTE.format(schema=schema)
        + f"""
        SELECT
            o.id::text AS org_id,
            do_.display_name AS org_name,
            count(*) AS n
        FROM {schema}.project p
        JOIN {schema}."user" u ON u.id = p.user_id
        JOIN {schema}.organization o ON o.id = u.organization_id
        JOIN disambig_orgs do_ ON do_.id = o.id
        GROUP BY o.id, do_.display_name
        """
    )
    result = await db.execute(query)
    rows = result.all()
    for row in rows:
        gauge.set(
            row.n,
            attributes={"org_id": row.org_id, "org_name": row.org_name},
        )
    return len(rows)


async def snapshot_users(db: AsyncSession, gauge: Instrument) -> int:
    """Emit ``goat_users_total`` per org (DISTINCT user count).

    Earlier iteration broke this out by role too, which caused
    ``sum(goat_users_total)`` on the dashboard's "Total Users" panel to
    double-count users with multiple roles. The role label is dropped;
    if a role breakdown panel is needed later, emit it as a separate
    metric family.

    The EXISTS filter keeps the original "user must have at least one
    role to be a GOAT user" semantics — unrole'd ghost rows in the
    ``user`` table are still excluded.
    """
    schema = settings.SCHEMA
    query = text(
        ORG_DISAMBIG_CTE.format(schema=schema)
        + f"""
        SELECT
            o.id::text AS org_id,
            do_.display_name AS org_name,
            count(DISTINCT u.id) AS n
        FROM {schema}."user" u
        JOIN {schema}.organization o ON o.id = u.organization_id
        JOIN disambig_orgs do_ ON do_.id = o.id
        WHERE EXISTS (
            SELECT 1 FROM {schema}.user_role ur WHERE ur.user_id = u.id
        )
        GROUP BY o.id, do_.display_name
        """
    )
    result = await db.execute(query)
    rows = result.all()
    for row in rows:
        gauge.set(
            row.n,
            attributes={
                "org_id": row.org_id,
                "org_name": row.org_name,
            },
        )
    return len(rows)


async def snapshot_user_projects(db: AsyncSession, gauge: Instrument) -> int:
    """Emit ``goat_user_projects_total{user_email, org_id, org_name}``.

    Users have a single ``organization_id`` in this schema, so emitting one
    series per (user, owning_org) is the same as one series per user. The
    extra org labels keep the dashboard's Organization dropdown working
    when scoped to a specific org.
    """
    schema = settings.SCHEMA
    query = text(
        ORG_DISAMBIG_CTE.format(schema=schema)
        + f"""
        SELECT
            u.email AS user_email,
            o.id::text AS org_id,
            do_.display_name AS org_name,
            count(p.id) AS n
        FROM {schema}."user" u
        JOIN {schema}.organization o ON o.id = u.organization_id
        JOIN {schema}.project p ON p.user_id = u.id
        JOIN disambig_orgs do_ ON do_.id = o.id
        WHERE u.email IS NOT NULL
        GROUP BY u.email, o.id, do_.display_name
        """
    )
    result = await db.execute(query)
    rows = result.all()
    for row in rows:
        gauge.set(
            row.n,
            attributes={
                "user_email": row.user_email,
                "org_id": row.org_id,
                "org_name": row.org_name,
            },
        )
    return len(rows)


async def snapshot_user_layers(
    db: AsyncSession,
    layers_gauge: Instrument,
    bytes_gauge: Instrument,
) -> int:
    """Emit ``goat_user_layers_total`` and ``goat_user_layer_bytes_total``.

    Both share the same join shape, so we issue a single query that returns
    both columns and write to two gauges. Keeps user-scoped data in one place.

    Mirrors the org-scoped `snapshot_layers` breakdown — same `type`,
    `feature_subtype`, `geometry`, `source`, `data_type` labels — so the
    Layers tab's composition panels keep working when scoped to a single
    user. Cardinality stays bounded because each user typically has
    a handful of unique (type, subtype, geometry, source, data_type)
    tuples, not the cross-product.
    """
    schema = settings.SCHEMA
    query = text(
        ORG_DISAMBIG_CTE.format(schema=schema)
        + f"""
        SELECT
            u.email AS user_email,
            o.id::text AS org_id,
            do_.display_name AS org_name,
            l.type AS type,
            COALESCE(l.feature_layer_type, :sentinel)          AS feature_subtype,
            COALESCE(l.feature_layer_geometry_type, :sentinel) AS geometry,
            CASE WHEN l.data_type IS NULL OR l.data_type = 'cog'
                 THEN 'internal' ELSE 'external' END           AS source,
            COALESCE(l.data_type, :sentinel)                   AS data_type,
            count(l.id) AS n,
            COALESCE(SUM(l.size), 0)::bigint AS bytes
        FROM {schema}."user" u
        JOIN {schema}.organization o ON o.id = u.organization_id
        JOIN {schema}.layer l ON l.user_id = u.id
        JOIN disambig_orgs do_ ON do_.id = o.id
        WHERE u.email IS NOT NULL
        GROUP BY
            u.email, o.id, do_.display_name,
            l.type, l.feature_layer_type, l.feature_layer_geometry_type,
            l.data_type
        """
    )
    result = await db.execute(query, {"sentinel": MISSING_DIM})
    rows = result.all()
    for row in rows:
        attrs = {
            "user_email": row.user_email,
            "org_id": row.org_id,
            "org_name": row.org_name,
            "type": row.type,
            "feature_subtype": row.feature_subtype,
            "geometry": row.geometry,
            "source": row.source,
            "data_type": row.data_type,
        }
        layers_gauge.set(row.n, attributes=attrs)
        bytes_gauge.set(row.bytes, attributes=attrs)
    return len(rows)


# ----------------------------------------------------------------------------
# Windmill metrics — cross-DB (goat user_id ↔ Windmill args.user_id UUID join)
# ----------------------------------------------------------------------------
#
# Windmill stores every user-triggered job's GOAT user UUID in
# `v2_job.args -> 'user_id'`. We use that to attribute jobs back to GOAT
# orgs without needing fragile email-string matching.
#
# Implementation flow (all driven from `snapshot()` below):
#  1. Open a second async connection to the Windmill DB.
#  2. Fetch a user_uuid → (org_id, org_name) dict from the GOAT DB
#     (using the same ORG_DISAMBIG_CTE so the org_name labels match
#     what other goat_* metrics emit).
#  3. Run aggregation queries against Windmill, post-process each row
#     to attach the org labels via the dict.
#  4. Stash the resulting Observation lists in `_OBSERVATIONS`.
#  5. Register ObservableGauge instruments whose callbacks just read
#     from the cache. `force_flush()` then collects and exports.
#
# Why ObservableGauge (not Counter):
# `goat_jobs_count` and friends represent activity in the LAST cron
# window (5 minutes), not cumulative-since-forever. Dashboards integrate
# with `sum_over_time(goat_jobs_count[$__range])`. Counters would have
# been wrong because Windmill's 30-day retention drops old jobs from
# `v2_job_completed`, so a counter sourced from that table would appear
# to reset/decrease — which `rate()` / `increase()` interpret as a real
# counter reset and double-count after the boundary. Per-window gauges
# don't have this failure mode.


async def _connect_windmill() -> asyncpg.Connection:
    """Open a read-only-style asyncpg connection to the Windmill DB.

    Reads `WINDMILL_DATABASE_URL` from the env. Strips the `?sslmode=…`
    query string because asyncpg doesn't accept it as a DSN parameter
    (it has its own `ssl=` kwarg). The connection is short-lived: opened
    in `snapshot()`, used to run a handful of aggregations, closed at
    the end of the function.
    """
    dsn = os.environ.get(WINDMILL_DSN_ENV)
    if not dsn:
        raise RuntimeError(
            f"{WINDMILL_DSN_ENV} env var not set — required for Windmill metrics. "
            "Mount it on the CronJob from windmill-secret."
        )
    # Drop the query string (sslmode etc.) — asyncpg parses DSN itself.
    dsn = dsn.split("?", 1)[0]
    return await asyncpg.connect(
        dsn=dsn,
        timeout=10,
        **asyncpg_connect_args("goat-core", settings.POSTGRES_TRANSACTION_POOLER),
    )


async def _fetch_user_org_map(
    db: AsyncSession,
) -> dict[str, tuple[str, str, str]]:
    """Build `dict[user_uuid_str → (org_id_str, org_name_str, email_str)]`.

    Used as a Python-side lookup table when post-processing Windmill rows:
    each Windmill job has `args.user_id` (a UUID), we resolve that to the
    user's org + email, and emit org_id/org_name/user_email labels on
    the metric.

    Reuses `ORG_DISAMBIG_CTE` so the `org_name` values match what other
    `goat_*` metrics emit — including any "Test (alice@…)" disambig
    suffix on colliding names.

    Returns empty dict on query failure (caller decides what to do —
    typically: log + skip Windmill metrics, since they can't be
    org-attributed without this map).
    """
    schema = settings.SCHEMA
    query = text(
        ORG_DISAMBIG_CTE.format(schema=schema)
        + f"""
        SELECT
            u.id::text AS user_id,
            o.id::text AS org_id,
            do_.display_name AS org_name,
            COALESCE(u.email, '(unknown)') AS email
        FROM {schema}."user" u
        JOIN {schema}.organization o ON o.id = u.organization_id
        JOIN disambig_orgs do_ ON do_.id = o.id
        """
    )
    result = await db.execute(query)
    return {row.user_id: (row.org_id, row.org_name, row.email) for row in result.all()}


def _tool_from_path(runnable_path: str | None) -> str:
    """Extract the tool name from a Windmill `runnable_path`.

    Inputs look like `f/goat/tools/clip` or `f/goat/tasks/rebuild_edited_pmtiles`
    — we just take the last `/`-segment. Empty / None gets a sentinel
    "(unknown)" so the metric never emits an empty `tool` label.
    """
    if not runnable_path:
        return "(unknown)"
    return runnable_path.rsplit("/", 1)[-1]


def _cron_aligned_window(
    cadence_minutes: int = 5,
) -> tuple[dt.datetime, dt.datetime]:
    """Compute the cron-aligned [window_start, window_end) for this run.

    The CronJob schedule is `*/5 * * * *` — fires at minutes 0, 5, 10, …
    of every hour. We round `now()` DOWN to the nearest 5-minute mark
    and query the previous 5-minute slot ending at that mark.

    Why: this makes the query window deterministic regardless of when
    the pod actually starts. A pod that fires 8s late and another that
    fires 14s late both query the SAME 5-minute window, so consecutive
    runs neither overlap nor leave drift-induced gaps. The only failure
    mode is a fully-skipped run, which loses that 5-min window's data
    (no automatic catch-up). For a usage dashboard this is acceptable;
    if it ever bites, the fix is a watermark — see commit history /
    spec for the rejected `usage_snapshot_watermark` table design.

    Returns timezone-aware UTC timestamps.
    """
    now = dt.datetime.now(dt.timezone.utc)
    cutoff = now.replace(
        second=0,
        microsecond=0,
        minute=(now.minute // cadence_minutes) * cadence_minutes,
    )
    return cutoff - dt.timedelta(minutes=cadence_minutes), cutoff


async def fetch_windmill_completed_jobs(
    wm_conn: asyncpg.Connection,
    user_to_org: dict[str, tuple[str, str, str]],
) -> tuple[int, int, int]:
    """Emit per-period (5-minute window) gauge values for user-triggered
    Windmill jobs that completed in the last cron-aligned slot.

    SCHEDULED tasks (`trigger_kind IS NOT NULL`, e.g. the windmill
    `rebuild_edited_pmtiles` cron) are intentionally EXCLUDED — they
    dwarf user activity by ~12× in volume and aren't usage data. If we
    ever need a "scheduled jobs" view (operational monitoring), it goes
    under a separate metric family (e.g. `goat_scheduled_jobs_count`).

    Window is cron-aligned (see `_cron_aligned_window`): drift-immune
    against pod start-time variance, no overlap between consecutive
    runs. The metric is a GAUGE — Mimir accumulates the stream of
    per-period samples and the dashboard integrates via
    `sum_over_time(goat_jobs_count[$__range])`.
    """
    window_start, window_end = _cron_aligned_window()
    rows = await wm_conn.fetch(
        """
        SELECT
            (j.args->>'user_id')                          AS user_id,
            j.runnable_path                               AS path,
            -- A workflow run whose steps failed returns their errors
            -- instead of raising (goatlib workflow_runner), so Windmill
            -- records it as a success; its result says it failed.
            CASE
                WHEN c.status::text = 'success'
                 AND j.runnable_path = 'f/goat/tools/workflow_runner'
                 AND c.result->>'status' = 'failed'
                THEN 'failure'
                ELSE c.status::text
            END                                           AS status,
            COUNT(*)::bigint                              AS n,
            COALESCE(SUM(c.duration_ms), 0)::bigint       AS duration_ms_sum,
            COALESCE(SUM(octet_length(c.result::text)), 0)::bigint
                                                          AS output_bytes_sum
        FROM v2_job_completed c
        JOIN v2_job j ON j.id = c.id
        -- Cron-aligned per-period window (see _cron_aligned_window docstring).
        WHERE c.started_at >= $1
          AND c.started_at <  $2
          -- User-triggered only. Scheduled tasks (trigger_kind='schedule',
          -- 'webhook', etc.) are NOT usage data and are emitted under a
          -- separate metric family if we ever need them.
          AND j.trigger_kind IS NULL
        GROUP BY 1, 2, 3
        """,
        window_start,
        window_end,
    )

    jobs: list[Observation] = []
    durations: list[Observation] = []
    output_bytes: list[Observation] = []

    for row in rows:
        tool = _tool_from_path(row["path"])
        user_id = row["user_id"]

        # Resolve user_id → org/email. If a user has been deleted from
        # goat but still has jobs in Windmill's 30-day retention window,
        # fall back to "(unknown)" so the row is still counted.
        org_id, org_name, user_email = user_to_org.get(
            user_id, ("(unknown)", "(unknown)", "(unknown)")
        )

        attrs = {
            "org_id": org_id,
            "org_name": org_name,
            "user_email": user_email,
            "tool": tool,
        }

        # Status is its own label on the count metric (so panels can
        # do "Top failing tools" via status="failure"), but duration
        # and output-bytes are unconditional sums (don't break out by
        # status — failure jobs contributed to time/bytes consumed too).
        jobs.append(
            Observation(int(row["n"]), attributes={**attrs, "status": row["status"]})
        )
        durations.append(
            Observation(int(row["duration_ms_sum"]) / 1000.0, attributes=attrs)
        )
        output_bytes.append(Observation(int(row["output_bytes_sum"]), attributes=attrs))

    _OBSERVATIONS["jobs_count"] = jobs
    _OBSERVATIONS["jobs_duration_seconds"] = durations
    _OBSERVATIONS["jobs_output_bytes"] = output_bytes
    return len(jobs), len(durations), len(output_bytes)


async def fetch_windmill_running_jobs(
    wm_conn: asyncpg.Connection,
    user_to_org: dict[str, tuple[str, str, str]],
) -> int:
    """Populate the running-jobs gauge observations.

    Looks at v2_job_queue (jobs that haven't completed yet) — joined to
    v2_job for args/path labels. Same `trigger_kind IS NULL` filter as
    completed jobs: scheduled tasks aren't usage data. Returns the number
    of distinct (org, tool) buckets observed.
    """
    rows = await wm_conn.fetch(
        """
        SELECT
            (j.args->>'user_id')          AS user_id,
            j.runnable_path               AS path,
            COUNT(*)::bigint              AS n
        FROM v2_job_queue q
        JOIN v2_job j ON j.id = q.id
        WHERE j.trigger_kind IS NULL
        GROUP BY j.args->>'user_id', j.runnable_path
        """
    )

    running: list[Observation] = []
    for row in rows:
        tool = _tool_from_path(row["path"])
        org_id, org_name, user_email = user_to_org.get(
            row["user_id"], ("(unknown)", "(unknown)", "(unknown)")
        )
        running.append(
            Observation(
                int(row["n"]),
                attributes={
                    "org_id": org_id,
                    "org_name": org_name,
                    "user_email": user_email,
                    "tool": tool,
                },
            )
        )
    _OBSERVATIONS["jobs_running"] = running
    return len(running)


# Sync ObservableGauge callbacks — invoked by the OTel SDK at export time.
# They read the pre-populated cache; the real work happened in
# `fetch_windmill_*` above. All four metrics are GAUGES (not counters)
# because their value represents a count over the last 5-minute window,
# not a cumulative all-time total.


def _cb_jobs_count(_options: CallbackOptions) -> list[Observation]:
    return _OBSERVATIONS.get("jobs_count", [])


def _cb_jobs_duration_seconds(_options: CallbackOptions) -> list[Observation]:
    return _OBSERVATIONS.get("jobs_duration_seconds", [])


def _cb_jobs_output_bytes(_options: CallbackOptions) -> list[Observation]:
    return _OBSERVATIONS.get("jobs_output_bytes", [])


def _cb_jobs_running(_options: CallbackOptions) -> list[Observation]:
    return _OBSERVATIONS.get("jobs_running", [])


def _register_windmill_observables(meter: otel_metrics.Meter) -> None:
    """Register 4 ObservableGauges for Windmill-derived metrics. Must be
    called AFTER `_OBSERVATIONS` is populated by `fetch_windmill_*`.

    All four are gauges of a per-period rolling window (5 minutes,
    matching the cron cadence). The dashboard uses `sum_over_time(...)`
    to compute totals over arbitrary ranges — Mimir stores the sample
    stream and that integrates cleanly across CronJob restarts and
    Windmill's 30-day retention boundary (because we're not relying on
    Windmill to remember anything past 30d — we have the history in
    Mimir).
    """
    meter.create_observable_gauge(
        "goat_jobs_count",
        callbacks=[_cb_jobs_count],
        description="Count of user-triggered Windmill jobs that completed in the last 5 minutes, by org × tool × status.",
    )
    meter.create_observable_gauge(
        "goat_jobs_duration_seconds",
        callbacks=[_cb_jobs_duration_seconds],
        unit="s",
        description="SUM of job durations (seconds) for Windmill jobs completed in the last 5 minutes.",
    )
    meter.create_observable_gauge(
        "goat_jobs_output_bytes",
        callbacks=[_cb_jobs_output_bytes],
        unit="By",
        description="SUM of octet_length(result::text) over Windmill jobs completed in the last 5 minutes.",
    )
    meter.create_observable_gauge(
        "goat_jobs_running",
        callbacks=[_cb_jobs_running],
        description="Currently queued / running user-triggered Windmill jobs by org × tool.",
    )


# ----------------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------------


async def _run_query(
    *,
    name: str,
    fn: Callable[[], Awaitable[int]],
    error_counter: Instrument,
) -> bool:
    """Run a query function with isolated error handling.

    Returns ``True`` on success, ``False`` on failure (the failure is logged
    and the error counter is incremented). Caller decides what to do with
    the aggregated success bit.
    """
    try:
        n = await fn()
        logger.info("snapshot query %s ok: %d series", name, n)
        return True
    except Exception:
        logger.exception("snapshot query %s failed", name)
        error_counter.add(1, attributes={"query_name": name})
        return False


async def _apply_session_safety_limits(db: AsyncSession) -> None:
    """Bound the cost a misbehaving query can impose on Postgres.

    - ``statement_timeout`` kills any single query that runs longer than 30s.
      Our aggregations are cheap (count(*) / sum(size) over a few tables) but
      a missing index or a vacuum-blocked table could turn one into a
      sequential scan. 30s is a generous ceiling that still keeps the CronJob
      tight — if it's hitting this, that's an alertable signal, not normal.
    - ``lock_timeout`` ensures we don't wait forever for a lock that some
      other transaction holds (we only run SELECTs, but the planner may take
      AccessShareLocks).
    - ``idle_in_transaction_session_timeout`` is a backstop for the unlikely
      case that the script wedges between queries; the server will drop the
      connection itself rather than us holding a pooler slot indefinitely.

    All three are SET LOCAL — they apply only to this session and revert on
    commit/rollback. Wrapped in their own try/except: a server that refuses
    to honor these (very unlikely) shouldn't fail the whole run.
    """
    try:
        await db.execute(text("SET LOCAL statement_timeout = '30s'"))
        await db.execute(text("SET LOCAL lock_timeout = '5s'"))
        await db.execute(text("SET LOCAL idle_in_transaction_session_timeout = '60s'"))
    except Exception:
        logger.exception("failed to apply session safety limits; continuing")


async def _run_windmill_block(
    meter: otel_metrics.Meter, error_counter: Instrument
) -> bool:
    """Open a Windmill connection, fetch metrics, register observables.

    Wrapped in its own try/except so a Windmill failure (DB unreachable,
    schema mismatch, etc.) doesn't kill the rest of the snapshot — we
    increment the error counter and return False so the caller knows.

    The order matters: we MUST populate `_OBSERVATIONS` before calling
    `_register_windmill_observables`, because the SDK invokes the
    callbacks at the next collection cycle (triggered by force_flush
    after main()). If observables were registered first they'd fire
    with the empty cache and emit nothing.
    """
    wm_conn: asyncpg.Connection | None = None
    user_to_org: dict[str, tuple[str, str, str]] = {}
    try:
        # 1. Cross-DB join setup: fetch the user_uuid → org map from goat.
        async with session_manager.session() as goat_db:
            await _apply_session_safety_limits(goat_db)
            user_to_org = await _fetch_user_org_map(goat_db)
            logger.info(
                "snapshot query %s ok: %d users mapped",
                Q_WM_USER_ORG,
                len(user_to_org),
            )

        # 2. Open Windmill connection.
        wm_conn = await _connect_windmill()

        # 3. Cumulative-counters query (jobs, duration, output bytes).
        n_jobs, _, _ = await fetch_windmill_completed_jobs(wm_conn, user_to_org)
        logger.info("snapshot query %s ok: %d series", Q_WM_JOBS, n_jobs)

        # 4. Running-jobs gauge.
        n_running = await fetch_windmill_running_jobs(wm_conn, user_to_org)
        logger.info("snapshot query %s ok: %d series", Q_WM_RUNNING, n_running)

        # 5. Register the ObservableCounters / Gauge now that the cache
        # is populated. Force-flush in main() then triggers the callbacks.
        _register_windmill_observables(meter)
        return True

    except Exception:
        logger.exception("Windmill metrics block failed")
        error_counter.add(1, attributes={"query_name": Q_WM_JOBS})
        return False
    finally:
        if wm_conn is not None:
            await wm_conn.close()


async def snapshot() -> bool:
    """Run a full snapshot pass. Returns True iff every query succeeded."""
    meter = _build_meter()
    instr = _make_instruments(meter)
    error_counter = instr["query_errors_total"]  # type: ignore[assignment]

    session_manager.init(settings.ASYNC_SQLALCHEMY_DATABASE_URI)
    try:
        async with session_manager.session() as db:
            await _apply_session_safety_limits(db)
            results = [
                await _run_query(
                    name=Q_LAYERS,
                    fn=lambda: snapshot_layers(db, instr["layers_total"]),  # type: ignore[arg-type]
                    error_counter=error_counter,  # type: ignore[arg-type]
                ),
                await _run_query(
                    name=Q_LAYER_BYTES,
                    fn=lambda: snapshot_layer_bytes(
                        db,
                        instr["layer_bytes_total"],  # type: ignore[arg-type]
                    ),
                    error_counter=error_counter,  # type: ignore[arg-type]
                ),
                await _run_query(
                    name=Q_LAYER_SIZE_DIST,
                    fn=lambda: snapshot_layer_size_distribution(
                        db,
                        instr["layer_size_distribution"],  # type: ignore[arg-type]
                    ),
                    error_counter=error_counter,  # type: ignore[arg-type]
                ),
                await _run_query(
                    name=Q_PROJECTS,
                    fn=lambda: snapshot_projects(db, instr["projects_total"]),  # type: ignore[arg-type]
                    error_counter=error_counter,  # type: ignore[arg-type]
                ),
                await _run_query(
                    name=Q_USERS,
                    fn=lambda: snapshot_users(db, instr["users_total"]),  # type: ignore[arg-type]
                    error_counter=error_counter,  # type: ignore[arg-type]
                ),
                await _run_query(
                    name=Q_USER_PROJECTS,
                    fn=lambda: snapshot_user_projects(
                        db,
                        instr["user_projects_total"],  # type: ignore[arg-type]
                    ),
                    error_counter=error_counter,  # type: ignore[arg-type]
                ),
                await _run_query(
                    name=Q_USER_LAYERS,
                    fn=lambda: snapshot_user_layers(
                        db,
                        instr["user_layers_total"],  # type: ignore[arg-type]
                        instr["user_layer_bytes_total"],  # type: ignore[arg-type]
                    ),
                    error_counter=error_counter,  # type: ignore[arg-type]
                ),
            ]

        # Windmill metrics (separate DB, separate connection). Done
        # AFTER the goat queries within the same try/finally so the
        # `session_manager` is still initialized — _run_windmill_block
        # opens its own session to fetch the user→org map. The Windmill
        # work has its own try/except so a Windmill failure (DB
        # unreachable, etc.) doesn't invalidate the goat-side results.
        windmill_ok = await _run_windmill_block(meter, error_counter)
        results.append(windmill_ok)
    finally:
        await session_manager.close()

    all_ok = all(results)
    if all_ok:
        instr["snapshot_success_ts"].set(time.time())  # type: ignore[attr-defined]
        logger.info("snapshot done: all queries ok")
    else:
        logger.error(
            "snapshot done with failures: %d/%d queries failed",
            len(results) - sum(results),
            len(results),
        )

    return all_ok


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    # Bootstrap OTel before doing anything else, so the MeterProvider is in
    # place by the time _build_meter() runs. Service name "core" lands these
    # metrics in the same Mimir bucket as the FastAPI RED metrics, which is
    # what the dashboard's datasource variable expects.
    setup_observability(service_name="core")

    try:
        all_ok = asyncio.run(snapshot())
    except Exception:
        logger.exception("snapshot crashed before completing")
        all_ok = False

    # Force-flush the OTel exporter so the cronjob pod doesn't exit before
    # the periodic reader has pushed this batch. The default reader interval
    # is 30s; without an explicit flush the pod can shut down with a full
    # in-memory buffer.
    provider = otel_metrics.get_meter_provider()
    if isinstance(provider, MeterProvider):
        try:
            provider.force_flush(timeout_millis=10_000)
            provider.shutdown(timeout_millis=10_000)
        except Exception:
            logger.exception("OTel meter provider flush/shutdown failed")

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())

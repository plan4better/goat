"""The one dependency core probes, and the systems it carries.

Object storage is the only dependency here that cannot be monitored any
other way. It is third-party and outside the cluster, so no exporter can
scrape it — and uploads use presigned PUT, meaning the browser talks to
the provider directly. On 25 August 2026 core issued presigned URLs
perfectly happily for 21 hours while every upload failed. There was no 5xx
of ours to alert on and no metric anywhere that moved.

Postgres and Keycloak are deliberately NOT probed here. Both are already
scraped into Mimir — CloudNativePG exports postgres and pgbouncer,
Keycloak exports its Metrics SPI — so probing them from core would be a
second signal for a fact already measured, and two signals for one fact is
worse than one. They get alert rules instead.

The probe runs through core's own `s3_service` client, not a copy of it. A
probe that builds its own client tests a code path nobody else runs, and
can report healthy while the real one is broken.

Nothing here is wired to a readiness probe. If object storage goes down and
every pod marks itself unready, Kubernetes pulls the whole service out of
the load balancer — turning a degraded service into a total outage.
"""

from goatlib.health import check_object_storage
from goatobs.health import Check, Prober

from core.core.config import settings
from core.services.s3 import s3_service

#: Often enough that a ten-minute window holds ~10 samples, so a ratio-based
#: alert can tell a flaky dependency from a dead one.
INTERVAL_SECONDS = 60.0

#: A dependency that has not answered in two seconds is not answering.
TIMEOUT_SECONDS = 2.0

#: Fixed key, so a crash leaves at most one probe object behind.
PROBE_KEY = ".healthz/probe"


def build_prober() -> Prober | None:
    """None when there is no bucket configured — nothing to probe."""
    bucket = settings.S3_BUCKET_NAME
    if not bucket:
        return None

    checks: dict[str, Check] = {
        "object_storage": lambda: check_object_storage(
            s3_service.s3_client, bucket=str(bucket), key=PROBE_KEY
        ),
    }
    #: Which status-page systems stop working for users when this dependency
    #: does. Declared, not derived, so it is a judgement to revisit when the
    #: product changes. Ids must match src/lib/systems.ts in the status repo.
    components: dict[str, list[str]] = {
        "object_storage": ["uploads-exports"],
    }
    return Prober(
        checks=checks,
        components=components,
        interval=INTERVAL_SECONDS,
        timeout=TIMEOUT_SECONDS,
    )

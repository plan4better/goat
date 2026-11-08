"""Periodic reconciliation for custom domains. Runs every 5 min via k8s CronJob.

For each domain not verified yet (``dns_status`` pending, or failed: a record
that pointed elsewhere): re-check DNS resolution.
If the customer's CNAME now points at us, flip ``dns_status=verified`` and
``cert_status=active``. Caddy handles cert lifecycle lazily on the first
inbound request to that hostname, so there's nothing for ``core`` to wait on.

Domains stuck in pending (or failed) for >7 days stay so — admin can still click
"Recheck" to re-run the verification on demand. We don't auto-fail them
since the customer might just be slow setting up DNS.
"""

import asyncio
import logging
import sys

from core.core.config import settings
from core.crud.crud_organization_domain import organization_domain as crud
from core.db.models.organization_domain import CertStatus, DnsStatus
from core.db.session import session_manager
from core.services.domain_reconciliation import refresh_dns

logger = logging.getLogger(__name__)


async def reconcile() -> tuple[int, int]:
    """Run one reconciliation pass. Returns (checked, transitioned).

    With custom domains off (``CUSTOM_DOMAIN_CNAME_TARGET`` empty) there is
    no target to verify against, so the pass checks nothing.
    """
    if not settings.custom_domains_enabled:
        logger.info("custom domains are not enabled; nothing to reconcile")
        return 0, 0
    transitioned = 0
    session_manager.init(settings.ASYNC_SQLALCHEMY_DATABASE_URI)
    try:
        async with session_manager.session() as db:
            domains = await crud.list_pending_dns(async_session=db)
            for d in domains:
                new_dns = await refresh_dns(
                    d, canonical_target=settings.CUSTOM_DOMAIN_CNAME_TARGET
                )
                if (
                    new_dns == DnsStatus.VERIFIED
                    and d.cert_status == CertStatus.PENDING
                ):
                    # Caddy issues lazily; nothing to wait for. Flip directly to active.
                    d.cert_status = CertStatus.ACTIVE
                    d.cert_status_message = None
                    transitioned += 1
                    logger.info(
                        "reconciled %s: dns_status=verified, cert_status=active",
                        d.base_domain,
                    )
                else:
                    logger.debug(
                        "reconciled %s: %s (%s)",
                        d.base_domain,
                        d.dns_status.value,
                        d.dns_status_message or "no message",
                    )
            await db.commit()
            return len(domains), transitioned
    finally:
        await session_manager.close()


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
    )
    try:
        checked, transitioned = asyncio.run(reconcile())
        logger.info("done: checked=%d transitioned=%d", checked, transitioned)
        return 0
    except Exception:
        logger.exception("reconciliation failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())

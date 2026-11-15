import contextlib
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from core.core.config import settings
from core.db.models.organization_domain import (
    DnsStatus,
    OrganizationDomain,
)
from core.scripts import reconcile_domains
from core.services.domain_reconciliation import (
    check_dns,
    provision_domain,
    release_domain,
)
from core.services.provisioner import FakeProvisioner
from tests.utils import fake_dns_resolve

CANON = "cname.goat.plan4better.de"


@pytest.mark.asyncio
async def test_check_dns_match(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "core.services.domain_reconciliation._resolve",
        fake_dns_resolve(cname=["cname.goat.plan4better.de."]),
    )

    status, msg = await check_dns("klima.example.com", canonical_target=CANON)
    assert status == DnsStatus.VERIFIED
    assert msg is None


@pytest.mark.asyncio
async def test_check_dns_match_without_trailing_dot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Targets returned without a trailing dot should still match canonical."""

    monkeypatch.setattr(
        "core.services.domain_reconciliation._resolve",
        fake_dns_resolve(cname=["cname.goat.plan4better.de"]),
    )

    status, _ = await check_dns("klima.example.com", canonical_target=CANON)
    assert status == DnsStatus.VERIFIED


@pytest.mark.asyncio
async def test_check_dns_no_record(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "core.services.domain_reconciliation._resolve",
        fake_dns_resolve(),
    )

    status, msg = await check_dns("klima.example.com", canonical_target=CANON)
    assert status == DnsStatus.PENDING
    assert msg is not None
    assert "no cname" in msg.lower()


@pytest.mark.asyncio
async def test_check_dns_wrong_target(monkeypatch: pytest.MonkeyPatch) -> None:
    """A record that points elsewhere is wrong, not missing: failed, so the
    list can say the entry is not right yet."""
    monkeypatch.setattr(
        "core.services.domain_reconciliation._resolve",
        fake_dns_resolve(cname=["other.example.com."]),
    )

    status, msg = await check_dns("klima.example.com", canonical_target=CANON)
    assert status == DnsStatus.FAILED
    assert msg is not None
    assert "other.example.com" in msg
    assert CANON in msg


@pytest.mark.asyncio
async def test_check_dns_wrong_a_record(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "core.services.domain_reconciliation._resolve",
        fake_dns_resolve(base_a=["198.51.100.7"]),
    )

    status, msg = await check_dns("example.com", canonical_target=CANON)
    assert status == DnsStatus.FAILED
    assert msg == "A points to 198.51.100.7 (expected 203.0.113.10)"


@pytest.mark.asyncio
async def test_check_dns_a_record_through_another_cname_matches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A CNAME to another name that ends at GOAT's address is right."""
    monkeypatch.setattr(
        "core.services.domain_reconciliation._resolve",
        fake_dns_resolve(cname=["edge.example.net."], base_a=["203.0.113.10"]),
    )

    status, msg = await check_dns("klima.example.com", canonical_target=CANON)
    assert (status, msg) == (DnsStatus.VERIFIED, None)


@pytest.mark.asyncio
async def test_check_dns_unresolvable_target_stays_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When GOAT's own target does not resolve, the customer's record cannot
    be judged: pending, even with a record that points elsewhere."""
    monkeypatch.setattr(
        "core.services.domain_reconciliation._resolve",
        fake_dns_resolve(cname=["other.example.com."], canonical_a=()),
    )

    status, msg = await check_dns("klima.example.com", canonical_target=CANON)
    assert status == DnsStatus.PENDING
    assert msg == f"Could not resolve canonical target {CANON}"


@pytest.mark.asyncio
async def test_check_dns_resolver_error_returns_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A transient DNS error should leave the domain pending with the error message,
    not flip it to FAILED. (Failed means a record was found that points
    elsewhere.)"""

    async def boom(domain: str, rdtype: str) -> list[str]:
        raise RuntimeError("DNS error: timeout")

    monkeypatch.setattr(
        "core.services.domain_reconciliation._resolve",
        boom,
    )

    status, msg = await check_dns("klima.example.com", canonical_target=CANON)
    assert status == DnsStatus.PENDING
    assert msg is not None
    assert "DNS error" in msg or "timeout" in msg.lower()


def _make_domain(
    base_domain: str = "klima.example.com",
) -> OrganizationDomain:
    """Build an OrganizationDomain in memory (no DB) for helper tests."""
    return OrganizationDomain(
        organization_id=uuid4(),
        base_domain=base_domain,
    )


@pytest.mark.asyncio
async def test_provision_records_domain() -> None:
    fake = FakeProvisioner()
    domain = _make_domain()

    result = await provision_domain(domain, provisioner=fake)
    assert result is None
    assert "klima.example.com" in fake.created


@pytest.mark.asyncio
async def test_provision_is_idempotent() -> None:
    fake = FakeProvisioner()
    domain = _make_domain()

    await provision_domain(domain, provisioner=fake)
    await provision_domain(domain, provisioner=fake)
    assert fake.created == ["klima.example.com"]


@pytest.mark.asyncio
async def test_release_calls_provisioner_release() -> None:
    fake = FakeProvisioner()
    await fake.provision(base_domain="klima.example.com")
    assert fake.created == ["klima.example.com"]
    domain = _make_domain()

    await release_domain(domain, provisioner=fake)
    assert fake.created == []


@pytest.mark.asyncio
async def test_release_is_idempotent() -> None:
    fake = FakeProvisioner()
    domain = _make_domain()
    # Releasing before provisioning is OK.
    await release_domain(domain, provisioner=fake)
    assert fake.created == []


class _FakeSessions:
    """Stands in for `session_manager` in `reconcile()`: one session that
    only counts its commits."""

    def __init__(self) -> None:
        self.commits = 0

    def init(self, host: str | None) -> None:
        pass

    async def close(self) -> None:
        pass

    @contextlib.asynccontextmanager
    async def session(self) -> AsyncIterator["_FakeSessions"]:
        yield self

    async def commit(self) -> None:
        self.commits += 1


@pytest.mark.asyncio
async def test_reconcile_records_when_it_checked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The periodic job records each check like the endpoints do."""
    domains = [_make_domain("a.example.com"), _make_domain("b.example.com")]
    sessions = _FakeSessions()

    async def pending(async_session: object) -> list[OrganizationDomain]:
        return domains

    monkeypatch.setattr(settings, "CUSTOM_DOMAIN_CNAME_TARGET", CANON)
    monkeypatch.setattr(reconcile_domains, "session_manager", sessions)
    monkeypatch.setattr(reconcile_domains.crud, "list_pending_dns", pending)
    monkeypatch.setattr(
        "core.services.domain_reconciliation._resolve",
        fake_dns_resolve(),
    )

    before = datetime.now(timezone.utc)
    assert await reconcile_domains.reconcile() == (2, 0)
    assert sessions.commits == 1
    for domain in domains:
        assert domain.dns_status == DnsStatus.PENDING
        assert domain.dns_last_checked_at is not None
        assert before <= domain.dns_last_checked_at <= datetime.now(timezone.utc)

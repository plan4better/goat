"""Organization-supplied endpoints (spec §4.1): HTTPS, no private addresses,
checked when saved, on every request and on every redirect hop."""

import asyncio
import datetime
import inspect
import ipaddress
from collections.abc import Awaitable, Callable, Iterable
from pathlib import Path

import httpcore2
import httpx2
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from assistant.llm import endpoints
from assistant.llm.endpoints import (
    BlockedEndpoint,
    EndpointNotAllowed,
    EndpointPolicy,
    GuardedBackend,
    GuardedTransport,
    IPAddress,
    check_resolves,
    guarded_client,
    validate_base_url,
)

STRICT = EndpointPolicy(allow_private=False)
OPEN = EndpointPolicy(allow_private=True)
OK = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
TIMEOUT = httpx2.Timeout(5.0)


def table_resolver(
    table: dict[str, list[str]],
) -> Callable[[str, int], Awaitable[list[IPAddress]]]:
    async def resolve(host: str, port: int) -> list[IPAddress]:
        if host not in table:
            raise OSError(f"unknown host {host}")
        return [ipaddress.ip_address(address) for address in table[host]]

    return resolve


def counting_resolver(
    table: dict[str, list[str]], calls: list[str]
) -> Callable[[str, int], Awaitable[list[IPAddress]]]:
    inner = table_resolver(table)

    async def resolve(host: str, port: int) -> list[IPAddress]:
        calls.append(host)
        return await inner(host, port)

    return resolve


class RecordingBackend(httpcore2.AsyncMockBackend):
    """A mock network that records which address each connection went to.
    ``followups`` are the responses of the second, third ... connection."""

    def __init__(self, buffer: list[bytes], *followups: list[bytes]) -> None:
        super().__init__(buffer)
        self.connected: list[str] = []
        self._followups = list(followups)

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[httpcore2.SOCKET_OPTION] | None = None,
    ) -> httpcore2.AsyncNetworkStream:
        self.connected.append(host)
        if self.connected[1:] and self._followups:
            return httpcore2.AsyncMockStream(self._followups.pop(0))
        return await super().connect_tcp(
            host,
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )


@pytest.mark.parametrize(
    "url",
    [
        "https://llm.example.org/v1/",
        "https://LLM.example.org:8443/v1",
        "https://93.184.215.14/v1",
    ],
)
def test_public_https_urls_are_accepted(url: str) -> None:
    assert validate_base_url(url, STRICT).startswith("https://")


def test_urls_are_normalized() -> None:
    assert (
        validate_base_url(" https://LLM.Example.org/v1/ ", STRICT)
        == "https://llm.example.org/v1"
    )
    assert (
        validate_base_url("https://llm.example.org:8443/v1", STRICT)
        == "https://llm.example.org:8443/v1"
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://llm.example.org/v1",
        "ftp://llm.example.org/v1",
        "https://user:secret@llm.example.org/v1",
        "https://llm.example.org/v1?key=1",
        "https://llm.example.org/v1#part",
        "https:///v1",
        "https://localhost/v1",
        "https://ollama/v1",
        "https://llm.internal/v1",
        "https://printer.local/v1",
        "https://10.0.0.5/v1",
        "https://127.0.0.1/v1",
        "https://169.254.169.254/latest",
        "https://100.64.0.1/v1",
        "https://[::1]/v1",
        "https://[::ffff:10.0.0.1]/v1",
        "https://[fd00::1]/v1",
        "https://[64:ff9b::a00:5]/v1",
        "https://127.0.0.1./v1",
        "https://[fec0::1]/v1",
        "https://[ff02::1]/v1",
        "https://224.0.0.1/v1",
        "https://[::ffff:0:a00:5]/v1",
        "https://168.63.129.16/v1",
        "https://100.100.100.200/v1",
        "https://[::1/v1",
        "https://[2002:808:808::1]/v1",
    ],
)
def test_private_internal_or_insecure_urls_are_refused(url: str) -> None:
    with pytest.raises(EndpointNotAllowed):
        validate_base_url(url, STRICT)


def test_trailing_dots_and_zone_ids_are_normalized_away() -> None:
    assert (
        validate_base_url("https://llm.example.org./v1", STRICT)
        == "https://llm.example.org/v1"
    )
    assert (
        validate_base_url("https://93.184.215.14./v1", STRICT)
        == "https://93.184.215.14/v1"
    )
    assert (
        validate_base_url("https://[fd00::1%251]:8443/v1", OPEN)
        == "https://[fd00::1]:8443/v1"
    )
    with pytest.raises(EndpointNotAllowed):
        validate_base_url("https://./v1", STRICT)


def test_the_operator_can_allow_private_endpoints() -> None:
    assert validate_base_url("http://ollama:11434/v1", OPEN) == "http://ollama:11434/v1"
    assert validate_base_url("https://10.0.0.5/v1", OPEN) == "https://10.0.0.5/v1"


@pytest.mark.parametrize(
    "url",
    [
        "https://169.254.169.254/latest",
        "https://169.254.1.1/v1",
        "https://[fe80::1]/v1",
        "https://[::ffff:169.254.169.254]/v1",
        "https://168.63.129.16/v1",
        "https://100.100.100.200/v1",
        "https://[fd00:ec2::254]/v1",
        "https://[fd00:ec2::254%251]/v1",
        "https://[fd00:ec2::254%1]/v1",
        "https://[2002:a9fe:a9fe::1]/v1",
    ],
)
def test_link_local_and_metadata_addresses_are_refused_even_when_private_is_allowed(
    url: str,
) -> None:
    with pytest.raises(EndpointNotAllowed):
        validate_base_url(url, OPEN)


async def test_check_resolves_refuses_any_private_address() -> None:
    resolver = table_resolver(
        {
            "llm.example.org": ["93.184.215.14"],
            "mixed.example.org": ["93.184.215.14", "10.0.0.5"],
            "inside.example.org": ["192.168.1.10"],
        }
    )
    await check_resolves("https://llm.example.org/v1", STRICT, resolver)
    for host in ("mixed.example.org", "inside.example.org", "nowhere.example.org"):
        with pytest.raises(EndpointNotAllowed):
            await check_resolves(f"https://{host}/v1", STRICT, resolver)
    await check_resolves("https://inside.example.org/v1", OPEN, resolver)


async def test_guarded_transport_connects_to_the_checked_address() -> None:
    backend = RecordingBackend([OK])
    transport = GuardedTransport(
        STRICT,
        resolver=table_resolver({"llm.example.org": ["93.184.215.14"]}),
        inner_backend=backend,
    )
    async with httpx2.AsyncClient(transport=transport) as client:
        response = await client.get("https://llm.example.org/v1/models")
    assert response.text == "ok"
    # The address that was checked, not the host name: a second DNS answer
    # (rebinding) never gets a say.
    assert backend.connected == ["93.184.215.14"]


async def test_host_that_now_resolves_privately_is_blocked() -> None:
    """Review Focus 2: saved while public, resolving to a private address now."""
    backend = RecordingBackend([OK])
    transport = GuardedTransport(
        STRICT,
        resolver=table_resolver({"llm.example.org": ["10.0.0.5"]}),
        inner_backend=backend,
    )
    async with httpx2.AsyncClient(transport=transport) as client:
        with pytest.raises(httpx2.ConnectError) as caught:
            await client.get("https://llm.example.org/v1/models")
    assert isinstance(caught.value.__cause__, BlockedEndpoint)
    assert "10.0.0.5" in str(caught.value.__cause__)
    assert backend.connected == []


async def test_redirect_to_a_private_host_is_blocked() -> None:
    """Review Focus 2: a 302 from the public endpoint to an internal one."""
    backend = RecordingBackend(
        [
            b"HTTP/1.1 302 Found\r\nLocation: https://inside.example.org/v1\r\nContent-Length: 0\r\n\r\n"
        ]
    )
    resolver = table_resolver(
        {"llm.example.org": ["93.184.215.14"], "inside.example.org": ["10.0.0.5"]}
    )
    transport = GuardedTransport(STRICT, resolver=resolver, inner_backend=backend)
    async with guarded_client(STRICT, timeout=TIMEOUT, transport=transport) as client:
        with pytest.raises(httpx2.ConnectError):
            await client.get("https://llm.example.org/v1/models")
    assert backend.connected == ["93.184.215.14"]


async def test_redirect_to_plain_http_is_blocked() -> None:
    backend = RecordingBackend(
        [
            b"HTTP/1.1 302 Found\r\nLocation: http://llm.example.org/v1\r\nContent-Length: 0\r\n\r\n"
        ]
    )
    resolver = table_resolver({"llm.example.org": ["93.184.215.14"]})
    transport = GuardedTransport(STRICT, resolver=resolver, inner_backend=backend)
    async with guarded_client(STRICT, timeout=TIMEOUT, transport=transport) as client:
        with pytest.raises(httpx2.ConnectError) as caught:
            await client.get("https://llm.example.org/v1/models")
    assert isinstance(caught.value.__cause__, BlockedEndpoint)
    assert backend.connected == ["93.184.215.14"]


async def test_internal_host_names_are_blocked_before_resolution() -> None:
    # The resolver would answer with a public address: only the name check can
    # refuse this host, and it must do so before asking DNS.
    calls: list[str] = []
    backend = RecordingBackend([OK])
    transport = GuardedTransport(
        STRICT,
        resolver=counting_resolver(
            {"metadata.google.internal": ["93.184.215.14"]}, calls
        ),
        inner_backend=backend,
    )
    async with httpx2.AsyncClient(transport=transport) as client:
        with pytest.raises(httpx2.ConnectError) as caught:
            await client.get("https://metadata.google.internal/computeMetadata/v1/")
    assert isinstance(caught.value.__cause__, BlockedEndpoint)
    assert "metadata.google.internal" in str(caught.value.__cause__)
    assert calls == []
    assert backend.connected == []


async def test_guarded_client_ignores_proxy_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Review Focus 5: a proxy from the environment would make the guard check
    the proxy's address instead of the endpoint's."""
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example.org:3128")
    monkeypatch.setenv("ALL_PROXY", "http://proxy.example.org:3128")
    backend = RecordingBackend([OK])
    transport = GuardedTransport(
        STRICT,
        resolver=table_resolver({"llm.example.org": ["93.184.215.14"]}),
        inner_backend=backend,
    )
    async with guarded_client(STRICT, timeout=TIMEOUT, transport=transport) as client:
        assert client.trust_env is False
        assert (await client.get("https://llm.example.org/v1")).text == "ok"
    assert backend.connected == ["93.184.215.14"]


async def test_private_endpoints_connect_when_allowed() -> None:
    backend = RecordingBackend([OK])
    transport = GuardedTransport(
        OPEN, resolver=table_resolver({"ollama": ["10.0.0.7"]}), inner_backend=backend
    )
    async with httpx2.AsyncClient(transport=transport) as client:
        assert (await client.get("http://ollama:11434/v1/models")).text == "ok"
    assert backend.connected == ["10.0.0.7"]


REDIRECT = (
    b"HTTP/1.1 302 Found\r\nLocation: %s\r\nConnection: close\r\n"
    b"Content-Length: 0\r\n\r\n"
)
PUBLIC = {
    "llm.example.org": ["93.184.215.14"],
    "other.example.org": ["93.184.215.15"],
}


async def test_relative_redirect_is_followed() -> None:
    backend = RecordingBackend([REDIRECT % b"/v2/models"], [OK])
    transport = GuardedTransport(
        STRICT, resolver=table_resolver(PUBLIC), inner_backend=backend
    )
    async with guarded_client(STRICT, timeout=TIMEOUT, transport=transport) as client:
        response = await client.get("https://llm.example.org/v1/models")
    assert response.text == "ok"
    assert str(response.url) == "https://llm.example.org/v2/models"
    assert backend.connected == ["93.184.215.14", "93.184.215.14"]


async def test_redirect_to_another_public_origin_is_not_followed() -> None:
    """The key travels in a header; a second host must never receive it."""
    backend = RecordingBackend([REDIRECT % b"https://other.example.org/v1"], [OK])
    transport = GuardedTransport(
        STRICT, resolver=table_resolver(PUBLIC), inner_backend=backend
    )
    async with guarded_client(STRICT, timeout=TIMEOUT, transport=transport) as client:
        with pytest.raises(httpx2.ConnectError) as caught:
            await client.get(
                "https://llm.example.org/v1/models", headers={"x-api-key": "secret"}
            )
    assert isinstance(caught.value.__cause__, BlockedEndpoint)
    assert "redirected" in str(caught.value.__cause__)
    assert backend.connected == ["93.184.215.14"]


@pytest.mark.parametrize(
    "location",
    [b"https://llm.example.org:8443/v1", b"//other.example.org/v1", b"https://[::1/"],
)
async def test_redirect_to_another_port_or_host_or_garbage_is_not_followed(
    location: bytes,
) -> None:
    backend = RecordingBackend([REDIRECT % location], [OK])
    transport = GuardedTransport(
        STRICT, resolver=table_resolver(PUBLIC), inner_backend=backend
    )
    async with guarded_client(STRICT, timeout=TIMEOUT, transport=transport) as client:
        with pytest.raises(httpx2.ConnectError) as caught:
            await client.get("https://llm.example.org/v1/models")
    assert isinstance(caught.value.__cause__, BlockedEndpoint)
    assert backend.connected == ["93.184.215.14"]


async def test_redirect_to_a_private_ip_literal_is_blocked() -> None:
    backend = RecordingBackend([REDIRECT % b"https://10.0.0.5/v1"], [OK])
    transport = GuardedTransport(
        STRICT, resolver=table_resolver(PUBLIC), inner_backend=backend
    )
    async with guarded_client(STRICT, timeout=TIMEOUT, transport=transport) as client:
        with pytest.raises(httpx2.ConnectError) as caught:
            await client.get("https://llm.example.org/v1/models")
    assert isinstance(caught.value.__cause__, BlockedEndpoint)
    assert backend.connected == ["93.184.215.14"]


async def test_same_origin_redirect_is_checked_again_on_the_second_hop() -> None:
    """The host resolves publicly for the first hop and privately for the
    second (rebinding between hops): the second connection is refused."""
    answers = iter([["93.184.215.14"], ["10.0.0.5"]])

    async def rebinding(host: str, port: int) -> list[IPAddress]:
        return [ipaddress.ip_address(address) for address in next(answers)]

    backend = RecordingBackend([REDIRECT % b"/v2/models"], [OK])
    transport = GuardedTransport(STRICT, resolver=rebinding, inner_backend=backend)
    async with guarded_client(STRICT, timeout=TIMEOUT, transport=transport) as client:
        with pytest.raises(httpx2.ConnectError) as caught:
            await client.get("https://llm.example.org/v1/models")
    assert isinstance(caught.value.__cause__, BlockedEndpoint)
    assert backend.connected == ["93.184.215.14"]


async def test_ipv6_literal_connects_to_that_address() -> None:
    backend = RecordingBackend([OK])
    transport = GuardedTransport(
        STRICT, resolver=table_resolver({}), inner_backend=backend
    )
    async with httpx2.AsyncClient(transport=transport) as client:
        assert (await client.get("https://[2606:4700::1111]/v1/models")).text == "ok"
        with pytest.raises(httpx2.ConnectError) as caught:
            await client.get("https://[::1]/v1/models")
    assert isinstance(caught.value.__cause__, BlockedEndpoint)
    assert backend.connected == ["2606:4700::1111"]


@pytest.mark.parametrize(
    ("host", "answer"),
    [
        ("169.254.169.254", None),
        ("[fe80::1]", None),
        ("metadata.example.org", "168.63.129.16"),
        ("alibaba.example.org", "100.100.100.200"),
    ],
)
async def test_metadata_addresses_are_blocked_even_when_private_is_allowed(
    host: str, answer: str | None
) -> None:
    backend = RecordingBackend([OK])
    table = {host: [answer]} if answer else {}
    transport = GuardedTransport(
        OPEN, resolver=table_resolver(table), inner_backend=backend
    )
    async with httpx2.AsyncClient(transport=transport) as client:
        with pytest.raises(httpx2.ConnectError) as caught:
            await client.get(f"https://{host}/latest")
    assert isinstance(caught.value.__cause__, BlockedEndpoint)
    assert backend.connected == []


async def test_check_resolves_judges_address_literals_on_its_own() -> None:
    async def never(host: str, port: int) -> list[IPAddress]:
        raise AssertionError("a literal address needs no lookup")

    for url in (
        "https://10.0.0.5/v1",
        "https://127.0.0.1./v1",
        "https://[::1]/v1",
        "https://[fec0::1]/v1",
    ):
        with pytest.raises(EndpointNotAllowed):
            await check_resolves(url, STRICT, never)
    with pytest.raises(EndpointNotAllowed):
        await check_resolves("https://169.254.169.254/v1", OPEN, never)
    with pytest.raises(EndpointNotAllowed):
        await check_resolves("https://localhost/v1", STRICT, never)
    await check_resolves("https://93.184.215.14/v1", STRICT, never)
    await check_resolves("https://10.0.0.5/v1", OPEN, never)


async def test_a_name_the_system_cannot_encode_is_a_refusal() -> None:
    long_label = "a" * 64 + ".example.org"

    async def cannot_encode(host: str, port: int) -> list[IPAddress]:
        raise UnicodeError("label too long")

    with pytest.raises(EndpointNotAllowed):
        await check_resolves(f"https://{long_label}/v1", STRICT, cannot_encode)
    # The real resolver rejects the label before any lookup happens.
    with pytest.raises(EndpointNotAllowed):
        await check_resolves(f"https://{long_label}/v1", STRICT)
    backend = GuardedBackend(STRICT, resolver=cannot_encode)
    with pytest.raises(BlockedEndpoint):
        await backend.connect_tcp(long_label, 443)


async def test_dns_lookup_is_bounded_by_the_connect_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def hangs(host: str, port: int) -> list[IPAddress]:
        await asyncio.sleep(30)
        return []

    backend = GuardedBackend(STRICT, resolver=hangs)
    with pytest.raises(httpcore2.ConnectTimeout):
        await backend.connect_tcp("llm.example.org", 443, timeout=0.05)
    monkeypatch.setattr(endpoints, "_RESOLVE_TIMEOUT", 0.05)
    with pytest.raises(EndpointNotAllowed):
        await check_resolves("https://llm.example.org/v1", STRICT, hangs)


class FailingBackend(RecordingBackend):
    """Refuses connections to the addresses in ``failures``."""

    def __init__(self, failures: dict[str, Exception]) -> None:
        super().__init__([OK])
        self._failures = failures

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[httpcore2.SOCKET_OPTION] | None = None,
    ) -> httpcore2.AsyncNetworkStream:
        if host in self._failures:
            self.connected.append(host)
            raise self._failures[host]
        return await super().connect_tcp(
            host,
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )


@pytest.mark.parametrize(
    "failure", [httpcore2.ConnectError("refused"), httpcore2.ConnectTimeout("slow")]
)
async def test_the_next_address_is_tried_when_one_fails(failure: Exception) -> None:
    inner = FailingBackend({"93.184.215.14": failure})
    backend = GuardedBackend(
        STRICT,
        resolver=table_resolver(
            {"llm.example.org": ["93.184.215.14", "93.184.215.15"]}
        ),
        inner=inner,
    )
    await backend.connect_tcp("llm.example.org", 443)
    assert inner.connected == ["93.184.215.14", "93.184.215.15"]


async def test_every_address_failing_raises_the_last_error() -> None:
    inner = FailingBackend(
        {
            "93.184.215.14": httpcore2.ConnectError("refused"),
            "93.184.215.15": httpcore2.ConnectTimeout("slow"),
        }
    )
    backend = GuardedBackend(
        STRICT,
        resolver=table_resolver(
            {"llm.example.org": ["93.184.215.14", "93.184.215.15"]}
        ),
        inner=inner,
    )
    with pytest.raises(httpcore2.ConnectTimeout):
        await backend.connect_tcp("llm.example.org", 443)


def test_the_pool_behaves_like_the_one_it_replaces() -> None:
    pool = GuardedTransport(STRICT)._pool
    # The defaults of httpx2's own transport, not `httpx2.Limits()`, which is
    # unlimited.
    default = inspect.signature(httpx2.AsyncHTTPTransport.__init__).parameters["limits"]
    limits = default.default
    assert limits.max_connections is not None
    assert limits.max_keepalive_connections is not None
    assert isinstance(pool, httpcore2.AsyncConnectionPool)
    assert pool._max_connections == limits.max_connections
    assert pool._max_keepalive_connections == limits.max_keepalive_connections
    assert pool._keepalive_expiry == limits.keepalive_expiry
    assert (pool._http1, pool._http2) == (True, False)
    assert isinstance(pool._network_backend, GuardedBackend)


def test_ca_bundles_from_the_environment_are_trusted(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A corporate CA given through SSL_CERT_FILE keeps working."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Corporate Test CA")])
    now = datetime.datetime.now(datetime.timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    bundle = tmp_path / "ca.pem"
    bundle.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    monkeypatch.setenv("SSL_CERT_FILE", str(bundle))
    context = GuardedTransport(STRICT)._pool._ssl_context
    assert any(
        "Corporate Test CA" in str(entry["subject"]) for entry in context.get_ca_certs()
    )


@pytest.mark.parametrize("zone", ["%1", "%eth0"])
async def test_a_zone_id_does_not_bypass_the_deny_list(zone: str) -> None:
    assert not OPEN.address_allowed(ipaddress.ip_address(f"fd00:ec2::254{zone}"))
    assert not OPEN.address_allowed(ipaddress.ip_address("2002:a9fe:a9fe::1"))

    backend = RecordingBackend([OK])
    guarded = GuardedBackend(OPEN, resolver=table_resolver({}), inner=backend)
    with pytest.raises(BlockedEndpoint):
        await guarded.connect_tcp(f"fd00:ec2::254{zone}", 443)
    # A name that resolves to a scoped address is refused as well.
    scoped = GuardedBackend(
        OPEN,
        resolver=table_resolver({"metadata.example.org": [f"fd00:ec2::254{zone}"]}),
        inner=backend,
    )
    with pytest.raises(BlockedEndpoint):
        await scoped.connect_tcp("metadata.example.org", 443)
    assert backend.connected == []
    with pytest.raises(EndpointNotAllowed):
        await check_resolves(f"https://[fd00:ec2::254{zone}]/v1", OPEN)


async def test_a_scoped_literal_in_a_request_is_blocked_under_open() -> None:
    backend = RecordingBackend([OK])
    transport = GuardedTransport(
        OPEN, resolver=table_resolver({}), inner_backend=backend
    )
    async with httpx2.AsyncClient(transport=transport) as client:
        with pytest.raises((httpx2.ConnectError, httpx2.InvalidURL)):
            await client.get("https://[fd00:ec2::254%251]/v1")
    assert backend.connected == []


async def test_an_allowed_scoped_literal_connects_without_its_zone() -> None:
    backend = RecordingBackend([OK])
    guarded = GuardedBackend(OPEN, resolver=table_resolver({}), inner=backend)
    await guarded.connect_tcp("fd00::1%1", 443)
    assert backend.connected == ["fd00::1"]

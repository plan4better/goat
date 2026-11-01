"""Organization-supplied endpoints (spec §4.1).

HTTPS only; private, loopback, link-local and internal addresses and host
names are refused unless the operator allows them. Two layers:

- ``validate_base_url`` and ``check_resolves`` refuse a URL when an admin
  saves it, so the admin page can say why.
- ``GuardedTransport`` re-checks every request the model SDKs send, which
  includes each redirect hop. Its network backend resolves the host itself,
  refuses the connection if any resolved address is not allowed, and then
  connects to the address it checked. Checking and connecting to the same
  address closes the gap a second, different DNS answer (rebinding) would
  otherwise open.
- ``guarded_client`` follows only same-origin redirects, so a key sent in a
  header such as ``x-api-key`` never reaches a host the admin did not enter.
"""

import asyncio
import inspect
import ipaddress
import socket
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

import anyio
import httpcore2
import httpx2

from assistant.config import AssistantSettings
from assistant.tls import ssl_context

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
Resolver = Callable[[str, int], Awaitable[list[IPAddress]]]

_INTERNAL_NAMES = frozenset({"localhost"})
#: NAT64 (RFC 6052) and the deprecated IPv4-compatible form embed an IPv4
#: address in the last 32 bits; `ipv4_mapped` covers only ::ffff:0:0/96.
_NAT64 = ipaddress.IPv6Network("64:ff9b::/96")
_IPV4_COMPATIBLE = ipaddress.IPv6Network("::/96")
#: SIIT "IPv4-translated" addresses (RFC 6145) carry an IPv4 address too.
_SIIT_TRANSLATED = ipaddress.IPv6Network("::ffff:0:0:0/96")
#: Cloud metadata and platform services that sit on addresses which look like
#: ordinary public (or private) ones. They are refused even when private
#: endpoints are allowed: tenants on a self-hosted instance must not reach the
#: cloud metadata service of the machine it runs on.
_ALWAYS_DENIED = frozenset(
    ipaddress.ip_address(address)
    for address in (
        "169.254.169.254",  # AWS, GCP, Azure and OpenStack metadata
        "fd00:ec2::254",  # AWS metadata over IPv6
        "168.63.129.16",  # Azure WireServer
        "100.100.100.200",  # Alibaba Cloud metadata
    )
)
#: The limits httpx2's own transport applies. `httpx2.Limits()` would mean
#: unlimited connections, so the default is read from the transport signature.
_HTTPX_LIMITS: httpx2.Limits = (
    inspect.signature(httpx2.AsyncHTTPTransport.__init__).parameters["limits"].default
)
#: Upper bound for resolving a host name when saving a connection.
_RESOLVE_TIMEOUT = 10.0
_INTERNAL_SUFFIXES = (
    ".localhost",
    ".local",
    ".internal",
    ".lan",
    ".home.arpa",
    ".intranet",
    ".corp",
)


class EndpointNotAllowed(ValueError):  # noqa: N818
    """A URL an organization connection may not use; the message is for admins."""


class BlockedEndpoint(httpcore2.ConnectError):  # noqa: N818
    """Raised while connecting. As an httpcore ConnectError it travels like any
    refused connection: httpx2 raises ``httpx2.ConnectError`` from it, the SDKs
    wrap that, and ``classify_failure`` finds it in the cause chain."""


def _unscoped(address: IPAddress) -> IPAddress:
    """The address without an IPv6 zone id. `fd00::1%1` neither equals nor
    hashes like `fd00::1`, while the system ignores the zone for any address
    that is not link-local."""
    if isinstance(address, ipaddress.IPv6Address) and address.scope_id:
        return ipaddress.IPv6Address(int(address))
    return address


def _embedded_ipv4(address: IPAddress) -> IPAddress:
    """The IPv4 address an IPv6 form carries, or the address itself."""
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return address.ipv4_mapped
        if (
            address in _NAT64
            or address in _SIIT_TRANSLATED
            or address in _IPV4_COMPATIBLE
        ):
            return ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
    return address


@dataclass(frozen=True)
class EndpointPolicy:
    allow_private: bool = False
    #: ``GOAT_CA_BUNDLE``: CA certificates the model clients trust in addition
    #: to the system CAs (``assistant.tls``). It changes trust only, never
    #: which addresses may be reached.
    ca_bundle: str | None = None

    @classmethod
    def from_settings(cls, settings: AssistantSettings) -> "EndpointPolicy":
        return cls(
            allow_private=settings.allow_private_endpoints,
            ca_bundle=settings.goat_ca_bundle,
        )

    def address_allowed(self, address: IPAddress) -> bool:
        address = _unscoped(address)
        # IPv6 forms that carry an IPv4 address are judged by the IPv4 address.
        inner = _embedded_ipv4(address)
        # 6to4 (2002::/16) embeds an IPv4 address too, but is not unwrapped:
        # it is refused outright unless the operator allows private endpoints,
        # and then its embedded address still has to pass the checks below.
        six_to_four = (
            address.sixtofour if isinstance(address, ipaddress.IPv6Address) else None
        )
        # Refused whatever the operator allows: link-local and the metadata
        # services (see `_ALWAYS_DENIED`).
        for candidate in (address, inner, six_to_four):
            if candidate is None:
                continue
            if candidate in _ALWAYS_DENIED or candidate.is_link_local:
                return False
        if self.allow_private:
            return True
        if six_to_four is not None:
            return False
        if inner.is_multicast:
            return False
        if isinstance(inner, ipaddress.IPv6Address) and inner.is_site_local:
            return False
        # `is_global` is false for private, loopback, carrier-grade NAT,
        # unique-local, documentation and reserved ranges alike.
        return inner.is_global

    def scheme_allowed(self, scheme: str) -> bool:
        return scheme == "https" or (self.allow_private and scheme == "http")

    def host_name_allowed(self, host: str) -> bool:
        if self.allow_private:
            return True
        name = host.lower().rstrip(".")
        if name in _INTERNAL_NAMES or name.endswith(_INTERNAL_SUFFIXES):
            return False
        # A single-label name (`ollama`, `vllm`) only resolves inside a network.
        return "." in name


def _literal_address(host: str) -> IPAddress | None:
    # A trailing dot names the same host: `127.0.0.1.` resolves like `127.0.0.1`.
    # The zone id (`%eth0`) goes too, as in `system_resolver`.
    try:
        return ipaddress.ip_address(host.strip("[]").split("%")[0].rstrip("."))
    except ValueError:
        return None


def _refusal(
    host: str, addresses: Iterable[IPAddress], policy: EndpointPolicy
) -> str | None:
    resolved = list(addresses)
    if not resolved:
        return f"{host} did not resolve to any address."
    for address in resolved:
        if not policy.address_allowed(address):
            what = (
                "is"
                if _literal_address(host) is not None
                else f"resolves to {address}, which is"
            )
            return f"{host} {what} a private or internal address."
    return None


def validate_base_url(url: str, policy: EndpointPolicy) -> str:
    """Check an admin-supplied base URL and return it normalized."""
    try:
        parts = urlsplit(url.strip())
        host = (parts.hostname or "").lower().rstrip(".")
    except ValueError as exc:
        raise EndpointNotAllowed("The address is not valid.") from exc
    scheme = parts.scheme.lower()
    if not policy.scheme_allowed(scheme):
        raise EndpointNotAllowed("Use an address that starts with https://.")
    if not host:
        raise EndpointNotAllowed("The address has no host name.")
    if parts.username or parts.password:
        raise EndpointNotAllowed(
            "The address must not contain a user name or password."
        )
    if parts.query or parts.fragment:
        raise EndpointNotAllowed("The address must not contain a query or a fragment.")
    try:
        port = parts.port
    except ValueError as exc:
        raise EndpointNotAllowed("The port of the address is not valid.") from exc
    literal = _literal_address(host)
    if literal is not None:
        reason = _refusal(host, [literal], policy)
        if reason is not None:
            raise EndpointNotAllowed(reason)
        host = str(_unscoped(literal))
    elif not policy.host_name_allowed(host):
        raise EndpointNotAllowed(f"{host} is an internal host name.")
    netloc = f"[{host}]" if ":" in host else host
    if port is not None:
        netloc = f"{netloc}:{port}"
    return urlunsplit((scheme, netloc, parts.path.rstrip("/"), "", ""))


async def system_resolver(host: str, port: int) -> list[IPAddress]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    addresses = [ipaddress.ip_address(str(info[4][0]).split("%")[0]) for info in infos]
    return list(dict.fromkeys(addresses))


async def _resolve(
    resolver: Resolver, host: str, port: int, timeout: float | None
) -> list[IPAddress]:
    """Resolve within ``timeout`` (``TimeoutError`` when it runs out). A name the
    system cannot encode, such as a label longer than 63 characters, raises
    ``UnicodeError`` from the resolver instead of ``OSError``."""
    with anyio.fail_after(timeout):
        return await resolver(host, port)


async def check_resolves(
    url: str, policy: EndpointPolicy, resolver: Resolver = system_resolver
) -> None:
    """Refuse an address that is, or a host name that now resolves to, a private
    address. Safe to call on its own: it does not rely on ``validate_base_url``."""
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as exc:
        raise EndpointNotAllowed("The address is not valid.") from exc
    if not host:
        raise EndpointNotAllowed("The address has no host name.")
    literal = _literal_address(host)
    if literal is not None:
        reason = _refusal(host, [literal], policy)
    else:
        if not policy.host_name_allowed(host):
            raise EndpointNotAllowed(f"{host} is an internal host name.")
        try:
            addresses = await _resolve(resolver, host, port, _RESOLVE_TIMEOUT)
        except TimeoutError as exc:
            raise EndpointNotAllowed(f"Resolving {host} took too long.") from exc
        except (OSError, UnicodeError) as exc:
            raise EndpointNotAllowed(f"{host} could not be resolved.") from exc
        reason = _refusal(host, addresses, policy)
    if reason is not None:
        raise EndpointNotAllowed(reason)


class GuardedBackend(httpcore2.AsyncNetworkBackend):
    def __init__(
        self,
        policy: EndpointPolicy,
        *,
        resolver: Resolver | None = None,
        inner: httpcore2.AsyncNetworkBackend | None = None,
    ) -> None:
        self._policy = policy
        self._resolver = resolver or system_resolver
        self._inner = inner or httpcore2.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[httpcore2.SOCKET_OPTION] | None = None,
    ) -> httpcore2.AsyncNetworkStream:
        literal = _literal_address(host)
        if literal is not None:
            addresses: list[IPAddress] = [literal]
        else:
            try:
                addresses = await _resolve(self._resolver, host, port, timeout)
            except TimeoutError as exc:
                raise httpcore2.ConnectTimeout(
                    f"Resolving {host} took too long."
                ) from exc
            except UnicodeError as exc:
                raise BlockedEndpoint(f"{host} is not a valid host name.") from exc
            except OSError as exc:
                raise httpcore2.ConnectError(f"{host} could not be resolved.") from exc
        reason = _refusal(host, addresses, self._policy)
        if reason is not None:
            raise BlockedEndpoint(reason)
        last: httpcore2.ConnectError | httpcore2.ConnectTimeout | None = None
        for address in addresses:
            try:
                # TLS still verifies the certificate against the host name: httpcore
                # passes the request's host as server_hostname to start_tls.
                return await self._inner.connect_tcp(
                    str(address),
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore2.ConnectError, httpcore2.ConnectTimeout) as exc:
                last = exc
        assert last is not None
        raise last

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[httpcore2.SOCKET_OPTION] | None = None,
    ) -> httpcore2.AsyncNetworkStream:
        raise BlockedEndpoint("Unix sockets are not allowed.")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


class GuardedTransport(httpx2.AsyncHTTPTransport):
    def __init__(
        self,
        policy: EndpointPolicy,
        *,
        resolver: Resolver | None = None,
        inner_backend: httpcore2.AsyncNetworkBackend | None = None,
    ) -> None:
        super().__init__(trust_env=False)
        self._policy = policy
        # httpx2 2.x builds its connection pool in __init__ and offers no
        # network-backend option, so the pool is replaced by one on the guarded
        # backend. It takes httpx2's own default limits and HTTP/1.1 only, so it
        # behaves like the pool it replaces. test_endpoints.py fails if a later
        # httpx2 stops routing requests through `_pool`.
        self._pool = httpcore2.AsyncConnectionPool(
            # trust_env=True is deliberate: SSL_CERT_FILE and SSL_CERT_DIR keep
            # working, so a corporate CA is trusted. Proxy variables are never
            # read here (see `guarded_client`). GOAT_CA_BUNDLE adds its CAs to
            # the system ones; without it this is httpx2's default context.
            ssl_context=httpx2.create_ssl_context(
                verify=ssl_context(policy.ca_bundle), trust_env=True
            ),
            max_connections=_HTTPX_LIMITS.max_connections,
            max_keepalive_connections=_HTTPX_LIMITS.max_keepalive_connections,
            keepalive_expiry=_HTTPX_LIMITS.keepalive_expiry,
            http1=True,
            http2=False,
            network_backend=GuardedBackend(
                policy, resolver=resolver, inner=inner_backend
            ),
        )

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        # Runs for every hop, so a redirect to http:// or an internal name is
        # refused before anything is sent.
        scheme = request.url.scheme
        host = request.url.host
        reason: str | None = None
        if not self._policy.scheme_allowed(scheme):
            reason = f"{scheme}:// is not allowed (request to {host})."
        elif _literal_address(host) is None and not self._policy.host_name_allowed(
            host
        ):
            reason = f"{host} is an internal host name."
        if reason is not None:
            raise httpx2.ConnectError(reason, request=request) from BlockedEndpoint(
                reason
            )
        return await super().handle_async_request(request)


def _origin(url: httpx2.URL) -> tuple[str, str, int]:
    return (url.scheme, url.host, url.port or (443 if url.scheme == "https" else 80))


async def _same_origin_redirects(response: httpx2.Response) -> None:
    """Refuse a redirect to another scheme, host or port. Model SDKs send the key
    in headers such as ``x-api-key``, which would travel on to the new host."""
    if not response.has_redirect_location:
        return
    request = response.request
    try:
        target: httpx2.URL | None = request.url.join(response.headers["location"])
    except httpx2.InvalidURL:
        target = None
    if target is None or _origin(target) != _origin(request.url):
        reason = (
            f"{request.url.host} redirected to another address, which is not followed."
        )
        raise httpx2.ConnectError(reason, request=request) from BlockedEndpoint(reason)


def guarded_client(
    policy: EndpointPolicy,
    *,
    timeout: httpx2.Timeout,
    transport: httpx2.AsyncBaseTransport | None = None,
) -> httpx2.AsyncClient:
    """The HTTP client of an organization connection. ``trust_env=False``: a
    proxy from the environment would carry the request past the guard. Only
    same-origin redirects are followed."""
    return httpx2.AsyncClient(
        transport=transport or GuardedTransport(policy),
        timeout=timeout,
        follow_redirects=True,
        max_redirects=3,
        trust_env=False,
        event_hooks={"response": [_same_origin_redirects]},
    )

"""GOAT_CA_BUNDLE: a company CA every outbound client of the assistant trusts in
addition to the system CAs, as core does. Unset, the clients keep their
libraries' default verification."""

import datetime
import ipaddress
import json
import ssl
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
import httpx2
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import NameOID
from google.auth.exceptions import TransportError
from pydantic import ValidationError

from assistant.config import AssistantSettings
from assistant.llm import providers
from assistant.llm.endpoints import EndpointPolicy, GuardedTransport, IPAddress
from assistant.llm.providers import Target, open_models
from assistant.tls import ssl_context
from assistant.tools.http import ServiceClients

TOKEN = {"access_token": "ya29.local", "expires_in": 3600, "token_type": "Bearer"}


@dataclass(frozen=True)
class CompanyCa:
    bundle: Path
    cert: Path
    key: Path
    #: A server certificate for the name ``localhost`` only, without an IP SAN.
    name_only_cert: Path
    name_only_key: Path


@pytest.fixture(autouse=True)
def _no_ca_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "GOAT_CA_BUNDLE",
        "ASSISTANT_GOAT_CA_BUNDLE",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(scope="module")
def company_ca(tmp_path_factory: pytest.TempPathFactory) -> CompanyCa:
    """A private CA and server certificates it signed for localhost."""
    folder = tmp_path_factory.mktemp("company-ca")
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, "GOAT Company Test CA")]
    )
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )

    def issue(names: list[x509.GeneralName], stem: str) -> tuple[Path, Path]:
        server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        server_cert = (
            x509.CertificateBuilder()
            .subject_name(
                x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
            )
            .issuer_name(ca_name)
            .public_key(server_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName(names), critical=False)
            .add_extension(
                x509.BasicConstraints(ca=False, path_length=None), critical=True
            )
            .add_extension(
                x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]),
                critical=False,
            )
            .add_extension(
                x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
                critical=False,
            )
            .sign(ca_key, hashes.SHA256())
        )
        cert = folder / f"{stem}.pem"
        cert.write_bytes(server_cert.public_bytes(serialization.Encoding.PEM))
        key = folder / f"{stem}-key.pem"
        key.write_bytes(
            server_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        return cert, key

    bundle = folder / "company-ca.pem"
    bundle.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    cert, key = issue(
        [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))],
        "server",
    )
    name_only_cert, name_only_key = issue([x509.DNSName("localhost")], "name-only")
    return CompanyCa(
        bundle=bundle,
        cert=cert,
        key=key,
        name_only_cert=name_only_cert,
        name_only_key=name_only_key,
    )


class _Handler(BaseHTTPRequestHandler):
    def _answer(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        body = json.dumps(TOKEN).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _answer  # noqa: N815
    do_POST = _answer  # noqa: N815

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass


class _QuietServer(ThreadingHTTPServer):
    def handle_error(self, request: Any, client_address: Any) -> None:
        pass


@contextmanager
def _serve(cert: Path, key: Path) -> Iterator[str]:
    """An HTTPS server on 127.0.0.1, addressed as localhost."""
    server = _QuietServer(("127.0.0.1", 0), _Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(cert), str(key))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"https://localhost:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture(scope="module")
def server_url(company_ca: CompanyCa) -> Iterator[str]:
    """A server whose certificate the company CA signed for localhost and 127.0.0.1."""
    with _serve(company_ca.cert, company_ca.key) as url:
        yield url


@pytest.fixture(scope="module")
def name_only_server_url(company_ca: CompanyCa) -> Iterator[str]:
    """A server whose certificate names localhost only, without an IP SAN."""
    with _serve(company_ca.name_only_cert, company_ca.name_only_key) as url:
        yield url


async def _loopback(host: str, port: int) -> list[IPAddress]:
    return [ipaddress.ip_address("127.0.0.1")]


# --- the helper ---------------------------------------------------------------


def test_without_a_bundle_the_library_default_applies() -> None:
    assert ssl_context(None) is True
    assert ssl_context("") is True


def test_the_bundle_is_added_to_the_system_cas(
    monkeypatch: pytest.MonkeyPatch, company_ca: CompanyCa
) -> None:
    system = ssl.create_default_context().get_ca_certs()
    default_context = ssl.create_default_context
    started: list[ssl.SSLContext] = []

    def record(*args: Any, **kwargs: Any) -> ssl.SSLContext:
        # No cafile, capath or cadata: only then does it load the defaults.
        assert not args and not kwargs, "ssl_context starts from the defaults"
        started.append(default_context())
        return started[-1]

    monkeypatch.setattr(ssl, "create_default_context", record)
    context = ssl_context(str(company_ca.bundle))
    assert isinstance(context, ssl.SSLContext)
    # The system CAs stay: the bundle adds to them, never replaces them. The
    # context is the default one, which loads OpenSSL's default verify paths
    # (the system store), with the bundle loaded on top.
    assert started == [context]
    trusted = context.get_ca_certs()
    if system:
        # A system store read from a file is listed, so every entry shows.
        assert len(trusted) == len(system) + 1
        assert all(entry in trusted for entry in system)
    else:
        # Builds without a default CA file (uv's CPython on Ubuntu) read the
        # system store from a hashed directory, which OpenSSL consults during
        # verification and never lists; only the bundle shows.
        paths = ssl.get_default_verify_paths()
        assert paths.cafile is None
        assert paths.capath, "the test needs a system CA store"
        assert any(Path(paths.capath).iterdir())
        assert len(trusted) == 1
    assert any("GOAT Company Test CA" in str(entry["subject"]) for entry in trusted)
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True


def test_a_missing_or_unreadable_bundle_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        ssl_context(str(tmp_path / "missing.pem"))
    garbage = tmp_path / "garbage.pem"
    garbage.write_text("not a certificate\n")
    with pytest.raises(ssl.SSLError):
        ssl_context(str(garbage))


# --- settings -------------------------------------------------------------------


def test_settings_read_goat_ca_bundle(
    monkeypatch: pytest.MonkeyPatch, company_ca: CompanyCa
) -> None:
    # The bare name, as core reads it.
    monkeypatch.setenv("GOAT_CA_BUNDLE", str(company_ca.bundle))
    assert AssistantSettings().goat_ca_bundle == str(company_ca.bundle)
    # The prefixed variable overrides it, like the other repo-wide settings.
    monkeypatch.setenv("ASSISTANT_GOAT_CA_BUNDLE", "")
    assert AssistantSettings().goat_ca_bundle is None


@pytest.mark.parametrize("value", ["", "  "])
def test_an_empty_goat_ca_bundle_means_unset(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    # Compose passes `GOAT_CA_BUNDLE: ${GOAT_CA_BUNDLE:-}` on every install.
    monkeypatch.setenv("GOAT_CA_BUNDLE", value)
    assert AssistantSettings().goat_ca_bundle is None


def test_a_missing_bundle_stops_the_start(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("GOAT_CA_BUNDLE", str(tmp_path / "missing.pem"))
    with pytest.raises(ValidationError, match="GOAT_CA_BUNDLE") as raised:
        AssistantSettings()
    assert "missing.pem" in str(raised.value)


def test_a_bundle_without_certificates_stops_the_start(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    garbage = tmp_path / "garbage.pem"
    garbage.write_text("not a certificate\n")
    monkeypatch.setenv("GOAT_CA_BUNDLE", str(garbage))
    with pytest.raises(ValidationError, match="GOAT_CA_BUNDLE"):
        AssistantSettings()


def test_the_endpoint_policy_carries_the_bundle(
    settings: AssistantSettings, company_ca: CompanyCa
) -> None:
    assert EndpointPolicy.from_settings(settings).ca_bundle is None
    with_ca = settings.model_copy(update={"goat_ca_bundle": str(company_ca.bundle)})
    assert EndpointPolicy.from_settings(with_ca).ca_bundle == str(company_ca.bundle)


# --- model endpoints ------------------------------------------------------------


async def test_the_guarded_transport_trusts_the_bundle(
    company_ca: CompanyCa, name_only_server_url: str
) -> None:
    """The connection is pinned to the address the guard checked (127.0.0.1),
    while the certificate is verified against the requested host name: the
    certificate names only localhost, so verifying against the address fails."""
    policy = EndpointPolicy(allow_private=True, ca_bundle=str(company_ca.bundle))
    transport = GuardedTransport(policy, resolver=_loopback)
    trusted = transport._pool._ssl_context
    assert trusted is not None
    assert len(trusted.get_ca_certs()) == (
        len(ssl.create_default_context().get_ca_certs()) + 1
    )
    async with httpx2.AsyncClient(transport=transport) as client:
        response = await client.get(f"{name_only_server_url}/v1/models")
    assert response.status_code == 200


async def test_without_the_bundle_the_guarded_transport_refuses_the_server(
    server_url: str,
) -> None:
    transport = GuardedTransport(EndpointPolicy(allow_private=True), resolver=_loopback)
    async with httpx2.AsyncClient(transport=transport) as client:
        with pytest.raises(httpx2.ConnectError, match="CERTIFICATE_VERIFY_FAILED"):
            await client.get(f"{server_url}/v1/models")


def _openai_target(*, own: bool) -> Target:
    return Target(
        connection_id=UUID(int=7) if own else None,
        provider="openai_compatible" if own else "openai",
        model="gpt-test",
        base_url="https://localhost/v1" if own else None,
        credentials={"api_key": "sk-test-0000"},
    )


@pytest.mark.parametrize("own", [True, False], ids=["own connection", "GOAT AI"])
async def test_model_clients_trust_the_bundle(
    company_ca: CompanyCa, server_url: str, own: bool
) -> None:
    policy = EndpointPolicy(allow_private=True, ca_bundle=str(company_ca.bundle))
    models = open_models(_openai_target(own=own), policy)
    try:
        (client,) = models.clients
        response = await client.get(f"{server_url}/v1/models")
        assert response.status_code == 200
    finally:
        await models.aclose()


@pytest.mark.parametrize("own", [True, False], ids=["own connection", "GOAT AI"])
async def test_model_clients_without_the_bundle_refuse_the_server(
    server_url: str, own: bool
) -> None:
    models = open_models(_openai_target(own=own), EndpointPolicy(allow_private=True))
    try:
        (client,) = models.clients
        with pytest.raises(httpx2.ConnectError, match="CERTIFICATE_VERIFY_FAILED"):
            await client.get(f"{server_url}/v1/models")
    finally:
        await models.aclose()


# --- Vertex AI token refresh ----------------------------------------------------


def _vertex_key(token_uri: str) -> dict[str, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return {
        "type": "service_account",
        "project_id": "goat-test",
        "private_key_id": "0123456789abcdef",
        "private_key": key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode(),
        "client_email": "goat@goat-test.iam.gserviceaccount.com",
        "token_uri": token_uri,
    }


def test_the_vertex_token_refresh_trusts_the_bundle(
    company_ca: CompanyCa, server_url: str
) -> None:
    credentials = providers._DirectCredentials.from_service_account_info(  # type: ignore[no-untyped-call]
        _vertex_key(f"{server_url}/token"), scopes=[providers.CLOUD_PLATFORM_SCOPE]
    )
    credentials.ca_bundle = str(company_ca.bundle)
    credentials.refresh(None)
    assert credentials.token == "ya29.local"


def test_without_the_bundle_the_vertex_token_refresh_refuses_the_server(
    server_url: str,
) -> None:
    credentials = providers._DirectCredentials.from_service_account_info(  # type: ignore[no-untyped-call]
        _vertex_key(f"{server_url}/token"), scopes=[providers.CLOUD_PLATFORM_SCOPE]
    )
    with pytest.raises(TransportError, match="CERTIFICATE_VERIFY_FAILED"):
        credentials.refresh(None)


async def test_an_own_vertex_connection_gets_the_bundle(company_ca: CompanyCa) -> None:
    target = Target(
        connection_id=UUID(int=8),
        provider="vertex",
        model="claude-sonnet-4-5",
        region="europe-west1",
        credentials={
            "service_account_json": json.dumps(
                _vertex_key("https://oauth2.googleapis.com/token")
            )
        },
    )
    for bundle in (str(company_ca.bundle), None):
        models = open_models(target, EndpointPolicy(ca_bundle=bundle))
        try:
            sdk: Any = models.main.client  # type: ignore[attr-defined]
            assert isinstance(sdk.credentials, providers._DirectCredentials)
            assert sdk.credentials.ca_bundle == bundle
        finally:
            await models.aclose()


# --- the tools' service clients and the Keycloak client -------------------------


def _service_settings(
    settings: AssistantSettings, url: str, bundle: str | None
) -> AssistantSettings:
    return settings.model_copy(
        update={
            "goat_ca_bundle": bundle,
            "core_url": url,
            "geoapi_url": url,
            "processes_url": url,
            "catalog_url": url,
            "auth": True,
            "keycloak_server_url": url,
        }
    )


async def test_service_clients_trust_the_bundle(
    settings: AssistantSettings, company_ca: CompanyCa, server_url: str
) -> None:
    clients = ServiceClients.from_settings(
        _service_settings(settings, server_url, str(company_ca.bundle))
    )
    try:
        assert clients.keycloak is not None
        for client in (
            clients.core,
            clients.geoapi,
            clients.processes,
            clients.catalog,
            clients.keycloak,
        ):
            response = await client.get("/healthz")
            assert response.status_code == 200
            # Still no redirects.
            assert client.follow_redirects is False
    finally:
        await clients.aclose()


async def test_service_clients_without_the_bundle_refuse_the_server(
    settings: AssistantSettings, server_url: str
) -> None:
    clients = ServiceClients.from_settings(
        _service_settings(settings, server_url, None)
    )
    try:
        assert clients.keycloak is not None
        for client in (
            clients.core,
            clients.geoapi,
            clients.processes,
            clients.catalog,
            clients.keycloak,
        ):
            with pytest.raises(httpx.ConnectError, match="CERTIFICATE_VERIFY_FAILED"):
                await client.get("/healthz")
    finally:
        await clients.aclose()

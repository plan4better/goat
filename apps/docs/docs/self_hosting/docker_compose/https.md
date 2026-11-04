---
sidebar_position: 2
sidebar_label: HTTPS and addresses
description: "Choose the public URL and one of the four TLS modes (auto, custom, internal, off) for Caddy, and run GOAT behind your own load balancer or with a company CA."
---

# HTTPS and addresses

GOAT is reachable under **one public URL**, and Caddy, the proxy in front of all services, decides how HTTPS works. You choose the URL and the TLS mode with `setup.sh`, interactively or with options:

```bash
./setup.sh --public-url <url> --tls <mode>
docker compose up -d
```

The public URL must be a bare origin without a path, for example `https://goat.example.org`, `http://10.0.0.5` or `http://10.0.0.5:8080`. All services live under it (see [Where the services live](./installation.md#urls)).

## The four TLS modes {#modes}

| Mode | Use it when | What happens |
|---|---|---|
| `auto` | The server has a public DNS name | Caddy gets a certificate from Let's Encrypt and renews it |
| `custom` | You have your own certificate | Caddy uses `cert.pem` and `key.pem` from `./certs` |
| `internal` | Test installations in an intranet | Caddy issues a certificate from its own CA; browsers warn until that CA is trusted |
| `off` | Local installations over plain HTTP, or behind your own load balancer that handles TLS | No TLS in Caddy |

All four modes have been tested, including `off` behind a load balancer.

## Automatic certificate (`auto`) {#auto}

```bash
./setup.sh --public-url https://goat.example.org --tls auto --acme-email ops@<your-domain>
```

Requirements:

- The DNS name resolves to the server.
- Port **443** reaches the server from the internet: Let's Encrypt validates the domain through it. Also open port **80** if `http://` addresses should redirect to HTTPS; Caddy can then validate through port 80 as well.
- The URL has no port.

Caddy then gets the certificate on the first start, renews it on its own and redirects HTTP to HTTPS.

The email for Let's Encrypt (`--acme-email`, stored as `GOAT_ACME_EMAIL`) is optional; Let's Encrypt uses it for expiry notices. Let's Encrypt rejects contacts on domains outside the public DNS, and your site would then get no certificate. `setup.sh` therefore refuses addresses ending in `.test`, `.local`, `.localhost`, `.invalid` or `.example`, and addresses at `example.com`, `example.org`, `example.net` or `localhost`. Use a real address or leave the field empty.

:::tip Certificate not issued?
Check that port 443 reaches the server from the internet and that the DNS name resolves to it, then look at `docker compose logs caddy`.
:::

## Your own certificate (`custom`) {#custom}

Put two PEM files into the `certs` folder of the bundle:

| File | Content |
|---|---|
| `certs/cert.pem` | The certificate with its full chain (your certificate first, then the intermediate certificates) |
| `certs/key.pem` | The private key |

```bash
./setup.sh --public-url https://goat.example.org --tls custom
docker compose up -d
```

`setup.sh` reminds you if the files are missing. In this mode the URL may contain a port other than 443, such as `https://goat.example.org:8443`; Caddy then serves HTTPS on that port.

## Caddy's own CA (`internal`) {#internal}

For test installations in an intranet, Caddy can issue a certificate from its own certificate authority. Browsers show a warning until you trust that CA's root certificate. Copy it out of the proxy container:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .
```

Then import `root.crt` into the trust store of your operating system or browser.

`setup.sh` points `GOAT_CA_BUNDLE` at this root certificate, so that GOAT's own services, such as the web server and the PDF print worker, trust the address too. `smoke.sh` skips certificate verification in this mode.

## Plain HTTP (`off`) {#off}

For local installations without TLS:

```bash
./setup.sh --public-url http://10.0.0.5 --tls off
```

With a port in the URL, such as `http://10.0.0.5:8080`, Caddy listens on that port instead of port 80. For an `http://` URL, the login server accepts logins over plain HTTP from any address.

:::warning
Without TLS, passwords and data travel unencrypted. Use plain HTTP only in networks you trust.
:::

## Behind your own load balancer {#load-balancer}

If a load balancer or reverse proxy of yours terminates TLS, keep the `https://` URL and switch TLS in Caddy off. Choose the port on which Caddy should accept plain HTTP from the load balancer:

```bash
./setup.sh --public-url https://goat.example.org --tls off --http-port 8080
docker compose up -d
```

Then:

1. Point your load balancer at port `8080` of the server.
2. List the load balancer's addresses in `GOAT_TRUSTED_PROXIES` in `.env`, as CIDRs separated by spaces. Caddy honours the `X-Forwarded-*` headers only from these addresses. The default, `private_ranges`, covers the RFC 1918 networks.
3. Make sure the server itself can reach the public URL through the load balancer: GOAT's containers call it, for example during login and PDF printing.

In this mode Caddy does not publish port 443 on the server, so the port stays free for other software.

## Company CA {#company-ca}

If certificates in your network come from a private certificate authority, for example the certificate of your load balancer, of your own Keycloak or of your SMTP relay, GOAT has to trust that CA. Put the CA certificate (PEM) into `./certs` and set its path inside the containers in `.env`:

```bash
GOAT_CA_BUNDLE=/certs/company-ca.pem
```

Apply the change with `docker compose up -d`. GOAT's web server, the job workers including the PDF print worker, the AI assistant (for model servers, GOAT's services and Keycloak), and the senders of email (GOAT and the bundled Keycloak) then trust the CA in addition to the public ones. `GOAT_CA_BUNDLE` holds one file, which may contain several certificates. In `internal` mode `setup.sh` uses it for Caddy's root certificate; to trust a company CA as well, put both certificates into one file in `./certs`.

## HSTS and security headers {#hsts}

In the modes `auto`, `custom` and `internal`, Caddy sends the header `Strict-Transport-Security: max-age=31536000`. Browsers that have visited GOAT then insist on HTTPS for this host name for one year. Keep this in mind before you move a host name from HTTPS back to plain HTTP.

In `off` mode Caddy sends no HSTS header. Behind your own load balancer, set HSTS there if you want it.

In every mode Caddy also sends `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`, and removes the `Server` header.

## Changing the address later {#change-url}

Run `setup.sh` again with the new URL or mode, then `docker compose up -d`. `setup.sh` rewrites all values it derives from the URL and the TLS mode.

:::info
The bundled Keycloak follows the new URL on its own: on every `docker compose up -d`, the step `keycloak-sync` sets the GOAT client's addresses (root URL, redirect URIs, web origins) and the HTTPS requirement from `.env`. With your own Keycloak, update the client there.
:::

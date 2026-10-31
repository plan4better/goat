---
sidebar_position: 4
sidebar_label: Konfigurationsreferenz
description: "Alle Einstellungen der Datei .env des Pakets, gruppiert nach Release, Adresse und TLS, Anmeldung, Speicher, Datenbank, Jobs, Integrationen, E-Mail und Backups."
---

# Konfigurationsreferenz

Die gesamte Konfiguration steht in der Datei `.env` im Ordner des Pakets. `setup.sh` erstellt sie aus `.env.example`, wo jede Einstellung mit Kommentaren beschrieben ist. Diese Seite listet die Einstellungen in denselben Gruppen auf.

- **Von setup.sh gesetzt** bedeutet, dass `setup.sh` den Wert einträgt: Geheimnisse werden einmal erzeugt, wenn sie leer sind, und abgeleitete Werte werden bei jedem Lauf aus der öffentlichen URL und dem TLS-Modus neu geschrieben. Bearbeiten Sie abgeleitete Werte nicht von Hand, sondern führen Sie `setup.sh` aus.
- Eine Einstellung mit dem Vermerk *(auskommentiert)* steht in `.env.example`, ist aber inaktiv, bis Sie das `#` entfernen.

Übernehmen Sie Änderungen mit `docker compose up -d`.

## Release {#release}

| Einstellung | Vorgabe | Bedeutung |
|---|---|---|
| `GOAT_VERSION` | das Release des Pakets | Die GOAT-Version, die alle Images verwenden. Siehe [Updates](./operations.md#upgrade). |
| `GOAT_REGISTRY` | `ghcr.io/plan4better/goat` | Woher die GOAT-Images geladen werden, z. B. ein interner Mirror |

## Öffentliche Adresse und TLS {#address}

| Einstellung | Vorgabe | Bedeutung |
|---|---|---|
| `GOAT_PUBLIC_URL` | von setup.sh abgefragt | Die URL, die Benutzer in den Browser eingeben, ohne abschließenden Schrägstrich |
| `GOAT_TLS` | `auto` | `auto`, `custom`, `internal` oder `off`; siehe [HTTPS und Adressen](./https.md) |
| `GOAT_ACME_EMAIL` | leer | Optionaler Kontakt für Ablaufhinweise von Let's Encrypt (nur `auto`) |
| `GOAT_TRUSTED_PROXIES` | `private_ranges` | Adressen, die `X-Forwarded-*`-Header setzen dürfen (Ihr Load Balancer), als CIDRs durch Leerzeichen getrennt |
| `GOAT_ADMIN_ALLOW_CIDRS` | `0.0.0.0/0 ::/0` | Netze, die die Keycloak-Admin-Konsole unter `/keycloak/admin` öffnen dürfen |
| `GOAT_CA_BUNDLE` | leer | Pfad innerhalb der Container zu zusätzlichen CA-Zertifikaten (PEM) in `./certs`, etwa Ihrer Firmen-CA für Load Balancer, Keycloak, SMTP-Relay oder den Modellserver des KI-Assistenten; im Modus `internal` von setup.sh gesetzt. Siehe [Firmen-CA](./https.md#company-ca). |
| `GOAT_HTTP_PORT` | `80` | Port für HTTP; von setup.sh aus der URL oder `--http-port` gesetzt |
| `GOAT_HTTPS_PORT` | `443` | Port für HTTPS; von setup.sh aus der URL gesetzt |
| `GOAT_HOSTNAME`, `GOAT_NETWORK_ALIAS`, `GOAT_SITE_ADDRESS`, `GOAT_HTTPS_PUBLISH`, `GOAT_KEYCLOAK_SSL_REQUIRED` | | Abgeleitet; von setup.sh gesetzt |

## Profile {#profiles}

| Einstellung | Vorgabe | Bedeutung |
|---|---|---|
| `COMPOSE_PROFILES` | `garage,keycloak` | Die mitgelieferten Komponenten, die laufen sollen: `garage` (Objektspeicher), `keycloak` (Anmeldeserver), `backup` (nächtliche Backups) |

## Authentifizierung {#authentication}

| Einstellung | Vorgabe | Bedeutung |
|---|---|---|
| `AUTH` | `True` | `True`: Benutzer melden sich über Keycloak an. `False`: keine Anmeldung, alle handeln als ein eingebauter Administrator (nur für lokale und Demo-Installationen). |
| `GOAT_ADMIN_EMAIL` | von setup.sh abgefragt | Der erste GOAT-Benutzer, der beim ersten Start im mitgelieferten Keycloak angelegt wird |
| `GOAT_ADMIN_PASSWORD` | von setup.sh gesetzt | Passwort des ersten Benutzers |
| `REALM_NAME` | `goat` | Keycloak-Realm, den GOAT verwendet |
| `KEYCLOAK_CLIENT_ID` | `goat` | Keycloak-Client, den GOAT verwendet |
| `KEYCLOAK_CLIENT_SECRET` | von setup.sh gesetzt | Secret dieses Clients |
| `KEYCLOAK_ADMIN_PASSWORD` | von setup.sh gesetzt | Passwort des Benutzers `admin` in der Keycloak-Admin-Konsole |
| `KEYCLOAK_PROVISION_INVITED_USERS` | `true` | Legt das Anmeldekonto in Keycloak an, wenn jemand eingeladen wird, dessen E-Mail-Adresse noch keines hat |
| `ALLOW_ORGANIZATION_CREATION` | `true` | `true`: Wer sich ohne Organisation anmeldet, kann eine einrichten. `false`: Das können nur Konten mit der Keycloak-Realm-Rolle `superuser`; alle anderen warten auf eine Einladung. Siehe [Wer Organisationen einrichtet](./operations.md#organizations). |
| `KEYCLOAK_DB_PASSWORD` | von setup.sh gesetzt | Datenbank-Passwort des mitgelieferten Keycloak |
| `KEYCLOAK_PUBLIC_URL`, `KEYCLOAK_INTERNAL_URL` | *(auskommentiert)* | Ihr eigenes Keycloak; siehe [Eigenes Keycloak](./external_services.md#keycloak) |
| `AUTH_ALLOWED_CLIENTS` | *(auskommentiert)* | Keycloak-Clients, deren Tokens die GOAT-APIs annehmen, durch Kommas getrennt; leer nimmt Tokens aller Clients des Realms an. Eine Liste muss `KEYCLOAK_CLIENT_ID` enthalten. Siehe [Ein Realm, den sich GOAT mit anderen Anwendungen teilt](./external_services.md#keycloak-shared-realm) |

## Objektspeicher (S3) {#storage}

| Einstellung | Vorgabe | Bedeutung |
|---|---|---|
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | von setup.sh gesetzt | Zugangsschlüssel für das mitgelieferte Garage oder Ihr eigener S3-Schlüssel |
| `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN` | von setup.sh gesetzt | Interne Geheimnisse des mitgelieferten Garage |
| `S3_ENDPOINT_URL`, `S3_PUBLIC_ENDPOINT_URL`, `S3_REGION`, `S3_BUCKET_NAME`, `S3_FORCE_PATH_STYLE` | *(auskommentiert)* | Ihr eigener S3-Speicher; siehe [Eigener S3-Speicher](./external_services.md#s3) |
| `ASSETS_S3_ENDPOINT_URL`, `ASSETS_BUCKET_NAME`, `ASSETS_URL` | *(auskommentiert)* | Der öffentlich lesbare Bucket für Profilbilder und Bilder in Ihrem eigenen S3-Speicher |
| `ASSETS_SERVED_BY_CORE` | `false` | `true`: Bilder im Upload-Bucket, von GOAT ausgeliefert, für S3 ohne öffentlichen Bucket |

## Datenbank {#database}

Die Speichervorgaben passen zu einer Maschine mit 16 GB. Als Faustregel setzen Sie `POSTGRES_SHARED_BUFFERS` auf etwa 1/4 und `POSTGRES_EFFECTIVE_CACHE_SIZE` auf etwa 3/4 des Arbeitsspeichers, den Sie PostgreSQL geben.

| Einstellung | Vorgabe | Bedeutung |
|---|---|---|
| `POSTGRES_PASSWORD` | von setup.sh gesetzt | Passwort der GOAT-Datenbank |
| `WINDMILL_DB_PASSWORD` | von setup.sh gesetzt | Passwort der Windmill-Datenbank |
| `POSTGRES_SHARED_BUFFERS` | `1GB` | PostgreSQL `shared_buffers` |
| `POSTGRES_EFFECTIVE_CACHE_SIZE` | `3GB` | PostgreSQL `effective_cache_size` |
| `POSTGRES_MAX_CONNECTIONS` | `200` | PostgreSQL `max_connections` |
| `POSTGRES_POOL_SIZE` | `5` | Größe des Verbindungspools der Core API |
| `POSTGRES_MAX_OVERFLOW` | `10` | Zusätzliche Verbindungen, die die Core API über den Pool hinaus öffnen darf |

Die Dienste von GOAT benennen ihre Datenbanksitzungen nach sich selbst (`goat-core`, `goat-geoapi`, `goat-processes`, `goat-tools`, …), sodass `pg_stat_activity` zeigt, welcher Dienst eine Verbindung hält. Auf der Windmill-Datenbank gehören die Sitzungen ohne `goat-`-Namen Windmill selbst. Windmill hält höchstens 10 Verbindungen zu seiner Datenbank für den Server und 3 für jeden Worker (`DATABASE_CONNECTIONS` in `compose.yaml`).

## Jobs (Windmill) {#jobs}

| Einstellung | Vorgabe | Bedeutung |
|---|---|---|
| `WINDMILL_ADMIN_PASSWORD` | von setup.sh gesetzt | Passwort von `admin@windmill.dev` in der Windmill-Oberfläche |
| `GOAT_TOOLS_WORKERS` | `2` | Anzahl der Analyse-Jobs, die parallel laufen; jeder Tools-Worker darf bis zu 4 GB Arbeitsspeicher nutzen |
| `WINDMILL_LOCAL_PORT` | `8110` | Port der Windmill-Oberfläche, nur an `127.0.0.1` gebunden; siehe [Windmill](./operations.md#windmill) |
| `GOAT_BASE_DATA_URL` | `https://goat-base-data.plan4better.de/` | Quelle der Routing- und ÖV-Basisdaten; siehe [Routing-Basisdaten](./operations.md#base-data) |

## Geheimnisse der Web-App {#web}

| Einstellung | Vorgabe | Bedeutung |
|---|---|---|
| `NEXTAUTH_SECRET` | von setup.sh gesetzt | Signaturschlüssel für die Anmeldesitzungen der Web-App |

## Optionale Integrationen {#integrations}

| Einstellung | Vorgabe | Bedeutung |
|---|---|---|
| `NEXT_PUBLIC_MAPTILER_KEY` | leer | MapTiler-Schlüssel für die Satelliten-/Hybrid-Grundkarte (ausgeblendet, wenn leer) |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | leer | Mapbox-Token für die Ortssuche |
| `CATALOG_S3_BUCKET`, `CATALOG_S3_ENDPOINT_URL`, `CATALOG_S3_ACCESS_KEY_ID`, `CATALOG_S3_SECRET_ACCESS_KEY`, `CATALOG_S3_REGION` | leer | Der GOAT-Datenkatalog (schreibgeschützter Bucket mit den harmonisierten Datensätzen) |
| `GEOCODING_URL`, `GEOCODING_AUTHORIZATION` | leer | Geocoding-Dienst, den Analyse-Werkzeuge verwenden |
| `NEXT_PUBLIC_WEBSITE_URL` | leer | Eine Website, die GOATs Blog- und Changelog-Feeds veröffentlicht. Sie füllt die Neuigkeiten auf der Startseite und liefert das Willkommensvideo sowie den Link zum Datenschutz im Menü und im Hinweis des KI-Assistenten; solange leer, erscheint nichts davon. |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | leer | E-Mail-Adresse hinter *Problem melden* und dem Link *Feedback* des KI-Assistenten, solange [Support-Tickets](./external_services.md#support) aus sind, und in der Meldung, wenn der Support vorübergehend nicht erreichbar ist. Standard ist `support@plan4better.de`; tragen Sie für eine White-Label-Installation Ihre eigene Adresse ein. Eine ungültige Adresse wird ignoriert und der Standard verwendet. |
| `NEXT_PUBLIC_STATUS_FEED_URL` | leer | Status-Feed in der App |
| `NEXT_PUBLIC_DOCS_URL` | `https://goat.plan4better.de/docs` | Link zur Dokumentation in der App |
| `STATIC_ASSETS_URL` | *(auskommentiert)* | Ein Mirror oder CDN für die Produktgrafiken (Icons, Standard-Vorschaubilder, Bilder in E-Mails). Solange nicht gesetzt, liefert GOAT die Grafiken selbst unter `/assets` aus. |
| `ODOO_URL`, `ODOO_DB` | *(auskommentiert)* | Das Odoo von Plan4Better, gemeinsam für GOATs Odoo-Anbindungen. Nur mit einem Zugang, den Plan4Better ausstellt. |
| `ODOO_SUPPORT_API_KEY`, `ODOO_SUPPORT_TEAM_ID` | *(auskommentiert)* | Optionale Support-Tickets in einem Odoo-Helpdesk; nur eingeschaltet, wenn diese und `ODOO_URL`, `ODOO_DB` gesetzt sind. Der Schlüssel ist ein Geheimnis, das Plan4Better ausstellt. Siehe [Support-Tickets](./external_services.md#support). |
| `ODOO_SUPPORT_POST_ACTION` | `GOAT: post message as ticket participant` | Odoo-Serveraktion, die eine Nachricht als Teilnehmer des Tickets veröffentlicht |
| `OTEL_ENABLED` | `false` | Traces, Metriken und Logs über OpenTelemetry exportieren |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | leer | Ihr OpenTelemetry-Endpunkt (OTLP) |

Wenn Sie `OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST` für einen Dienst setzen, nehmen Sie `Authorization` nie auf: Sonst landen die Anmelde-Tokens von Benutzern und externen Agenten in Ihren Traces.

## E-Mail {#email}

Wie diese Einstellungen zusammenwirken, lesen Sie unter [E-Mail](./external_services.md#email).

| Einstellung | Vorgabe | Bedeutung |
|---|---|---|
| `SMTP_HOST` | leer | Mailserver; E-Mail ist ausgeschaltet, solange leer |
| `SMTP_PORT` | `587` | Port des Mailservers |
| `SMTP_SECURITY` | `starttls` | `starttls`, `ssl` oder `none` |
| `SMTP_USER`, `SMTP_PASSWORD` | leer | Anmeldedaten; lassen Sie beide leer für ein Relay ohne Anmeldung |
| `SMTP_FROM` | leer | Absenderadresse; `SMTP_USER`, wenn leer |
| `EMAILS_FROM_NAME` | `GOAT` | Absendername |
| `SMTP_STARTTLS`, `SMTP_SSL` | `true`, `false` | Aus `SMTP_SECURITY` abgeleitet; von setup.sh gesetzt |
| `EMAIL_BRAND_NAME`, `EMAIL_LOGO_URL`, `EMAIL_CONTACT_URL`, `EMAIL_PRIVACY_URL`, `EMAIL_COMPANY_NAME`, `EMAIL_COMPANY_URL` | *(auskommentiert)* | Optionales Branding der E-Mails von GOAT und Keycloak: Name, Logo statt des Namens, Links in der Fußzeile, wer Ihr GOAT betreibt. Siehe [E-Mail-Branding](./external_services.md#email-branding). |

## KI-Assistent {#assistant}

Wie diese Einstellungen zusammenwirken, steht unter [KI-Assistent](./external_services.md#assistant).

| Einstellung | Vorgabe | Bedeutung |
|---|---|---|
| `ASSISTANT_DEFAULT_PROVIDER` | `none` | Anbieter von „GOAT AI“, dem eingebauten Modell, das jede Organisation nutzen darf: `anthropic`, `bedrock`, `vertex`, `azure_openai`, `openai`, `mistral`, `openai_compatible` oder `none` (kein eingebautes Modell) |
| `ASSISTANT_DEFAULT_MODEL` | leer | Die Modell-ID des Anbieters; das Modell antwortet und schreibt auch die Titel der Unterhaltungen; Pflicht, außer bei `none` |
| `ASSISTANT_DEFAULT_BASE_URL` | leer | Pflicht für `openai_compatible` und `azure_openai` (der Azure-v1-Endpunkt, endet auf `/openai/v1`); ein optionales Gateway für `anthropic`, `openai` und `mistral` |
| `ASSISTANT_DEFAULT_API_KEY` | leer | Pflicht für `anthropic`, `openai`, `mistral` und `azure_openai`; optional für `openai_compatible`; für `bedrock` ein optionaler Bedrock-API-Schlüssel |
| `ASSISTANT_DEFAULT_REGION` | leer | AWS-Region (`bedrock`) oder Google-Cloud-Standort (`vertex`) |
| `ASSISTANT_ALLOW_ORG_CONNECTIONS` | `true` | Organisationen dürfen eigene Verbindungen anlegen |
| `ASSISTANT_ALLOWED_PROVIDERS` | alle sieben Typen | Anbietertypen, die Organisationen verwenden dürfen, durch Kommas getrennt |
| `ASSISTANT_ALLOW_PRIVATE_ENDPOINTS` | `false` | Erlaubt Verbindungen von Organisationen zu privaten und internen Adressen sowie unverschlüsseltes `http` |
| `ASSISTANT_SECRETS_KEY` | von setup.sh gesetzt | Verschlüsselt die Zugangsdaten, die Organisationen speichern. Bewahren Sie ihn mit Ihren Backups auf; siehe [Der Schlüssel des Assistenten](./operations.md#assistant-key). |
| `ASSISTANT_RUN_MAX_TOOL_CALLS`, `ASSISTANT_RUN_MAX_TOKENS`, `ASSISTANT_RUN_MAX_SECONDS` | *(auskommentiert)*: `40`, `200000`, `900` | Grenzen pro Antwort. Tokens, die aus dem Cache des Modellanbieters gelesen werden, werden für `ASSISTANT_RUN_MAX_TOKENS` nur zu einem Zehntel gezählt. Das Ergebnis eines abgeschlossenen Workflow-Laufs zu lesen, kann bis zu 7 Werkzeugaufrufe über `ASSISTANT_RUN_MAX_TOOL_CALLS` hinaus kosten. |
| `ASSISTANT_RUN_WAIT_MAX_SECONDS` | *(auskommentiert)*: `1800` | Wie lange eine Antwort insgesamt dauern darf, die auf einen Workflow-Lauf wartet; der Lauf selbst geht danach weiter. Wirkt nur mit einem Wert über `ASSISTANT_RUN_MAX_SECONDS` |
| `ASSISTANT_USER_MAX_CONCURRENT_RUNS` | *(auskommentiert)*: `3` | Antworten, die eine Person gleichzeitig laufen lassen kann |
| `ASSISTANT_TOOL_TIMEOUT_SECONDS` | *(auskommentiert)*: `30` | Sekunden pro Anfrage des Assistenten an die anderen Dienste |
| `ASSISTANT_DISABLED_SURFACES` | *(auskommentiert)* | Seiten, auf denen der Assistent aus ist, durch Kommas getrennt: `catalog`, `project.map`, `project.workflows`, `project.layouts`, `project.dashboard`, `none` (alle anderen Seiten) |
| `ASSISTANT_ENABLE_MCP` | *(auskommentiert)*: `true` | Der MCP-Endpunkt für externe Agenten unter `<GOAT_PUBLIC_URL>/assistant/mcp` |
| `ASSISTANT_MCP_AUDIT_RETENTION_DAYS` | *(auskommentiert)*: `30` | Tage, die die Aufzeichnungen von Werkzeugaufrufen über MCP aufbewahrt werden (mindestens 1) |
| `ASSISTANT_TOKEN_EXCHANGE_ENABLED`, `ASSISTANT_KEYCLOAK_CLIENT_ID`, `ASSISTANT_KEYCLOAK_CLIENT_SECRET` | *(auskommentiert)*: `false` | Keycloak Token Exchange für lange Antworten, statt die Anmeldung mit dem Client der Web-App zu erneuern. Erfordert Keycloak 26.2 oder neuer; das mitgelieferte Keycloak hat Version 22. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_BEARER_TOKEN_BEDROCK`, `GOOGLE_APPLICATION_CREDENTIALS`, `ANTHROPIC_VERTEX_PROJECT_ID`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `OPENAI_ADMIN_KEY`, `OPENAI_CUSTOM_HEADERS`, `ANTHROPIC_CUSTOM_HEADERS` | nicht gesetzt; in `assistant.env` | Die eigenen Einstellungen der Modell-SDKs. Sie gelten nur für GOAT AI, nie für eigene Verbindungen der Organisationen. |
| `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | siehe [Authentifizierung](#authentication) | Mit diesem Client der Web-App erneuert der Assistent die Anmeldung langer Antworten. Seine eigenen Namen, `ASSISTANT_WEB_CLIENT_ID` und `ASSISTANT_WEB_CLIENT_SECRET`, haben Vorrang; das Paket braucht keinen davon. |

## Backups {#backups}

Diese Einstellungen gelten, wenn das Profil `backup` eingeschaltet ist; siehe [Backups](./operations.md#backups).

| Einstellung | Vorgabe | Bedeutung |
|---|---|---|
| `BACKUP_TIME` | `02:30` | Uhrzeit des nächtlichen Backups (UTC) |
| `BACKUP_RETENTION_DAYS` | `7` | Backups, die älter als diese Anzahl Tage sind, werden gelöscht |

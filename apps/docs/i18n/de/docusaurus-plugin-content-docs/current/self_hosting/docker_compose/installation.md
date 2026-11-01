---
sidebar_position: 1
sidebar_label: Installation
description: "Installieren Sie GOAT mit dem Docker-Compose-Paket auf einem Linux-Server: Voraussetzungen, Download, setup.sh, erster Start, Prüfung mit smoke.sh, Anmeldung."
---

# Installation

Das Docker-Compose-Paket betreibt ein vollständiges GOAT auf **einem Linux-Server**: die Web-App und ihre APIs, den Anmeldeserver (Keycloak), den Objektspeicher (Garage), die Datenbank (PostgreSQL mit PostGIS), die Job-Engine (Windmill) und einen Proxy (Caddy), der sich um HTTPS kümmert. Eine Installation besteht aus drei Befehlen:

```bash
./setup.sh && docker compose up -d && ./smoke.sh
```

Diese Seite führt Sie Schritt für Schritt durch diese Befehle, von den Voraussetzungen bis zur ersten Anmeldung.

## Voraussetzungen {#requirements}

| | Minimum (Test) | Empfohlen |
|---|---|---|
| **CPU / RAM** | 4 vCPU / 8 GB | 8 vCPU / 16 GB |
| **Festplatte** | 50 GB | 200 GB oder mehr (wächst mit Ihren Daten) |
| **Betriebssystem** | Jedes Linux mit Docker Engine 24+ und Docker Compose 2.24+ | Ubuntu 24.04 LTS |

Außerdem benötigen Sie:

- **Offener Port 443**, dazu Port 80 für die Umleitung von `http://` auf HTTPS, oder der eine Port, den Sie für unverschlüsseltes HTTP wählen. Sonst muss nichts von außen erreichbar sein.
- **Einen DNS-Namen, der auf den Server zeigt**, wenn Sie automatisches HTTPS mit Let's Encrypt möchten.
- **Ausgehenden Internetzugang**, um die Images von `ghcr.io` zu laden, sowie für die Routing-Basisdaten, die Grundkarten und die optionalen Integrationen.
- **`openssl`** für `setup.sh` sowie **`curl` und `jq`** für `smoke.sh`.

Das Paket installiert und aktualisiert Docker nicht. Installieren Sie es nach der [Docker-Dokumentation](https://docs.docker.com/engine/install/), unter Ubuntu mit [Dockers apt-Paketquelle](https://docs.docker.com/engine/install/ubuntu/). Das `docker.io`-Paket der Distribution ist oft zu alt. `setup.sh` prüft die Versionen von Docker Engine und Compose, bevor es etwas schreibt, und `smoke.sh` prüft, ob `curl` und `jq` vorhanden sind; beide brechen mit einer Meldung ab, wenn etwas fehlt oder zu alt ist.

:::info
Die GOAT-Images sind öffentlich. Sie müssen sich bei keiner Registry anmelden.
:::

## 1. Paket herunterladen {#download}

Jedes GOAT-Release veröffentlicht das Paket als `goat-compose-<version>.tar.gz` auf seiner [GitHub-Release-Seite](https://github.com/plan4better/goat/releases). Das Paket ist an sein Release gebunden: Es installiert genau diese GOAT-Version.

```bash
curl -LO https://github.com/plan4better/goat/releases/download/<version>/goat-compose-<version>.tar.gz
tar xzf goat-compose-<version>.tar.gz
cd goat-compose
```

Ersetzen Sie `<version>` durch das Release-Tag, das Sie installieren möchten. Der Ordner enthält:

| Datei | Zweck |
|---|---|
| `compose.yaml` | Alle Dienste |
| `.env.example` | Alle Einstellungen mit Kommentaren. `setup.sh` erstellt daraus `.env`. |
| `setup.sh` | Schreibt und aktualisiert `.env` |
| `smoke.sh` | Prüft die laufende Installation von Anfang bis Ende |
| `base-data.sh` | Lädt die Routing- und ÖV-Basisdaten herunter |
| `restore.sh` | Stellt ein Backup wieder her |
| `certs/` | Ihr eigenes Zertifikat und Ihre CA-Dateien, falls Sie welche verwenden |
| `init/` | Konfiguration der mitgelieferten Dienste (Proxy, Datenbank, Anmeldung, Speicher, Jobs) |

Führen Sie alle Befehle auf dieser Seite in diesem Ordner aus.

## 2. Konfiguration erstellen {#setup}

`setup.sh` erstellt die Datei `.env`, die die gesamte Konfiguration enthält. Ohne Optionen aufgerufen, stellt das Skript vier Fragen:

```bash
./setup.sh
```

| Frage | Vorgabe |
|---|---|
| **Public URL**: die Adresse, die Benutzer in den Browser eingeben, etwa `https://goat.example.org` oder `http://10.0.0.5` | `http://localhost` |
| **TLS mode**: `auto`, `custom`, `internal` oder `off` (siehe [HTTPS und Adressen](./https.md)) | `off` bei einer `http://`-URL, sonst `auto` |
| **Email for Let's Encrypt notices** (nur im Modus `auto`, optional) | leer |
| **Email of the first GOAT administrator** | `admin@<Ihr Host>` |

Anschließend erzeugt `setup.sh` zufällige Passwörter und Schlüssel für alle Komponenten, speichert sie in `.env` (nur für Ihren Benutzer lesbar) und gibt die Zugangsdaten des ersten Administrators aus:

```text
Wrote .env for https://goat.example.org (TLS: auto).
First login: admin@example.org / <generated password>  (also stored in .env as GOAT_ADMIN_PASSWORD)
Next: docker compose up -d && ./smoke.sh
```

### Ohne Rückfragen {#non-interactive}

Für automatisierte Installationen übergeben Sie die Antworten als Optionen und ergänzen `--non-interactive`:

```bash
./setup.sh --public-url https://goat.example.org --tls auto \
  --acme-email ops@<ihre-domain> --admin-email admin@<ihre-domain> \
  --non-interactive
```

| Option | Bedeutung |
|---|---|
| `--public-url URL` | Die öffentliche URL, mit `http://` oder `https://`, ohne Pfad |
| `--tls auto\|custom\|internal\|off` | Der TLS-Modus |
| `--acme-email EMAIL` | Kontakt für Ablaufhinweise von Let's Encrypt (nur `auto`) |
| `--admin-email EMAIL` | E-Mail-Adresse des ersten Administrators |
| `--http-port PORT` | Port für unverschlüsseltes HTTP, wenn TLS an Ihrem eigenen Load Balancer endet (siehe [Hinter Ihrem eigenen Load Balancer](./https.md#load-balancer)) |
| `--non-interactive` | Nichts fragen; die Optionen und die Werte aus `.env` verwenden |
| `-h`, `--help` | Hilfe anzeigen |

`setup.sh` bricht mit einer klaren Meldung ab, wenn etwas nicht passt, zum Beispiel wenn:

- die URL weder mit `http://` noch mit `https://` beginnt oder einen Pfad enthält (sie muss ein reiner Origin wie `https://goat.example.org` sein);
- eine `http://`-URL mit einem anderen TLS-Modus als `off` kombiniert wird;
- der Modus `auto` mit einem Port in der URL kombiniert wird (Let's Encrypt benötigt die Standard-Ports);
- die E-Mail-Adresse für Let's Encrypt eine Domain verwendet, die Let's Encrypt ablehnt (siehe [Automatisches Zertifikat](./https.md#auto));
- Docker Compose älter als 2.24 ist.

### setup.sh erneut ausführen {#rerun}

Sie können `setup.sh` beliebig oft ausführen. Das Skript sichert die aktuelle Datei als `.env.bak.<Zeitstempel>`, behält alle Werte in `.env` bei, ergänzt Einstellungen, die in `.env.example` neu sind, und erzeugt Geheimnisse nur dort, wo sie leer sind. Neu geschrieben werden nur die Werte, die es aus der öffentlichen URL und dem TLS-Modus ableitet.

:::warning Bewahren Sie `.env` sicher auf
`.env` enthält alle Passwörter und Schlüssel Ihrer Installation. Legen Sie eine Kopie zu Ihren Backups: Eine wiederhergestellte Datenbank und ein wiederhergestellter Speicher erwarten genau diese Werte.
:::

## 3. GOAT starten {#start}

```bash
docker compose up -d
```

Der erste Start dauert einige Minuten: Docker lädt die Images, PostgreSQL legt die Datenbanken an, Keycloak erstellt den Anmelde-Realm mit dem ersten Administrator, und die Analyse-Werkzeuge werden in Windmill registriert.

Einige Dienste bereiten die Installation nur vor und beenden sich dann: `data-init`, `core-migrate`, `ducklake-init`, `garage-init`, `windmill-bootstrap` und `windmill-sync`. Sie laufen bei jedem `docker compose up -d`, lassen sich gefahrlos wiederholen und spielen nach einem Update die Datenbankmigrationen ein. `docker compose ps -a` zeigt sie nach erfolgreichem Lauf als `Exited (0)` an.

## 4. Installation prüfen {#smoke}

```bash
./smoke.sh
```

`smoke.sh` prüft die gesamte Installation Schritt für Schritt und gibt für jeden Schritt `PASS` oder `FAIL` aus:

1. Alle einmaligen Dienste wurden erfolgreich beendet, und alle dauerhaft laufenden Dienste sind gesund. Dienste, deren Health-Check direkt nach `docker compose up -d` noch nicht bestanden ist, bekommen bis zu fünf Minuten Zeit (`SMOKE_WAIT`, in Sekunden).
2. Web-App, Core API, GeoAPI, Processes, Catalog und der KI-Assistent antworten unter der öffentlichen URL, und die GeoAPI bildet ihre Links mit der öffentlichen URL. Der MCP-Endpunkt antwortet unter `/assistant/mcp`, und der Assistent kann jede Datenbanktabelle lesen, die er braucht.
3. Keycloak nennt die öffentliche URL als Aussteller (Issuer), und der erste Administrator kann sich anmelden.
4. Der Administrator gehört zu einer Organisation und hat ein Profil.
5. Eine kleine GeoJSON-Datei wird hochgeladen, als Layer importiert, als Vektorkachel ausgeliefert und in einer Puffer-Analyse verwendet.

`./smoke.sh --quick` führt nur die Schritte 1 bis 3 aus. Schlägt ein Schritt fehl, hält `smoke.sh` an, nennt den Schritt und gibt die letzten Log-Zeilen des betroffenen Dienstes aus.

:::info Was smoke.sh verändert
`smoke.sh` arbeitet mit dem Konto des ersten Administrators. Die Test-Datensätze, die es importiert, löscht es am Ende wieder, sodass in <code>Meine Inhalte</code> nichts zurückbleibt. Hat der Administrator noch keine Organisation, legt das Skript eine mit dem Namen **GOAT** an; um den Namen selbst zu wählen, melden Sie sich zuerst an (Schritt 5) und starten `smoke.sh` danach, oder benennen Sie sie später unter <code>Einstellungen</code> → <code>Organisation</code> → <code>Profil</code> um. `./smoke.sh --quick` prüft nur die Dienste und die Anmeldung und verändert nichts.
:::

## 5. Anmelden {#first-login}

Öffnen Sie die öffentliche URL im Browser und melden Sie sich mit der E-Mail-Adresse und dem Passwort an, die `setup.sh` ausgegeben hat. Das Passwort steht außerdem in `.env` als `GOAT_ADMIN_PASSWORD`.

Hat der Administrator noch keine Organisation (weil Sie sich vor dem Lauf von `smoke.sh` angemeldet haben), fordert GOAT Sie zuerst auf der Seite **Eine neue Organisation einrichten** auf, eine anzulegen. Die Seite hat drei Schritte, <code>Name & Region</code>, <code>Profil</code> und <code>Kontakt</code>; klicken Sie zum Abschluss auf <code>Fangen wir an</code>.

Wie Sie weitere Benutzer hinzufügen, lesen Sie unter [Benutzer und die Keycloak-Admin-Konsole](./operations.md#users).

## Wo die Dienste liegen {#urls}

Alle Dienste teilen sich die eine öffentliche URL und werden über den Pfad unterschieden:

| Pfad | Dienst |
|---|---|
| `/` | Web-App |
| `/api` | Core API (`/api/v2/…`, Health-Check unter `/api/healthz`) |
| `/geoapi` | GeoAPI |
| `/processes` | Processes |
| `/catalog` | Catalog (STAC API unter `/catalog/stac`) |
| `/assistant` | KI-Assistent (MCP-Endpunkt für externe Agenten unter `/assistant/mcp`) |
| `/keycloak` | Anmeldung (Keycloak); Admin-Konsole unter `/keycloak/admin` |

Mit dem mitgelieferten Objektspeicher führen `/goat-uploads` und `/goat-assets` zu Garage, für Uploads und öffentliche Bilder.

Nur Caddy ist von außen erreichbar. PostgreSQL, Redis, die Admin-Schnittstelle von Garage und die Oberfläche von Windmill sind nicht freigegeben; wie Sie Windmill erreichen, steht unter [Betrieb](./operations.md#windmill).

## Nächste Schritte {#next-steps}

- Laden Sie die [Routing-Basisdaten](./operations.md#base-data) für Ihre Region herunter, damit Einzugsgebiete, Heatmaps und die ÖV-Werkzeuge funktionieren.
- Richten Sie [E-Mail](./external_services.md#email) ein, damit GOAT Einladungen und Keycloak E-Mails zum Zurücksetzen des Passworts versenden kann.
- Schalten Sie [Backups](./operations.md#backups) ein.

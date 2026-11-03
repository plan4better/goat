---
sidebar_position: 5
sidebar_label: Betrieb
description: "Betreiben Sie GOAT mit Docker Compose im Alltag: Benutzer über Keycloak anlegen, Windmill erreichen, Routing-Basisdaten laden, Backups, Updates und Fehlersuche."
---

# Betrieb

Diese Seite beschreibt die alltäglichen Aufgaben beim Betrieb von GOAT mit Docker Compose: Benutzer verwalten, Routing-Basisdaten laden, Backups, Updates und Fehlersuche. Führen Sie alle Befehle im Ordner des Pakets aus.

## Benutzer und die Keycloak-Admin-Konsole {#users}

Benutzerkonten liegen in Keycloak; Organisationen, Teams und Rollen liegen in GOAT.

Die Keycloak-Admin-Konsole finden Sie unter `<GOAT-URL>/keycloak/admin`. Melden Sie sich mit dem Benutzer `admin` und dem Passwort `KEYCLOAK_ADMIN_PASSWORD` aus `.env` an. GOATs Benutzer liegen im Realm `goat` (`REALM_NAME`).

Um einen Benutzer hinzuzufügen, laden Sie ihn in GOAT ein: Öffnen Sie <code>Einstellungen</code> → <code>Organisation</code> → <code>Mitglieder</code>, klicken Sie auf <code>Neues Mitglied</code>, geben Sie die E-Mail-Adresse ein, wählen Sie die Rolle und klicken Sie auf <code>Einladung senden</code>.

Die Selbstregistrierung ist im mitgelieferten Realm ausgeschaltet, deshalb legt GOAT das Anmeldekonto für eine Adresse an, die noch keines hat:

- **Mit eingerichteter [E-Mail](./external_services.md#email)** erhält die eingeladene Person zwei E-Mails: die Einladung von GOAT und eine Nachricht von Keycloak mit einem Link zum Festlegen des Passworts. Danach meldet sie sich an, GOAT zeigt die Einladung, und mit <code>Akzeptieren</code> tritt sie der Organisation bei.
- **Ohne E-Mail** wird das Konto angelegt, aber niemand benachrichtigt. GOAT zeigt nach der Einladung einen Hinweis; vergeben Sie in der Keycloak-Admin-Konsole (Realm `goat`, *Users*) ein Passwort für den neuen Benutzer und geben Sie es weiter. Bei der ersten Anmeldung verlangt Keycloak ein eigenes Passwort.

Konten lassen sich auch direkt in der Admin-Konsole anlegen; die Einladung fügt die Person dann nur der Organisation hinzu. Mit Ihrem eigenen Keycloak legt GOAT die Konten dort ebenfalls an, sofern sein Service-Account Benutzer verwalten darf; mit `KEYCLOAK_PROVISION_INVITED_USERS=false` schalten Sie das ab.

### Wer Organisationen einrichtet {#organizations}

Ein Benutzer gehört zu genau einer Organisation. Wer sich ohne Organisation und ohne offene Einladung anmeldet, wird gebeten, eine einzurichten. Wer sich also anmeldet, bevor die Einladung verschickt wurde, landet in einer eigenen Organisation und kann danach nicht mehr eingeladen werden.

Um das zu verhindern, setzen Sie `ALLOW_ORGANIZATION_CREATION=false`. Dann können nur Konten mit der Keycloak-Realm-Rolle `superuser` Organisationen anlegen; alle anderen sehen die Seite <code>Warten auf eine Einladung</code>, bis eine Einladung eintrifft, die sich dann von selbst öffnet. Der mitgelieferte Realm gibt diese Rolle keinem Konto. Richten Sie Ihre Organisation deshalb ein, bevor Sie das Anlegen abschalten, oder legen Sie in der Admin-Konsole die Realm-Rolle `superuser` an und weisen Sie sie Ihrem Konto zu.

Hat jemand bereits versehentlich eine Organisation eingerichtet, kann ein Superuser sie mit `DELETE /api/v2/organizations/{organization_id}/permanent` endgültig löschen (`GET /api/v2/organizations` listet alle Organisationen mit ihren IDs). Das geht nur, solange die Organisation höchstens ein Mitglied hat und nichts enthält: keine Inhalte in ihrem Bereich oder im persönlichen Bereich des Mitglieds (Papierkorb eingeschlossen), keine Teams, keine offenen Einladungen, keine eigenen Domains und keine Analytics-Einstellungen. Andernfalls antwortet GOAT mit `409` und nennt, was noch vorhanden ist. Die Person behält ihr Konto und kann danach eingeladen werden. Eine Organisation, deren letztes Mitglied nicht mehr existiert, lässt sich auf dieselbe Weise löschen. <code>Organisation löschen</code> in den Organisationseinstellungen sperrt eine Organisation nur.

Die Abrechnung bleibt unberührt. Ist die Abrechnung über Stripe eingeschaltet, bleiben der Stripe-Kunde der Organisation und sein Abonnement in Stripe bestehen; die Antwort nennt den Kunden in `stripe_id`. Kündigen Sie diesen Kunden in Stripe. Bis dahin finden die Ereignisse, die Stripe für ihn schickt, keine Organisation mehr, und der bisherige Inhaber erhält keine E-Mail.

:::tip Admin-Konsole einschränken
Tragen Sie die Netze, die `/keycloak/admin` öffnen dürfen, in `GOAT_ADMIN_ALLOW_CIDRS` ein, zum Beispiel Ihr Büronetz. Anfragen von anderen Adressen erhalten `403`. Die Vorgabe erlaubt jede Adresse.

```bash
GOAT_ADMIN_ALLOW_CIDRS=192.168.10.0/24 10.20.0.0/16
```
:::

## Windmill, die Job-Engine {#windmill}

Windmill führt die Analyse-Werkzeuge, Datensatz-Importe, den PDF-Druck und geplante Aufgaben aus. Seine Oberfläche ist nicht freigegeben; sie lauscht nur auf `127.0.0.1` des Servers. Sie erreichen sie über einen SSH-Tunnel:

```bash
ssh -L 8110:127.0.0.1:8110 <server>
```

Öffnen Sie dann `http://localhost:8110` und melden Sie sich als `admin@windmill.dev` mit dem Passwort `WINDMILL_ADMIN_PASSWORD` aus `.env` an. Der Port wird mit `WINDMILL_LOCAL_PORT` eingestellt.

**Parallele Analysen:** `GOAT_TOOLS_WORKERS` (Vorgabe `2`) legt fest, wie viele Analyse-Jobs gleichzeitig laufen. Jeder Tools-Worker darf bis zu 4 GB Arbeitsspeicher nutzen; wählen Sie den Wert passend zu Ihrem Server.

**Arbeitsspeicher je Dienst:** `compose.yaml` gibt jedem Dienst ein Speicherlimit. geoapi und processes setzen dort außerdem die Speicherbudgets von DuckDB (`GEOAPI_DUCKLAKE_POOL_SIZE`, `GEOAPI_DUCKDB_MEMORY_LIMIT`, `PROCESSES_DUCKDB_MEMORY_LIMIT`), sodass sie unter dieses Limit passen: DuckDB lagert Arbeit erst auf die Festplatte aus, wenn es sein eigenes Budget erreicht, und ein Dienst über seinem Limit wird beendet. Um einem Dienst mehr Speicher zu geben, erhöhen Sie Limit und Budgets gemeinsam in einer `compose.override.yaml`.

## Routing-Basisdaten {#base-data}

Einzugsgebiete, Heatmaps und die ÖV-Werkzeuge benötigen ein **Straßennetz** und **ÖV-Daten**. Diese werden nicht automatisch heruntergeladen: Der vollständige Satz umfasst mehrere zehn GB, deshalb wählen Sie die Region, in der Sie arbeiten, mit einem Begrenzungsrechteck (`min_lon,min_lat,max_lon,max_lat`).

```bash
# Anzeigen, was geladen würde und wie viel
./base-data.sh --dry-run --bbox 11.3,48.0,11.8,48.3

# Herunterladen
./base-data.sh --bbox 11.3,48.0,11.8,48.3

# Herunterladen und diesen Download jede Woche wiederholen
./base-data.sh --bbox 11.3,48.0,11.8,48.3 --weekly on
```

Der Download läuft als Job im laufenden GOAT-Stack; `base-data.sh` verfolgt ihn und gibt sein Log aus, bis er beendet ist.

| Option | Bedeutung |
|---|---|
| `--bbox min_lon,min_lat,max_lon,max_lat` | Nur das Gebiet um dieses Rechteck laden. Das Straßennetz ist in regionale Kacheln aufgeteilt; GOAT lädt die Kacheln, die das Rechteck abdecken, und einen Ring benachbarter Kacheln. Der ÖV-Fahrplan wird immer vollständig geladen. |
| `--datasets a,b` | Die zu ladenden Datensätze, durch Kommas getrennt. Vorgabe: `street_network,public_transport`. Außerdem verfügbar: `traveltime_matrices` (nur für die älteren Heatmaps), `nuts` und `geoip`. |
| `--dry-run` | Anzeigen, was geladen würde, ohne etwas zu schreiben |
| `--weekly on\|off` | Diesen Lauf (mit derselben Region und denselben Datensätzen) zusätzlich jede Woche wiederholen, dienstags um 03:00 UTC, oder die Wiederholung beenden |

Die Daten stammen von `GOAT_BASE_DATA_URL`, standardmäßig vom öffentlichen Basisdaten-Server von Plan4Better. Hat Ihr Server keinen Zugriff darauf, richten Sie die Einstellung auf einen internen Mirror.

## Backups {#backups}

### Nächtliche Backups einschalten {#backup-setup}

Fügen Sie `backup` zu `COMPOSE_PROFILES` in `.env` hinzu, zum Beispiel `COMPOSE_PROFILES=garage,keycloak,backup`, und führen Sie `docker compose up -d` aus.

Jede Nacht um `BACKUP_TIME` (UTC, Vorgabe `02:30`) schreibt der Backup-Dienst nach `./backups/<Zeitstempel>`:

- einen Dump jeder Datenbank: `goat`, `keycloak` und `windmill`;
- ein Archiv von GOATs Daten-Volume (Layer-Daten, Kacheln, Basisdaten);
- mit dem mitgelieferten Garage ein Archiv des Objektspeichers.

Backups, die älter als `BACKUP_RETENTION_DAYS` (Vorgabe `7`) Tage sind, werden gelöscht.

So erstellen Sie sofort ein Backup:

```bash
docker compose run --rm backup --now
```

:::warning Kopieren Sie Backups vom Server weg
Backups in `./backups` liegen auf derselben Festplatte wie GOAT. Kopieren Sie den Ordner mit Ihren üblichen Werkzeugen an einen anderen Ort, zum Beispiel mit `rclone` oder `restic`. Legen Sie eine Kopie von `.env` dazu: Die wiederhergestellten Datenbanken und der Speicher erwarten die Passwörter und Schlüssel, die darin stehen.
:::

Wenn Sie Ihren eigenen S3-Speicher verwenden, sind die Dateien darin nicht Teil dieser Backups; sichern Sie sie mit den Mitteln Ihres Speicheranbieters.

### Backup wiederherstellen {#restore}

```bash
./restore.sh backups/<Zeitstempel>
```

`restore.sh` fordert Sie auf, zur Bestätigung `restore` einzugeben. Danach stoppt es GOAT, ersetzt **alle aktuellen Daten** durch das Backup (Datenbanken und Volumes) und startet GOAT wieder. Prüfen Sie das Ergebnis mit `./smoke.sh --quick`.

Das funktioniert auch auf einem neuen Server: Installieren Sie das Paket derselben Version, legen Sie die `.env` aus Ihrem Backup in seinen Ordner und führen Sie `restore.sh` mit dem Pfad zum Backup-Ordner aus.

Der vollständige Ablauf aus Backup, vollständigem Löschen und Wiederherstellen wurde getestet.

## Der Schlüssel des Assistenten {#assistant-key}

`ASSISTANT_SECRETS_KEY` in `.env` verschlüsselt die Zugangsdaten der Modelle, die Organisationen speichern. Sichern Sie ihn zusammen mit `.env`: Eine wiederhergestellte Datenbank ohne ihn kann diese Verbindungen nicht nutzen, und die Organisationen müssen ihre Schlüssel neu eingeben.

Um den Schlüssel zu ersetzen, stellen Sie einen neuen vor den alten, durch ein Komma getrennt, verschlüsseln neu und entfernen dann den alten:

```bash
new=$(openssl rand -base64 32 | tr '+/' '-_')
sed -i "s|^ASSISTANT_SECRETS_KEY=|ASSISTANT_SECRETS_KEY=$new,|" .env
docker compose up -d assistant
docker compose exec assistant python -m assistant.llm.vault rotate
# danach .env so ändern, dass ASSISTANT_SECRETS_KEY nur den neuen Schlüssel enthält, und:
docker compose up -d assistant
```

Der Assistent speichert seine Unterhaltungen im Schema `assistant` der GOAT-Datenbank, das reguläre Backup erfasst sie also. Eine ältere GOAT-Version zu starten lässt das Schema bestehen; erst ein Downgrade der Datenbank unter die Migrationen des Assistenten (`alembic downgrade`) entfernt es mit den Unterhaltungen und den Nutzungsdaten.

## Updates {#upgrade}

1. Erstellen Sie ein Backup: `docker compose run --rm backup --now` (siehe [Backups](#backups)).
2. Laden Sie `goat-compose-<version>.tar.gz` des neuen Releases herunter und entpacken Sie es über Ihre Installation. Ihre `.env`, `certs/` und `backups/` sind nicht im Archiv enthalten und bleiben unverändert.
3. Führen Sie aus:

   ```bash
   tar xzf goat-compose-<version>.tar.gz --strip-components=1
   ./setup.sh             # stellt GOAT_VERSION auf das neue Release um, ergänzt neue Einstellungen, behält den Rest
   docker compose pull
   docker compose up -d   # Datenbankmigrationen laufen automatisch
   ./smoke.sh --quick
   ```

## Logs {#logs}

```bash
docker compose logs -f <dienst>    # z. B. core, web, geoapi, processes, assistant, keycloak, caddy
docker compose logs --tail 100 windmill-worker-tools
```

Die Logs aller Dienste werden automatisch rotiert.

## Fehlersuche {#troubleshooting}

**Beginnen Sie mit `./smoke.sh`.** Das Skript nennt den fehlgeschlagenen Schritt und gibt die Logs des betroffenen Dienstes aus.

**Prüfen Sie die Container** mit `docker compose ps -a`:

- Jeder einmalige Dienst (die Namen, die auf `-init`, `-migrate`, `-bootstrap` und `-sync` enden) sollte `Exited (0)` zeigen.
- Jeder andere Dienst sollte `healthy` oder `running` zeigen.

Ein einmaliger Dienst mit einem anderen Exit-Code zeigt den Grund in seinen Logs, z. B. `docker compose logs core-migrate`.

**Let's Encrypt schlägt fehl** (Modus `auto`): Prüfen Sie, ob Port 443 den Server aus dem Internet erreicht und der DNS-Name auf ihn auflöst. Sehen Sie sich dann `docker compose logs caddy` an. Siehe auch [Automatisches Zertifikat](./https.md#auto).

**Einzugsgebiete, Heatmaps oder ÖV-Analysen schlagen fehl:** Wahrscheinlich fehlen die [Routing-Basisdaten](#base-data) für das Gebiet.

**E-Mails kommen nicht an:** Prüfen Sie die [E-Mail-Einstellungen](./external_services.md#email) und das Log des letzten Versuchs: `docker compose logs core` für GOATs E-Mails, `docker compose logs keycloak` für Passwort-E-Mails. Ein Zertifikatsfehler dort (`CERTIFICATE_VERIFY_FAILED`, `PKIX path building failed`) bedeutet, dass das Zertifikat des Relays von einer CA stammt, der GOAT noch nicht vertraut; siehe [Firmen-CA](./https.md#company-ca).

**Der Assistent erscheint nicht:** Es ist noch kein Modell eingerichtet (siehe [KI-Assistent](./external_services.md#assistant)), oder der Dienst ist nicht bereit: `docker compose ps assistant` sollte `healthy` zeigen, und `docker compose logs assistant` nennt eine fehlende oder ungültige Einstellung.

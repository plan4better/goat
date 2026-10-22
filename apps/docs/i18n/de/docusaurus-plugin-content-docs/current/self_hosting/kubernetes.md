---
sidebar_position: 3
sidebar_label: Kubernetes (Helm)
description: "Installieren Sie GOAT mit dem Helm-Chart und legen Sie fest, was es offenlässt: öffentliche URLs, S3-Speicher, Anmeldung, Analyse-Worker und RWX-Speicher."
---

# Kubernetes (Helm)

Für Kubernetes-Cluster gibt es ein Helm-Chart für GOAT, veröffentlicht unter `oci://ghcr.io/plan4better/charts/goat`. Diese Seite fasst zusammen, was das Chart enthält und was Sie bereitstellen müssen. Die [README des Charts](https://github.com/plan4better/goat/tree/main/deploy/helm/goat) ist die vollständige Referenz aller Values.

:::tip Ein Server? Nutzen Sie Docker Compose
Für einen einzelnen Server ist das [Docker-Compose-Paket](./docker_compose/installation.md) der empfohlene Weg. Es enthält den Anmeldeserver, den Objektspeicher und HTTPS, die das Helm-Chart Ihnen überlässt.
:::

Diese Seite beschreibt die Chart-Version **0.8.0**, die standardmäßig GOAT **v3.0.9** installiert.

## Installation {#install}

```bash
helm install goat oci://ghcr.io/plan4better/charts/goat \
  --version 0.8.0 \
  --namespace goat --create-namespace \
  --values your-values.yaml \
  --wait --timeout 25m
```

Eine erste Installation lädt mehrere große Images, daher der lange Timeout. Ein frischer Cluster benötigt nur diesen einen Befehl.

## Was das Chart enthält {#included}

| Komponente | Vorgabe |
|---|---|
| core, web, geoapi, processes, catalog | an |
| Windmill-Server und der Standard-Worker | an |
| Windmill-Worker `tools`, `workflows` und `print` | **aus** |
| PostgreSQL über CloudNativePG (Operator und Cluster) | an, optionales Sub-Chart |
| Redis | an, optional |
| Ein gemeinsames Daten-Volume (`data`, 200 Gi, `ReadWriteOnce`) | an |
| Caddy für eigene Domains | aus |

Das Chart enthält **nicht**:

- **Objektspeicher.** GOAT benötigt einen S3-kompatiblen Speicher: Ihren eigenen oder das Garage, das das Chart für Sie betreiben kann.
- **Keycloak.** Wenn sich Benutzer anmelden sollen, benötigen Sie ein externes Keycloak.

Statt der mitgelieferten Instanzen können Sie das Chart auch auf ein bestehendes PostgreSQL oder Redis richten; die README des Charts listet das SQL auf, das Ihr PostgreSQL benötigt. Ist `postgresql.external.host` ein Connection-Pooler im Transaktionsmodus, setzen Sie `postgresql.external.transactionPooler: true` (`POSTGRES_TRANSACTION_POOLER`), damit GOAT keine Anweisungen auf dem Server vorbereitet und keine Einstellungen sendet, die der Pooler ablehnen könnte, und setzen Sie `postgresql.external.ducklakeHost` auf die Datenbank selbst: DuckLake hält seine Katalogverbindungen offen, deshalb umgehen sie den Pooler. Lauscht der Pooler an einem anderen Port als die Datenbank (PgBouncer standardmäßig an 6432), setzen Sie zusätzlich `postgresql.external.ducklakePort` auf den Port der Datenbank.

Jeder Dienst hat standardmäßig Speicher-Requests und -Limits sowie einen CPU-Request ohne Limit. Die README des Charts listet sie auf; braucht ein Dienst mehr, etwa geoapi bei einem großen Katalog, erhöhen Sie sie unter `<service>.resources` und setzen Sie Requests und Limits gemeinsam.

## Was Sie einstellen müssen {#required-values}

### Öffentliche URLs {#public-urls}

Der Browser ruft core, geoapi, processes und catalog direkt auf, deshalb benötigt die Web-App deren öffentliche Adressen. Geben Sie jedem Dienst ein Ingress mit Host (`<service>.ingress.*`), dann werden die URLs daraus abgeleitet, oder setzen Sie sie ausdrücklich in `web.publicUrls.api`, `.geoapi`, `.processes` und `.catalog`.

:::warning
Ohne diese URLs zeigt die Web-App eine leere Seite.
:::

### Objektspeicher {#storage}

Beschreiben Sie Ihren S3-Speicher einmal in `global.s3`: den Bucket für Uploads, Anbieter, Endpunkt, Region, ob der Speicher Pfad-URLs (path style) braucht, und ein Secret mit dem Zugangsschlüssel-Paar (`global.s3.existingSecret`). core, geoapi, processes und die Analyse-Worker (siehe unten) erhalten alle diese Einstellungen.

Hochgeladene Bilder, etwa Vorschaubilder von Projekten und Datensätzen, Profilbilder und Bilder in Dashboards, liegen in einem zweiten Bucket desselben Speichers (`global.s3.assets.bucket`). Browser laden sie direkt aus diesem Bucket; machen Sie ihn deshalb öffentlich lesbar und tragen Sie seine öffentliche URL in `global.s3.assets.publicUrl` ein. Außerhalb von AWS ist die URL Pflicht. GOATs eigene Grafiken liefert die Web-App selbst aus; sie brauchen beides nicht.

Erlaubt Ihr Speicher keinen öffentlich lesbaren Bucket, setzen Sie stattdessen `global.s3.assets.servedByCore: true` (`ASSETS_SERVED_BY_CORE`). GOAT legt die Bilder dann im Upload-Bucket unter `assets/` ab, und core liefert sie über seine API aus; Sie brauchen dann weder einen Assets-Bucket noch eine öffentliche URL. Core muss dafür GOAT v3.0.9 oder neuer ausführen, also neuer als die Vorgabe des Charts: Setzen Sie `core.image.tag`. Die Bildlinks zeigen auf die API von core unter dem Host der Web-App; hat core einen eigenen Host, setzen Sie `global.s3.assets.publicUrl` auf `<öffentliche URL von core>/api/v2/asset/file`.

Ohne eigenen Speicher setzen Sie `garage.enabled: true`: Das Chart betreibt dann ein Garage mit einem Knoten, wie das Docker-Compose-Paket, legt beide Buckets und ein Schlüsselpaar an und füllt `global.s3` dafür aus. Browser erreichen es über den Host der Web-App, Uploads unter `/<bucket>` und Bilder unter `/<assets bucket>`; `garage.ingress.enabled: true` richtet beide Routen für ingress-nginx ein. Mit einem anderen Ingress-Controller richten Sie sie selbst ein (siehe README des Charts). Es ist ein einzelner Knoten ohne Replikation: Sichern Sie sein Datenvolume.

### Anmeldung {#auth}

Die Anmeldung ist standardmäßig **aus** (`global.auth.enabled: false`): Alle Dienste handeln dann als ein Standardbenutzer, stellen Sie eine solche Installation also hinter Ihre eigene Zugriffskontrolle. Um die Anmeldung einzuschalten, setzen Sie `global.auth.enabled: true` und `global.auth.existingSecret` auf ein Secret mit den Schlüsseln `server-url`, `realm`, `client-id`, `client-secret` und `nextauth-secret`. Ein Secret versorgt alle fünf Dienste.

Verwenden andere Anwendungen denselben Realm, bestehen deren Tokens ebenfalls die Signaturprüfung von GOAT. Setzen Sie `global.auth.allowedClients` auf die Clients, deren Tokens GOAT annimmt, zum Beispiel `[goat-web]`; core, geoapi, processes und catalog beantworten dann ein Token jedes anderen Clients mit `401`. Die Liste muss den Client von GOAT selbst enthalten (`client-id` im Secret): Die Web-App meldet Benutzer mit ihm an, und der Druck-Worker und die Dienste reichen diese Tokens weiter. Ohne ihn startet core nicht. Die Liste prüft, welcher Client ein Token ausgestellt hat, nicht, wer der Benutzer ist: Dürfen nur bestimmte Benutzer GOAT verwenden, setzen Sie das am Client von GOAT für jeden Ablauf durch, den er erlaubt, oder schalten Sie seine *Direct access grants* aus. Siehe [Ein Realm, den sich GOAT mit anderen Anwendungen teilt](./docker_compose/external_services.md#keycloak-shared-realm).

### E-Mail und Einladungen {#email}

- **`email`** legt den SMTP-Server fest, über den core Einladungen verschickt, mit dem Passwort aus einem Secret (`email.existingSecret`). Die Links in diesen E-Mails entstehen aus den öffentlichen URLs von Web-App und API.
- **Keycloak** verschickt seine eigenen E-Mails, etwa zum Zurücksetzen des Passworts, mit den SMTP-Einstellungen seines Realms. Tragen Sie dort denselben Server ein.
- **`global.auth.provisionInvitedUsers: true`** lässt eine Einladung das Keycloak-Konto anlegen, und Keycloak schickt einen Link zum Setzen des Passworts. Nutzen Sie es, wenn Ihr Realm keine Selbstregistrierung erlaubt. Der Keycloak-Client von core braucht dann die realm-management-Rollen `view-users` und `manage-users`.
- **`global.auth.allowOrganizationCreation: false`** lässt nur Konten mit der Keycloak-Realm-Rolle `superuser` Organisationen anlegen; alle anderen sehen <code>Warten auf eine Einladung</code>, bis sie eingeladen werden. So richtet niemand, der sich vor seiner Einladung anmeldet, eine eigene Organisation ein, nach der er nicht mehr eingeladen werden könnte. Richten Sie Ihre Organisation ein oder geben Sie einem Konto diese Rolle, bevor Sie es abschalten. Ein Superuser kann eine Organisation mit höchstens einem Mitglied und ohne Inhalt mit `DELETE /api/v2/organizations/{organization_id}/permanent` endgültig löschen, damit ihr Mitglied eingeladen werden kann; ist die Abrechnung über Stripe eingeschaltet, kündigen Sie den Stripe-Kunden aus `stripe_id` in der Antwort in Stripe.
- **`global.caBundle`** nennt eine ConfigMap oder ein Secret mit dem Zertifikat einer eigenen CA, für ein SMTP-Relay, ein Keycloak oder Seiten, die der Druck-Worker öffnet, deren Zertifikat von einer privaten CA stammt. Das Chart bindet es in core, die Web-App und die Worker `print`, `tools` und `workflows` ein.

### Support-Tickets {#support}

Optional und **standardmäßig aus**. Support-Tickets reichen Problemmeldungen Ihrer Benutzer an einen Odoo-Helpdesk weiter. Der Block `odoo` enthält die Verbindung (`odoo.url`, `odoo.db`), `odoo.support` das Helpdesk-Team (`odoo.support.teamId`) und den API-Schlüssel aus einem Secret (`odoo.support.existingSecret`). Die Tickets sind nur eingeschaltet, wenn all das gesetzt ist. Den Schlüssel stellt Plan4Better für sein eigenes Odoo aus; lassen Sie den Block auf Ihrer eigenen Installation leer, es sei denn, Sie haben einen erhalten.

Ohne Tickets öffnet *Problem melden* eine E-Mail an die Adresse in `web.supportEmail`; sie steht auch in der Meldung, wenn der Support vorübergehend nicht erreichbar ist. Standard ist `support@plan4better.de`; tragen Sie für eine White-Label-Installation Ihre eigene Adresse ein.

Nachrichten zu einem Ticket können Anhänge von bis zu 55 MiB in einer Anfrage enthalten. Das Ingress vor core muss für `/api/v2/support` Anfragekörper von mindestens 56 MB annehmen und großzügige Lese-Timeouts erlauben. ingress-nginx begrenzt Anfragekörper standardmäßig auf 1 MB; erhöhen Sie das mit `nginx.ingress.kubernetes.io/proxy-body-size: "56m"` und `proxy-read-timeout` in `core.ingress.annotations`.

### OpenStreetMap und Overture Maps {#open-data-mirror}

Optional. Die Bereiche OpenStreetMap und Overture Maps unter *Layer hinzufügen › Dienst verbinden* lesen aus einem Spiegel beider Datensätze, den eine eigene Pipeline im Katalog-Bucket unter `mirror/osm` und `mirror/overture` ablegt; er gehört nicht zum Chart. Das Chart gibt `catalog.s3` an processes und die Worker `tools`, `workflows` und `print` weiter, mehr ist nicht einzustellen. Ohne `catalog.s3.bucket` finden die beiden Bereiche keine Daten; siehe [OpenStreetMap und Overture Maps](./docker_compose/external_services.md#open-data-mirror).

### Analyse-Worker {#workers}

Der Standard-Worker von Windmill übernimmt nur kleine Jobs. **Analyse-Werkzeuge, Datensatz-Importe und Workflows benötigen die Worker `tools` und `workflows`, der PDF-Druck benötigt den Worker `print`.** Alle drei sind standardmäßig aus. So nutzen Sie sie:

- Schalten Sie sie mit `windmill.workers.tools.enabled`, `windmill.workers.workflows.enabled` und `windmill.workers.print.enabled` ein.
- Die Worker `tools` und `workflows` sind an Nodes mit dem Label `node.kubernetes.io/server-usage: geodata` und der Toleration `geodata=true:NoSchedule` gebunden. Bereiten Sie solche Nodes vor oder überschreiben Sie `nodeSelector` und `tolerations` für diese Worker. Andernfalls bleiben ihre Pods im Zustand `Pending`, und `helm install --wait` läuft in den Timeout.
- Das Chart gibt diesen Workern, was GOATs Jobs brauchen: die GOAT-Datenbank, den S3-Speicher, den Katalog-Bucket (mit dem Spiegel von OpenStreetMap und Overture), die Adresse der Web-App für den Druck und, bei eingeschalteter Anmeldung, den Keycloak-Client, mit dem sich der Druck-Worker anmeldet. Windmill reicht nur die Variablen an die Jobs weiter, die in `WHITELIST_ENVS` stehen; das Chart stellt diese Liste zusammen, einschließlich jeder Variable, die Sie in `config` oder `extraEnv` eines Workers ergänzen.
- Schalten Sie `windmill.scriptSync.enabled` ein, um GOATs Analyse-Werkzeuge und Aufgaben nach der Installation in Windmill zu registrieren. Die Einstellung ist standardmäßig aus.
- Jeder Windmill-Container hält höchstens wenige Verbindungen zu seiner Datenbank: der Server 10 und jeder Worker 3 (`windmill.server.config.DATABASE_CONNECTIONS`, `windmill.workers.databaseConnections`). Ein Update auf ein GOAT-Release mit neuerem Windmill migriert die Windmill-Datenbank beim Start, und zwar nur vorwärts: Sichern Sie sie vorher.

### Speicher für mehrere Nodes {#rwx}

Das gemeinsame Daten-Volume verwendet standardmäßig `ReadWriteOnce`, was auf einem einzelnen Node funktioniert. In einem Cluster mit mehreren Nodes setzen Sie `data.accessMode: ReadWriteMany` mit einer RWX-fähigen Storage-Class (`data.storageClassName`) oder stellen mit `data.existingClaim` Ihren eigenen Claim bereit.

geoapi, processes und die Windmill-Worker schreiben alle in dieses Volume, und ein neues RWX-Volume gehört root, deshalb laufen sie als root. Erlaubt Ihr Cluster das nicht, finden Sie die Alternative in der README des Charts („The shared data volume“).

## Weiterführende Informationen {#further-reading}

Die [README des Charts](https://github.com/plan4better/goat/tree/main/deploy/helm/goat) behandelt die Details: die Installation auf einem frischen Cluster, die Einrichtung eines externen PostgreSQL, die Rangfolge der Authentifizierungseinstellungen, das gemeinsame Daten-Volume, die Region, in der neue Projekte öffnen (`DEFAULT_PROJECT_VIEW_STATE`), Schema-Migrationen und die Upgrade-Hinweise zwischen den Chart-Versionen.

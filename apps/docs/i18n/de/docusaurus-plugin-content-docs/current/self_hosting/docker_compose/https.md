---
sidebar_position: 2
sidebar_label: HTTPS und Adressen
description: "Wählen Sie die öffentliche URL und einen der vier TLS-Modi (auto, custom, internal, off) und betreiben Sie GOAT hinter eigenem Load Balancer oder mit Firmen-CA."
---

# HTTPS und Adressen

GOAT ist unter **einer öffentlichen URL** erreichbar, und Caddy, der Proxy vor allen Diensten, bestimmt, wie HTTPS funktioniert. Die URL und den TLS-Modus wählen Sie mit `setup.sh`, interaktiv oder mit Optionen:

```bash
./setup.sh --public-url <url> --tls <modus>
docker compose up -d
```

Die öffentliche URL muss ein reiner Origin ohne Pfad sein, zum Beispiel `https://goat.example.org`, `http://10.0.0.5` oder `http://10.0.0.5:8080`. Alle Dienste liegen darunter (siehe [Wo die Dienste liegen](./installation.md#urls)).

## Die vier TLS-Modi {#modes}

| Modus | Verwenden Sie ihn, wenn | Was passiert |
|---|---|---|
| `auto` | der Server einen öffentlichen DNS-Namen hat | Caddy holt ein Zertifikat von Let's Encrypt und erneuert es |
| `custom` | Sie ein eigenes Zertifikat haben | Caddy verwendet `cert.pem` und `key.pem` aus `./certs` |
| `internal` | Sie im Intranet testen | Caddy stellt ein Zertifikat aus seiner eigenen CA aus; Browser warnen, bis diese CA vertrauenswürdig ist |
| `off` | Sie lokal über unverschlüsseltes HTTP arbeiten oder Ihr eigener Load Balancer TLS übernimmt | Kein TLS in Caddy |

Alle vier Modi wurden getestet, auch `off` hinter einem Load Balancer.

## Automatisches Zertifikat (`auto`) {#auto}

```bash
./setup.sh --public-url https://goat.example.org --tls auto --acme-email ops@<ihre-domain>
```

Voraussetzungen:

- Der DNS-Name löst auf den Server auf.
- Port **443** erreicht den Server aus dem Internet: Let's Encrypt prüft die Domain darüber. Öffnen Sie auch Port **80**, wenn `http://`-Adressen auf HTTPS umleiten sollen; Caddy kann die Domain dann auch über Port 80 prüfen lassen.
- Die URL enthält keinen Port.

Caddy holt das Zertifikat dann beim ersten Start, erneuert es selbstständig und leitet HTTP auf HTTPS um.

Die E-Mail-Adresse für Let's Encrypt (`--acme-email`, gespeichert als `GOAT_ACME_EMAIL`) ist optional; Let's Encrypt verschickt daran Ablaufhinweise. Let's Encrypt lehnt Kontakte auf Domains außerhalb des öffentlichen DNS ab, und Ihre Seite bekäme dann kein Zertifikat. `setup.sh` weist deshalb Adressen zurück, die auf `.test`, `.local`, `.localhost`, `.invalid` oder `.example` enden, sowie Adressen bei `example.com`, `example.org`, `example.net` oder `localhost`. Verwenden Sie eine echte Adresse oder lassen Sie das Feld leer.

:::tip Kein Zertifikat ausgestellt?
Prüfen Sie, ob Port 443 den Server aus dem Internet erreicht und der DNS-Name auf ihn auflöst, und sehen Sie sich dann `docker compose logs caddy` an.
:::

## Eigenes Zertifikat (`custom`) {#custom}

Legen Sie zwei PEM-Dateien in den Ordner `certs` des Pakets:

| Datei | Inhalt |
|---|---|
| `certs/cert.pem` | Das Zertifikat mit vollständiger Kette (zuerst Ihr Zertifikat, dann die Zwischenzertifikate) |
| `certs/key.pem` | Der private Schlüssel |

```bash
./setup.sh --public-url https://goat.example.org --tls custom
docker compose up -d
```

`setup.sh` erinnert Sie, wenn die Dateien fehlen. In diesem Modus darf die URL einen anderen Port als 443 enthalten, etwa `https://goat.example.org:8443`; Caddy stellt HTTPS dann auf diesem Port bereit.

## Caddys eigene CA (`internal`) {#internal}

Für Testinstallationen im Intranet kann Caddy ein Zertifikat aus seiner eigenen Zertifizierungsstelle ausstellen. Browser zeigen eine Warnung, bis Sie dem Stammzertifikat dieser CA vertrauen. Kopieren Sie es aus dem Proxy-Container:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .
```

Importieren Sie `root.crt` anschließend in den Zertifikatsspeicher Ihres Betriebssystems oder Browsers.

`setup.sh` setzt `GOAT_CA_BUNDLE` auf dieses Stammzertifikat, damit auch GOATs eigene Dienste, etwa der Webserver und der PDF-Druck-Worker, der Adresse vertrauen. `smoke.sh` überspringt in diesem Modus die Zertifikatsprüfung.

## Unverschlüsseltes HTTP (`off`) {#off}

Für lokale Installationen ohne TLS:

```bash
./setup.sh --public-url http://10.0.0.5 --tls off
```

Enthält die URL einen Port, etwa `http://10.0.0.5:8080`, lauscht Caddy auf diesem Port statt auf Port 80. Bei einer `http://`-URL akzeptiert der Anmeldeserver Anmeldungen über unverschlüsseltes HTTP von jeder Adresse.

:::warning
Ohne TLS werden Passwörter und Daten unverschlüsselt übertragen. Verwenden Sie unverschlüsseltes HTTP nur in Netzen, denen Sie vertrauen.
:::

## Hinter Ihrem eigenen Load Balancer {#load-balancer}

Wenn ein eigener Load Balancer oder Reverse Proxy TLS beendet, behalten Sie die `https://`-URL bei und schalten TLS in Caddy aus. Wählen Sie den Port, auf dem Caddy unverschlüsseltes HTTP vom Load Balancer annehmen soll:

```bash
./setup.sh --public-url https://goat.example.org --tls off --http-port 8080
docker compose up -d
```

Danach:

1. Richten Sie Ihren Load Balancer auf Port `8080` des Servers.
2. Tragen Sie die Adressen des Load Balancers in `.env` unter `GOAT_TRUSTED_PROXIES` ein, als CIDRs durch Leerzeichen getrennt. Caddy wertet die `X-Forwarded-*`-Header nur von diesen Adressen aus. Die Vorgabe `private_ranges` umfasst die Netze nach RFC 1918.
3. Stellen Sie sicher, dass der Server selbst die öffentliche URL über den Load Balancer erreicht: GOATs Container rufen sie auf, zum Beispiel bei der Anmeldung und beim PDF-Druck.

In diesem Modus veröffentlicht Caddy Port 443 auf dem Server nicht, sodass der Port für andere Software frei bleibt.

## Firmen-CA {#company-ca}

Stammen Zertifikate in Ihrem Netz von einer privaten Zertifizierungsstelle, etwa das Zertifikat Ihres Load Balancers, Ihres eigenen Keycloak oder Ihres SMTP-Relays, muss GOAT dieser CA vertrauen. Legen Sie das CA-Zertifikat (PEM) in `./certs` und tragen Sie seinen Pfad innerhalb der Container in `.env` ein:

```bash
GOAT_CA_BUNDLE=/certs/company-ca.pem
```

Übernehmen Sie die Änderung mit `docker compose up -d`. GOATs Webserver, die Job-Worker einschließlich des PDF-Druck-Workers, der KI-Assistent (für Modellserver, GOATs Dienste und Keycloak) und die Absender von E-Mails (GOAT und das mitgelieferte Keycloak) vertrauen der CA dann zusätzlich zu den öffentlichen. `GOAT_CA_BUNDLE` nimmt eine Datei auf, die mehrere Zertifikate enthalten darf. Im Modus `internal` verwendet `setup.sh` die Einstellung für Caddys Stammzertifikat; um zusätzlich einer Firmen-CA zu vertrauen, legen Sie beide Zertifikate in eine Datei in `./certs`.

## HSTS und Sicherheits-Header {#hsts}

In den Modi `auto`, `custom` und `internal` sendet Caddy den Header `Strict-Transport-Security: max-age=31536000`. Browser, die GOAT besucht haben, bestehen dann ein Jahr lang auf HTTPS für diesen Hostnamen. Denken Sie daran, bevor Sie einen Hostnamen von HTTPS zurück auf unverschlüsseltes HTTP umstellen.

Im Modus `off` sendet Caddy keinen HSTS-Header. Hinter Ihrem eigenen Load Balancer setzen Sie HSTS dort, wenn Sie es wünschen.

In jedem Modus sendet Caddy außerdem `X-Content-Type-Options: nosniff` und `Referrer-Policy: same-origin` und entfernt den `Server`-Header.

## Adresse später ändern {#change-url}

Führen Sie `setup.sh` mit der neuen URL oder dem neuen Modus erneut aus, danach `docker compose up -d`. `setup.sh` schreibt alle Werte neu, die es aus der URL und dem TLS-Modus ableitet.

:::info
Das mitgelieferte Keycloak übernimmt die neue URL selbst: Bei jedem `docker compose up -d` setzt der Schritt `keycloak-sync` die Adressen des GOAT-Clients (Root-URL, Redirect-URIs, Web-Origins) und die HTTPS-Anforderung aus `.env`. Mit Ihrem eigenen Keycloak passen Sie den Client dort an.
:::

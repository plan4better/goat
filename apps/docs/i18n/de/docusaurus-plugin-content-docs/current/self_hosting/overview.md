---
sidebar_position: 1
sidebar_label: Übersicht
description: "Aus welchen Diensten GOAT besteht, von Web-App und APIs bis Keycloak, Garage und Windmill, und wie sich Docker Compose und Kubernetes mit Helm unterscheiden."
---

# Self-Hosting

GOAT ist Open Source, und Sie können es auf Ihrer eigenen Infrastruktur betreiben. Dieser Abschnitt beschreibt zwei Wege dafür: **Docker Compose auf einem einzelnen Server** und **Kubernetes mit Helm**.

:::info Unterstützung beim Selbst-Hosting
Fragen und Fehlermeldungen sind in den [GitHub-Issues](https://github.com/plan4better/goat/issues) willkommen und werden beantwortet, sobald es die Zeit erlaubt. Soll GOAT auf Ihrer eigenen Infrastruktur laufen, ohne dass Ihr Team es betreibt, bietet Plan4Better den **On-Premise-Betrieb** an: Wir richten GOAT auf Ihren Servern ein, halten es aktuell und betreuen den Betrieb; auf Wunsch binden wir es an Ihre Systeme an oder schulen Ihr Team. [Kontakt aufnehmen](https://plan4better.de/de/contact/). Muss es nicht auf Ihrer Infrastruktur laufen, nutzen Sie die gehostete Version unter [goat.plan4better.de](https://goat.plan4better.de).
:::

## Woraus GOAT besteht {#components}

GOAT ist nicht ein einzelnes Programm, sondern eine Reihe von Diensten, die zusammenarbeiten. Beide Installationswege verwenden dieselben GOAT-Images, die öffentlich unter `ghcr.io/plan4better/goat` bereitstehen.

| Komponente | Aufgabe |
|---|---|
| **Web-App** | Die Benutzeroberfläche, die Sie im Browser öffnen. |
| **Core API** | Benutzer, Organisationen, Teams, Projekte, Ordner und die Metadaten Ihrer Datensätze. |
| **GeoAPI** | Liefert die Daten Ihrer Layer als OGC API Features und als Vektorkacheln aus. |
| **Processes** | Startet Analysen, Importe und andere Jobs (OGC API Processes) und meldet ihren Status. |
| **Catalog** | Der GOAT-Datenkatalog als STAC API. |
| **Assistant** | Der KI-Assistent: Unterhaltungen, Antworten eines Sprachmodells mit den Daten in GOAT und der MCP-Endpunkt für externe Agenten. Aus, bis ein Modell eingerichtet ist. |
| **Keycloak** | Anmeldung und Benutzerkonten. |
| **PostgreSQL mit PostGIS** | Die Datenbanken von GOAT, Keycloak und Windmill. |
| **Garage** | S3-kompatibler Objektspeicher für hochgeladene Dateien und Bilder. |
| **Windmill** | Die Job-Engine. Ihre Worker führen die Analyse-Werkzeuge, Datensatz-Importe, den PDF-Druck und geplante Aufgaben aus. |
| **Redis** | Ein Cache für die GeoAPI und die Live-Zustellung der Antworten des Assistenten. |
| **Caddy** | Der Reverse Proxy vor allen Diensten. Er ist der einzige Zugangspunkt und kümmert sich um HTTPS. |

## Welcher Weg? {#which-option}

|   | Docker Compose | Kubernetes (Helm) |
|---|---|---|
| **Läuft auf** | Einem Linux-Server | Einem Kubernetes-Cluster, den Sie bereits betreiben |
| **Enthalten** | Alles aus der Tabelle oben, einschließlich Keycloak, Garage und HTTPS | Die GOAT-Dienste und Windmill; PostgreSQL (über CloudNativePG) und Redis, beide optional |
| **Sie stellen bereit** | Einen Server und einen DNS-Namen, wenn Sie automatisches HTTPS möchten | S3-Objektspeicher, Keycloak (wenn sich Benutzer anmelden sollen), Ingress und TLS, Speicher |
| **Einrichtung** | `setup.sh` schreibt die Konfiguration, `smoke.sh` prüft die Installation | Eine Values-Datei |

:::tip Empfehlung
Für einen einzelnen Server ist das **Docker-Compose-Paket der empfohlene Weg**. Es enthält alle Komponenten, erzeugt alle Passwörter und Schlüssel für Sie und bringt Skripte für Prüfungen, Backups und Wiederherstellungen mit. Nutzen Sie das Helm-Chart, wenn Sie bereits Kubernetes betreiben und einen S3-Speicher sowie ein Keycloak zur Verfügung haben.
:::

## Nächste Schritte {#next-steps}

- [Installation](./docker_compose/installation.md): Voraussetzungen, Download, erster Start und erste Anmeldung mit Docker Compose.
- [HTTPS und Adressen](./docker_compose/https.md): die vier TLS-Modi, ein eigenes Zertifikat, der Betrieb hinter einem Load Balancer.
- [Externe Dienste](./docker_compose/external_services.md): eigener S3-Speicher oder eigenes Keycloak, E-Mail und optionale Integrationen.
- [Konfigurationsreferenz](./docker_compose/configuration.md): alle Einstellungen in `.env`.
- [Betrieb](./docker_compose/operations.md): Benutzer, Routing-Basisdaten, Backups, Updates und Fehlersuche.
- [Kubernetes (Helm)](./kubernetes.md): was das Helm-Chart enthält und was Sie einstellen müssen.

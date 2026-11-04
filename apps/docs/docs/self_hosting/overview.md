---
sidebar_position: 1
sidebar_label: Overview
description: "The services GOAT consists of, from web app and APIs to Keycloak, Garage and Windmill, and how Docker Compose and Kubernetes with Helm deployments compare."
---

# Self-hosting

GOAT is open source, and you can run it on your own infrastructure. This section explains two ways to do that: **Docker Compose on a single server**, and **Kubernetes with Helm**.

:::info Help with self-hosting
Questions and bug reports are welcome in [GitHub issues](https://github.com/plan4better/goat/issues), answered as time allows. If GOAT should run on your own infrastructure without your team operating it, Plan4Better offers **managed on-premise deployment**: we set GOAT up on your servers, keep it up to date and look after its operation, and we help with connecting it to your systems or training your team. [Get in touch](https://plan4better.de/en/contact/). If it doesn't have to run on your infrastructure, use the hosted version at [goat.plan4better.de](https://goat.plan4better.de).
:::

## What GOAT consists of {#components}

GOAT is not one program but a set of services that work together. Both deployment options run the same GOAT images, which are published publicly at `ghcr.io/plan4better/goat`.

| Component | What it does |
|---|---|
| **Web app** | The user interface you open in the browser. |
| **Core API** | Users, organizations, teams, projects, folders and the metadata of your datasets. |
| **GeoAPI** | Serves the data of your layers as OGC API Features and vector tiles. |
| **Processes** | Starts analyses, imports and other jobs (OGC API Processes) and reports their status. |
| **Catalog** | The GOAT data catalog, served as a STAC API. |
| **Assistant** | The AI assistant: conversations, answers from a language model with GOAT's data, and the MCP endpoint for external agents. Off until a model is configured. |
| **Keycloak** | Login and user accounts. |
| **PostgreSQL with PostGIS** | The databases of GOAT, Keycloak and Windmill. |
| **Garage** | S3-compatible object storage for uploaded files and images. |
| **Windmill** | The job engine. Its workers run the analysis tools, dataset imports, PDF printing and scheduled tasks. |
| **Redis** | A cache for the GeoAPI, and the live delivery of the assistant's answers. |
| **Caddy** | The reverse proxy in front of everything. It is the only entry point and takes care of HTTPS. |

## Which option? {#which-option}

|   | Docker Compose | Kubernetes (Helm) |
|---|---|---|
| **Runs on** | One Linux server | A Kubernetes cluster you already operate |
| **Included** | Everything in the table above, including Keycloak, Garage and HTTPS | The GOAT services and Windmill; PostgreSQL (through CloudNativePG) and Redis, both optional |
| **You provide** | A server, and a DNS name if you want automatic HTTPS | S3 object storage, Keycloak (if users should log in), Ingress and TLS, storage |
| **Setup** | `setup.sh` writes the configuration, `smoke.sh` checks the installation | A values file |

:::tip Recommendation
For a single server, the **Docker Compose bundle is the recommended path**. It contains every component, generates all passwords and keys for you, and ships with scripts for checks, backups and restores. Use the Helm chart if you already run Kubernetes and have S3 storage and a Keycloak available.
:::

## Next steps {#next-steps}

- [Installation](./docker_compose/installation.md): requirements, download, first start and first login with Docker Compose.
- [HTTPS and addresses](./docker_compose/https.md): the four TLS modes, your own certificate, running behind a load balancer.
- [External services](./docker_compose/external_services.md): your own S3 or Keycloak, email, and optional integrations.
- [Configuration reference](./docker_compose/configuration.md): every setting in `.env`.
- [Operations](./docker_compose/operations.md): users, routing base data, backups, upgrades and troubleshooting.
- [Kubernetes (Helm)](./kubernetes.md): what the Helm chart includes and what you have to set.

---
description: "Durchsuchen Sie Projekt-, Workflow- und Layout-Vorlagen auf der Startseite, filtern Sie nach Art und Quelle, erstellen Sie daraus ein neues Projekt und legen Sie fest, ob eine Vorlage ihre Datensätze mitliefert oder jedem Nutzer eine eigene Kopie gibt."
sidebar_position: 4
---

# Mit einer Vorlage starten

Mit Vorlagen **beginnen Sie mit etwas bereits Eingerichtetem** statt mit einer leeren Arbeitsfläche. GOAT bietet drei Arten:

- **Projektvorlagen**: öffnen ein vorbereitetes Projekt mit gestalteten Layern, fertigen Analysen und einem Dashboard. Ein guter Ausgangspunkt, wenn Sie ein vollständiges Beispiel erkunden oder anpassen möchten.
- **Workflow-Vorlagen**: ein fertiger Analyse-Workflow, dem nur Ihre eigenen Daten fehlen. Sie geben die Eingabe-Layer an und führen ihn aus.
- **Layout-Vorlagen**: druckfertige Seitenlayouts, wobei die Seitengröße in Millimetern angegeben ist.

Diese Seite behandelt vor allem **Projektvorlagen**. Für die anderen beiden siehe [Einen Workflow als Vorlage speichern](../workflows/workflow_interface#3-wie-man-die-workflow-benutzeroberfläche-verwendet) und die Layouts-Seite.

## Vorlagen durchsuchen

Auf der **Startseite** zeigt die Reihe `Mit einer Vorlage starten` die verfügbaren Vorlagen. Sie können:

- **Nach Art filtern**: `Alle Vorlagen`, `Projekt`, `Workflow` oder `Layout`.
- **Nach Quelle filtern**: woher die Vorlage stammt (`Alle`, `GOAT`, `Meine`, `Team`, `Organisation` oder `Mit mir geteilt`). Eine Vorlage, die mit Ihrem Team oder Ihrer Organisation geteilt wurde, direkt oder über einen Ordner, steht unter `Team` oder `Organisation`.
- Über `Alle Vorlagen` die vollständige Vorlagenübersicht öffnen, in der Sie Vorlagen **durchsuchen** und eine vor der Verwendung in der **Vorschau** ansehen können.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/getting_started/start_from_template_de.webp').default} alt="Vorlagen-Reihe auf der Startseite" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "cover"}}/>
</div>

Vorlagen von GOAT finden Sie außerdem im Tab `Vorlagen` des [Katalogs](../workspace/catalog).

## Eine Projektvorlage verwenden

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Suchen Sie auf der <code>Startseite</code> in der Reihe <code>Mit einer Vorlage starten</code> eine Projektvorlage, oder öffnen Sie <code>Alle Vorlagen</code> und filtern Sie nach <code>Projekt</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Wählen Sie eine Vorlage, um in der <strong>Vorschau</strong> zu sehen, was sie enthält.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Klicken Sie auf <code>Vorlage verwenden</code>. GOAT erstellt aus der Vorlage ein neues Projekt mit den bereits vorhandenen Layern, Analysen und dem Dashboard und öffnet es.</div>
</div>

:::info
Eine Projektvorlage wird als **neues Projekt** geöffnet, das Ihnen gehört. Sie können es frei ändern, ohne die Vorlage zu beeinflussen.
:::

## Datensätze in einer Vorlage

Wenn Sie ein Projekt als Vorlage speichern (`Projekt als Vorlage speichern…` im **Projektmenü**) oder einen Workflow als Vorlage speichern, listet die Tabelle `Eingaben` alle Datensätze auf, die darin verwendet werden. Für jeden legen Sie fest, wie ihn die Personen erhalten, die die Vorlage verwenden:

- `Mitliefern (nur lesen)`: Alle sehen **Ihren Datensatz** in ihrem Projekt. Sie können ihn ansehen und analysieren, aber nicht ändern, es sei denn, Sie teilen ihn zusätzlich als Editor mit ihnen. Das ist die Voreinstellung.
- `Kopie für jeden Nutzer (mit Inhalt)`: Alle, die die Vorlage verwenden, erhalten **eine eigene Kopie** des Datensatzes mit allen Features, Spalten, Stil, Auswahlfeldern und Beschreibung. Ihre Kopie können sie frei bearbeiten.
- `Leere Kopie für jeden Nutzer`: wie eine Kopie, aber **ohne Features**: dieselben Spalten, derselbe Geometrietyp und derselbe Stil, bereit für eigene Eingaben, zum Beispiel geplante Vorhaben in einer Schulung.

Ein Raster-Datensatz oder ein Datensatz aus einem externen Dienst hat keine Features, die kopiert werden könnten; er kann daher nur mitgeliefert werden. In einer Workflow-Vorlage können Sie einen Datensatz außerdem ausschalten, sodass die Vorlage beim Verwenden nach einem Layer fragt.

Wenn jemand die Vorlage verwendet, erstellt GOAT zuerst das Projekt oder den Workflow mit Ihrem Datensatz und legt die Kopien anschließend im Hintergrund an; Sie können sie unter [Job Status](../workspace/workspace_interface.md#user-controls) verfolgen. Bis eine Kopie fertig ist, wird der Datensatz schreibgeschützt angezeigt. Danach ersetzt sie Ihren Datensatz überall in diesem Projekt: auf der Karte, im Dashboard und in Workflows.

:::info
Eine Kopie entsteht aus Ihrem Datensatz **in dem Stand, in dem er beim Verwenden der Vorlage ist**. Spätere Änderungen an Ihrem Datensatz erreichen bereits vorhandene Kopien nicht, und Änderungen anderer an ihrer Kopie erreichen Ihren Datensatz nie. Alle, die die Vorlage verwenden dürfen, können die mitgelieferten oder mit Inhalt kopierten Datensätze lesen, egal wie die Vorlage mit ihnen geteilt wurde, auch über einen geteilten Ordner. Ein Datensatz, der mit Ihnen nur zum Ansehen geteilt wurde, wird auf diesem Weg nicht weitergegeben. Eine leere Kopie übernimmt nur Spalten, Geometrietyp und Stil. Ihr Datensatz selbst bleibt daher privat: Er wird nicht mitgeteilt und nie öffentlich.
:::


---
description: "Legen Sie fest, in welchem Zoombereich von 0 bis 24 ein Layer auf der Karte erscheint, schränken Sie ihn je Teil, Klasse oder Regel ein und sehen Sie den Zoom der Karte auf der Skala, mit Empfehlungen je nach Datenart."
sidebar_position: 1
---

# Zoom-Sichtbarkeit

**Die Zoom-Sichtbarkeit legt fest, in welchem Zoombereich ein Layer auf Ihrer Karte erscheint.** So zeigen Sie bei jeder Zoomstufe die relevantesten Daten und halten die Karte schnell und lesbar. Innerhalb des Bereichs des Layers kann jeder Teil des Symbols, jede Klasse und jede Regel bei weniger Zoomstufen erscheinen.

## Zoomstufen verstehen

GOAT verwendet Zoomstufen von **0 (Weltansicht) bis 24 (Straßenebenen-Detail)**:

| Zoomstufe  | Typischer Anwendungsfall         |
| ---------- | -------------------------------- |
| **0-8**    | Globaler bis regionaler Kontext  |
| **9-14**   | Stadt- bis Nachbarschaftsanalyse |
| **15-24**  | Straßenebenen-Details            |

:::info Standardeinstellungen
Ein neuer Layer ist bei allen Zoomstufen sichtbar (<code>Alle Zoomstufen</code>), sofern nicht anders eingestellt.
:::

## Wie man den Zoombereich eines Layers einstellt

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie im <code>Layer</code>-Panel auf Ihren Layer. Rechts öffnet sich das Einstellungs-Panel des Layers; der Tab <code>Stil</code> ist ausgewählt.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie im Abschnitt <code>Layer</code> auf <code>Sichtbar</code>. Die Zeile zeigt den aktuellen Bereich, zum Beispiel <code>Alle Zoomstufen</code>, <code>Ab Zoom 8</code> oder <code>Zoom 8 bis 14</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Ziehen Sie unter <code>Zoomstufen</code> <strong>die beiden Griffe der Skala</strong>, um festzulegen, wo der Layer erscheint und wo nicht mehr. Der Bereich steht neben der Skala, zum Beispiel <code>8 bis 14</code>. Ein Griff am Ende der Skala (0 oder 24) bedeutet: auf dieser Seite keine Grenze.</div>
</div>

Das Dreieck unter der Skala markiert den aktuellen Zoom der Karte, mit seiner Zahl. Klicken Sie unter die Skala, um die Karte auf diese Stufe zu zoomen, oder ziehen Sie das Dreieck, um sie stufenlos zu zoomen: So prüfen Sie sofort, wie der Layer an den Rändern seines Bereichs aussieht. Auch der Untertitel des Editors nennt den Zoom der Karte, zum Beispiel <code>Karte bei Zoom 12.5</code>.

## Zoombereiche von Teilen, Klassen und Regeln

Der Zoombereich eines Layers gilt für alles, was er zeichnet. Innerhalb davon können Sie den Bereich weiter einschränken:

- **Ein Teil des Symbols**: Jeder Editor eines Teils (etwa <code>Füllung</code>, <code>Umriss</code> oder <code>Beschriftung</code>) endet mit einer eigenen Skala <code>Sichtbar</code>. Zeigen Sie zum Beispiel die Beschriftungen erst ab Zoom 13, während die Polygone bei allen Zoomstufen erscheinen. Die Zeile <code>Sichtbar</code> im Abschnitt <code>Layer</code> nennt die Teile mit einem eigenen Bereich, etwa <code>Beschriftung: Ab Zoom 13</code>.
- **Eine Klasse**: Während Sie [eine Klasse gestalten](./style/attribute_based_styling.md#style-one-class), zeigt der Abschnitt die eigene Skala <code>Sichtbar</code> der Klasse.
- **Eine Regel**: Die <code>Zoomstufen</code> einer Regel zeigen die passenden Objekte bei weniger Zoomstufen, siehe [Regeln](./style/attribute_based_styling.md#rules).

Die Skalen von Teilen und Klassen schattieren den Bereich des Layers. Diese Bereiche können den des Layers nur einschränken: Eine Klasse, die ab Zoom 5 erscheinen soll, erscheint bei einem Layer ab Zoom 8 erst ab Zoom 8.

## Bewährte Praktiken

<b>Detaillierte Features</b> (Gebäude, [POIs](https://www.plan4better.de/de/glossar/point-of-interest)): Verwenden Sie höhere Zoomstufen (14-24), um Durcheinander zu vermeiden.

<b>Regionale Daten</b> (Demografie, Grenzen): Verwenden Sie mittlere Stufen (8-16) für Kontext.

<b>Hintergrund-Layer</b> (Straßen, Wasser): Verwenden Sie den vollen Bereich für konsistente Referenz.

<b>Zusammenfassende Daten</b> (Heatmaps, Aggregiert): Verwenden Sie niedrigere Stufen (bis 14) für Überblick.

<b>Beschriftungen</b>: Zeigen Sie sie ab einer höheren Zoomstufe als die Objekte selbst, damit sie erscheinen, sobald Platz für sie ist.

:::tip Profi-Tipp
Testen Sie Ihre Einstellungen, indem Sie hinein- und herauszoomen, um zu sehen, wie Layer bei verschiedenen Maßstäben erscheinen.
:::

:::info Verwandte Funktionen
Erkunden Sie weitere Optionen für das [Layer-Styling](../../category/style) und kombinieren Sie sie mit [Filtern](../filter) für eine erweiterte Datendarstellung.
:::

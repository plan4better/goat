---
description: "Fassen Sie Polygonattribute auf Polygonen oder einem H3-Gitter zusammen, etwa als Anzahl, Summe oder Mittelwert, optional nach Verschneidungsfläche gewichtet."
sidebar_position: 3
---


import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';


# Polygone aggregieren

Das Werkzeug "Polygone aggregieren" **führt statistische Analysen von Polygonen durch, z.B. Anzahl, Summe, Minimum oder Maximum, und aggregiert die Informationen auf Polygonen.**

## 1. Erklärung

Das Werkzeug "Polygone aggregieren" kann verwendet werden, um **die Eigenschaften von Polygonen innerhalb eines bestimmten Gebiets zu analysieren**. Es aggregiert die Informationen der Polygone und ermöglicht die Berechnung der Polygonanzahl, die Summe von Polygonattributen oder die Ableitung z.B. des Maximalwerts eines bestimmten Polygonattributs innerhalb eines Aggregationsbereichs.

Im folgenden Beispiel werden die Polygone des *zu aggregierenden Layers* auf Hexagonen zusammengefasst: Das Ergebnis behält die Geometrie der *Aggregierungspolygone* und erhält die Statistiken, die aus den sie schneidenden Polygonen berechnet werden.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/toolbox/geoanalysis/aggregate_polygons/polygon_aggregation.webp').default} alt="Polygon-Aggregation" style={{ maxHeight: "auto", maxWidth: "40%", objectFit: "cover"}}/>
</div> 


## 2. Beispiel-Anwendungsfälle

- Visualisierung der Anzahl Parks pro Stadtbezirk.
- Berechnung der durchschnittlichen Gebäudegröße in einem Gebiet.
- Aggregation von Bevölkerungszahlen auf einem Hexagonal-Gitter und Berechnung von Bevölkerungsdichten.

## 3. Wie wird das Werkzeug verwendet?

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Werkzeuge</code> <img src={require('/img/icons/toolbox.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie im Menü <code>Geoanalyse</code> auf <code>Polygone aggregieren</code>.</div>
</div>

### Zu aggregierender Layer

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie Ihren <code>Eingabe-Polygon-Layer</code>, der die Polygone enthält, die Sie aggregieren möchten.</div>
</div>

### Aggregierungspolygone

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie den <code>Flächentyp</code>, auf dem Sie die Polygone aggregieren möchten. Sie können zwischen <b>Polygon</b> oder <b>H3 Grid</b> wählen.</div>
</div>

<Tabs>
  <TabItem value="Polygon" label="Polygon" default className="tabItemBox">

Wählen Sie den <code>Flächen-Layer</code>, der die Polygone enthält, auf denen Sie Ihre Polygondaten aggregieren möchten. Jedes Polygon des Eingabe-Layers wird in jeder Fläche berücksichtigt, die es schneidet.


  </TabItem>
  <TabItem value="H3 Grid" label="H3 Grid" className="tabItemBox">

Wählen Sie die <code>H3-Auflösung</code>. Sie können Auflösungen zwischen <b>3</b> (durchschnittliche Kantenlänge von 69km) und <b>10</b> (durchschnittliche Kantenlänge von 70m) wählen. Höhere Werte erzeugen kleinere Hexagone. Jedes Polygon des Eingabe-Layers wird dem Hexagon zugeordnet, in dem sein Schwerpunkt liegt.

:::tip HINWEIS

Um mehr über das H3-Gitter zu erfahren, können Sie das [Glossar](https://www.plan4better.de/de/glossar/h3-gitter) besuchen.

:::

  </TabItem>
</Tabs>

### Statistik

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Wählen Sie unter <code>Statistik-Konfiguration</code> die <code>Operation</code>. Wählen Sie für alle Operationen außer <b>Count</b> zusätzlich unter <code>Field</code> das Feld des Polygon-Layers, für das die Statistik berechnet wird. Es können nur numerische Felder ausgewählt werden.</div>
</div>

Die folgenden **Operationen** stehen zur Verfügung:

| Operation          | Feld     | Beschreibung                                                   |
| ------------------ | -------- | -------------------------------------------------------------- |
| Count              | –        | Zählt die Polygone in jeder Fläche                             |
| Sum                | `number` | Berechnet die Summe der Werte des ausgewählten Felds           |
| Min                | `number` | Liefert den Mindestwert des ausgewählten Felds                 |
| Max                | `number` | Liefert den Höchstwert des ausgewählten Felds                  |
| Mean               | `number` | Berechnet den Durchschnittswert (Mittelwert) des ausgewählten Felds |
| Standard Deviation | `number` | Berechnet die Standardabweichung des ausgewählten Felds        |

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Geben Sie optional unter <code>Result Name</code> einen Namen für die Ergebnisspalte ein. Wenn Sie das Feld leer lassen, heißt die Spalte bei Count <code>count</code> und sonst <code>&lt;Operation&gt;_&lt;Feld&gt;</code> (z.B. <code>sum_population</code>).</div>
</div>

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Um im selben Durchlauf weitere Statistiken zu berechnen, klicken Sie auf <code>Hinzufügen Statistik-Konfiguration</code> und wiederholen Sie die Schritte 5 und 6. Sie können bis zu 30 Statistiken hinzufügen; um eine zu entfernen, klicken Sie auf das Papierkorb-Symbol darüber.</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Falls gewünscht, aktivieren Sie <code>Nach Schnittfläche gewichten</code>. Dadurch werden die <b>Werte nach dem Anteil jedes Eingabe-Polygons gewichtet, der innerhalb der Aggregierungsfläche liegt</b>. Die Gewichtung gilt für <b>Sum</b> und <b>Mean</b> beim Flächentyp <b>Polygon</b>; Count, Min, Max, Standard Deviation sowie der Flächentyp H3 Grid werden nicht gewichtet.</div>
</div>

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Klicken Sie optional auf das Optionen-Symbol <img src={require('/img/icons/options.png').default} alt="Optionen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> in der Kopfzeile von <code>Statistik</code> und wählen Sie bis zu drei <code>Gruppenfelder</code> des Polygon-Layers. Die Statistiken werden dann zusätzlich je Gruppe (je Kombination der Werte dieser Felder) berechnet.</div>
</div>

### Ergebnisse

<div class="step">
  <div class="step-number">10</div>
  <div class="content">Ändern Sie optional das Feld <code>Name des Ergebnis-Layers</code> (Standard: <b>Polygone aggregieren</b>).</div>
</div>

<div class="step">
  <div class="step-number">11</div>
  <div class="content">Klicken Sie auf <code>Ausführen</code>.</div>
</div>

Sobald der Berechnungsprozess abgeschlossen ist, wird der resultierende Polygon-Layer zur Karte hinzugefügt. Er enthält <b>je Statistik eine zusätzliche Spalte</b> und wird nach der ersten Statistik eingefärbt. Sie können die Werte sehen, indem Sie auf ein Polygon auf der Karte klicken.

- Beim Flächentyp **Polygon** enthält das Ergebnis alle Polygone des Flächen-Layers mit ihren Attributen. Flächen ohne schneidende Polygone erhalten für **Anzahl** und **Summe** den Wert 0 und für **Mittelwert**, **Minimum**, **Maximum** und **Standardabweichung** keinen Wert. Eine Fläche mit nur einem schneidenden Polygon erhält für **Standardabweichung** keinen Wert, eine Fläche, deren Polygone im ausgewählten Feld alle keinen Wert haben, für **Mittelwert**, **Minimum**, **Maximum** und **Standardabweichung**.
- Beim Flächentyp **H3 Grid** enthält das Ergebnis die Hexagone, in denen der Schwerpunkt mindestens eines Polygons liegt. Die Spalte <code>h3_&lt;Auflösung&gt;</code> (z.B. <code>h3_8</code>) enthält die ID des Hexagons.
- Wenn Sie <code>Gruppenfelder</code> gewählt haben, enthält eine zusätzliche Spalte <code>&lt;Ergebnisspalte&gt;_grouped</code> den Wert jeder Gruppe.

<img src={require('/img/toolbox/geoanalysis/aggregate_polygons/aggregate_polygons_result.webp').default} alt="Polygon-Aggregation Ergebnis in GOAT" style={{ maxHeight: "auto", maxWidth: "auto"}}/>

:::tip Tipp
Möchten Sie Ihren Ergebnis-Layer stylen und schön aussehende Karten erstellen? Siehe [Styling](../../map/layer_style/style/styling).
:::
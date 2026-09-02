---
sidebar_position: 1
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Einzugsgebiet

<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="https://www.youtube.com/embed/GA_6PbhAA6k?si=4mA2OdTPGCl7iVRi&amp;start=46" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

Einzugsgebiet zeigt **wie weit Menschen innerhalb einer bestimmten Reisezeit oder Entfernung, mit einem oder mehreren Verkehrsmitteln reisen können** — mit erweiterten Ausgabeformen, anpassbaren Schrittgrößen und zusätzlichen Einstellungen für den öffentlichen Verkehr.

## 1. Erklärung

Basierend auf festgelegten Startpunkten, maximaler Reisezeit oder Entfernung und Verkehrsmitteln **visualisiert das Tool die Erreichbarkeit anhand realer Routing-Netzwerke**. Die resultierenden Isochronen können mit räumlichen Datensätzen, wie Bevölkerungs- oder Infrastrukturdaten, verschnitten werden, um die Abdeckung zu bewerten und Erreichbarkeitslücken zu identifizieren.

Einzugsgebiet bietet folgende zusätzliche Funktionen:

**Für alle Routing-Modi:**

- **Anpassbare Schrittgrößen** — jeden Isochronenschritt individuell definieren (z. B. 5, 10, 20, 30 Minuten) anstatt gleichmäßiger Abstände.
- **Punktraster-Ausgabeform** — eine neue Ausgabeoption, bei der das Einzugsgebiet als Raster einzelner Punkte dargestellt wird, die jeweils den genauen Reisekostenwert anzeigen.

**Nur für den öffentlichen Verkehr:**

- **Maximale Anzahl an Umstiegen** — begrenzt die Anzahl der ÖV-Verbindungen pro Fahrt.
- **Zugangsart und Abgangsart** — konfiguriert, wie Nutzer zu ÖV-Haltestellen und von diesen weg gelangen (zu Fuß, mit dem Fahrrad, mit dem Pedelec oder mit dem Auto).

:::info
Die Berechnung der Einzugsgebiete ist für `Zu Fuß`, `Fahrrad`, `Pedelec` und `Auto` in **über 30 europäischen Ländern** verfügbar. Für `Öffentliche Verkehrsmittel` werden Deutschland, die Schweiz und die Region Haut-Rhin in Frankreich unterstützt. Wenn Sie Analysen außerhalb dieser Regionen benötigen, [kontaktieren Sie uns gerne](https://plan4better.de/de/contact/).
:::

## 2. Anwendungsbeispiele

- Welche Einrichtungen sind innerhalb von 5, 10 und 20 Minuten zu Fuß erreichbar? (Mit anpassbaren Schrittgrößen entsprechend planerischer Standards.)
- Wie verändert sich das Einzugsgebiet, wenn ÖV-Verbindungen auf einen Umstieg begrenzt werden?
- Welche Gebiete sind innerhalb von 5, 15 und 30 Minuten mit dem Fahrrad von einem neuen Radknoten erreichbar?
- Wie unterscheiden sich die Einzugsgebiete von Arbeitsstätten zwischen Auto und öffentlichem Verkehr, wenn Radfahrer ÖV-Haltestellen nutzen können?
- Welcher Anteil der Bevölkerung hat einen Hausarzt innerhalb von 500 m zu Fuß?

## 3. Verwendung des Tools

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Werkzeugkasten</code> <img src={require('/img/icons/toolbox.png').default} alt="Werkzeugkasten" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> . Klicken Sie unter <code>Erreichbarkeitsindikatoren</code> auf <code>Einzugsgebiet</code>.</div>
</div>

### Routing & Konfiguration

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Wählen Sie den <code>Routentyp</code> für Ihre Analyse aus.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Konfigurieren Sie die Parameter für den gewählten <code>Routentyp</code>. Die verfügbaren Felder hängen vom Modus ab:</div>
</div>

<Tabs>
<TabItem value="active-car" label="Zu Fuß / Fahrrad / Pedelec / Auto" default className="tabItemBox">

- Wählen Sie, ob das Einzugsgebiet auf Basis von <code>Zeit</code> oder <code>Entfernung</code> berechnet werden soll, und setzen Sie das entsprechende Limit. Bei Wahl von <code>Zeit</code> können Sie auch die <code>Geschwindigkeit</code> konfigurieren.
- Wählen Sie die <code>Form des Einzugsgebiets</code>. Bei Wahl von:
  - <code>Polygon</code> oder <code>Netzwerk</code>: können Sie <code>Schritte</code> und <code>Schrittgrößen</code> festlegen.
  - <code>Sechseckiges Gitter</code>: keine weitere Konfiguration erforderlich.
  - <code>Punktraster</code>: Sie müssen den <code>Punktraster-Layer</code> auswählen, auf den die Werte angewendet werden.

:::tip Hinweis

Geeignete Reisezeitlimits nach Einrichtungstyp finden Sie im [Standortwerkzeug](https://www.chemnitz.de/chemnitz/media/unsere-stadt/verkehr/verkehrsplanung/vep2040_standortwerkzeug.pdf) der Stadt Chemnitz.

:::

</TabItem>

<TabItem value="public transport" label="ÖPNV" className="tabItemBox">

**Berücksichtigt alle per öffentlichem Verkehr erreichbaren Orte, einschließlich intermodaler Umstiege und Haltestellen-Zugang.**

- Wählen Sie die <code>ÖV-Modi</code> für die Analyse: Bus, Straßenbahn, Bahn, U-Bahn, Fähre, Seilbahn, Gondel und/oder Standseilbahn, und konfigurieren Sie das <code>Reisezeitlimit</code> in Minuten.
- Wählen Sie die <code>Form des Einzugsgebiets</code>. Bei Wahl von:
  - <code>Polygon</code> oder <code>Netzwerk</code>: können Sie <code>Schritte</code> und <code>Schrittgrößen</code> festlegen.
  - <code>Sechseckiges Gitter</code>: keine weitere Konfiguration erforderlich.
  - <code>Punktraster</code>: Sie müssen den <code>Punktraster-Layer</code> auswählen, auf den die Werte angewendet werden.
- Wählen Sie <code>Tag</code>, <code>Startzeit</code> und <code>Endzeit</code> für das Analysezeitfenster.

:::tip Hinweis

Geeignete Reisezeitlimits nach Einrichtungstyp finden Sie im [Standortwerkzeug](https://www.chemnitz.de/chemnitz/media/unsere-stadt/verkehr/verkehrsplanung/vep2040_standortwerkzeug.pdf) der Stadt Chemnitz.

:::

</TabItem>
</Tabs>

### Erweiterte Optionen

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Optional können Sie auf <code>Erweiterte Optionen</code> klicken, um weitere Einstellungen vorzunehmen. Die verfügbaren Optionen hängen vom gewählten <code>Routentyp</code> ab:</div>
</div>

<Tabs>
<TabItem value="non-pt" label="Zu Fuß / Fahrrad / Pedelec / Auto" default className="tabItemBox">

#### Form der Geometrien

*(Nur für Zu Fuß, Fahrrad und Pedelec — sichtbar wenn die Form des Einzugsgebiets auf Polygon gesetzt ist)*

Wählen Sie, wie die Polygone bei mehreren Startpunkten geformt werden:

- **Zusammengefasst über Startpunkte** *(Standard)* — alle Startpunkte werden pro Schritt zu einem gemeinsamen Einzugsgebietspolygon zusammengeführt.
- **Getrennt nach Startpunkt** — jeder Startpunkt erhält pro Schritt ein eigenes individuelles Einzugsgebietspolygon.

#### Darstellung der Schritte

Wählen Sie, wie die Isochronen-Schritte dargestellt werden:

- **Getrennte Schritte** — jeder Schritt zeigt nur das Gebiet, das *zwischen* diesem und dem vorherigen Schritt erreichbar ist. Zum Beispiel zeigt bei Schritten bei 5, 10 und 15 Minuten die 10-Minuten-Zone nur das Gebiet, das zwischen 5 und 10 Minuten erreichbar ist.
- **Kumulative Schritte** — jeder Schritt zeigt das *gesamte bis zu diesem Reisekostenwert erreichbare Gebiet*. Zum Beispiel umfasst die 10-Minuten-Zone alles, was innerhalb von 10 Minuten erreichbar ist, einschließlich der 5-Minuten-Zone.

<p></p>

</TabItem>

<TabItem value="pt-advanced" label="ÖPNV" className="tabItemBox">

Für den öffentlichen Verkehr können Sie über die Erweiterten Optionen die <code>Darstellung der Schritte</code>, die <code>Maximalen Umstiege</code>, die <code>Zugangsart</code> und die <code>Abgangsart</code> konfigurieren.

#### Darstellung der Schritte

Wählen Sie, wie die Isochronen-Schritte dargestellt werden:

- **Getrennte Schritte** — jeder Schritt zeigt nur das Gebiet, das *zwischen* diesem und dem vorherigen Schritt erreichbar ist.
- **Kumulative Schritte** — jeder Schritt zeigt das *gesamte bis zu diesem Reisekostenwert erreichbare Gebiet*.

#### Maximale Umstiege

Legen Sie die `Maximalen Umstiege` fest, um die Anzahl der zulässigen ÖV-Verbindungen pro Fahrt zu begrenzen. Beispiel: Bei Wert `1` werden nur Fahrten mit maximal einem Umstieg berücksichtigt — Direktverbindungen und Fahrten mit einem Wechsel.

#### Zugangsart & Abgangsart

Konfigurieren Sie, wie Nutzer **zu** und **von** ÖV-Haltestellen gelangen:

- **Zugangsart** — Verkehrsmittel zur Haltestelle (Zu Fuß, Fahrrad, Pedelec, Auto).
- **Abgangsart** — Verkehrsmittel von der Haltestelle zum Ziel (Zu Fuß, Fahrrad, Pedelec, Auto).

Für jeden Modus können Sie die **maximale Reisezeit oder Entfernung** sowie die **Reisegeschwindigkeit** konfigurieren. Beispielsweise können Sie einen Radfahrer modellieren, der mit 15 km/h bis zu 10 Minuten zur Bahnstation fährt.

<p></p>

</TabItem>
</Tabs>

### Startpunkte

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Wählen Sie die <code>Methode zur Startpunktauswahl</code>: Wählen Sie <code>Auf der Karte auswählen</code> und klicken Sie auf die Karte, um Startpunkte zu setzen, oder wählen Sie <code>Aus Layer auswählen</code> und wählen Sie einen Punktlayer mit den gewünschten Startpunkten. Alle Features des Layers werden als Startpunkte verwendet.</div>
</div>

### Ergebnis-Layer

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Legen Sie den <code>Name der Ergebnislayer</code> für den Ausgabe-Einzugsgebiet-Layer fest.</div>
</div>

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Legen Sie den <code>Name des Startpunkte-Layer</code> für den Ausgabe-Startpunkte-Layer fest.</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Klicken Sie auf <code>Ausführen</code>, um die Berechnung zu starten.</div>
</div>

:::tip Hinweis

Die Berechnungszeit variiert je nach Einstellungen. Den Fortschritt können Sie in der [Statusleiste](../../workspace/home#status-bar) verfolgen.

:::

### Ergebnisse

Nach Abschluss der Berechnung werden die resultierenden Layer zur Karte hinzugefügt:

- **Einzugsgebiet** — die berechneten Isochronen in der gewählten Form (Polygon, Netzwerk, Sechseckiges Gitter oder Punktraster). Durch Klick auf ein Feature kann das Attribut **travel_cost** eingesehen werden, das die Reisezeit (Minuten) oder Entfernung (Meter) anzeigt.
- **Startpunkte** — ein Punktlayer mit den ausgewählten Startpositionen (wird nur erstellt, wenn Startpunkte auf der Karte gesetzt wurden, nicht bei Verwendung eines vorhandenen Layers).

Der Ergebnislayer wird automatisch mit einer Farbskala von der kürzesten bis zur längsten Reisekostenstufe eingefärbt.

## 4. Technische Details

**Einzugsgebiete sind Isolinien, die Punkte verbinden, die von einem Startpunkt aus innerhalb eines Zeitintervalls (*Isochronen*) oder einer Entfernung (*Isodistanzen*) erreichbar sind.** Die Berechnung nutzt das entsprechende Verkehrsnetz für den gewählten Routing-Modus.

### Grenzen für Startpunkte

| Routing-Modus | Maximale Startpunkte |
| --- | --- |
| Zu Fuß / Fahrrad / Pedelec / Auto | 1.000 |
| ÖPNV | 100 |

### Zeitfenster

Für den öffentlichen Verkehr wird das Einzugsgebiet über ein **Zeitfenster** berechnet – definiert durch einen Wochentag sowie eine Start- und Endzeit – anstatt für eine einzelne Abfahrt. Die Engine wertet **jede Abfahrtsminute** innerhalb dieses Zeitfensters aus und behält die **schnellste** Verbindung zu jedem erreichbaren Ort. Das Ergebnis ist kein Durchschnitt über die Abfahrten, sondern der beste Fall unter ihnen, wodurch das größtmögliche Einzugsgebiet entsteht. Eine Verbindung gilt ausschließlich anhand ihrer Startzeit als innerhalb des Zeitfensters liegend, unabhängig von ihrer Endzeit oder Gesamtdauer.

### Visualisierung

Der verwendete Algorithmus zur Ableitung der Einzugsgebietsform hängt vom Routing-Modus ab:

- **Zu Fuß, Fahrrad, Pedelec und ÖPNV** — die Form wird aus dem Routing-Raster mithilfe des [Marching-Squares-Konturlinien-Algorithmus](https://de.wikipedia.org/wiki/Marching_Squares "Wikipedia: Marching Squares") abgeleitet, einem Computergraphik-Algorithmus, der zweidimensionale Konturlinien aus einem rechteckigen Wertearray erzeugt ([de Queiroz Neto et al. 2016](#6-referenzen)). Dieser Algorithmus transformiert das Routing-Raster von einem 2D-Array in glatte Polygonkonturen für die Visualisierung und räumliche Analyse.
- **Auto** — die Form wird mithilfe der DuckDB-Funktion [`ST_ConcaveHull`](https://duckdb.org/docs/current/core_extensions/spatial/functions#st_concavehull) abgeleitet, die sich eng um die erreichbaren Punkte legt, um das Einzugsgebiets-Polygon zu erzeugen. Es wird ein dynamisches Konkavitätsverhältnis basierend auf der Anzahl erreichter Knoten verwendet: `0,5` bei weniger als 10.000 Knoten, `0,3` bei weniger als 50.000 und `0,2` andernfalls — niedrigere Werte erzeugen engere, stärker konkave Formen bei großen Einzugsgebieten, höhere Werte glattere Konturen bei kleinen.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/toolbox/accessibility_indicators/catchments/wiki.png').default} alt="Marching-Squares-Illustration" style={{ maxHeight: "400px", maxWidth: "400px", objectFit: "contain"}}/>
</div>

### Wissenschaftlicher Hintergrund

Einzugsgebiete sind *konturbasierte Maße* (auch *kumulierte Gelegenheiten*), die für ihre interpretierbaren Ergebnisse geschätzt werden ([Geurs und van Eck 2001](#6-referenzen); [Albacete 2016](#6-referenzen)). Sie unterscheiden nicht zwischen verschiedenen Reisezeiten innerhalb des Grenzwerts ([Bertolini, le Clercq und Kapoen 2005](#6-referenzen)), anders als [heatmap-basierte Erreichbarkeitsindikatoren](./closest_average.md).

:::tip Hinweis

Weitere Einblicke in den Routing-Algorithmus finden Sie unter [Routing](../../category/routing).

:::

## 5. Weiterführende Literatur

Weitere Einblicke in die Einzugsgebietsberechnung und deren wissenschaftlichen Hintergrund finden Sie in dieser [Publikation](https://doi.org/10.1016/j.jtrangeo.2021.103080).

## 6. Referenzen

Albacete, Xavier. 2016. "Evaluation and Improvements of Contour-Based Accessibility Measures." url: https://dspace.uef.fi/bitstream/handle/123456789/16857/urn_isbn_978-952-61-2103-1.pdf?sequence=1&isAllowed=y

Bertolini, Luca, F. le Clercq, and L. Kapoen. 2005. "Sustainable Accessibility: A Conceptual Framework to Integrate Transport and Land Use Plan-Making. Two Test-Applications in the Netherlands and a Reflection on the Way Forward." Transport Policy 12 (3): 207–20. https://doi.org/10.1016/j.tranpol.2005.01.006.

J. F. de Queiroz Neto, E. M. d. Santos, and C. A. Vidal. "MSKDE - Using Marching Squares to Quickly Make High Quality Crime Hotspot Maps". en. In: 2016 29th SIBGRAPI Conference on Graphics, Patterns and Images (SIBGRAPI). Sao Paulo, Brazil: IEEE, Oct. 2016, pp. 305–312. isbn: 978-1-5090-3568-7. doi: 10.1109/SIBGRAPI.2016.049. url: https://ieeexplore.ieee.org/document/7813048

https://fr.wikipedia.org/wiki/Marching_squares#/media/Fichier:Marching_Squares_Isoline.svg

Majk Shkurti, "Spatio-temporal public transport accessibility analysis and benchmarking in an interactive WebGIS", Sep 2022. url: https://www.researchgate.net/publication/365790691_Spatio-temporal_public_transport_accessibility_analysis_and_benchmarking_in_an_interactive_WebGIS

Matthew Wigginton Conway, Andrew Byrd, Marco Van Der Linden. "Evidence-Based Transit and Land Use Sketch Planning Using Interactive Accessibility Methods on Combined Schedule and Headway-Based Networks", 2017. url: https://journals.sagepub.com/doi/10.3141/2653-06

Geurs, Karst T., and Ritsema van Eck. 2001. "Accessibility Measures: Review and Applications." RIVM Report 408505 006. url: https://rivm.openrepository.com/handle/10029/259808

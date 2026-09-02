---
sidebar_position: 4

---

import MathJax from 'react-mathjax';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Heatmap - Konnektivität
Der Heatmap - Konnektivität Indikator **erstellt eine farbkodierte Karte zur Visualisierung der Konnektivität von Orten innerhalb eines Interessengebiets** ([**AOI**](../../further_reading/glossary#area-of-interest-aoi "Was ist ein AOI?")).

<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="https://www.youtube.com/embed/A8f32ai4ddQ?si=PKUBBKu0vvEFLdEs&amp;start=46" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

## 1. Erklärung

Die Heatmap verwendet ein farbkodiertes sechseckiges Gitter, um **zu zeigen, wie gut verschiedene Gebiete miteinander verbunden sind.** Als Eingabeparameter werden ein **Interessengebiet** (AOI), ein **Verkehrsmittel** (zu Fuß, Radfahren usw.) und ein **Reisezeitlimit** benötigt. Unter Berücksichtigung der realen Verkehrs- und Straßennetze berechnet sie die Konnektivität jedes Sechsecks innerhalb der AOI.


:::info

Die Heatmap-Berechnung ist für `Walk`, `Bicycle`, `Pedelec` und `Auto` in **über 30 europäischen Ländern** verfügbar. Für `Öffentliche Verkehrsmittel` werden Deutschland, die Schweiz und die Region Haut-Rhin in Frankreich unterstützt. Wenn Sie Analysen außerhalb dieser Regionen benötigen, [kontaktieren Sie uns](https://plan4better.de/de/contact/) gerne.

:::

## 2. Anwendungsbeispiele

 - Bietet das bestehende Verkehrsnetz einen gleichberechtigten Zugang innerhalb der AOI?
 - Wie gut ist das Straßen-, Fuß- oder Radwegenetz in einem bestimmten Gebiet vernetzt?
 - Wie schneiden die Orte innerhalb einer AOI in Bezug auf die Konnektivität über die verschiedenen Verkehrsmittel ab?
 - Gibt es Barrieren, Lücken oder Inseln im Straßennetz, die die Konnektivität behindern?

## 3. Wie verwendet man den Indikator?

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Werkzeuge</code> <img src={require('/img/icons/toolbox.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Unter dem <code>Erreichbarkeitsindikatoren</code> Menü klicken Sie auf <code>Heatmap Konnektivität</code>.</div>
</div>

### Routing & Konfiguration

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie das <code>Verkehrsmittel</code> für die Heatmap.</div>
</div>

| Verkehrsmittel | Berücksichtigt |
|----------------|----------------|
| Zu Fuß | Alle zu Fuß begehbaren Wege |
| Fahrrad | Alle mit dem Fahrrad befahrbaren Wege (unter Berücksichtigung von Oberfläche und Steigung) |
| Pedelec | Alle mit dem Pedelec befahrbaren Wege (unter Berücksichtigung von Oberfläche und Steigung) |
| Auto | Alle mit dem Auto befahrbaren Wege (unter Berücksichtigung von Tempolimits und Einbahnstraßen) |
| Öffentlicher Verkehr | Alle mit dem ÖV möglichen Fahrten (gemäß offiziellen GTFS-Fahrplänen), unter Berücksichtigung von Zu- und Abgang zu Fuß zu und von den Haltestellen |

<Tabs>
<TabItem value="active-car" label="Zu Fuß / Fahrrad / Pedelec / Auto" default className="tabItemBox">

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie im Menü <code>Berechnung nach</code>, ob die Reisekosten als Zeit (Minuten) oder als Entfernung (Meter) gemessen werden.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Geben Sie ein <code>Limit</code> in Minuten oder Metern für Ihre Heatmap ein. Dieses wird entsprechend dem zuvor gewählten Verkehrsmittel und der gewählten Maßeinheit verwendet.</div>
</div>

</TabItem>

<TabItem value="public transport" label="Öffentlicher Verkehr (ÖV)" className="tabItemBox">

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie die zu analysierenden <code>ÖV-Modi</code>: Bus, Straßenbahn, Bahn, U-Bahn, Fähre, Seilbahn, Gondel und/oder Standseilbahn. Wählen Sie anschließend <code>Tag</code> und <code>Ankunftszeit</code> für die Analyse. Berücksichtigt werden die besten ÖV-Fahrten, die die Gelegenheiten bis zu dieser Zeit erreichen.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Geben Sie ein <code>Limit</code> in Minuten für Ihre Heatmap ein.</div>
</div>

</TabItem>
</Tabs>

:::tip Hinweis
Benötigen Sie Hilfe bei der Auswahl eines geeigneten Reisezeitlimits für verschiedene gängige Einrichtungen? Das ["Standort-Werkzeug"](https://www.chemnitz.de/chemnitz/media/unsere-stadt/verkehr/verkehrsplanung/vep2040_standortwerkzeug.pdf) der Stadt Chemnitz kann hilfreiche Orientierung bieten.
:::


#### Erweiterte Optionen

Optional können Sie <code>Erweiterte Optionen</code> aktivieren, um weitere Einstellungen für Routing und Heatmap-Erstellung vorzunehmen.

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Konfigurieren Sie verschiedene Routing-Optionen für das gewählte Verkehrsmittel, etwa Reisegeschwindigkeit, maximale Anzahl an Umstiegen, Zu- und Abgangslimits und mehr. Weitere Informationen zu verkehrsmittelspezifischen Optionen finden Sie im Abschnitt <a href="/docs/category/routing">Routing</a>.</div>
</div>

### Referenzgebiet

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Wählen Sie ein <code>Referenzgebiet</code> — einen Polygon-Layer, der Ihr Interessengebiet (AOI) definiert, für das die Heatmap berechnet werden soll.</div>
</div>


### Ergebnis-Layer

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Legen Sie den <code>Name der Ergebnislayer</code> für den Ausgabe-Heatmap-Layer fest.</div>
</div>

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Klicken Sie auf <code>Ausführen</code>, um die Berechnung der Heatmap zu beginnen.</div>
</div>

### Ergebnisse

Sobald die Berechnung abgeschlossen ist, wird ein Ergebnislayer zur Karte hinzugefügt. Dieser Heatmap Konnektivität Layer enthält Ihre farbkodierte Heatmap. **Durch Klicken auf eine der sechseckigen Zellen der Heatmap wird der berechnete Konnektivitätswert für diese Zelle angezeigt.**

<img src={require('/img/toolbox/accessibility_indicators/heatmaps/connectivity_based/connectivity_calculation.gif').default} alt="Connectivity-basierte Heatmap Ergebnis in GOAT" style={{ maxHeight: "auto", maxWidth: "80%"}}/>


:::tip Tipp

Möchten Sie Ihre Heatmaps gestalten und schöne Karten erstellen? Siehe [Styling](../../map/layer_style/style/styling).

:::

## 4. Technische Details

### Berechnung

Für jedes Sechseck im Raster innerhalb des Interessengebiets (AOI) identifiziert das Tool alle umgebenden Sechsecke, die es erreichen können. Diese umgebenden Sechsecke können sich außerhalb der AOI befinden, müssen aber innerhalb der angegebenen **Reisezeit** und mit der gewählten **Reisemethode** erreichbar sein.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/toolbox/accessibility_indicators/heatmaps/connectivity_based/heatmap_connectivity_infographic.png').default} alt="Extent of cells from where destination cell within AOI is accessible." style={{ maxHeight: "400px", maxWidth: "500px", alignItems:'center'}}/>
</div>

Konnektivitäts-Formel:

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={"\\text{Zellen-Konnektivität} = \\sum_{i=1}^{n} (\\text{Anzahl erreichbarer Zellen}_i \\times \\text{Zellfläche})"} />
  </div>
</MathJax.Provider>

Die Konnektivitäts-Formel berechnet die Gesamtfläche (in Quadratmetern), von der aus eine Zielzelle innerhalb des Interessengebiets (AOI) erreicht werden kann. Sie berücksichtigt dabei die **Anzahl der Zellen**, die die Zielzelle innerhalb jedes **Reisezeitschritts** ***i*** bis zum angegebenen **Reisezeitlimit** ***n*** erreichen können. **Die Summe aller dieser erreichbaren Bereiche ergibt den endgültigen Konnektivitätswert für diese Zelle.**

### Rasterzellen 

Heatmaps in GOAT nutzen **[Ubers H3-rasterbasierte](../../further_reading/glossary#h3-grid)** Lösung für effiziente Berechnungen und leicht verständliche Visualisierung. Im Hintergrund wird die Erreichbarkeit direkt zur Laufzeit von GOATs eigener Routing-Engine berechnet. Für jedes *Verkehrsmittel* routet die Engine von den Gelegenheiten ausgehend nach außen, um die erreichbaren H3-Zellen und deren Reisekosten zu ermitteln, und aggregiert diese anschließend zu einem Erreichbarkeitswert pro Zelle. Der öffentliche Verkehr nutzt die RAPTOR-basierte Engine, während die Verkehrsträger der aktiven Mobilität und das Auto GOATs Dijkstra-Implementierung verwenden.

Die Auflösung und Abmessungen des verwendeten sechseckigen Rasters hängen vom gewählten *Verkehrsmittel* ab:

| Verkehrsmittel | Auflösung | Durchschnittliche Sechseckfläche | Durchschnittliche Kantenlänge |
|----------------|-----------|----------------------------------|-------------------------------|
| Walk | 10 | 11.285,6 m² | 65,9 m |
| Bicycle | 9 | 78.999,4 m² | 174,4 m |
| Pedelec | 9 | 78.999,4 m² | 174,4 m |
| Car | 8 | 552.995,7 m² | 461,4 m |
| Public Transport | 9 | 78.999,4 m² | 174,4 m |

:::tip Tipp

Für weitere Einblicke in den Routing-Algorithmus, besuchen Sie [Routing](../../category/routing). Außerdem können Sie diese [Publikation](https://doi.org/10.1016/j.jtrangeo.2021.103080) lesen.

:::

### Visualisierung

Zur Visualisierung verwendet das Ergebnis der Konnektivitätsanalyse standardmäßig eine Klassifizierungsmethode basierend auf Quantilen. Es können jedoch auch verschiedene andere Klassifizierungsmethoden verwendet werden. Lesen Sie mehr im Abschnitt **[Datenklassifizierungsmethoden](../../map/layer_style/style/attribute_based_styling#data-classification-methods)** der Seite *Attribut-basiertes Styling*.
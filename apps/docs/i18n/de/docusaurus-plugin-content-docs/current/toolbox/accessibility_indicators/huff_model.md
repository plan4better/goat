---
sidebar_position: 6
---

import MathJax from 'react-mathjax';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Huff-Modell

Das Huff-Modell **prognostiziert die Wahrscheinlichkeit, mit der Konsumenten in einem Referenzgebiet bestimmte Standorte aufsuchen**, basierend auf der Attraktivität der Standorte und der Entfernung zu diesen, unter Berücksichtigung der Konkurrenz zwischen den Zielen. Das Huff-Modell konzentriert sich auf **wettbewerbsfähige Marktanteile**.

<!-- TODO: Add YouTube video embed when available
<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="VIDEO_URL" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>
-->

## 1. Erklärung

Das Huff-Modell ist ein **räumliches Interaktionsmodell, das schätzt, wie sich die Nachfrage (z. B. Kunden, Bewohner) auf konkurrierende Angebotsstandorte (z. B. Geschäfte, Einrichtungen) verteilt**.
Das Modell funktioniert nach einem einfachen Prinzip: **Die Wahrscheinlichkeit, dass ein Standort gewählt wird, hängt von seiner Attraktivität im Verhältnis zu allen konkurrierenden Standorten ab, gewichtet nach der Reisezeit**. Ein großes, nahe gelegenes Einkaufszentrum wird mehr Nachfrage auf sich ziehen als ein kleines, weit entferntes – aber die genaue Aufteilung hängt vom Gleichgewicht zwischen Attraktivität und Entfernung aller verfügbaren Optionen ab.

Das Ergebnis ist ein **Wahrscheinlichkeitswert für jeden Angebotsstandort**, der den Anteil der Gesamtnachfrage darstellt, den er aus dem Referenzgebiet auf sich zieht. Dies ermöglicht einen direkten Vergleich, wie gut verschiedene Einrichtungen um denselben Kundenstamm konkurrieren.

Sie können das Verkehrsmittel, den Gelegenheiten-Layer (mit Kapazitätsfeldern), den Nachfrage-Layer (mit Bevölkerungsfeld), das Referenzgebiet und Reisezeitlimits konfigurieren und Ihr Modell kalibrieren.

- **Referenzgebiet** — Ein Polygon, das das Untersuchungsgebiet definiert. Nur Nachfrage und Gelegenheiten innerhalb dieses Gebiets werden berücksichtigt.

- Der **Gelegenheiten-Layer enthält Einrichtungsdaten** mit einem Attraktivitätsattribut (z. B. Anzahl der Krankenhausbetten, Quadratmeter Verkaufsfläche, Schulplätze).

- Der **Nachfrage-Layer enthält Bevölkerungs- oder Nutzerdaten** (z. B. Einwohnerzahl, potenzielle Kunden), die die Nachfrage nach den Einrichtungen darstellen.


**Wesentlicher Unterschied:** Im Gegensatz zu Heatmaps, die die Erreichbarkeit pro Rasterzelle visualisieren, erzeugt das *Huff-Modell* eine **Wahrscheinlichkeit pro Angebotsstandort** – und zeigt, welchen Anteil der Gesamtnachfrage jede Einrichtung erfasst.

:::info

Die Berechnung des Huff-Modells ist für `Walk`, `Bicycle`, `Pedelec` und `Auto` in **über 30 europäischen Ländern** verfügbar. Für `Öffentliche Verkehrsmittel` werden Deutschland, die Schweiz und die Region Haut-Rhin in Frankreich unterstützt. Wenn Sie Analysen außerhalb dieser Regionen benötigen, [kontaktieren Sie uns](https://plan4better.de/de/contact/ "Kontaktieren Sie uns") gerne.

:::

## 2. Anwendungsfälle

- Welchen Marktanteil erfasst jeder Supermarkt aus den umliegenden Wohngebieten?

- Wo sollte ein neues Einzelhandelsgeschäft eröffnet werden, um die Kundenreichweite unter Berücksichtigung bestehender Wettbewerber zu maximieren?

- Wie würde sich das Hinzufügen einer neuen Schule auf die Verteilung der Anmeldungen auf bestehende Schulen auswirken?

- Welchen Anteil der Nachfrage deckt jede öffentliche Bibliothek aus den umliegenden Stadtvierteln ab?

## 3. Vorgehensweise

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Werkzeuge</code> <img src={require('/img/icons/toolbox.png').default} alt="Optionen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>. </div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie im Menü <code>Erreichbarkeitsindikatoren</code> auf <code>Huff-Modell</code>.</div>
</div>

### Routing & Konfiguration

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie das <code>Verkehrsmittel</code>, das Sie für die Analyse verwenden möchten.</div>
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
  <div class="content">Geben Sie ein <code>Limit</code> in Minuten oder Metern ein. Dieses wird entsprechend dem zuvor gewählten Verkehrsmittel und der gewählten Maßeinheit verwendet.</div>
</div>

</TabItem>

<TabItem value="public transport" label="Öffentlicher Verkehr (ÖV)" className="tabItemBox">

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie die zu analysierenden <code>ÖV-Modi</code>: Bus, Straßenbahn, Bahn, U-Bahn, Fähre, Seilbahn, Gondel und/oder Standseilbahn. Wählen Sie anschließend <code>Tag</code> und <code>Ankunftszeit</code> für die Analyse.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Geben Sie ein <code>Limit</code> in Minuten ein. Einrichtungen außerhalb dieses Limits werden nicht berücksichtigt.</div>
</div>

</TabItem>
</Tabs>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Wählen Sie Ihr <code>Referenzgebiet</code> – einen Polygon-Layer, der die Grenze des Untersuchungsgebiets definiert. Nur Nachfrage und Ziele innerhalb dieses Gebiets werden in die Analyse einbezogen.</div>
</div>

:::tip Hinweis

Benötigen Sie Hilfe bei der Auswahl einer geeigneten Reisezeitgrenze für verschiedene allgemeine Einrichtungen? Das ["Standort-Werkzeug"](https://www.chemnitz.de/chemnitz/media/unsere-stadt/verkehr/verkehrsplanung/vep2040_standortwerkzeug.pdf) der Stadt Chemnitz kann hilfreiche Orientierung bieten.

:::

### Nachfrage

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Wählen Sie Ihren <code>Nachfrage-Layer</code> aus dem Dropdown-Menü. Dieser Layer sollte Bevölkerungs- oder Verbraucherdaten enthalten (z. B. Zensusdaten mit Einwohnerzahlen, Kundenstandorte).</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Wählen Sie das <code>Nachfragefeld</code> – ein numerisches Feld aus Ihrem Nachfrage-Layer, das die Anzahl potenzieller Verbraucher darstellt (z. B. Bevölkerung, Anzahl der Haushalte).</div>
</div>

### Gelegenheiten

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Wählen Sie Ihren <code>Gelegenheiten-Layer</code> aus dem Dropdown-Menü. Dieser Layer sollte Standorte von Einrichtungen oder Geschäften enthalten, die um die Nachfrage konkurrieren.</div>
</div>

<div class="step">
  <div class="step-number">10</div>
  <div class="content">Wählen Sie das <code>Attraktivitätsfeld</code> – ein numerisches Feld, das die Attraktivität jeder Einrichtung darstellt (z. B. Verkaufsfläche in m², Anzahl der Produkte, Qualitätsbewertung).</div>
</div>

### Erweiterte Konfiguration

<div class="step">
  <div class="step-number">11</div>
  <div class="content">Passen Sie optional den <code>Attraktivitätsparameter</code> (Standard: 1,0) an, um zu steuern, wie stark die Attraktivität die Wahrscheinlichkeit beeinflusst. Höhere Werte verstärken die Unterschiede zwischen den Einrichtungen.</div>
</div>

<div class="step">
  <div class="step-number">12</div>
  <div class="content">Passen Sie optional den Parameter <code>Entfernungsabnahme</code> (Standard: 2,0) an, um zu steuern, wie stark die Reisezeit die Attraktivität einer Einrichtung verringert. Höhere Werte bedeuten, dass Menschen weniger bereit sind, weit zu reisen.</div>
</div>

:::info Modellkalibrierung

Für realistische Ergebnisse sollten die Parameter des Huff-Modells **unter Verwendung beobachteter Marktanteils- oder Nutzerwahldaten kalibriert werden**. Die Standardparameter spiegeln möglicherweise nicht das tatsächliche Kundenverhalten in Ihrem Untersuchungsgebiet wider.
Idealerweise sammeln Sie Daten zu tatsächlichen Kundenbesuchen oder Marktanteilen, um optimale Parameter zu schätzen.

**Hinweis:** Eine automatische Parameterkalibrierung ist derzeit in GOAT nicht verfügbar. Sie können die Parameter manuell anpassen.

:::

### Ergebnis-Layer

<div class="step">
  <div class="step-number">13</div>
  <div class="content">Optional können Sie verschiedene Routing-Optionen für das gewählte Verkehrsmittel konfigurieren, etwa Reisegeschwindigkeit, maximale Anzahl an Umstiegen, Zu- und Abgangslimits und mehr. Weitere Informationen zu verkehrsmittelspezifischen Optionen finden Sie im Abschnitt <a href="/docs/category/routing">Routing</a>.</div>
</div>

<div class="step">
  <div class="step-number">14</div>
  <div class="content">Legen Sie den <code>Name der Ergebnislayer</code> für den Ausgabe-Huff-Modell-Layer fest.</div>
</div>

<div class="step">
  <div class="step-number">15</div>
  <div class="content">Klicken Sie auf <code>Ausführen</code>, um die Berechnung zu starten.</div>
</div>

### Ergebnisse

Sobald die Berechnung abgeschlossen ist, wird ein Ergebnis-Layer zur Karte hinzugefügt. Jedes Feature im Ergebnis-Layer stellt einen **Angebotsstandort** mit seiner berechneten Huff-Wahrscheinlichkeit dar.

- **Höhere Wahrscheinlichkeitswerte** zeigen an, dass eine Einrichtung einen größeren Anteil der Gesamtnachfrage erfasst – sie ist im Vergleich zu Alternativen wettbewerbsfähiger.
- **Niedrigere Wahrscheinlichkeitswerte** zeigen an, dass eine Einrichtung weniger Nachfrage erfasst, entweder weil sie weniger attraktiv ist, weiter entfernt liegt oder starker Konkurrenz durch nahegelegene Alternativen ausgesetzt ist.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/huff_model/huff_model.png').default} alt="Huff-model Heatmap Ergebnis in GOAT" style={{ maxHeight: "auto", maxWidth: "80%"}}/>
</div>
<p></p>

:::tip Tipp

Möchten Sie visuell ansprechende Karten erstellen, die eine klare Geschichte erzählen? Erfahren Sie, wie Sie Farben, Legenden und Stile in unserem Abschnitt [Styling](../../map/layer_style/style/styling) anpassen können.

:::

## 4. Technische Details

### Berechnung

Das Huff-Modell berechnet die Wahrscheinlichkeit, dass die Nachfrage von Standort *i* zum Angebotsstandort *j* fließt:

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={"P_{ij} = \\frac{A_j^{\\alpha} \\cdot d_{ij}^{-\\beta}}{\\sum_{k=1}^{n} A_k^{\\alpha} \\cdot d_{ik}^{-\\beta}}"} />
  </div>
</MathJax.Provider>

Wobei:
- *P<sub>ij</sub>* = Wahrscheinlichkeit, dass die Nachfrage am Standort *i* den Angebotsstandort *j* aufsucht
- *A<sub>j</sub>* = Attraktivität des Angebotsstandorts *j*
- *d<sub>ij</sub>* = Reisezeit vom Bedarfsstandort *i* zum Angebotsstandort *j*
- *α* = Attraktivitätsparameter (Standard: 1,0)
- *β* = Distanzabfallparameter (Standard: 2,0)
- *n* = Anzahl der von *i* aus erreichbaren Angebotsstandorte

Die **erfasste Nachfrage** für jeden Angebotsstandort wird dann berechnet, indem die Wahrscheinlichkeit mit dem Nachfragewert an jedem Ursprung multipliziert und über alle Ursprünge summiert wird:

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={"C_j = \\sum_{i=1}^{m} P_{ij} \\cdot D_i"} />
  </div>
</MathJax.Provider>

Wobei:
- *C<sub>j</sub>* = gesamte erfasste Nachfrage am Angebotsstandort *j*
- *D<sub>i</sub>* = Nachfrage (Bevölkerung) am Standort *i*
- *m* = Anzahl der Bedarfsstandorte

Die finale **Huff-Wahrscheinlichkeit**, die pro Angebotsstandort angegeben wird, ist der Anteil der Gesamtnachfrage, den er erfasst:

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={"H_j = \\frac{C_j}{\\sum_{i=1}^{m} D_i}"} />
  </div>
</MathJax.Provider>


## 5. Referenzen

Huff, D. L. (1963). A Probabilistic Analysis of Shopping Center Trade Areas. *Land Economics*, 39(1), 81–90.

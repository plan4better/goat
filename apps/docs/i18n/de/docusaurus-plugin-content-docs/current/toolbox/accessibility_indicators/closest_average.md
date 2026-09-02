---
sidebar_position: 3
---

import MathJax from 'react-mathjax';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Heatmap - Durchschnitt Reisezeit

Der **Heatmap - Durchschnitt Reisezeit** Indikator erstellt eine farbkodierte Karte zur Visualisierung der durchschnittlichen Reisekosten (Zeit oder Entfernung) zu Punkten (etwa Einrichtungen) oder Polygonen (etwa Parks) aus umliegenden Gebieten.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="https://www.youtube.com/embed/azIe5etz5sM?si=MIHjuHZNlR3D6f6T&amp;start=46" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

## 1. Erklärung

Die Heatmap zeigt ein farbkodiertes sechseckiges Raster, das **die durchschnittlichen Reisekosten zu Zielen (Gelegenheiten)** anhand realer Verkehrsnetze darstellt. Sie können das **Verkehrsmittel**, die **Maßeinheit (Zeit oder Entfernung)**, den **Gelegenheits-Layer**, die **Anzahl der Ziele** und das **Reisekostenlimit** spezifizieren, um die Visualisierung zu erstellen.

- Der Gelegenheits-Layer enthält punkt- oder polygonbasierte Ziele (POIs, Haltestellen, Schulen, Einrichtungen, Parks oder benutzerdefinierte Daten), **für die Sie die Erreichbarkeit analysieren möchten**. Sie können mehrere Gelegenheits-Layer verwenden, die zu einer einheitlichen Heatmap kombiniert werden.

- Mit <code>Anzahl der Ziele</code> begrenzen Sie die Berechnung der durchschnittlichen Reisekosten auf bis zu *n* nächstgelegene Gelegenheiten. So erhalten Sie eine gezieltere Erreichbarkeitsanalyse.

:::tip

**Hauptunterschied:** Heatmaps zeigen den *Zugang* von vielen Ausgangspunkten zu spezifischen Zielen, während Einzugsgebiete die *Reichweite* von spezifischen Ausgangspunkten zu vielen Zielen zeigen.

:::


:::info

Die Heatmap-Berechnung ist für `Walk`, `Bicycle`, `Pedelec` und `Auto` in **über 30 europäischen Ländern** verfügbar. Für `Öffentliche Verkehrsmittel` werden Deutschland, die Schweiz und die Region Haut-Rhin in Frankreich unterstützt. Wenn Sie Analysen außerhalb dieser Regionen benötigen, [kontaktieren Sie uns](https://plan4better.de/de/contact/) gerne.

:::

## 2. Anwendungsbeispiele

 - Haben Bewohner in bestimmten Gebieten längere durchschnittliche Reisezeiten zu Einrichtungen als andere?

 - Wie variiert die durchschnittliche Reisezeit zu Einrichtungen zwischen verschiedenen Verkehrsmitteln?

 - Wie variiert die durchschnittliche Reisezeit zwischen verschiedenen Arten von Einrichtungen?
 
 - Wenn Standards verlangen, dass eine Mindestanzahl von Einrichtungen innerhalb einer bestimmten Reisezeit zugänglich sein muss, welche Gebiete erfüllen diese Standards?

## 3. Wie verwendet man den Indikator?

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Werkzeuge</code> <img src={require('/img/icons/toolbox.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Unter <code>Erreichbarkeitsindikatoren</code> klicken Sie auf <code>Heatmap Durchschnitt Reisezeit</code>.</div>
</div>

### Routing & Konfiguration

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie ein <code>Verkehrsmittel</code> welches Sie für die Heatmap anwenden möchten.</div>
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

</TabItem>

<TabItem value="public transport" label="Öffentlicher Verkehr (ÖV)" className="tabItemBox">

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie die zu analysierenden <code>ÖV-Modi</code>: Bus, Straßenbahn, Bahn, U-Bahn, Fähre, Seilbahn, Gondel und/oder Standseilbahn. Wählen Sie anschließend <code>Tag</code> und <code>Ankunftszeit</code> für die Analyse. Berücksichtigt werden die besten ÖV-Fahrten, die die Gelegenheiten bis zu dieser Zeit erreichen.</div>
</div>

</TabItem>
</Tabs>

#### Erweiterte Optionen

Optional können Sie <code>Erweiterte Optionen</code> aktivieren, um weitere Einstellungen für Routing und Heatmap-Erstellung vorzunehmen.

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Wählen Sie ein <code>Referenzgebiet</code> — einen Polygon-Layer, der Ihr Untersuchungsgebiet darstellt. Wenn festgelegt, erweitert sich die Heatmap auf alle H3-Zellen innerhalb dieses Polygons; nicht erreichbare Zellen erhalten den Wert <code>NULL</code> und zeigen so Versorgungslücken und unterversorgte Gebiete auf.</div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Konfigurieren Sie verschiedene Routing-Optionen für das gewählte Verkehrsmittel, etwa Reisegeschwindigkeit, maximale Anzahl an Umstiegen, Zu- und Abgangslimits und mehr. Weitere Informationen zu verkehrsmittelspezifischen Optionen finden Sie im Abschnitt <a href="/docs/category/routing">Routing</a>.</div>
</div>

### Gelegenheiten

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Wählen Sie Ihren <code>Eingabe-Layer</code> aus dem Dropdown-Menü. Dies kann jeder zuvor erstellte Layer mit punkt- oder polygonbasierten Daten sein.</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Geben Sie ein <code>Limit</code> in Minuten oder Metern für Ihre Heatmap ein. Dieses wird entsprechend dem zuvor gewählten Verkehrsmittel und der gewählten Maßeinheit verwendet.</div>
</div>

:::tip Hint

Brauchen Sie Hilfe bei der Wahl eines geeigneten Reisezeitlimits für verschiedene gängige Einrichtungen? Das ["Standort-Werkzeug"](https://www.chemnitz.de/chemnitz/media/unsere-stadt/verkehr/verkehrsplanung/vep2040_standortwerkzeug.pdf) der Stadt Chemnitz kann hilfreiche Leitlinien bieten.

:::

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Geben Sie die <code>Anzahl der Ziele</code> an, die beim Berechnen der durchschnittlichen Reisekosten berücksichtigt werden sollen.</div>
</div>

<div class="step">
  <div class="step-number">10</div>
  <div class="content">Optional können Sie auf <code>+ Gelegenheit hinzufügen</code> klicken, um weitere Gelegenheits-Layer hinzuzufügen. Jeder Layer kann unterschiedliche Reisekostenlimits und Anzahl der Ziele für eine Multi-Kriterien-Analyse haben.</div>
</div>

### Ergebnis-Layer

<div class="step">
  <div class="step-number">11</div>
  <div class="content">Legen Sie den <code>Name der Ergebnislayer</code> für den Ausgabe-Heatmap-Layer fest.</div>
</div>

<div class="step">
  <div class="step-number">12</div>
  <div class="content">Klicken Sie auf <code>Ausführen</code>, um die Berechnung der Heatmap zu beginnen.</div>
</div>

### Ergebnisse

Sobald die Berechnung abgeschlossen ist, wird ein Ergebnislayer zur Karte hinzugefügt. **Durch Klicken auf eine der sechseckigen Zellen der Heatmap wird der berechnete Durchschnittswert der Reisekosten für diese Zelle angezeigt**.


<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/toolbox/accessibility_indicators/heatmaps/closest_average_based/clst-avg-calculation.gif').default} alt="Heatmap Durchschnitt Reisezeit Berechnung" style={{width: "auto", height: "400px", objectFit: "cover"}}/>
</div>

## 4. Technische Details

### Zellkosten

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/shared/cell_cost_assignment.png').default} alt="Zuordnung der Zellkosten" style={{ maxHeight: "400px", maxWidth: "auto"}}/>
</div>

<p></p>

Wenn mehrere Kanten (Straßen) des Straßennetzes eine sechseckige Zelle schneiden, werden die Kosten der Zelle als **Minimum aller Kantenkosten** innerhalb dieser Zelle berechnet. Für die Heatmap Durchschnitt Reisezeit wird dieser Kostenwert (dargestellt durch **tᵢⱼ**) anschließend gemäß der im folgenden Abschnitt beschriebenen Formel verwendet, um die durchschnittlichen Reisekosten (Zeit oder Entfernung) jeder Zelle zu bestimmen.

### Berechnung

**Nachdem alle Gelegenheits-Layer kombiniert wurden** (z.B. Schulen, Geschäfte oder Parks), erstellt das Tool **ein Gitter aus sechseckigen Zellen um das Gebiet**. **Es werden nur Zellen einbezogen, in denen mindestens eine Gelegenheit basierend auf dem gewählten** **Verkehrsmittel** (z.B. zu Fuß, Fahrrad) und **Reisekostenlimit** (z.B. 15 Minuten) erreichbar ist.

Dann werden für jede Zelle die durchschnittlichen Reisekosten zu den **nächsten n Zielen** (wie in den Einstellungen festgelegt) berechnet.

Die Formel für die durchschnittliche Reisezeit lautet:

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={"\\overline{t}_i = \\frac{\\sum_{j=1}^{n} t_{ij}}{n}"} />
  </div>
</MathJax.Provider>

Für jede Zelle (**i**) summiert das Tool die Reisezeiten (**tij**) zu allen erreichbaren Gelegenheiten (**j**), bis zu **n** davon, und teilt durch **n**, um die durchschnittliche Reisezeit zu erhalten.

### Klassifizierung
Um die berechneten Erreichbarkeitswerte für jede Rasterzelle zu klassifizieren, wird standardmäßig eine Klassifizierung auf Basis von Quantilen verwendet. Es können jedoch auch verschiedene andere Klassifizierungsmethoden eingesetzt werden. Weitere Informationen finden Sie im Abschnitt **[Datenklassifizierungsmethoden](../../map/layer_style/style/attribute_based_styling#datenklassifizierungsmethoden)** auf der Seite *Attributbasiertes Styling*.

### Visualisierung

Heatmaps in GOAT nutzen die **[Uber H3 Gitter-basierte](../../further_reading/glossary#h3-gitter)** Lösung für effiziente Berechnungen und eine leicht verständliche Visualisierung. Hinter den Kulissen wird die Erreichbarkeit direkt zur Laufzeit von GOATs eigener Routing-Engine berechnet. Für jedes *Verkehrsmittel* routet die Engine von den Gelegenheiten ausgehend nach außen, um die erreichbaren H3-Zellen und deren Reisekosten zu ermitteln, und aggregiert diese anschließend zu einem Erreichbarkeitswert pro Zelle. Der öffentliche Verkehr nutzt die RAPTOR-basierte Engine, während die Verkehrsträger der aktiven Mobilität und das Auto GOATs Dijkstra-Implementierung verwenden.

Die Auflösung und die Dimensionen des verwendeten sechseckigen Gitters hängen vom gewählten *Verkehrsmittel* ab:

| Verkehrsmittel | Auflösung | Durchschnittliche Sechseckfläche | Durchschnittliche Kantenlänge |
|----------------|-----------|----------------------------------|-------------------------------|
| Walk | 10 | 11.285,6 m² | 65,9 m |
| Bicycle | 9 | 78.999,4 m² | 174,4 m |
| Pedelec | 9 | 78.999,4 m² | 174,4 m |
| Car | 8 | 552.995,7 m² | 461,4 m |
| Public Transport | 9 | 78.999,4 m² | 174,4 m |

:::tip Tipp

Für weitere Einblicke in den Routing-Algorithmus besuchen Sie [Routing](../../category/routing). Außerdem können Sie diese [Publikation](https://doi.org/10.1016/j.jtrangeo.2021.103080) einsehen.

:::

### Beispiel für die Berechnung

Die folgenden Beispiele illustrieren die Berechnung einer Heatmap Durchschnitt Reisezeit für die gleichen Gelegenheiten, mit einem variierenden Wert für die `Anzahl der Ziele`.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/closest_average_based/cls-avg-destinations.png').default} alt="Heatmap Durchschnitt Reisezeit für verschiedene Ziele" style={{ maxHeight: "auto", maxWidth: "80%"}}/>
</div>

<p></p>

Im ersten Beispiel wird die durchschnittliche Reisezeit nur für das nächstgelegene Ziel berechnet, während im zweiten Beispiel die 5 nächstgelegenen Ziele berücksichtigt werden.

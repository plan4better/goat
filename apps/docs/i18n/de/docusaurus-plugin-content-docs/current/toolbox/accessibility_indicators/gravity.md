---
sidebar_position: 2
---
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

import MathJax from 'react-mathjax';

# Heatmap - Gravity

Der Indikator Heatmap - Gravity **erzeugt eine farbcodierte Karte zur Visualisierung der Erreichbarkeit von Punkten (etwa Einrichtungen) oder Polygonen (etwa Parks) aus umliegenden Gebieten**.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="https://www.youtube.com/embed/WhMbwt5j-Jc?si=gM8F-3nu-lvUOnsq&amp;start=46" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

## 1. Erklärung

Die Heatmap Gravity zeigt ein **farbcodiertes hexagonales Raster, das die Erreichbarkeit von Zielen (Gelegenheiten) basierend auf Reisekosten (Zeit oder Entfernung) und Attraktivität der Ziele darstellt**. Die Erreichbarkeit wird mit realen Verkehrsnetzen und einer gravitationsbasierten Formel berechnet, die widerspiegelt, wie die Reisebereitschaft mit zunehmender Entfernung abnimmt.

Sie können das **Verkehrsmittel**, den **Gelegenheits-Layer**, das **Reisekostenlimit** sowie die **Sensitivität** und das **Destinationspotenzial** einstellen, um die Berechnung der Erreichbarkeit zu verfeinern.

- Der **Gelegenheits-Layer enthält punktbasierte Zieldaten** (wie POIs, Haltestellen, Schulen, Einrichtungen oder benutzerdefinierte Punkte). Sie können mehrere Ziel-Layer auswählen, die zu einer einzigen Heatmap kombiniert werden.

- Die **Sensitivität steuert, wie schnell die Erreichbarkeit mit zunehmenden Reisekosten abnimmt**, während das **Destinationspotenzial es ermöglicht, Zielen mit höherer Kapazität oder Qualität mehr Gewicht zu geben** (z. B. ein größerer Supermarkt oder eine Haltestelle mit mehr Abfahrten). Zusammen mit der gewählten **Widerstandsfunktion definieren diese Einstellungen, wie die Erreichbarkeit berechnet wird**.

- Der **Potenzialtyp** bestimmt, wie das Gewicht jedes Ziels abgeleitet wird: Mit **Constant** wird allen Zielen der gleiche Wert zugewiesen, oder mit **Field** wird ein numerisches Attribut aus dem Eingabe-Layer verwendet (z. B. Abfahrten, Sitzplätze oder Kapazität).

- Mit dem **Destinationspotenzial können bestimmte Ziele priorisiert werden**. Zum Beispiel kann ein größerer, aber weiter entfernter Supermarkt höher bewertet werden als ein kleinerer in der Nähe. So können qualitative Informationen – wie Größe, Frequenz oder Servicelevel – in die Berechnung einfließen, was zu einer realistischeren Heatmap führt.

Beeinflusst durch all diese Eigenschaften kann **die Erreichbarkeit eines Punktes komplexes reales menschliches Verhalten modellieren** und ist ein leistungsfähiges Maß für Verkehrs- und Erreichbarkeitsplanung.

:::tip

**Wichtiger Unterschied:** Im Gegensatz zur *Heatmap Durchschnitt Reisezeit*, die den Reiseaufwand misst, zeigt die *Gravity-basierte Heatmap* die **Attraktivität** – also wie erreichbar und anziehend Ziele sind, wenn sowohl Entfernung als auch Qualität berücksichtigt werden.

:::


:::info

Die Heatmap-Berechnung ist für `Walk`, `Bicycle`, `Pedelec` und `Auto` in **über 30 europäischen Ländern** verfügbar. Für `Öffentliche Verkehrsmittel` werden Deutschland, die Schweiz und die Region Haut-Rhin in Frankreich unterstützt. Wenn Sie Analysen außerhalb dieser Regionen benötigen, [kontaktieren Sie uns](https://plan4better.de/de/contact/) gerne.

:::

## 2. Beispielanwendungen

 - Welche Stadtteile oder Gebiete haben eingeschränkten Zugang zu öffentlichen Einrichtungen wie Parks, Freizeiteinrichtungen oder kulturellen Institutionen und benötigen gezielte Maßnahmen zur Verbesserung der Erreichbarkeit?

 - Gibt es Bereiche mit hohem Potenzial für eine verkehrsorientierte Entwicklung oder Möglichkeiten zur Verbesserung der Infrastruktur für den nicht-motorisierten Verkehr, wie Radwege oder fußgängerfreundliche Straßen?

 - Wie wirkt sich eine neue Einrichtung auf die lokale Erreichbarkeit aus?

 - Gibt es Potenzial, die Verfügbarkeit von Diensten wie Fahrrad- oder Carsharing-Stationen zu erweitern?

## 3. Wie benutzt man den Indikator?

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Werkzeuge</code> <img src={require('/img/icons/toolbox.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>. </div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Im Menü <code>Erreichbarkeitsindikatoren</code> klicken Sie auf <code>Heatmap Gravity</code>.</div>
</div>

### Routing & Konfiguration

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie das <code>Verkehrsmittel</code> für die Heatmap aus.</div>
</div>

| Verkehrsmittel | Berücksichtigt |
|----------------|----------------|
| Zu Fuß | Alle zu Fuß begehbaren Wege |
| Fahrrad | Alle mit dem Fahrrad befahrbaren Wege (unter Berücksichtigung von Oberfläche und Steigung) |
| Pedelec | Alle mit dem Pedelec befahrbaren Wege (unter Berücksichtigung von Oberfläche und Steigung) |
| Auto | Alle mit dem Auto befahrbaren Wege (unter Berücksichtigung von Tempolimits und Einbahnstraßen) |
| Öffentlicher Verkehr | Alle mit dem ÖV möglichen Fahrten (gemäß offiziellen GTFS-Fahrplänen), unter Berücksichtigung von Zu- und Abgang zu Fuß zu und von den Haltestellen |

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie die <code>Widerstandsfunktion</code> für die Heatmap aus.</div>
</div>

<Tabs>

<TabItem value="gaussian" label="Gauß" default className="tabItemBox">

Diese Funktion berechnet die Erreichbarkeit basierend auf einer Gaußschen Kurve, die von der `Sensitivität` und dem `Destinationspotenzial` beeinflusst wird. Für weitere Details siehe den Abschnitt [Technische Details](#4-technische-details).

</TabItem>
  
<TabItem value="linear" label="Linear" default className="tabItemBox">

Diese Funktion hält eine direkte Korrelation zwischen Reisezeit und Erreichbarkeit aufrecht, die durch das von Ihnen angegebene `Destinationspotenzial` moduliert wird. Für weitere Details siehe den Abschnitt [Technische Details](#4-technische-details).

</TabItem>

<TabItem value="exponential" label="Exponential" default className="tabItemBox">

Diese Funktion berechnet die Erreichbarkeit basierend auf einer exponentiellen Kurve, die von der `Sensitivität` und dem `Destinationspotenzial` beeinflusst wird. Für weitere Details siehe den Abschnitt [Technische Details](#4-technische-details).

</TabItem>

<TabItem value="power" label="Potenz" default className="tabItemBox">

Diese Funktion berechnet die Erreichbarkeit basierend auf einer Potenzkurve, die von der `Sensitivität` und dem `Destinationspotenzial` beeinflusst wird. Für weitere Details siehe den Abschnitt [Technische Details](#4-technische-details).

</TabItem>

<TabItem value="cumulative" label="Kumulativ" default className="tabItemBox">

Diese Funktion zählt jedes Ziel innerhalb des Reisezeitlimits gleich und wendet keinen Distanzabfall an: Ziele, die innerhalb des Limits erreichbar sind, erhalten das volle Gewicht (moduliert durch ihr `Destinationspotenzial`), während weiter entfernte Ziele unberücksichtigt bleiben. Der Parameter `Sensitivität` wird dabei nicht verwendet. Für weitere Details siehe den Abschnitt [Technische Details](#4-technische-details).

</TabItem>

</Tabs>

<Tabs>
<TabItem value="active-car" label="Zu Fuß / Fahrrad / Pedelec / Auto" default className="tabItemBox">

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Wählen Sie im Menü <code>Berechnung nach</code>, ob die Reisekosten als Zeit (Minuten) oder als Entfernung (Meter) gemessen werden.</div>
</div>

</TabItem>

<TabItem value="public transport" label="Öffentlicher Verkehr (ÖV)" className="tabItemBox">

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Wählen Sie die zu analysierenden <code>ÖV-Modi</code>: Bus, Straßenbahn, Bahn, U-Bahn, Fähre, Seilbahn, Gondel und/oder Standseilbahn. Wählen Sie anschließend <code>Tag</code> und <code>Ankunftszeit</code> für die Analyse. Berücksichtigt werden die besten ÖV-Fahrten, die die Gelegenheiten bis zu dieser Zeit erreichen.</div>
</div>

</TabItem>
</Tabs>

#### Erweiterte Optionen

Optional können Sie <code>Erweiterte Optionen</code> aktivieren, um weitere Einstellungen für Routing und Heatmap-Erstellung vorzunehmen.

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Wählen Sie ein <code>Referenzgebiet</code> — einen Polygon-Layer, der Ihr Untersuchungsgebiet darstellt. Wenn festgelegt, erweitert sich die Heatmap auf alle H3-Zellen innerhalb dieses Polygons; nicht erreichbare Zellen erhalten den Wert <code>NULL</code> und zeigen so Versorgungslücken und unterversorgte Gebiete auf.</div>
</div>

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Konfigurieren Sie verschiedene Routing-Optionen für das gewählte Verkehrsmittel, etwa Reisegeschwindigkeit, maximale Anzahl an Umstiegen, Zu- und Abgangslimits und mehr. Weitere Informationen zu verkehrsmittelspezifischen Optionen finden Sie im Abschnitt <a href="/docs/category/routing">Routing</a>.</div>
</div>

### Gelegenheiten

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Wählen Sie Ihren <code>Eingabe-Layer</code> aus dem Dropdown-Menü. Dies kann jeder zuvor erstellte Layer mit punktbasierten Daten sein.</div>
</div>

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Geben Sie ein <code>Limit</code> für die Reisekosten Ihrer Heatmap ein. Dieses wird im Kontext des zuvor gewählten <i>Verkehrsmittels</i> verwendet.</div>
</div>

:::tip Hinweis

Benötigen Sie Hilfe bei der Wahl eines geeigneten Reisezeitlimits für verschiedene Einrichtungen? Das ["Standort-Werkzeug"](https://www.chemnitz.de/chemnitz/media/unsere-stadt/verkehr/verkehrsplanung/vep2040_standortwerkzeug.pdf) der Stadt Chemnitz bietet hilfreiche Orientierung.

:::

<div class="step">
  <div class="step-number">10</div>
  <div class="content">Wählen Sie den <code>Potenzialtyp</code>, um zu bestimmen, wie jedes Ziel gewichtet wird:
    <ul>
      <li><b>Constant</b> — alle Ziele erhalten das gleiche Gewicht. Geben Sie einen numerischen Wert ein (Standard: 1.0).</li>
      <li><b>Field</b> — verwenden Sie ein numerisches Feld aus dem <i>Eingabe-Layer</i> als Gewicht (z. B. Anzahl der Abfahrten, Sitzplätze oder Kapazität).</li>
    </ul>
  </div>
</div>

<div class="step">
  <div class="step-number">11</div>
  <div class="content">Geben Sie einen <code>Sensitivitätswert</code> an. Dieser muss numerisch sein und wird von der Heatmap-Funktion verwendet, um zu bestimmen, wie sich die Erreichbarkeit mit zunehmender Reisezeit verändert.</div>
</div>

:::tip Hinweis

**Wie wählt man den Sensitivitätswert?**

Der beste **Sensitivitätswert (β)** hängt von Ihrer Analyse ab – es gibt keine einzig richtige Zahl. Er definiert **wie schnell die Erreichbarkeit mit zunehmender Reisezeit abnimmt**.

- **Niedriges β (Stadt):** Verwenden Sie einen niedrigeren Wert für Analysen auf Stadtebene. Die Erreichbarkeit sinkt schneller mit der Entfernung, was für städtische Kontexte passt, in denen viele Ziele in der Nähe sind und meist das nächste gewählt wird.
- **Hohes β (Region):** Verwenden Sie einen höheren Wert für Analysen auf regionaler oder ländlicher Ebene. Die Erreichbarkeit nimmt langsamer ab, da Menschen bereit sind, längere Strecken zu reisen, wenn es weniger Optionen gibt.

Eine visuelle Erklärung, wie die Sensitivität die Berechnung beeinflusst, finden Sie im Abschnitt **[Berechnung](#berechnung)**.

:::

### Ergebnis-Layer

<div class="step">
  <div class="step-number">12</div>
  <div class="content">Legen Sie den <code>Name der Ergebnislayer</code> für den Ausgabe-Heatmap-Layer fest.</div>
</div>

<div class="step">
  <div class="step-number">13</div>
  <div class="content">Klicken Sie auf <code>Ausführen</code>, um die Berechnung der Heatmap zu starten.</div>
</div>

### Ergebnisse

Nach Abschluss der Berechnung wird ein Ergebnis-Layer zur Karte hinzugefügt. Dieser <i>Heatmap Gravity</i>-Layer enthält Ihre farbcodierte Heatmap. Ein Klick auf eine der hexagonalen Zellen zeigt den berechneten Erreichbarkeitswert für diese Zelle an.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/gravity_based/gravity_calculation.gif').default} alt="Heatmap Gravity-basierte Berechnung in GOAT" style={{ maxHeight: "auto", maxWidth: "80%"}}/> </div>

<p></p>

:::tip Tipp

Möchten Sie visuell ansprechende Karten erstellen, die eine klare Geschichte erzählen? Erfahren Sie, wie Sie Farben, Legenden und Stil in unserem [Stil-Abschnitt](../../map/layer_style/style/styling) anpassen können.

:::

### Beispielrechnung

Das folgende Beispiel zeigt, wie sich Änderungen in den Ziel-Einstellungen auf die Gravity-Heatmap auswirken. Das Destinationspotenzial basiert auf der Gesamtzahl der stündlichen ÖPNV-Abfahrten von einer Haltestelle.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/gravity_based/gravity_calculation_comparison.png').default} alt="gravity-no-destination-potential" style={{ maxHeight: "auto", maxWidth: "80%"}}/>
</div>

<p></p>

Die hintere Karte ist ohne Destinationspotenzial berechnet. Die zweite Karte verwendet die gleichen Einstellungen, aber mit Destinationspotenzial basierend auf der Gesamtzahl der Abfahrten. Dadurch ändern sich die Erreichbarkeitswerte jeder Hexagonzelle und sie verteilen sich in einem breiteren Bereich, da der höchste Wert noch weiter steigt. **Höhere Erreichbarkeitswerte konzentrieren sich um die Haltestellen mit mehr Abfahrten (rote Punkte).**

## 4. Technische Details

### Zellkosten

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/shared/cell_cost_assignment.png').default} alt="Zuordnung der Zellkosten" style={{ maxHeight: "400px", maxWidth: "auto"}}/>
</div>

<p></p>

Wenn mehrere Kanten (Straßen) des Straßennetzes eine sechseckige Zelle schneiden, werden die Kosten der Zelle als **Minimum aller Kantenkosten** innerhalb dieser Zelle berechnet. Für die gravitationsbasierte Heatmap wird dieser Kostenwert (dargestellt durch **tᵢⱼ**) anschließend gemäß der im folgenden Abschnitt beschriebenen Formel verwendet, um die Erreichbarkeit jeder Zelle zu bestimmen.

### Berechnung
Der Erreichbarkeitswert für jede hexagonale Zelle wird mit einer **gravitationsbasierten Formel** berechnet, die schätzt, wie stark Ziele jeden Standort beeinflussen.

**Formel zur Erreichbarkeit:**

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px'  }}>
    <MathJax.Node formula={"A_i=\\sum_j O_jf(t_{i,j})"} />
  </div>
</MathJax.Provider>

Einfach gesagt, die Erreichbarkeit (**A**) einer Zelle (**i**) hängt ab von:
- der **Anzahl oder Bedeutung der Ziele** (**O**) in der Nähe und  
- der **Reisezeit** (**tᵢⱼ**) zu diesen Zielen.

Die Funktion **f(tᵢⱼ)** reduziert den Einfluss weiter entfernter Ziele – dies ist die **Widerstandsfunktion**. In GOAT können Sie zwischen verschiedenen Widerstandstypen wählen: `Gauß`, `Linear`, `Exponential`, `Potenz` oder `Kumulativ`.

und einstellen, wie stark die Entfernung die Erreichbarkeit beeinflusst, mit dem **Sensitivitätsparameter (β)**. Falls ein **Destinationspotenzial** enthalten ist, erhöht dies zusätzlich das Gewicht von Zielen mit höherer Kapazität oder Qualität (z. B. größere Geschäfte oder häufige Haltestellen).

#### GOAT verwendet folgende Formeln für die Widerstandsfunktionen:

*Modifizierte Gaußfunktion, (Kwan,1998):*

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px'  }}>
    <MathJax.Node formula={"f(t_{i,j})=\\exp^{(-t_{i,j}^2/\\beta)}"} />
  </div>
</MathJax.Provider>

:::tip Profi-Tipp

Studien zeigen, dass der Zusammenhang zwischen Reisezeit und Erreichbarkeit oft nicht linear ist. Das bedeutet, dass Menschen bereit sind, eine kurze Strecke zu einem Ziel zu gehen, aber mit zunehmender Entfernung sinkt die Bereitschaft oft überproportional.

Mit der von Ihnen gewählten *Sensitivität* ermöglicht die Gaußfunktion, dieses reale Verhalten genauer zu modellieren.

:::

*Kumulative Chancen Linear, (Kwan,1998):*
<div>
<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={`
      f(t_{ij}) =
      \\begin{cases}
        1 - \\frac{t_{ij}}{\\bar{t}} & \\text{für } t_{ij} \\leq \\bar{t} \\\\
        0 & \\text{sonst}
      \\end{cases}
    `} />
  </div>
</MathJax.Provider>
  </div>    

*Negative Exponentialfunktion, (Kwan,1998):*

<div><MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px'  }}>
    <MathJax.Node formula={"f(t_{i,j})=\\exp^{(-\\beta t_{i,j})}"} />
  </div>
</MathJax.Provider>
    </div>  

*Inverse Potenzfunktion, (Kwan,1998) (`Potenz` in GOAT):*

<div>
<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={`f(t_{ij}) = \\begin{cases}
      \\ 1 & \\text{für } t_{ij} \\leq 1 \\\\
      t_{i,j}^{-\\beta} & \\text{sonst}
    \\end{cases}`}/>
  </div>
</MathJax.Provider>
</div>  

*Kumulative Gelegenheiten (`Kumulativ` in GOAT):*

<div>
<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={`f(t_{ij}) = \\begin{cases}
      1 & \\text{für } t_{ij} \\leq \\bar{t} \\\\
      0 & \\text{sonst}
    \\end{cases}`}/>
  </div>
</MathJax.Provider>
</div>

Anders als die übrigen Funktionen wendet die kumulative Funktion **keinen Distanzabfall** innerhalb des Reisezeitlimits **t̄** an: Jedes erreichbare Ziel zählt gleich. Sie verwendet daher den Parameter *Sensitivität (β)* nicht – sie zählt einfach die innerhalb des Limits erreichbaren Gelegenheiten.

Reisezeiten werden in Minuten gemessen. Für ein maximales Reisezeitlimit von 30 Minuten werden Ziele, die weiter entfernt sind, als nicht erreichbar betrachtet und gehen nicht in die Berechnung ein. Der *Sensitivitätsparameter* bestimmt, wie sich die Erreichbarkeit mit zunehmender Reisezeit verändert. Da der *Sensitivitätsparameter* entscheidend für die Messung der Erreichbarkeit ist, können Sie diesen in GOAT einstellen. Das Diagramm zeigt, wie die Bereitschaft zu Fuß zu gehen mit zunehmender Reisezeit je nach gewählter Widerstandsfunktion und Sensitivitätswert (β) abnimmt.

import ImpedanceFunction from '@site/src/components/ImpedanceFunction';

<div style={{ display: 'block', textAlign: 'center'}}>
  <div style={{ maxHeight: "auto", maxWidth: "auto"}}>
    <ImpedanceFunction />
   </div> 
</div>

### Klassifizierung
Um die berechneten Erreichbarkeitswerte für jede Rasterzelle (zur farbcodierten Darstellung) zu klassifizieren, wird standardmäßig eine **Klassifizierung in 8 Quantilgruppen** verwendet. Das bedeutet, jede Farbe deckt 12,5 % der Rasterzellen ab. Der Bereich außerhalb des berechneten Layers hat innerhalb der definierten Reisezeit keinen Zugang.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/gravity_based/gravity_default_classification_de.png').default} alt="gravity-default-classification" style={{ maxHeight: "auto", maxWidth: "40%"}}/>
</div>

<p></p>

Es können jedoch auch andere Klassifizierungsmethoden verwendet werden. Mehr dazu im Abschnitt **[Datenklassifizierungsmethoden](../../map/layer_style/style/attribute_based_styling#data-classification-methods)** der Seite *Attributbasierte Darstellung*.

### Visualisierung

Heatmaps in GOAT nutzen die **[Uber H3 grid-basierte](../../further_reading/glossary#h3-grid)** Lösung für effiziente Berechnung und leicht verständliche Visualisierung. Im Hintergrund wird die Erreichbarkeit direkt zur Laufzeit von GOATs eigener Routing-Engine berechnet. Für jedes *Verkehrsmittel* routet die Engine von den Gelegenheiten ausgehend nach außen, um die erreichbaren H3-Zellen und deren Reisekosten zu ermitteln, und aggregiert diese anschließend zu einem Erreichbarkeitswert pro Zelle. Der öffentliche Verkehr nutzt die RAPTOR-basierte Engine, während die Verkehrsträger der aktiven Mobilität und das Auto GOATs Dijkstra-Implementierung verwenden.

Die Auflösung und Dimensionen des verwendeten hexagonalen Rasters hängen vom gewählten *Verkehrsmittel* ab:

| Verkehrsmittel | Auflösung | Durchschnittliche Sechseckfläche | Durchschnittliche Kantenlänge |
|----------------|-----------|----------------------------------|-------------------------------|
| Walk | 10 | 11.285,6 m² | 65,9 m |
| Bicycle | 9 | 78.999,4 m² | 174,4 m |
| Pedelec | 9 | 78.999,4 m² | 174,4 m |
| Car | 8 | 552.995,7 m² | 461,4 m |
| Public Transport | 9 | 78.999,4 m² | 174,4 m |

:::tip Hinweis

Für weitere Einblicke in den Routing-Algorithmus besuchen Sie [Routing](../../category/routing). Außerdem finden Sie eine [Publikation](https://doi.org/10.1016/j.jtrangeo.2021.103080).
:::

## 5. Literatur

Kwan, Mei-Po. 1998. „Space-Time and Integral Measures of Individual Accessibility: A Comparative Analysis Using a Point-Based Framework.“ Geographical Analysis 30 (3): 191–216. [https://doi.org/10.1111/j.1538-4632.1998.tb00396.x](https://doi.org/10.1111/j.1538-4632.1998.tb00396.x).

Vale, D.S., und M. Pereira. 2017. „The Influence of the Impedance Function on Gravity-Based Pedestrian Accessibility Measures: A Comparative Analysis.“ Environment and Planning B: Urban Analytics and City Science 44 (4): 740–63.  [https://doi.org/10.1177%2F0265813516641685](https://doi.org/10.1177%2F0265813516641685).

Higgins, Christopher D. 2019. „Accessibility Toolbox for R and ArcGIS.“ Transport Findings, Mai.  [https://doi.org/10.32866/8416](https://doi.org/10.32866/8416).

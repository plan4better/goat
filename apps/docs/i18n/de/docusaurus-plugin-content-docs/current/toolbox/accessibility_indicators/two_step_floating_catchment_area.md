---
sidebar_position: 5
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import MathJax from 'react-mathjax';

# Heatmap - 2SFCA

Die Heatmap 2SFCA (Two-Step Floating Catchment Area)-Methode **visualisiert räumliche Erreichbarkeit durch eine farbcodierte Karte, die Angebotskapazität und Nachfrage in einem Maß vereint**.

<!-- TODO: Add YouTube video embed when available
<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="VIDEO_URL" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>
-->

## 1. Erklärung

Die 2SFCA-Methode misst die **räumliche Erreichbarkeit unter Berücksichtigung von Angebot (Kapazität der Einrichtungen) und Nachfrage (Bevölkerung)**. Im Gegensatz zu einfachen Angebot-Nachfrage-Verhältnissen pro Verwaltungseinheit berücksichtigt 2SFCA grenzüberschreitende Zugänge – Menschen können Einrichtungen in benachbarten Gebieten erreichen, und Einrichtungen versorgen Bevölkerungsgruppen über ihren eigenen Bezirk hinaus.
Das Ergebnis ist ein **Verhältnis von Angebot zu Nachfrage auf der Ebene hexagonaler Rasterzellen**. Das Werkzeug arbeitet in zwei Schritten:

1. **Schritt 1 — Kapazitäts-Nachfrage-Verhältnisse:** Für jeden Standort einer Einrichtung wird berechnet, wie viel Kapazität im Verhältnis zur Gesamtnachfrage (Bevölkerung) in ihrem Einzugsgebiet verfügbar ist. Dies ergibt ein Angebot-Nachfrage-Verhältnis pro Einrichtung.

2. **Schritt 2 — Kumulative Erreichbarkeit:** Für jede Rasterzelle werden die Kapazitätsverhältnisse aller erreichbaren Einrichtungen summiert. Das Ergebnis zeigt, wie gut jeder Standort versorgt ist.

Sie können den **Routing-Modus**, **Gelegenheits-Layer** (mit Kapazitätsfeld), **Bedarfs-Layer** (mit Bevölkerungsfeld), **Reisezeitlimits** konfigurieren und zwischen drei **2SFCA-Varianten** wählen.
- Die **Gelegenheits-Layer enthalten Einrichtungsdaten** mit einem Kapazitätsattribut (z. B. Anzahl der Krankenhausbetten, Quadratmeter Verkaufsfläche, Schulplätze).

- Der **Bedarfs-Layer enthält Bevölkerungs- oder Nutzerdaten** (z. B. Einwohnerzahl, potenzielle Kunden), die die Nachfrage nach den Einrichtungen darstellen.

- Der **2SFCA-Typ** steuert, wie die Distanzgewichtung angewendet wird:
  - **Standard 2SFCA** verwendet binäre Einzugsgebiete (drinnen oder draußen) – alle Standorte innerhalb des Reisezeitlimits werden gleich gewichtet, unabhängig von ihrer tatsächlichen Entfernung zu den Einrichtungen. Dies liefert klare, einfache Angebot-Nachfrage-Verhältnisse.
  - **Enhanced 2SFCA (E2SFCA)** gewichtet mittels einer Widerstandsfunktion in beiden Berechnungsschritten, wodurch ein realistischer Distanzabfall entsteht, bei dem näher gelegene Einrichtungen stärker zur Erreichbarkeit beitragen als entfernte.
  - **Modified 2SFCA (M2SFCA)** verwendet quadrierte Widerstandsgewichte im zweiten Schritt, was eine noch stärkere Bevorzugung von Nähe erzeugt. Diese Variante betont stark nahegelegene Einrichtungen, berücksichtigt aber immer noch entfernte Optionen, was ideal ist, wenn Reisekomfort entscheidend ist.

:::tip

**Wesentlicher Unterschied:** Im Gegensatz zur *Gravitationsbasierten Heatmap*, die die allgemeine Erreichbarkeit von Zielen misst, modelliert die *2SFCA Heatmap* explizit das **Gleichgewicht von Angebot und Nachfrage** – und zeigt, wo die Kapazität im Verhältnis zur bedürftigen Bevölkerung ausreichend oder unzureichend ist.

:::


:::info

Die Heatmap-Berechnung ist für `Walk`, `Bicycle`, `Pedelec` und `Auto` in **über 30 europäischen Ländern** verfügbar. Für `Öffentliche Verkehrsmittel` werden Deutschland, die Schweiz und die Region Haut-Rhin in Frankreich unterstützt. Wenn Sie Analysen außerhalb dieser Regionen benötigen, [kontaktieren Sie uns](https://plan4better.de/de/contact/) gerne.

:::

## 2. Anwendungsfälle

- Welche Stadtteile sind in Bezug auf Kinderbetreuungseinrichtungen im Verhältnis zur bedürftigen Bevölkerung unterversorgt?

- Wo sollten neue Kitas gebaut werden, um Lücken im Gleichgewicht von Angebot und Nachfrage am besten zu schließen?

- Gibt es Gebiete, in denen die Schulkapazität angesichts der Anzahl schulpflichtiger Kinder im Einzugsgebiet unzureichend ist?

## 3. Vorgehensweise

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Werkzeuge</code> <img src={require('/img/icons/toolbox.png').default} alt="Optionen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>. </div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie im Menü <code>Erreichbarkeitsindikatoren</code> auf <code>Heatmap 2SFCA</code>.</div>
</div>

### Routing & Konfiguration

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie das <code>Verkehrsmittel</code>, das Sie für die Heatmap verwenden möchten.</div>
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


<div class="step">
  <div class="step-number">7</div>
  <div class="content">Wählen Sie den <code>2SFCA-Typ</code>, den Sie verwenden möchten.</div>
</div>

<Tabs>

<TabItem value="twosfca" label="Standard 2SFCA" default className="tabItemBox">

Die Standard 2SFCA-Methode verwendet **binäre Einzugsgebiete**: Eine Einrichtung versorgt einen Bevölkerungsstandort entweder (wenn innerhalb des Reisezeitlimits) oder nicht. Es gibt keine Distanzgewichtung – alle Standorte innerhalb des Einzugsgebiets werden gleich behandelt.

Dies ist die einfachste Variante und eignet sich gut, wenn Sie ein direktes Angebot-Nachfrage-Verhältnis wünschen.

</TabItem>

<TabItem value="e2sfca" label="Enhanced 2SFCA (E2SFCA)" className="tabItemBox">

Die Enhanced 2SFCA-Methode fügt eine **Reisewiderstandsgewichtung** unter Verwendung einer Widerstandsfunktion hinzu. In beiden Schritten werden Interaktionen danach gewichtet, wie weit Einrichtung und Bevölkerung voneinander entfernt sind – nähere Standorte erhalten ein höheres Gewicht. Dies führt zu realistischeren Ergebnissen und spiegelt wider, dass Menschen eher nahegelegene Einrichtungen nutzen.

Erfordert die Auswahl einer **Widerstandsfunktion** und eines **Sensitivitätswertes**.

</TabItem>

<TabItem value="m2sfca" label="Modified 2SFCA (M2SFCA)" className="tabItemBox">

Die Modified 2SFCA-Methode wendet **quadrierte Widerstandsgewichte** an, was einen noch stärkeren Distanzabfalleffekt erzeugt. Während Enhanced 2SFCA die Nähe mit einem relativen Gewichtungsansatz berücksichtigt, bezieht Modified 2SFCA durch Quadrieren der Widerstandsgewichte auch die absolute Distanzwirkung mit ein.

Erfordert die Auswahl einer **Widerstandsfunktion** und eines **Sensitivitätswertes**.

</TabItem>

</Tabs>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Wenn Sie <b>E2SFCA</b> oder <b>M2SFCA</b> verwenden, wählen Sie die <code>Widerstandsfunktion</code> für die Distanzgewichtung.</div>
</div>

<Tabs>

<TabItem value="gaussian" label="Gauß" default className="tabItemBox">

Berechnet Distanzgewichte unter Verwendung einer Gaußschen (glockenförmigen) Kurve. Die Erreichbarkeit nimmt für kurze Reisezeiten langsam ab und fällt jenseits eines bestimmten Schwellenwerts schnell ab. Dies ist die am häufigsten verwendete Widerstandsfunktion. Details siehe [Technische Details](#calculation).

</TabItem>

<TabItem value="linear" label="Linear" className="tabItemBox">

Behält eine direkte lineare Beziehung zwischen Reisezeit und Gewicht bei. Das Gewicht nimmt gleichmäßig von 1 (am Ursprung) bis 0 (bei maximaler Reisezeit) ab. Details siehe [Technische Details](#calculation).

</TabItem>

<TabItem value="exponential" label="Exponentiell" className="tabItemBox">

Berechnet Gewichte unter Verwendung einer exponentiellen Abklingkurve, gesteuert durch den Sensitivitätsparameter. Höhere Sensitivitätswerte erzeugen ein langsameres Abklingen. Details siehe [Technische Details](#calculation).

</TabItem>

<TabItem value="power" label="Potenz" className="tabItemBox">

Berechnet Gewichte unter Verwendung einer Potenzfunktion. Der Sensitivitätsparameter steuert den Exponenten und bestimmt, wie schnell die Gewichte mit der Reisezeit abnehmen. Details siehe [Technische Details](#calculation).

</TabItem>

<TabItem value="cumulative" label="Kumulativ" className="tabItemBox">

Wendet innerhalb des Reisezeitlimits ein volles Gewicht von 1 auf jede Einrichtung an und 0 darüber hinaus, ohne Distanzabfall. Anders als die übrigen Funktionen verwendet sie den Sensitivitätsparameter nicht – alle erreichbaren Einrichtungen zählen gleich. Details siehe [Technische Details](#calculation).

</TabItem>

</Tabs>

### Bedarf

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Wählen Sie Ihren <code>Nachfrage-Layer</code> aus dem Dropdown-Menü. Dieser Layer sollte Bevölkerungs- oder Nutzerdaten enthalten (z. B. Zensusdaten mit Einwohnerzahlen).</div>
</div>

<div class="step">
  <div class="step-number">10</div>
  <div class="content">Wählen Sie das <code>Nachfragefeld</code> – ein numerisches Feld aus Ihrem Bedarfs-Layer, das die Anzahl potenzieller Nutzer darstellt (z. B. Bevölkerung, Anzahl der Haushalte).</div>
</div>

### Gelegenheiten

<div class="step">
  <div class="step-number">11</div>
  <div class="content">Wählen Sie Ihren <code>Eingabe-Layer</code> aus dem Dropdown-Menü. Dieser Layer sollte Standorte von Einrichtungen enthalten (z. B. Krankenhäuser, Schulen, Geschäfte).</div>
</div>

<div class="step">
  <div class="step-number">12</div>
  <div class="content">Legen Sie das <code>Reisezeitlimit</code> fest, das das maximale Einzugsgebiet in Minuten definiert.</div>
</div>

<div class="step">
  <div class="step-number">13</div>
  <div class="content">Wählen Sie einen <code>Potenzialtyp</code>, um festzulegen, wie die Kapazität jeder Einrichtung bestimmt wird:
    <ul>
      <li><b>Constant</b> — alle Einrichtungen haben die gleiche Kapazität. Geben Sie einen numerischen Wert ein (Standard: 1.0).</li>
      <li><b>Field</b> — verwenden Sie ein numerisches Feld aus dem <i>Eingabe-Layer</i> als Kapazität (z. B. Anzahl der Betten, Sitze oder Quadratmeter).</li>
    </ul>
  </div>
</div>

:::tip Hinweis

Benötigen Sie Hilfe bei der Auswahl einer geeigneten Reisezeitgrenze für verschiedene allgemeine Einrichtungen? Das ["Standort-Werkzeug"](https://www.chemnitz.de/chemnitz/media/unsere-stadt/verkehr/verkehrsplanung/vep2040_standortwerkzeug.pdf) der Stadt Chemnitz kann hilfreiche Orientierung bieten.

:::

<div class="step">
  <div class="step-number">14</div>
  <div class="content">Wenn Sie <b>E2SFCA</b> oder <b>M2SFCA</b> verwenden, geben Sie einen <code>Sensitivitätswert</code> an, um zu steuern, wie schnell die Widerstandsfunktion mit der Entfernung abfällt.</div>
</div>

<div class="step">
  <div class="step-number">15</div>
  <div class="content">Optional können Sie weitere Gelegenheiten hinzufügen, indem Sie auf <code>+ Hinzufügen Gelegenheiten</code> klicken. Mehrere Einrichtungstypen können in einer einzigen Analyse kombiniert werden.</div>
</div>

<div class="step">
  <div class="step-number">16</div>
  <div class="content">Optional können Sie unter <code>Erweiterte Optionen</code> ein <code>Referenzgebiet</code> auswählen — einen Polygon-Layer, der das vollständige Untersuchungsgebiet definiert. Wenn festgelegt, erweitert sich die Heatmap auf alle H3-Zellen innerhalb dieses Polygons; Zellen außerhalb der berechneten Erreichbarkeit werden als <code>NULL</code> dargestellt und zeigen so Versorgungslücken und unterversorgte Gebiete auf.</div>
</div>

### Ergebnis-Layer

<div class="step">
  <div class="step-number">17</div>
  <div class="content">Legen Sie den <code>Name der Ergebnislayer</code> für den Ausgabe-Heatmap-Layer fest.</div>
</div>

<div class="step">
  <div class="step-number">18</div>
  <div class="content">Klicken Sie auf <code>Ausführen</code>, um die Berechnung zu starten.</div>
</div>

### Ergebnisse

Sobald die Berechnung abgeschlossen ist, wird ein Ergebnis-Layer zur Karte hinzugefügt. Dieser *Heatmap 2SFCA*-Layer enthält ein farbcodiertes hexagonales Raster, wobei jede Zelle den berechneten Erreichbarkeitswert anzeigt – das Verhältnis von Angebot zu Nachfrage an diesem Standort.

- **Höhere Werte** weisen auf eine bessere Erreichbarkeit hin: Im Verhältnis zur lokalen Nachfrage ist mehr Angebotskapazität verfügbar.
- **Niedrigere Werte** weisen auf unterversorgte Gebiete hin: Die Bevölkerung übersteigt die verfügbare Kapazität der erreichbaren Einrichtungen.

Durch Klicken auf eine hexagonale Zelle wird deren berechneter Erreichbarkeitswert angezeigt.

<!--
<div style={{ display: 'flex', justifyContent: 'center' }}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/two_step_floating_catchment_area/2sfca.gif').default} alt="Heatmap 2SFCA Ergebnis in GOAT" style={{ maxHeight: "auto", maxWidth: "80%"}}/>
</div>
<p></p>
-->

:::tip Tipp

Möchten Sie visuell ansprechende Karten erstellen, die eine klare Geschichte erzählen? Erfahren Sie, wie Sie Farben, Legenden und Stile in unserem Abschnitt [Styling](../../map/layer_style/style/styling) anpassen können.

:::


### Berechnungsbeispiel

Das folgende Beispiel veranschaulicht, wie die 2SFCA-Methode für jeden Schritt funktioniert.

- **Schritt 1** berechnet ein Kapazitätsverhältnis für jedes Ziel: `R_j = S_j / Σ D_k` – die Kapazität des Ziels geteilt durch die Gesamtbevölkerung in seinem Einzugsgebiet. Ein Ziel mit 100 Betten, das 100 Personen versorgt, hat ein Verhältnis von 1.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/two_step_floating_catchment_area/step1_2sfca.png').default} alt="Heatmap 2SFCA Result in GOAT" style={{ maxHeight: "auto", maxWidth: "80%"}}/>
</div>
<p></p>

- **Schritt 2** summiert die Verhältnisse aller Ziele, die von jeder Zelle aus erreichbar sind. Eine Zelle, die zwei Ziele erreichen kann (Verhältnisse 1 und 0,4), erhält eine Erreichbarkeit von 1,4.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/two_step_floating_catchment_area/step2_2sfca.png').default} alt="Heatmap 2SFCA Result in GOAT" style={{ maxHeight: "auto", maxWidth: "80%"}}/>
</div>
<p></p>


## 4. Technische Details

### Zellkosten

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/shared/cell_cost_assignment.png').default} alt="Zuordnung der Zellkosten" style={{ maxHeight: "400px", maxWidth: "auto"}}/>
</div>

<p></p>

Wenn mehrere Kanten (Straßen) des Straßennetzes eine sechseckige Zelle schneiden, werden die Kosten der Zelle als **Minimum aller Kantenkosten** innerhalb dieser Zelle berechnet. Für die 2SFCA-Heatmap wird dieser Kostenwert (dargestellt durch **tᵢⱼ**) anschließend gemäß der in den folgenden Abschnitten beschriebenen Formeln verwendet.

### Berechnung

Die 2SFCA-Methode berechnet die Erreichbarkeit in zwei Schritten:

#### Schritt 1 — Kapazitäts-Nachfrage-Verhältnis

Für jeden Einrichtungsstandort *j* wird das Verhältnis seiner Kapazität zur Gesamtnachfrage in seinem Einzugsgebiet berechnet:

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={"R_j = \\frac{S_j}{\\sum_{k \\in \\{t_{kj} \\leq t_0\\}} D_k \\cdot f(t_{kj})}"} />
  </div>
</MathJax.Provider>

Wobei:
- *R<sub>j</sub>* = Kapazitäts-Nachfrage-Verhältnis der Einrichtung *j*
- *S<sub>j</sub>* = Kapazität (Angebot) der Einrichtung *j*
- *D<sub>k</sub>* = Nachfrage (Bevölkerung) am Standort *k*
- *t<sub>kj</sub>* = Reisezeit vom Standort *k* zur Einrichtung *j*
- *t<sub>0</sub>* = Reisezeitlimit (maximales Einzugsgebiet)
- *f(t<sub>kj</sub>)* = Widerstandsfunktion (Distanzgewicht)

#### Schritt 2 — Kumulative Erreichbarkeit

Für jede Rasterzelle *i* werden die Kapazitäts-Nachfrage-Verhältnisse aller erreichbaren Einrichtungen summiert:

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={"A_i = \\sum_{j \\in \\{t_{ij} \\leq t_0\\}} R_j \\cdot f(t_{ij})"} />
  </div>
</MathJax.Provider>

Wobei:
- *A<sub>i</sub>* = Erreichbarkeit am Standort *i*
- *R<sub>j</sub>* = Kapazitäts-Nachfrage-Verhältnis der Einrichtung *j* (aus Schritt 1)
- *f(t<sub>ij</sub>)* = Gewicht der Widerstandsfunktion

### 2SFCA-Varianten

Die drei Varianten unterscheiden sich darin, wie die Widerstandsfunktion *f(t)* angewendet wird:

| Variante | Schritt 1 | Schritt 2 |
|---------|--------------------------|--------------------------|
| **Standard 2SFCA** | *f(t) = 1* (binär) | *f(t) = 1* (binär) |
| **E2SFCA** | *f(t) = w(t)* | *f(t) = w(t)* |
| **M2SFCA** | *f(t) = w(t)* | *f(t) = w(t)<sup>2</sup>* |

Dabei ist *w(t)* die gewählte Widerstandsfunktion (Gauß, Linear, Exponentiell, Potenz oder Kumulativ).

### Vergleich der Varianten

Die verschiedenen Berechnungsmethoden verändern, wie Distanz wahrgenommen und gemessen wird, wie in den Beispielen unten dargestellt. Jedes Szenario zeigt eine Einrichtung mit **100 Kapazitätseinheiten** (angezeigt durch die zentrale Standortmarkierung), die Rasterzellen mit jeweils **50 Nachfrageeinheiten** versorgt. Wir nehmen eine **maximale Reisezeit von 5 Minuten** an, wobei kleine Pfeile **1 Minute Reisezeit** und große Pfeile **2 Minuten Reisezeit** darstellen. Für die Enhanced- und Modified-Varianten wird eine **lineare Widerstandsfunktion** ($f(d) = 1 - d/5$) verwendet.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<img src={require('/img/toolbox/accessibility_indicators/heatmaps/two_step_floating_catchment_area/2sfca_variants_comparaison.png').default} alt="Vergleich von 2SFCA-Varianten, der Effekte der Distanzgewichtung zeigt" style={{ maxHeight: "auto", maxWidth: "80%"}}/>
</div>

- Die **Standard 2SFCA** behandelt alle Standorte innerhalb des Einzugsgebiets **gleich**, unabhängig von der Distanz. Ob eine Bevölkerungszelle 1 Minute oder 2 Minuten von der Einrichtung entfernt ist, sie erhält in allen Konfigurationen denselben Wert von 1.

- Die **Enhanced 2SFCA** führt eine **Reisewiderstandsgewichtung** ein, die eine Differenzierung der Erreichbarkeit basierend auf der Distanz erzeugt, mit einer **höheren Erreichbarkeit** (Wert von 1,1) für nähere Zellen. Zellen, die gleich weit von Einrichtungen entfernt sind, erhalten jedoch unabhängig von der absoluten Distanz dieselbe Erreichbarkeit (z. B. erhalten zwei Zellen, die beide 1 Minute entfernt sind, oder beide 2 Minuten entfernt sind, alle **1**).

- Die **Modified 2SFCA** wendet in Schritt 2 **quadrierte Widerstandsgewichte** an, was stärkere Distanzstrafen mit Werten wie **0,9** und **0,5** erzeugt (verglichen mit 1,1 und 0,9 bei E2SFCA für ähnliche Positionen). Sie berücksichtigt im Gegensatz zu E2SFCA die absolute Distanz – zum Beispiel erhalten zwei Zellen, die beide 2 Minuten entfernt sind, eine geringere Erreichbarkeit (**0,6**) als zwei Zellen, die beide 1 Minute entfernt sind (**0,8**).

**Die Wahl der geeigneten Variante** hängt von Ihren spezifischen Analysezielen ab und davon, wie empfindlich Ihre Zielbevölkerung auf Reisedistanzen reagiert.


**GOAT verwendet die folgenden Widerstandsfunktionen für die Enhanced und Modified 2SFCA-Varianten:**


*Modified Gaussian, (Kwan,1998):*

<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px'  }}>
    <MathJax.Node formula={"f(t_{ij})=\\exp{(-t_{ij}^2/\\beta)}"} />
  </div>
</MathJax.Provider>

:::tip Pro-Tipp

Wie Studien gezeigt haben, ist der Zusammenhang zwischen Reisezeit und Erreichbarkeit oft nicht-linear. Das bedeutet, dass Menschen bereit sein können, eine kurze Strecke zurückzulegen, um eine Einrichtung zu erreichen, aber wenn die Entfernung zunimmt, ihre Bereitschaft zur Reise schnell abnimmt (oft überproportional).

Durch Nutzung der *Sensitivität*, die Sie definieren, ermöglicht Ihnen die Gauß-Funktion, diesen Aspekt des realen Verhaltens genauer zu modellieren.

:::


*Cumulative Opportunities Linear, (Kwan,1998):*
<div>
<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={`
      f(t_{ij}) =
      \\begin{cases}
        1 - \\frac{t_{ij}}{\\bar{t}} & \\text{for } t_{ij} \\leq \\bar{t} \\\\
        0 & \\text{otherwise}
      \\end{cases}
    `} />
  </div>
</MathJax.Provider>
  </div>    

*Negative Exponential, (Kwan,1998):*

<div><MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px'  }}>
    <MathJax.Node formula={"f(t_{ij})=\\exp^{(-\\beta t_{ij})}"} />
  </div>
</MathJax.Provider>
    </div>  

*Inverse Power, (Kwan,1998) (`power` in GOAT):*

<div>
<MathJax.Provider>
  <div style={{ marginTop: '20px', fontSize: '24px' }}>
    <MathJax.Node formula={`f(t_{ij}) = \\begin{cases}
      \\ 1 & \\text{for } t_{ij} \\leq 1 \\\\
      t_{ij}^{-\\beta} & \\text{otherwise}
    \\end{cases}`} />
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
    \\end{cases}`} />
  </div>
</MathJax.Provider>
</div>

Die kumulative Funktion wendet **keinen Distanzabfall** an und verwendet den Parameter *Sensitivität* nicht: Jede Einrichtung innerhalb des Reisezeitlimits **t̄** trägt mit vollem Gewicht bei. Mit kumulativen Gewichten reduzieren sich E2SFCA und M2SFCA darauf, erreichbare Einrichtungen gleich zu zählen, statt sie nach Entfernung zu differenzieren.


### Klassifizierung

Um die berechneten Erreichbarkeitsniveaus für jede Rasterzelle zu klassifizieren, wird standardmäßig eine Klassifizierung basierend auf Quantilen verwendet. 
Es können jedoch auch verschiedene andere Klassifizierungsmethoden verwendet werden. Lesen Sie mehr im Abschnitt **[Datenklassifizierungsmethoden](../../map/layer_style/style/attribute_based_styling#data-classification-methods)** auf der Seite *Attributbasiertes Styling*.

### Visualisierung 

Heatmaps in GOAT nutzen **[Ubers H3-Raster](../../further_reading/glossary#h3-grid)**-Lösung für effiziente Berechnung und leicht verständliche Visualisierung. Im Hintergrund wird die Erreichbarkeit direkt zur Laufzeit von GOATs eigener Routing-Engine berechnet. Für jeden *Routing-Modus* routet die Engine von den Gelegenheiten ausgehend nach außen, um die erreichbaren H3-Zellen und deren Reisekosten zu ermitteln, und aggregiert diese anschließend zu einem Erreichbarkeitswert pro Zelle. Der öffentliche Verkehr nutzt die RAPTOR-basierte Engine, während die Verkehrsträger der aktiven Mobilität und das Auto GOATs Dijkstra-Implementierung verwenden.

Die Auflösung und Dimensionen des verwendeten hexagonalen Rasters hängen vom gewählten *Routing-Modus* ab:

| Verkehrsmittel | Auflösung | Durchschnittliche Sechseckfläche | Durchschnittliche Kantenlänge |
|----------------|-----------|----------------------------------|-------------------------------|
| Walk | 10 | 11.285,6 m² | 65,9 m |
| Bicycle | 9 | 78.999,4 m² | 174,4 m |
| Pedelec | 9 | 78.999,4 m² | 174,4 m |
| Car | 8 | 552.995,7 m² | 461,4 m |
| Public Transport | 9 | 78.999,4 m² | 174,4 m |

:::tip Hinweis

Für weitere Einblicke in den Routing-Algorithmus besuchen Sie [Routing](../../category/routing). Außerdem können Sie diese [Publikation](https://doi.org/10.1016/j.jtrangeo.2021.103080) einsehen.

:::

## 5. Literatur

Jörg, R.; Lenz, N.; Wetz, S.; Widmer, M. (2019): Ein Modell zur Analyse der Versorgungsdichte: Herleitung eines Index zur räumlichen Zugänglichkeit mithilfe von GIS und Fallstudie zur ambulanten Grundversorgung in der Schweiz (Obsan Bericht, Nr. 01/2019). Neuchâtel: Schweizerisches Gesundheitsobservatorium.

https://www.obsan.admin.ch/sites/default/files/obsan_01_2019_bericht_0.pdf



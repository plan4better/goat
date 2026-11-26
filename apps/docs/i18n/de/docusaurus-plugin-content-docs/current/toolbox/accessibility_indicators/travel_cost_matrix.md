---
description: "Berechnen Sie Reisezeit oder Entfernung für jedes Start-Ziel-Paar zweier Punkt-Layer, per Routing oder Luftlinie, und erhalten Sie eine Tabelle der Reisekosten."
sidebar_position: 10
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Reisekostenmatrix

Die Reisekostenmatrix **berechnet [Reisezeit](https://www.plan4better.de/de/glossar/reisezeit) oder Entfernung zwischen einer Menge von Ursprüngen und einer Menge von Zielen** und erzeugt eine Tabelle, die für [Erreichbarkeitsanalysen](https://www.plan4better.de/de/glossar/erreichbarkeitsanalyse), [Standortplanung](https://www.plan4better.de/de/glossar/standortanalyse) und räumliche Modellierung verwendet werden kann.

## 1. Erklärung

Die Reisekostenmatrix berechnet die **Reisekosten (Zeit oder Entfernung) zwischen jedem [Ursprungs-Ziel-Paar](https://www.plan4better.de/de/glossar/quelle-ziel-matrix)** in zwei Eingabe-Layern für einen gewählten Routing-Modus. Das Ergebnis ist eine Tabelle, in der jede Zeile eine OD-Verbindung mit Ursprungskennung, Zielkennung und den berechneten Reisekosten darstellt.

Die Reisekostenmatrix ist für die **Massenberechnung über viele Ursprünge und Ziele gleichzeitig** ausgelegt. Dies macht sie zum richtigen Tool, wenn Sie die Rohdaten für weiterführende Analysen benötigen, z. B. für Standortbewertungen, Angebot-Nachfrage-Abgleiche oder individuelle Erreichbarkeitsindizes.

## 2. Anwendungsbeispiele

- Berechnung von Gehzeiten von allen Wohngebäuden zu den nächstgelegenen Schulen, um [unterversorgte Gebiete](https://www.plan4better.de/de/glossar/defizitgebiet) zu identifizieren.
- Berechnung von Fahrzeiten zwischen einer Menge von Lagerhäusern (Ursprünge) und Einzelhandelsgeschäften (Ziele) zur Logistikoptimierung.
- Erstellung einer Eingangsmatrix für einen individuellen Erreichbarkeitsindex, der die Reisezeit nach Attraktivität des Ziels gewichtet.
- Bewertung, wie viele Ziele von jedem Ursprung aus innerhalb einer bestimmten Reisezeitgrenze erreichbar sind.
- Vergleich von Reisekostunterschieden zwischen zwei Verkehrsmitteln (z. B. Fahrrad vs. öffentlicher Verkehr) für eine Menge von OD-Paaren.

## 3. Verwendung des Tools

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Werkzeugkasten</code> <img src={require('/img/icons/toolbox.png').default} alt="Werkzeugkasten" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> und klicken Sie unter <code>Erreichbarkeitsindikatoren</code> auf <code>Reisekostenmatrix</code>.</div>
</div>

### Routing

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Wählen Sie das <code>Verkehrsmittel</code> für die Reisekostenberechnung.</div>
</div>

### Konfiguration

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Konfigurieren Sie die Optionen für Ihr gewähltes <code>Verkehrsmittel</code>. Die verfügbaren Felder hängen vom Verkehrsmittel ab:</div>
</div>

<Tabs>
<TabItem value="active-car" label="Zu Fuß / Fahrrad / Pedelec / Auto" default className="tabItemBox">

- Wählen Sie unter <code>Berechnung nach</code> die Option <code>Zeit (Min)</code> oder <code>Entfernung (m)</code>.
- Bei Berechnung nach <code>Zeit (Min)</code> legen Sie die <code>Reisegeschwindigkeit (km/h)</code> fest.
- Optional können Sie <code>Erweiterte Optionen</code> aktivieren, um ein maximales Kostenlimit festzulegen: <code>Limit - Zeit (Min)</code> bei Berechnung nach Zeit oder <code>Limit - Distanz (m)</code> bei Berechnung nach Entfernung.

</TabItem>
<TabItem value="flight" label="Luftlinie" className="tabItemBox">

**Berechnet die geradlinige geodätische Entfernung zwischen jedem Ursprungs-Ziel-Paar.** Es wird kein Routing-Netzwerk verwendet. Für diesen Modus gibt es keine Konfigurationsfelder, wählen Sie ihn einfach aus und fahren Sie mit dem Abschnitt Eingabe fort.

</TabItem>
<TabItem value="pt" label="ÖPNV" className="tabItemBox">

- Wählen Sie unter <code>ÖV-Modi wählen</code> die gewünschten Verkehrsmittel: Bus, Straßenbahn, Bahn, U-Bahn, Fähre, Seilbahn, Gondel und/oder Standseilbahn.
- Wählen Sie den <code>Tag</code> (<code>Wochentag</code>, <code>Samstag</code> oder <code>Sonntag</code>) und legen Sie <code>Startzeit</code> und <code>Endzeit</code> für das Analysezeitfenster fest.
- Legen Sie das <code>Reisezeitlimit (Min)</code> fest, also die maximale Reisedauer, die berücksichtigt werden soll.
- Optional können Sie <code>Erweiterte Optionen</code> aktivieren, um <code>Max. Umstiege</code>, <code>Zugangsart</code> und <code>Abgangsart</code> zu konfigurieren.

</TabItem>
</Tabs>

### Eingabe

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie unter <b>Startpunkte</b> Ihren <code>Startpunkte-Layer</code> (ein Punktlayer, bei dem jedes Feature ein Startort ist) und legen Sie die <code>Herkunft-Bezeichnung</code> fest, also die Spalte zur Identifikation der Startpunkte in der Ergebnismatrix.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Wählen Sie unter <b>Zielpunkte</b> Ihren <code>Zielpunkte-Layer</code> (ein Punktlayer, bei dem jedes Feature ein Zielort ist) und legen Sie die <code>Ziel-Bezeichnung</code> fest, also die Spalte zur Identifikation der Zielpunkte in der Ergebnismatrix.</div>
</div>

### Ergebnis-Layer

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Legen Sie den <code>Namen des Zielpunkte-Layers</code> für den Ausgabe-Zielpunkte-Layer fest.</div>
</div>

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Legen Sie den <code>Namen des Matrix-Layers</code> für den Ausgabe-Tabellen-Layer fest.</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Klicken Sie auf <code>Ausführen</code>.</div>
</div>

:::tip Hinweis

Die Berechnungszeit skaliert mit der Anzahl der OD-Paare. Den Fortschritt können Sie in der [Statusleiste](../../workspace/workspace_interface.md#user-controls) verfolgen.

:::

### Ergebnisse

Nach Abschluss der Berechnung wird ein **Tabellen-Layer** zum Kartenpanel hinzugefügt. Jede Zeile stellt ein Ursprungs-Ziel-Paar dar, das innerhalb des festgelegten Reisekostenschwellenwerts liegt. Die Spalten `origin` und `destination` enthalten die Werte aus den gewählten Bezeichnungsspalten.

| Spalte | Beschreibung |
|--------|-------------|
| `origin` | Kennung des Ursprungs-Features (aus der gewählten Herkunft-Bezeichnung) |
| `destination` | Kennung des Ziel-Features (aus der gewählten Ziel-Bezeichnung) |
| `travel_cost` | Reisezeit (Minuten) oder Entfernung (Meter), je nach gewähltem Maßtyp |

OD-Paare, die den maximalen Reisekostenwert überschreiten, werden aus der Ausgabe ausgeschlossen.

Ein **Ziel**-Punktlayer wird ebenfalls hinzugefügt, der alle ursprünglichen Zielattribute um einen berechneten **travel_cost**-Wert für jeden Punkt ergänzt, die **durchschnittlichen Kosten von den Ursprüngen, die dieses Ziel erreichen**. Dadurch lässt sich der Layer leicht darstellen und gestalten und zeigt, wie gut jedes Ziel von den Ursprüngen aus im Durchschnitt erreichbar ist.

:::tip Tipp
Möchten Sie diese Matrix für weitere Analysen verwenden? Verwenden Sie die Ergebnistabelle als Eingabe für andere Tools in einem [Workflow](../../map/layers.md) oder exportieren Sie sie als CSV für externe Tools.
:::

## 4. Technische Details

Reisekosten werden mit der **gleichen Routing-Engine wie das Einzugsgebiet-Tool** berechnet, was konsistente Ergebnisse über alle Erreichbarkeitsanalysen in GOAT hinweg gewährleistet. Für jeden Ursprung erkundet der Routing-Algorithmus das Netzwerk bis zu den festgelegten maximalen Kosten und erfasst die Kosten zu jedem erreichbaren Ziel.

### Rechnerische Überlegungen

- Die Anzahl der Berechnungen skaliert als **U × Z** (Anzahl der Ursprünge × Anzahl der Ziele). Große Datensätze mit vielen Ursprüngen und Zielen benötigen mehr Verarbeitungszeit.
- Ein realistisches **maximales Reisekostenlimit** reduziert die Berechnungszeit und die Ausgabegröße erheblich.
- Für den **Öffentlichen Verkehr** wertet die Engine jede Abfahrtsminute innerhalb des festgelegten Zeitfensters aus und behält die **schnellste** Fahrt zu jedem Ziel (es handelt sich nicht um einen Durchschnitt über das Zeitfenster).

### Grenzen für unbeschränkte Berechnungen

Wenn kein maximales Reisekostenlimit gesetzt wird, gelten folgende Grenzen basierend auf der Begrenzungsrahmen-Diagonale aller Ursprungs-Ziel-Paare (die Luftliniendistanz über das kleinste Rechteck, das alle Ihre Ursprungs- und Zielpunkte enthält, also wie weit Ihre beiden am weitesten voneinander entfernten Punkte auseinanderliegen):

| Verkehrsmittel | Maximale OD-Ausdehnung (Begrenzungsrahmen-Diagonale) |
|---|---|
| Zu Fuß | 100 km |
| Fahrrad | 100 km |
| Pedelec | 100 km |
| Auto | 300 km |
| Öffentlicher Verkehr | 300 km |
| Luftlinie | Kein Limit |

### Ausgabegeometrie

Die Reisekostenmatrix erzeugt einen **tabellarischen (nicht-räumlichen) Layer**. Um die Verbindungen auf der Karte zu visualisieren, verwenden Sie das Tool [Ursprung-Ziel](../geoanalysis/origin_destination.md), das eine OD-Tabelle und einen Geometrie-Layer verwenden kann, um Verbindungslinien darzustellen.

:::tip Hinweis

Weitere Einblicke in den Routing-Algorithmus finden Sie unter [Routing](../../category/routing).

:::

---
description: "Filtern Sie Layer und Tabellen nach Attributen oder Kartenausdehnung, verknüpfen Sie Ausdrücke mit UND/ODER und sichern Sie das Ergebnis als Layer."
sidebar_position: 5
---
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';


# Filter


**Filter begrenzt die Datensichtbarkeit auf Ihrer Karte** durch logische Ausdrücke (z.B. Supermärkte mit bestimmten Namen) oder räumliche Ausdrücke (z.B. Punkte innerhalb eines Begrenzungsrahmens). **Das Filter-Tool ermöglicht es Ihnen, sich auf relevante Informationen zu konzentrieren, ohne die ursprünglichen Daten zu verändern.** Es funktioniert mit **Punkt-, Linien- und Polygon-Layern** sowie mit **Tabellen**, deren Felder vom Typ `Zahl`, `Text`, `Datum` oder `Boolesch` sind.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

  <Video src={require('/img/map/filter/filter_clicking.mp4').default} alt="Filter tool in GOAT" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>

</div> 


## Wie benutzt man den Filter?

### Einzelausdruck-Filterung

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie im <code>Layer</code>-Panel auf Ihren Layer. Rechts öffnet sich das Einstellungs-Panel des Layers mit den Tabs <code>Stil</code>, <code>Filtern</code> und <code>Metadaten</code>. Wählen Sie den Tab <code>Filtern</code>. Bei einer Tabelle hat das Panel nur die Tabs <code>Filtern</code> und <code>Metadaten</code> und öffnet sich direkt mit <code>Filtern</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf <code>+ Ausdruck hinzufügen</code>, um <strong>einen neuen Filterausdruck hinzuzufügen</strong>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie <code>Logischer Ausdruck</code> oder <code>Räumlicher Ausdruck</code>, um <strong>Ihren Filtertyp zu definieren</strong>. Bei einer Tabelle wird direkt ein <code>Logischer Ausdruck</code> hinzugefügt.</div>
</div>

<Tabs>
  <TabItem value="Logical expression" label="Logischer Ausdruck" default className="tabItemBox">

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie unter <code>Feld auswählen</code> das Attribut, <strong>nach dem gefiltert werden soll</strong>.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Wählen Sie unter <code>Operator auswählen</code> den Operator. Verfügbare Optionen variieren je nach Datentyp (<code>Zahl</code>, <code>Text</code>, <code>Datum</code> und <code>Boolesch</code>).</div>
</div>

<div style={{ display: 'flex', justifyContent: 'center' }}>

| Ausdrücke für `Zahl` | Ausdrücke für `Text` |
| -------------------- | ---------------------- |
| Ist                  | Ist                    |
| Ist nicht            | Ist nicht              |
| Enthält              | Enthält                |
| Schließt aus         | Schließt aus           |
| Ist leer             | Ist leer               |
| Ist nicht leer       | Ist nicht leer         |
| Ist mindestens       | Beginnt mit            |
| Ist weniger als      | Endet mit              |
| Ist höchstens        | Enthält den Text       |
| Ist größer als       | Enthält nicht den Text |
| Liegt zwischen       | Ist leer (leerer String) |
|                      | Ist nicht leer (kein leerer String) |

</div>

<div style={{ display: 'flex', justifyContent: 'center' }}>

| Ausdrücke für `Datum` | Ausdrücke für `Boolesch` |
| --------------------- | ----------------------- |
| Ist am                | Ist wahr                |
| Ist nicht am          | Ist falsch              |
| Ist vorher            | Ist leer                |
| Ist danach            | Ist nicht leer          |
| Im letzten            |                         |
| Nicht im letzten      |                         |
| Liegt zwischen        |                         |
| Liegt nicht dazwischen |                        |

</div>

:::tip Hinweis
Bei `Datum`-Feldern wählen Sie ein Datum über den **Datumsauswähler** (`Datum auswählen`). **"Liegt zwischen"** verwendet zwei Daten (**Von** und **Bis**), und **"Im letzten"** erwartet eine **Anzahl der Tage**. Bei `Boolesch`-Feldern legt der Operator die Bedingung bereits fest, sodass kein Wert erforderlich ist.
:::

:::tip Hinweis
Für die Ausdrücke **"Enthält"** und **"Schließt aus"** können mehrere Werte ausgewählt werden.
:::

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Legen Sie Ihre Filterkriterien je nach Operator unter <code>Wert auswählen</code>, <code>Werte auswählen</code> oder <code>Wert eingeben</code> fest. Sobald der Ausdruck vollständig ist, wird die Karte <strong>automatisch aktualisiert</strong> und der Layer zeigt im <code>Layer</code>-Panel ein Filtersymbol an.</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/filter/filter_atlayer_de.webp').default} alt="Filter Result in GOAT" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 
</TabItem>

<TabItem value="Spatial expression" label="Räumlicher Ausdruck" default className="tabItemBox">
<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie unter <code>Wählen Sie die Schnittmethode aus</code> die <strong>räumliche Begrenzung</strong>.</div>
</div>

<Tabs>
  <TabItem value="Map extent" label="Kartenausdehnung" default className="tabItemBox">

Mit <code>Kartenausdehnung</code> wird der Layer <strong>automatisch auf die aktuelle Kartenausdehnung zugeschnitten</strong>. Um den Filter zu ändern, <strong>zoomen Sie hinein/heraus</strong> und klicken Sie auf das Aktualisieren-Symbol (<code>Aktuelle Kartenausdehnung verwenden</code>).

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>

  <Video src={require('/img/map/filter/Map_extend.mp4').default} alt="Attribute Selection" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>

</div> 
</TabItem>

<TabItem value="Boundary" label="Begrenzung" default className="tabItemBox">

:::info demnächst verfügbar

Diese Funktion wird derzeit entwickelt. 🧑🏻‍💻

:::
</TabItem>
</Tabs>

</TabItem>
</Tabs>

### Mehrfachausdruck-Filterung

<strong>Kombinieren Sie mehrere Filter</strong>, indem Sie die Schritte 2-6 für jeden Ausdruck wiederholen. Sobald es zwei oder mehr Ausdrücke gibt, erscheint darüber <code>Filter Ergebnisse</code>. Wählen Sie dort <code>Passen Sie alle Filter an</code> (UND) oder <code>Entspricht mindestens einem Filter</code> (ODER), um <strong>zu steuern, wie Filter interagieren</strong>.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/filter/filter-results_de.webp').default} alt="Logic Operators" style={{ maxHeight: "300px", maxWidth: "300px", objectFit: "cover"}}/>
</div>
  
### Ausdrücke und Filter löschen

<strong>Einzelne Ausdrücke entfernen</strong>: Klicken Sie auf das <code>Weitere Optionen</code> <img src={require('/img/icons/3dots-horizontal.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> Menü neben dem Ausdruck, dann klicken Sie auf <code>Löschen</code>, um <strong>den Ausdruck zu entfernen</strong>.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/filter/filter_delete_clear_de.webp').default} alt="Delete expression and clear filters" style={{ maxHeight: "300px", maxWidth: "300px", objectFit: "cover"}}/>
</div>

<strong>Gesamten Filter entfernen</strong>: Klicken Sie auf <code>Filter löschen</code> am unteren Rand des Tabs <code>Filtern</code>, um <strong>alle Filter zu entfernen</strong>.

### Als neuen Layer speichern

Sobald der Filter angewendet ist, klicken Sie unten im Tab <code>Filtern</code> auf <code>Als neuen Layer speichern</code>, um das **gefilterte Ergebnis als neuen Datensatz** in Ihrem Workspace zu speichern. So können Sie mit den gefilterten Daten unabhängig weiterarbeiten.


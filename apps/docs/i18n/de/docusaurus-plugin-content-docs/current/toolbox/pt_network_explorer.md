---
description: "Erkunden Sie ein aus GTFS importiertes ÖPNV-Netz: Linien und Haltestellen durchsuchen, Takt, Halte und Fahrpläne lesen, Fahrzeuge auf der Karte abspielen und Betriebskosten schätzen."
sidebar_position: 6
---

# ÖPNV-Netz-Explorer

Der **Explorer** öffnet ein ÖPNV-Netz Ihres Projekts als interaktive Ansicht: **Durchsuchen Sie Linien und Haltestellen, lesen Sie Takt, Haltestellenfolgen und Fahrpläne, verfolgen Sie die Fahrzeuge im Tagesverlauf auf der Karte und schätzen Sie, was der Betrieb des Netzes kostet.**

## 1. Erklärung

Ein ÖPNV-Netz, das aus einem [GTFS](https://www.plan4better.de/de/glossar/gtfs)-Feed importiert wurde, kommt als [Bundle](../data/dataset_types.md#datensätze-aus-mehreren-layern) in Ihr Projekt: eine Gruppe von Layern (Haltestellen, Linien, Fahrten, Haltezeiten usw.), die zusammengehören. Der Explorer liest den gesamten Feed auf einmal und zeigt ihn so, wie Fahrgäste und Planende ihn sehen: **Linien** mit ihren Richtungen, **Haltestellen** mit ihren Steigen, **Fahrten** mit ihren Zeiten und den **Kalender** der Tage, an denen sie verkehren.

Solange der Explorer geöffnet ist, zeichnet er das Netz selbst auf die Karte: jede Linie in ihrer Farbe, die Haltestellen ab Straßenebene und beim Abspielen die Fahrzeuge, die gerade unterwegs sind. Die Layer des Bundles werden währenddessen ausgeblendet und erscheinen wieder, wenn Sie den Explorer verlassen.

Alle Kennzahlen beziehen sich auf **ein Datum**, das Sie in der unteren Leiste einstellen. Die Betriebskosten sind eine Schätzung für ein Jahr, gerechnet über einen **Datenzeitraum** des Feeds und auf Grundlage von Kostensätzen, die Sie anpassen können.

:::info

Der Explorer öffnet **ÖPNV-Bundles, die aus einem GTFS-Feed erstellt wurden**. Wie Sie einen eigenen Feed importieren, lesen Sie unter [Eigenes ÖPNV-Netz](../data/builtin_datasets.md#eigenes-öpnv-netz). Der Explorer ist in der Ansicht `Karte` des Projekts verfügbar.

:::

## 2. Anwendungsbeispiele

- Prüfen, wie oft eine Linie in der Morgenspitze im Vergleich zum Abend fährt.
- Herausfinden, welche Linien eine Haltestelle bedienen und wann die nächsten Abfahrten sind.
- Eine einzelne Fahrt Halt für Halt verfolgen und zu den Fahrten davor und danach wechseln.
- Das Netz einen Tag lang abspielen, um zu sehen, wo und wann die meisten Fahrzeuge unterwegs sind.
- Die jährlichen Betriebskosten einer Linie mit denen des gesamten Netzes vergleichen.
- Prüfen, an welchen Tagen des Fahrplanzeitraums eine Linie fährt und wo sich ihr Angebot ändert.

## 3. Wie benutzt man den Explorer?

### Explorer öffnen

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Öffnen Sie in Ihrem Projekt das Panel <code>Layer</code> und suchen Sie das Bundle Ihres ÖPNV-Netzes.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf das Symbol <img src={require('/img/icons/3dots.png').default} alt="Optionen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>weitere Optionen</code> neben dem Bundle und wählen Sie <code>Explorer</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Das linke Panel hat nun zwei Tabs, <code>Layer</code> und <code>Explorer</code>. Während das Netz lädt, zeigt der Tab <code>Explorer</code> <b>Netz wird geöffnet</b> mit zwei Schritten: <code>Daten werden vorbereitet</code> und <code>Daten werden geladen</code>. Wird eine Version eines Bundles zum ersten Mal geöffnet, kann die Vorbereitung eine Minute dauern.</div>
</div>

Sobald die Linien aufgelistet werden können, zoomt die Karte auf das Netz. Die Fahrpläne laden im Hintergrund weiter; bis sie da sind, zeigen Kennzahlen, die sie brauchen, `Fahrpläne werden geladen` mit einem Prozentwert. Im Tab `Layer` ist das Bundle mit `Im Explorer` markiert, und `Layer hinzufügen` ist deaktiviert, bis Sie den Explorer verlassen.

:::tip Tipp

Lässt sich das Netz nicht öffnen, zeigt der Tab den Grund und was Sie tun können. Nutzen Sie `Erneut versuchen`, wo angeboten, und öffnen Sie `Details` für die technische Meldung, falls Sie das Problem melden möchten.

:::

:::danger[Screenshot placeholder]
The layer menu (⋮) of a public transport bundle with the `Explorer` entry, and the `In Explorer` chip in the layer tree.
:::

### Linien und Haltestellen

Der Tab `Explorer` zeigt den Namen des Bundles, ein Suchfeld und zwei Abschnitte, `Linien` und `Haltestellen & Steige`, jeweils mit ihrer Anzahl. Es ist immer nur ein Abschnitt geöffnet; klicken Sie auf die Überschrift eines Abschnitts, um ihn zu öffnen oder einzuklappen.

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Geben Sie einen Begriff in <code>Linien und Haltestellen suchen…</code> ein, um beide Listen gemeinsam zu durchsuchen. Gibt es nur in einer Liste Treffer, öffnet sich dieser Abschnitt.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Um die Listen einzugrenzen, klicken Sie auf das Symbol <code>Filter</code> am Ende des Suchfelds und wählen Sie die gewünschten Optionen unter <code>Art</code> (<code>Linien</code> oder <code>Haltestellen & Steige</code>), <code>Verkehrsmittel</code> und <code>Verkehrsunternehmen</code>. Jede Option zeigt, wie viele Linien sie umfasst. Die Filter wirken sofort; <code>Zurücksetzen</code> hebt sie auf und <code>Fertig</code> schließt die Liste.</div>
</div>

Aktive Filter erscheinen als Chips unter dem Suchfeld; klicken Sie auf das × eines Chips, um ihn zu entfernen. Auf der Karte werden Linien, die ein Filter nach Verkehrsmittel oder Verkehrsunternehmen ausschließt, blass dargestellt.

- **Linien** erscheinen mit ihrem Liniensymbol in der Linienfarbe, ihrem Namen und einem Symbol für das Verkehrsmittel. Eine Linie ohne Fahrten am gewählten Datum ist abgeblendet.
- **Haltestellen & Steige** listet Haltestellen mit ihren eingeklappten Steigen sowie Haltestellen, die zu keiner übergeordneten Haltestelle gehören. Jede Zeile zeigt die Liniensymbole der dort haltenden Linien. Klicken Sie auf eine Haltestelle oder einen Steig, um den Fahrplan im rechten Panel zu öffnen; ein erneuter Klick schließt ihn.

Jede Liste zeigt höchstens 200 Zeilen; grenzen Sie die Suche ein, um die übrigen zu finden.

:::danger[Screenshot placeholder]
The Explorer's left panel: lines and stations lists with the search field and filter chips.
:::

### Das Linien-Panel

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Klicken Sie auf eine Linie in der Liste oder auf ihren Verlauf auf der Karte. Teilen sich mehrere Linien die Strecke unter dem Mauszeiger, öffnet sich eine Liste der Linien dort zur Auswahl.</div>
</div>

Der Tab `Explorer` zeigt nun die Linie: ihr Liniensymbol und ihren Namen, Verkehrsmittel, Verkehrsunternehmen, Anzahl der Richtungen und Haltestellen sowie drei Tabs: `Übersicht`, `Haltestellen` und `Fahrplan`. Auf der Karte ist die Linie über dem blassen Netz hervorgehoben, mit ihren Haltestellen und den Namen ihrer Endpunkte, und die Karte zoomt auf sie. Klicken Sie oben auf `Linien`, um zur Liste zurückzukehren.

#### Übersicht

Der Tab `Übersicht` beschreibt das Angebot der Linie am gewählten Datum, je Richtung. Jeder Abschnitt zeigt das Datum, auf das er sich bezieht.

- `Takt`: wie oft die Linie in jeder Verkehrszeit fährt, in Minuten. `1 Fahrt` bedeutet eine einzige Fahrt in dieser Verkehrszeit.
- `Fahrzeuge im Einsatz`: ein Diagramm, wie viele Fahrzeuge der Linie im Tagesverlauf unterwegs sind.
- `Fahrzeit`: die ungefähre Fahrzeit von Endpunkt zu Endpunkt in jeder Verkehrszeit (der Median).
- `Bedienungszeit`: die erste und letzte Abfahrt jeder Richtung.

Die Verkehrszeiten (`Früh`, `HVZ vorm.`, `Mittag`, `HVZ nachm.`, `Abend`, `Nacht`) ändern Sie über das Symbol `Verkehrszeiten` neben `Takt` und `Fahrzeit`; siehe [Berechnungsannahmen](#berechnungsannahmen). Fährt die Linie am gewählten Datum nicht, wählen Sie in der unteren Leiste einen anderen Tag.

:::danger[Screenshot placeholder]
The line panel, `Overview` tab.
:::

#### Haltestellen

Der Tab `Haltestellen` zeigt **immer eine Richtung**. Wählen Sie sie unter `Richtung`: Jede Richtung ist nach ihrem Ziel benannt, mit der Anzahl ihrer Fahrten am gewählten Datum, und ihre Varianten (`Kurzläufer`, `Express` oder `Linienast`) stehen eingerückt darunter.

Unter der Auswahl sehen Sie Fahrten, Haltestellen und Länge der Richtung und darunter die Haltestellen als Liniendiagramm: die Minuten ab der ersten Haltestelle sowie Strecke und Minuten zwischen je zwei Haltestellen. Wo Kurzläufer enden, gibt das Diagramm an, wie viele Fahrten dort enden. Klicken Sie auf eine Haltestelle, um ihren Fahrplan im rechten Panel zu öffnen.

Auf der Karte ist die gewählte Richtung hervorgehoben, mit Pfeilen in Fahrtrichtung. Sie können auch auf die ausgewählte Linie auf der Karte klicken, um eine Richtung zu wählen; teilen sich mehrere Richtungen die Strecke, werden sie zur Auswahl angeboten.

Die hier gewählte Richtung gilt auch für den Fahrtenstreifen und für die Haltestellenfahrpläne dieser Linie.

:::danger[Screenshot placeholder]
The line panel, `Stops` tab (line diagram).
:::

#### Fahrplan

Der Tab `Fahrplan` zeigt, an welchen Tagen die Linie fährt:

- `Fahrplanzeitraum`: der erste und letzte Verkehrstag sowie die Anzahl der Verkehrstage und Tagesarten.
- `Tagesarten`: die Tage mit gleichem Fahrplan, jeweils mit ihren Wochentagen und der Anzahl der Fahrten am Tag. Seltene Tagesarten sind hinter einem Link eingeklappt.
- `Ausnahmen`: die Tage, an denen gegenüber der üblichen Woche zusätzlicher Verkehr stattfindet oder Verkehr entfällt, im Kalender markiert.
- `Kalender`: der Zeitraum des Feeds Monat für Monat, jeder Tag in der Farbe seiner Tagesart. Das gewählte Datum ist umrandet; klicken Sie auf einen Tag, um ihn zum Datum des Explorers zu machen.

:::danger[Screenshot placeholder]
The line panel, `Schedule` tab.
:::

### Haltestellen- und Fahrt-Panel

Haltestellen und Fahrten öffnen sich in einem Panel auf der rechten Seite. Klicken Sie oben auf `‹`, um zu dem Element zurückzukehren, von dem aus Sie es geöffnet haben, oder auf `Schließen`, um es zu schließen.

**Eine Haltestelle oder ein Steig** zeigt den Namen, die Steige, die Anzahl der Linien und, wo der Feed es angibt, den rollstuhlgerechten Einstieg. Wechseln Sie zwischen zwei Ansichten:

- `Fahrplan`: die Abfahrten einer Linie je Richtung, nach Stunden und Minuten. Fahren hier mehrere Linien ab, wählen Sie eine unter `Linien`. Die nächste Abfahrt nach der Abspielzeit ist hervorgehoben. Eine gepunktet umrandete Abfahrt ist ein Zeitfenster: Der Feed gibt für diesen Halt bei dieser Fahrt keine eigene Zeit an. Klicken Sie auf die Überschrift einer Richtung, um die Linie zu öffnen.
- `Abfahrten`: die nächsten Abfahrten aller Linien ab der Abspielzeit, mit den Minuten bis zur Abfahrt.

Klicken Sie auf eine Abfahrt, um ihre Fahrt zu öffnen.

**Eine Fahrt** zeigt ihr Liniensymbol, ihre Abfahrtszeit, ihre erste und letzte Haltestelle und das Datum. Darunter sehen Sie, wann sie fährt, wie lange sie dauert und wie viele Haltestellen sie hat; mit den Pfeilen (`Vorherige Fahrt`, `Nächste Fahrt`) wechseln Sie zu den Fahrten davor und danach in derselben Richtung. Es folgen zwei Tabs: `Haltestellen`, ihre Haltestellen mit Zeiten (klicken Sie auf eine Haltestelle, um ihren Fahrplan zu öffnen), und `Fahrplan`, die Tage, an denen diese Fahrt verkehrt. Liegt die Abspielzeit innerhalb der Fahrt, sind die bereits passierten Haltestellen abgeblendet und ihr Fahrzeug ist auf der Karte umringt.

Sie können diese Panels auch über die Karte öffnen: Klicken Sie auf ein Fahrzeug, um seine Fahrt zu öffnen, auf eine Haltestelle für ihren Fahrplan oder, nah herangezoomt, auf die Fläche einer Haltestelle für den Fahrplan all ihrer Steige. Ein Klick auf eine leere Stelle der Karte schließt zuerst das rechte Panel, danach die ausgewählte Linie.

:::danger[Screenshot placeholder]
A stop panel and a trip panel in the right panel.
:::

### Abspielen und Datum

Die Leiste am unteren Kartenrand spielt das Netz im Tagesverlauf ab:

- **Abspielen und Pause** der Fahrzeuge auf der Karte. In der Pause zeigt die Karte das Netz ohne Fahrzeuge.
- **Geschwindigkeit**: `1×`, `10×` oder `60×`.
- **Datum**: das Datum, auf das sich alle Kennzahlen beziehen. Mit den Pfeilen gehen Sie zum Tag davor oder danach, oder Sie klicken auf das Datum und wählen eines im Kalender. Der Explorer öffnet mit dem heutigen Tag, wenn der Feed ihn abdeckt, sonst mit dem nächstgelegenen abgedeckten Tag. Ein Datum außerhalb des Datenzeitraums erscheint grau.
- **Uhrzeit**: die Uhr und ein Schieberegler, um durch das Tagesangebot zu gehen.
- **Fahrzeuge**: wie viele Fahrzeuge gerade unterwegs sind, im ganzen Netz oder, bei ausgewählter Linie, auf dieser Linie in der gezeigten Richtung.

Fahrzeuge sind Punkte in der Farbe ihrer Linie; nah herangezoomt oder bei der ausgewählten Linie tragen sie das Liniensymbol. Klicken Sie auf ein Fahrzeug, um seine Fahrt zu öffnen.

:::info

Auf einem Gerät oder in einem Browser mit zu wenig Arbeitsspeicher ist das Abspielen ausgeschaltet, und die Abspieltaste nennt den Grund. Alles andere im Explorer funktioniert weiterhin.

:::

:::danger[Recording placeholder]
Vehicle playback on the map, with the bottom bar (play, speed, date).
:::

### Der Fahrtenstreifen

Bei ausgewählter Linie wird die untere Leiste zum **Fahrtenstreifen**: die Fahrten der Linie über ihren ganzen Tag. Seine Kopfzeile zeigt die Richtung (dieselbe Auswahl wie im Tab `Haltestellen`) und eine Schaltfläche, um den Streifen einzuklappen (`Fahrten einklappen`); eingeklappt holt ihn das Liniensymbol in der Leiste zurück (`Fahrten zeigen`). Ziehen Sie den oberen Rand des Streifens, um ihn höher oder niedriger zu machen.

Unten im Streifen wechseln Sie zwischen zwei Ansichten:

- `Diagramm`: Jede Fahrt ist eine Linie, mit der Uhrzeit nach rechts und der Strecke entlang der Richtung nach unten; links sind die Endpunkte der Richtung und ihrer Varianten benannt. Kurzläufer sind gestrichelt. Klicken Sie auf die Linie einer Fahrt, um sie im rechten Panel zu öffnen; ist ihr Fahrzeug unterwegs, fliegt die Karte zu ihm. Ein Klick an eine andere Stelle des Diagramms setzt die Abspielzeit, alternativ ziehen Sie die senkrechte Zeitlinie. Ziehen Sie einen Rahmen, um in einen Teil von Tag und Strecke zu zoomen (oder per Pinch bzw. Strg und Scrollen); `Zoom zurücksetzen`, Esc oder ein Doppelklick führt zurück zum ganzen Tag. Ist der Streifen hoch genug gezogen, zeigt er unten außerdem die `Fahrzeuge` im Einsatz.
- `Liste`: eine Zeile pro Fahrt mit `Ab`, `An`, `Dauer`, `Strecke`, `Richtung` und `Halte`. Ein Punkt markiert die Fahrten, die zur Abspielzeit unterwegs sind. Eine mit ≈ markierte Strecke ist eine Schätzung in Luftlinie zwischen den Halten, weil der Feed für diese Fahrt keinen Linienverlauf hat.

Die Anzahl der gezeigten Fahrten steht neben dem Umschalter.

:::danger[Screenshot placeholder]
The trip strip.
:::

### Betriebskosten

Unter dem linken Panel schätzt die Karte `Betriebskosten`, was der Betrieb des Netzes in einem Jahr kostet:

- `Gesamtes Netz`, immer;
- darunter die ausgewählte Linie (oder die Linie der im rechten Panel geöffneten Fahrt);
- darunter die geöffnete Fahrt dieser Linie.

Jede Stufe zeigt ihre ungefähren Jahreskosten. Die unterste Stufe zeigt außerdem ihre `Fahrplankilometer` und `Fahrzeugstunden`. Die Fußzeile der Karte gibt an, dass es sich um eine `Jahreshochrechnung` handelt und aus welchen Monaten des Datenzeitraums gerechnet wird. Klicken Sie auf das Symbol `Kostensätze` in der Kopfzeile der Karte, um die Sätze anzupassen.

:::danger[Screenshot placeholder]
The operating cost section and cost card.
:::

### Berechnungsannahmen

Der Dialog `Berechnungsannahmen` enthält die Annahmen hinter den Kennzahlen. Er öffnet sich über das Symbol `Kostensätze` auf der Kostenkarte und über das Symbol `Verkehrszeiten` in der `Übersicht` einer Linie und hat drei Tabs:

- `Betriebskosten`, mit zwei Ansichten:
  - `Kostensätze`: Wählen Sie die `Währung` und das `Verkehrsunternehmen` und legen Sie für jede Fahrzeugart des Unternehmens einen `Satz pro km` und optional einen `Satz pro Stunde` fest. Ein leeres Feld verwendet den darin angezeigten Standardwert. Bei U-Bahn und Bahn gilt der Satz `Pro Zuggarnitur`. Unternehmen mit eigenen Sätzen sind mit `Sätze gesetzt` gekennzeichnet. Eine Formel unter den Feldern zeigt, wie die Kosten berechnet werden.
  - `Datenzeitraum`: die Tage, über die die Jahreswerte gerechnet werden. Das Diagramm `Tägliche Fahrten` zeigt die Fahrten je Tag über den gesamten Feed; ziehen Sie die beiden Griffe (`Erster Tag` und `Letzter Tag`), um den Zeitraum festzulegen, oder wählen Sie `Optimaler Zeitraum` (der Abschnitt, den der Fahrplan vollständig abdeckt, standardmäßig verwendet) oder `Gesamter Zeitraum`.
- `Verkehrszeiten`: die Endzeit jeder Verkehrszeit von `Früh` bis `Abend` im Format HH:MM. Jede Verkehrszeit beginnt, wo die vorige endet, und `Nacht` reicht bis zum Ende des Betriebstags (48:00).
- `Fahrzeuge`: die `Wendezeit`, die Standzeit am Ende jeder Fahrt, in Minuten.

Klicken Sie auf `Speichern`, um die Änderungen zu übernehmen. Sie werden für dieses Bundle **nur in diesem Browser** gespeichert.

:::danger[Screenshot placeholder]
The network assumptions dialog.
:::

### Explorer verlassen

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Klicken Sie auf das × im Tab <code>Explorer</code> (<code>Explorer verlassen</code>) oder wählen Sie <code>Explorer verlassen</code> im Menü <code>weitere Optionen</code> des Bundles im Tab <code>Layer</code>.</div>
</div>

Die Layer des Bundles werden wieder auf der Karte angezeigt, und Sie können wieder Layer hinzufügen.

## 4. Technische Details

**Betriebskosten.** Die Jahreskosten eines Netzes, einer Linie oder einer Fahrt werden geschätzt als:

`Jährliche Betriebskosten ≈ Fahrplan-km × km-Satz + Fahrzeugstunden × Stundensatz`

Fahrplankilometer und Fahrzeugstunden ergeben sich aus dem Fahrplan und seinem Kalender: die täglichen Kilometer und Stunden jedes Angebots mal die Tage, an denen es im Datenzeitraum fährt, hochgerechnet von der Länge des Zeitraums auf 365 Tage. Die Sätze werden je Verkehrsunternehmen und Fahrzeugart festgelegt. Ist keiner gesetzt, gilt ein Standardsatz pro Kilometer: 5,5 für Busse und andere Verkehrsmittel, 8 für Straßenbahnen und Oberleitungsbusse und 24 pro Zuggarnitur für U-Bahn und Bahn, in der gewählten Währung (standardmäßig `EUR`). Der Stundensatz ist optional und standardmäßig leer.

**Standard-Verkehrszeiten.** `Früh` bis 07:00, `HVZ vorm.` 07:00 bis 09:00, `Mittag` 09:00 bis 15:00, `HVZ nachm.` 15:00 bis 18:00, `Abend` 18:00 bis 22:00 und `Nacht` ab 22:00. Zeiten nach Mitternacht werden so geschrieben wie im Fahrplan (zum Beispiel 24:30).

**Wendezeit.** Die Standard-Wendezeit beträgt 6 Minuten.

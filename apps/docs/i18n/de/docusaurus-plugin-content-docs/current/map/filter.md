---
description: "Filtern Sie Layer und Tabellen nach Attributen, nach einem Gebiet auf der Karte oder nach beidem, verknüpfen Sie Bedingungen und speichern Sie das Ergebnis als neuen Layer."
sidebar_position: 5
---

# Filter

**Der Filter begrenzt, welche Features eines Layers auf der Karte angezeigt werden**: nach Attributen (z.B. Supermärkte mit bestimmten Namen), nach einem Gebiet (z.B. Punkte innerhalb eines Stadtbezirks) oder nach beidem. **So können Sie sich auf die relevanten Daten konzentrieren, ohne die ursprünglichen Daten zu verändern.** Er funktioniert mit **Punkt-, Linien- und Polygon-Layern** sowie mit **Tabellen**, für Felder mit Text, Zahlen, Datumswerten oder Wahr/Falsch-Werten. Im Tab <code>Filtern</code> heißen Features „Objekte“.

## Der Tab Filtern

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie im <code>Layer</code>-Panel auf Ihren Layer. Rechts öffnet sich das Einstellungs-Panel des Layers mit den Tabs <code>Stil</code>, <code>Filtern</code> und <code>Metadaten</code>. Wählen Sie den Tab <code>Filtern</code>. Bei einer Tabelle hat das Panel nur die Tabs <code>Filtern</code> und <code>Metadaten</code> und öffnet sich direkt mit <code>Filtern</code>.</div>
</div>

Der Tab hat vier Teile, von oben nach unten:

| Teil | Funktion |
| ---- | -------- |
| Ergebniszeile | Zeigt, wie viele Features den Filter erfüllen, zum Beispiel <code>120 von 3.400 Objekten</code>, mit einem Balken für ihren Anteil. Ohne Filter steht dort <code>Alle 3.400 Objekte</code>. <code>Leeren</code> daneben entfernt den gesamten Filter. |
| <code>Gebiet</code> | Begrenzt den Layer auf ein Gebiet auf der Karte. Solange kein Gebiet festgelegt ist, steht dort <code>Ganzer Layer</code>. |
| <code>Bedingungen</code> | Die Attributbedingungen, eine Zeile pro Bedingung, und die Schaltfläche <code>Bedingung hinzufügen</code>. |
| <code>Als neuen Layer speichern</code> | Speichert die gefilterten Features als neuen Layer. Die Schaltfläche steht unter der Anzahl der gefilterten Features. |

:::info Änderungen gelten sofort
Der Filter hat keine Schaltfläche zum Anwenden. Jede Änderung wird sofort angewendet und gespeichert, und die Karte und die Ergebniszeile werden aktualisiert. Ein Layer mit Filter zeigt im <code>Layer</code>-Panel ein Filtersymbol. Ein Klick auf das Symbol öffnet den Tab <code>Filtern</code> des Layers.
:::

## Nach Attributen filtern

Eine Bedingung vergleicht ein Feld des Layers mit einem Wert, zum Beispiel **Name ist Aldi** oder **Einwohner ist größer als 10.000**.

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie unter <code>Bedingungen</code> auf <code>Bedingung hinzufügen</code> und wählen Sie das Feld, nach dem gefiltert werden soll. Mit <code>Felder suchen</code> finden Sie ein Feld in einer langen Liste.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Der Editor der neuen Bedingung öffnet sich neben dem Panel. Wählen Sie unter <code>Bedingung</code>, wie das Feld verglichen wird. Welche Vergleiche zur Auswahl stehen, hängt vom Typ des Felds ab.</div>
</div>

| Text | Zahl | Datum | Wahr/Falsch |
| ---- | ---- | ----- | ----------- |
| ist | ist | ist am | ist wahr |
| ist nicht | ist nicht | ist nicht am | ist falsch |
| ist einer von | ist einer von | ist vor | ist leer |
| ist keiner von | ist keiner von | ist nach | ist nicht leer |
| enthält | ist kleiner als | liegt zwischen | |
| enthält nicht | ist größer als | liegt nicht zwischen | |
| beginnt mit | ist höchstens | in den letzten | |
| endet mit | ist mindestens | nicht in den letzten | |
| ist leer | liegt zwischen | ist leer | |
| ist nicht leer | liegt nicht zwischen | ist nicht leer | |
| | ist leer | | |
| | ist nicht leer | | |

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Legen Sie den Wert fest. Wie das geht, hängt vom Vergleich ab.</div>
</div>

| Vergleich | So legen Sie den Wert fest |
| --------- | -------------------------- |
| ist, ist nicht (Text und Zahlen) | Wählen Sie einen Wert aus der Liste der Werte des Felds. Die Liste zeigt, wie oft jeder Wert vorkommt, die häufigsten zuerst. Mit <code>Werte suchen</code> finden Sie einen Wert. Ein Wert, der nicht in der Liste steht, lässt sich eintippen und mit <code>„…“ verwenden</code> übernehmen. |
| ist einer von, ist keiner von | Wählen Sie mehrere Werte aus derselben Liste. Die gewählten Werte bleiben oben, und die Liste zählt sie, zum Beispiel <code>3 von 100 gewählt</code>. |
| ist kleiner als, ist größer als, ist höchstens, ist mindestens | Ziehen Sie den Schieberegler über dem Histogramm der Werte des Felds oder tippen Sie die Zahl in <code>Wert</code> ein. Die Balken der Werte, die die Bedingung erfüllen, sind hervorgehoben. |
| liegt zwischen, liegt nicht zwischen (Zahlen) | Ziehen Sie die beiden Griffe des Schiebereglers oder tippen Sie die Grenzen in <code>Wert</code> und <code>Bis</code> ein. |
| enthält, enthält nicht, beginnt mit, endet mit | Tippen Sie den Text in <code>Wert</code> ein. |
| ist am, ist nicht am | Wählen Sie unter <code>Wert</code> ein Datum. |
| ist vor, ist nach | Wählen Sie unter <code>Wert</code> ein Datum. Bei einem Feld mit Datum und Uhrzeit legen Sie auch die Uhrzeit fest. |
| liegt zwischen, liegt nicht zwischen (Datum) | Wählen Sie die beiden Datumswerte unter <code>Wert</code> und <code>Bis</code>. Bei einem Feld mit Datum und Uhrzeit legen Sie auch die Uhrzeiten fest. |
| in den letzten, nicht in den letzten | Tippen Sie eine ganze Zahl in <code>Anzahl der Tage</code> ein. |
| ist leer, ist nicht leer, ist wahr, ist falsch | Es ist kein Wert nötig. |

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Sobald die Bedingung vollständig ist, zeigt die Karte nur noch die Features, die sie erfüllen, und die Bedingung steht als Satz in ihrer Zeile. Eine Bedingung, der noch ein Wert fehlt, hat einen gestrichelten Rahmen und den Hinweis <code>Wird erst angewendet, wenn die Bedingung vollständig ist.</code></div>
</div>

:::tip Hinweis
- Vergleiche, die einen Wert ausschließen („ist nicht“, „ist keiner von“, „enthält nicht“, „liegt nicht zwischen“, „ist nicht am“, „nicht in den letzten“), behalten die Features, die in dem Feld keinen Wert haben. Fügen Sie für dasselbe Feld die Bedingung „ist nicht leer“ hinzu, um auch diese auszuschließen.
- Nach den Zeichen `%` und `_` kann mit „enthält“, „enthält nicht“, „beginnt mit“ und „endet mit“ nicht gesucht werden.
- „in den letzten“ und „nicht in den letzten“ zählen die Tage von dem Moment zurück, in dem der Filter gespeichert wird. Das Datum wandert nicht von selbst von Tag zu Tag weiter. Es wird neu gesetzt, sobald der Filter geändert wird.
:::

### Bedingungen kombinieren

Wiederholen Sie die Schritte 2 bis 5 für jede weitere Bedingung. Ein Filter umfasst bis zu 20 Bedingungen.

Sobald es zwei oder mehr Bedingungen gibt, erscheint neben <code>Bedingungen</code> ein Menü. Es legt fest, wie die Bedingungen zusammenwirken:

- <code>Alle erfüllt</code>: Objekte erfüllen jede Bedingung.
- <code>Eine erfüllt</code>: Objekte erfüllen mindestens eine Bedingung.

### Bedingung ändern, ausschalten oder entfernen

- **Ändern**: Klicken Sie auf die Zeile, um ihren Editor wieder zu öffnen. Um nach einem anderen Feld zu filtern, klicken Sie oben im Editor auf den Feldnamen.
- **Ausschalten**: Verwenden Sie den Schalter am Ende der Zeile. Die Bedingung bleibt in der Liste, wird aber nicht angewendet, und ihre Zeile ist abgeblendet. Schalten Sie sie wieder ein, um sie anzuwenden.
- **Entfernen**: Zeigen Sie auf die Zeile und klicken Sie auf das Papierkorb-Symbol, oder wählen Sie die Zeile aus und drücken Sie die Entf-Taste.
- **Alles entfernen**: <code>Leeren</code> neben der Ergebniszeile entfernt alle Bedingungen und das Gebiet.

:::tip Hinweis
Die [Datentabelle](./layer_editing#daten-ansehen) eines Layers kann nach Spalten filtern. Ein Spaltenfilter ist Teil desselben Layer-Filters und erscheint deshalb auch als Bedingung im Tab <code>Filtern</code>.
:::

## Nach einem Gebiet filtern

Ein Gebiet behält die Features, die darin liegen oder es berühren, oder die außerhalb davon. Das Gebiet und die Bedingungen wirken immer zusammen: Ein Feature muss das Gebiet und die Bedingungen erfüllen, auch bei <code>Eine erfüllt</code>.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie unter <code>Gebiet</code> auf die Zeile <code>Ganzer Layer</code>. Die Gebietsauswahl öffnet sich neben dem Panel.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf <code>Zum Gebiet hinzufügen</code> und wählen Sie, woraus das Gebiet besteht.</div>
</div>

| Option | Was hinzugefügt wird |
| ------ | -------------------- |
| <code>Aktueller Kartenausschnitt</code> | Der Teil der Karte, der gerade sichtbar ist. |
| <code>Polygon zeichnen</code> | Ein Polygon, das Sie auf der Karte zeichnen. |
| <code>Kreis zeichnen</code> | Ein Kreis, den Sie auf der Karte zeichnen. |
| <code>Regionen</code> | Verwaltungsregionen. Tippen Sie mindestens zwei Zeichen in <code>Regionen suchen</code> ein und haken Sie die benötigten Regionen an. |
| <code>Objekte eines Layers</code> | Features eines anderen Polygon-Layers des Projekts, zum Beispiel Stadtbezirke. Wählen Sie den Layer und haken Sie dann die Features an. Die Liste zeigt die ersten 50 Features, die übrigen finden Sie mit <code>Objekte suchen</code>. |

Während Sie zeichnen, zeigt das Panel <code>Form auf der Karte zeichnen</code>. Die fertige Form wird Teil des Gebiets. <code>Abbrechen</code> oder die Esc-Taste beendet das Zeichnen, ohne eine Form hinzuzufügen.

Um ein gezeichnetes Polygon später zu ändern, klicken Sie im Gebiet auf sein Stiftsymbol (<code>Form auf der Karte bearbeiten</code>). Ziehen Sie die Ecken, oder klicken Sie zwischen zwei Ecken, um eine hinzuzufügen; wählen Sie eine Ecke aus und drücken Sie Entf, um sie zu entfernen. <code>Fertig</code> oder die Eingabetaste übernimmt die Änderung, <code>Abbrechen</code> oder die Esc-Taste behält die alte Form. Ein gezeichneter Kreis lässt sich so nicht ändern: Entfernen Sie ihn und zeichnen Sie ihn neu.

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Fügen Sie bei Bedarf mit <code>Zum Gebiet hinzufügen</code> weitere Teile hinzu. Die Teile ergeben zusammen ein Gebiet: Ein Feature erfüllt es, wenn es in einem der Teile liegt.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie <code>Innerhalb</code>, um die Features im Gebiet zu behalten, oder <code>Außerhalb</code>, um die zu behalten, die es nicht berühren. Ein neues Gebiet beginnt mit <code>Innerhalb</code>.</div>
</div>

Die Zeile unter <code>Gebiet</code> nennt, woraus das Gebiet besteht, zum Beispiel <code>Kartenausschnitt</code>, <code>2 Formen</code> oder <code>3 Regionen</code>, und der Umriss des Gebiets wird auf der Karte gezeichnet, solange der Tab <code>Filtern</code> geöffnet ist.

### Gebiet ändern, ausschalten oder entfernen

- **Einen Teil entfernen**: Öffnen Sie die Gebietsauswahl und klicken Sie auf das X neben dem Teil. Bei Regionen und Objekten eines Layers öffnet ein Klick auf den Teil seine Liste, in der Sie einzelne Einträge abwählen können.
- **Kartenausschnitt aktualisieren**: Ein Gebiet mit dem Teil <code>Kartenausschnitt</code> behält den Ausschnitt, mit dem es hinzugefügt wurde. Nachdem Sie die Karte verschoben haben, erscheint in der Gebietszeile ein Aktualisieren-Symbol (<code>Die Karte wurde verschoben. Aktuellen Ausschnitt verwenden</code>). Ein Klick darauf übernimmt den Ausschnitt, den die Karte jetzt zeigt.
- **Ausschalten**: Verwenden Sie den Schalter am Ende der Gebietszeile. Das Gebiet bleibt erhalten, wird aber nicht angewendet.
- **Entfernen**: Klicken Sie auf das Papierkorb-Symbol in der Gebietszeile oder in der Gebietsauswahl. <code>Leeren</code> entfernt das Gebiet zusammen mit allen Bedingungen.

## Grenzen

| Was | Grenze |
| --- | ------ |
| Bedingungen in einem Filter | 20 |
| Werte in einer Bedingung („ist einer von“, „ist keiner von“) | 100 |
| Gezeichnete Formen in einem Gebiet (Polygone und Kreise) | 3 |
| Regionen und Objekte eines Layers in einem Gebiet, zusammen | 200 |
| Punkte im Umriss eines Gebiets | 2.000 |
| Zeichen des ganzen Filters, wie ihn eine Kartenanfrage überträgt | 60.000 |

Ein Umriss, der passt, wird so hinzugefügt, wie er ist. Einer, mit dem der Filter über eine Grenze käme, wird nur vereinfacht hinzugefügt und nur, wenn Sie zustimmen: Das Panel nennt seine Punkte, die Punkte des vereinfachten Umrisses und wie weit sich seine Ränder verschieben (<code>Vereinfacht hinzufügen</code> oder <code>Abbrechen</code>). Ein Umriss, der auch vereinfacht nicht passt, etwa einer aus sehr vielen Inseln, wird nicht hinzugefügt (<code>Nicht hinzugefügt: Der Umriss passt auch vereinfacht nicht in den Filter.</code>).

## Eigener Filter

Ein Filter, der außerhalb dieses Tabs geschrieben wurde, kann Teile enthalten, für die der Tab keine Zeile hat. Ein solcher Teil erscheint als Zeile mit dem Namen <code>Eigener Filter</code>. Er filtert weiter und lässt sich ausschalten oder entfernen, aber nicht bearbeiten.

## Als neuen Layer speichern

Klicken Sie oben im Tab <code>Filtern</code> unter der Anzahl auf <code>Als neuen Layer speichern</code>, geben Sie dem Layer einen Namen und klicken Sie auf <code>Layer speichern</code>, um **die gefilterten Features als neuen Layer zu speichern**. Vorgeschlagen wird der Name des ursprünglichen Layers mit dem Zusatz „(gefiltert)“. GOAT startet einen Job, der den Layer erstellt und ihn dem Projekt mit demselben Stil hinzufügt. So können Sie mit den gefilterten Daten unabhängig vom ursprünglichen Layer weiterarbeiten.

Der neue Layer enthält, was die Karte zeigt: Bedingungen und Gebiete, die ausgeschaltet oder unvollständig sind, bleiben außen vor. Die Schaltfläche erscheint, sobald ein Filter angewendet ist.

:::info
Um einen Filter zu ändern und als neuen Layer zu speichern, sind Bearbeitungsrechte für das Projekt nötig. Ohne sie zeigt der Tab <code>Filtern</code> den Filter nur als Text.
:::

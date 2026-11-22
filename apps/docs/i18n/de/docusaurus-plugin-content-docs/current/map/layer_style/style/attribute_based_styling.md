---
description: "Gestalten Sie Farben, Größen, Breiten und Symbole nach einem Datenfeld, nach Zoom oder nach Klassen mit Paletten und Klassifizierungsmethoden wie Quantilen oder manuellen Grenzen, gestalten Sie eine Klasse für sich und ändern Sie passende Objekte mit Regeln."
sidebar_position: 2
---

# Attributbasiertes Styling

**Sie können einen Layer nach seinen Daten gestalten, um Unterschiede und Trends auf einen Blick zu zeigen.** Fast jede Farbe, Größe, Breite und jedes Symbol im Stil-Panel kann einem Feld folgen, sich mit dem Zoom ändern oder einen Wert je Klasse eines Feldes annehmen. Regeln ändern die Objekte, die eine Bedingung erfüllen.

## Wie ein Wert festgelegt wird

Rechts neben einer Eigenschaft im Stil-Panel sitzt eine kleine Schaltfläche mit einem Symbol und einem Pfeil. Sie zeigt, wie der Wert festgelegt wird. Klicken Sie darauf, um eine andere Art zu wählen:

| Option | Was sie bewirkt |
| ------ | --------------- |
| <code>Fest</code> | Ein Wert überall. |
| <code>Nach Zoom</code> | Der Wert ändert sich beim Zoomen oder wechselt an den Zoomstufen, die Sie festlegen. Siehe [Nach Zoom](#by-zoom). |
| <code>Nach Attribut</code> | Ein Farbverlauf über ein Zahlenfeld oder eine Größe im Verhältnis zu einem Zahlenfeld. Siehe [Nach Attribut](#by-attribute). |
| <code>Feldwerte</code> | Nimmt den Wert des Feldes, wie er ist: ein Textfeld mit Farben wie `#2166ac` oder ein Zahlenfeld für die <code>Drehung</code> von Symbolen oder eine <code>Höhe</code>. |
| <code>Nach Klassen</code> | Ein Wert je Kategorie oder Bereich eines Feldes. Siehe [Nach Klassen](#by-classes). |

Das Menü zeigt nur die Optionen, die die Eigenschaft erlaubt. <code>Feldwerte</code> erscheint bei Farben nur, wenn der Layer ein Textfeld mit Farben hat. Während Sie [eine Klasse gestalten](#style-one-class), kommt <code>Zurücksetzen</code> hinzu, das der Klasse wieder den Wert aller Objekte gibt.

Wenn Sie eine Option wählen, öffnet sich ihr Editor neben dem Panel. Danach zeigt die Zeile eine Zusammenfassung, etwa einen Farbverlauf, <code>Nach Zoom · 3 Stufen</code> oder den Namen des Feldes; ein Klick auf die Zeile öffnet den Editor wieder.

## Nach Attribut {#by-attribute}

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Öffnen Sie einen Teil des Symbols, zum Beispiel <code>Füllung</code> im Abschnitt <code>Polygone</code>, klicken Sie auf die Schaltfläche neben <code>Farbe</code> und wählen Sie <code>Nach Attribut</code>. Der Editor <code>Farbe nach Attribut</code> öffnet sich.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Wählen Sie unter <code>Feld</code> das <strong>Zahlenfeld</strong>, nach dem gestaltet werden soll. Die Liste zeigt den Wertebereich jedes Feldes.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Klicken Sie bei einer Farbe auf <code>Palette</code> und wählen Sie eine Palette (siehe <a href="#color-palettes">Farbpaletten</a>). Bei einer Größe oder Breite legen Sie unter <code>Kleinster Wert</code> und <code>Größter Wert</code> fest, welche Werte sie annimmt.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie unter <code>Skala</code>, wie Werte auf die Farben oder Größen abgebildet werden: <code>Linear</code> (Werte werden gleichmäßig abgebildet), <code>Quadratwurzel</code> (Größen wachsen mit der Fläche, die übliche Wahl für Kreise; bei Farben mehr von der Palette für die kleinen Werte) oder <code>Logarithmisch</code> (für Werte über mehrere Größenordnungen).</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Legen Sie <code>Keine Daten</code> fest: die Farbe oder den Wert von Objekten ohne Wert im Feld. <code>Titel in der Legende</code> benennt den Verlauf in der Legende; ohne Eingabe gilt der Name des Feldes.</div>
</div>

<code>Werte</code> zeigt den Bereich, den der Server aus dem Feld berechnet hat, zum Beispiel <code>2 bis 97 entlang der Palette</code>. Der Server berechnet ihn neu, wenn sich die Daten ändern. Um den Bereich festzuhalten, schalten Sie <code>Fester Bereich</code> ein und geben ihn unter <code>Bereich</code> ein; Werte außerhalb erhalten die Endwerte.

## Nach Klassen {#by-classes}

Nach Klassen teilt die Werte eines Feldes in Klassen und gibt jeder Klasse einen eigenen Wert: eine Farbe, Größe, Breite, ein Muster oder Symbol.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf die Schaltfläche neben einer Eigenschaft, zum Beispiel <code>Farbe</code> im Editor <code>Füllung</code>, und wählen Sie <code>Nach Klassen</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Wählen Sie das Feld in der Liste, die sich öffnet. Text-, Zahlen- und Wahr/Falsch-Felder sind möglich. Der Klassifizierungseditor öffnet sich, zum Beispiel <code>Füllfarbe nach Klassen</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie unter <code>Methode</code>, wie die Klassen gebildet werden (siehe <a href="#datenklassifizierungsmethoden">Datenklassifizierungsmethoden</a>), und unter <code>Klassen</code>, wie viele.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie bei Farben eine <code>Palette</code>, bei Größen und Breiten einen <code>Bereich</code>. Bei einem Zahlenfeld zeigt ein Histogramm die Werte und die Klassengrenzen; ziehen Sie eine Grenze daran entlang, oder klicken Sie darauf und verwenden Sie die Pfeiltasten: Die Klassen werden zu <code>Manuelle Grenzen</code>, und die übrigen Grenzen bleiben. Eine Grenze bleibt einen Schritt innerhalb der Balken des Histogramms; bei einem Feld aus ganzen Zahlen bewegt sie sich in ganzen Zahlen.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Passen Sie die Klassen in der Klassenliste an (siehe <a href="#the-class-list">Die Klassenliste</a>).</div>
</div>

Weitere Einstellungen des Klassifizierungseditors:

- <code>Feld</code>: das Feld, aus dem die Klassen gebildet werden. Sie können es hier ändern.
- <code>Setzt</code>: die Eigenschaft, die die Klassen setzen, etwa <code>Füllfarbe</code>, <code>Umrissbreite</code> oder <code>Symbol</code>. Eine Eigenschaft, die eine andere Klassifizierung setzt, zeigt <code>auch gesetzt von</code> diesem Feld.
- Das Papierkorb-Symbol im Kopf des Editors (<code>Klassifizierung entfernen</code>) entfernt die Klassen; die Eigenschaft hat dann wieder einen Wert.

Der Server berechnet die Klassen: Währenddessen zeigt der Editor <code>Klassen werden berechnet…</code> und danach, aus wie vielen Objekten sie berechnet wurden. Die Klassen werden neu berechnet, wenn sich die Daten ändern, außer Klassen, die Sie von Hand festgelegt haben.

### Die Klassenliste {#the-class-list}

Jede Klasse hat eine Zeile mit:

- ihrem Wert: ein Farbfeld, eine Zahl, ein Muster oder ein Symbol. Klicken Sie darauf, um ihn zu ändern.
- bei <code>Manuelle Grenzen</code> ihrer Untergrenze, ab der zweiten Klasse.
- ihrem Namen. Ohne Eingabe gelten die Werte oder der Bereich der Klasse, zum Beispiel <code>2.800 bis 3.600</code>; geben Sie einen Namen ein, erscheint er stattdessen in der Legende, etwa <code>Niedrig</code> oder <code>Hoch</code>.
- der Zahl der Objekte darin.
- einem Augen-Symbol, um die Klasse aus- oder einzublenden (<code>Diese Klasse ausblenden</code>, <code>Diese Klasse einblenden</code>).
- einem Stift-Symbol, <code>Diese Klasse gestalten</code>, das die Klasse im Panel öffnet: siehe [Eine Klasse gestalten](#style-one-class).

Am Ende der Liste steht <code>Andere</code> für Werte in keiner Klasse und <code>Keine Daten</code> für Objekte ohne Wert im Feld. Eine Zeile für Objekte, die es in den Daten nicht gibt, ist abgeblendet und zählt 0: Ihre Einstellungen warten auf Daten, die solche Objekte enthalten, und die Legende lässt sie weg.

Einen Wert, den Sie in einer Klassenzeile ändern, behält die Klasse, auch wenn der Server die Klassen neu berechnet. Solange die Klassen eingegebene Größen oder Breiten haben, zeigt <code>Bereich</code> <code>Eigene Werte</code>; solange sie selbst gewählte Farben haben, zeigt <code>Palette</code> <code>Eigene Farben</code>. Wählen Sie einen Bereich oder eine Palette, erhalten alle Klassen ihre Werte wieder daraus.

**Selbst gewählte Kategorien.** Bei der Methode <code>Kategorien</code> klicken Sie auf den Namen einer Klasse, um ihre Werte zu öffnen: Haken Sie die Werte an, die in diese Klasse gehören, durchsuchen Sie sie oder entfernen Sie die Klasse. <code>Klasse hinzufügen</code> beginnt eine neue Klasse (<code>Werte auswählen</code>). Ziehen Sie eine Klasse an die Stelle einer anderen, um sie zu verschieben, oder verschieben Sie sie mit Alt und der Pfeiltaste nach oben oder unten um eine Stelle, während eines ihrer Bedienelemente den Fokus hat (nur bei Kategorien, Klassen aus Wertebereichen behalten ihre Reihenfolge): Die Legende folgt der Reihenfolge. Sobald Sie die Klassen von Hand ändern, auch durch Verschieben, zeigt <code>Klassen</code> den Eintrag <code>Von Hand gewählt</code>: Neue Daten behalten diese Klassen, und Werte in keiner Klasse erscheinen als <code>Andere</code>.

### Datenklassifizierungsmethoden {#datenklassifizierungsmethoden}

| Methode | Wie sie die Klassen bildet | Geeignet für |
| ------- | -------------------------- | ------------ |
| <code>Kategorien</code> | Eine Klasse pro Wert. | Text- und Wahr/Falsch-Felder oder Zahlen, die Codes sind. Die einzige Methode für Text- und Wahr/Falsch-Felder. |
| <code>Quantile</code> | Etwa gleich viele Objekte in jeder Klasse ([Quantil](https://www.plan4better.de/de/glossar/quantilklassifizierung)). | Rangfolgen; ergibt ungleiche Wertebereiche. |
| <code>Gleiche Intervalle</code> | Klassen gleicher Breite ([Gleiche Intervalle](https://www.plan4better.de/de/glossar/gleiche-intervalle)). | Gleichmäßig verteilte Werte; bei schiefen Daten bleiben manche Klassen leer. |
| <code>Natürliche Unterbrechungen</code> | Grenzen dort, wo die Werte springen (Jenks). | Werte, die Gruppen bilden. |
| <code>Standardabweichung</code> | Klassen um den Mittelwert ([Standardabweichung](https://www.plan4better.de/de/glossar/standardabweichung-klassifizierung)). | Zeigen, wie weit Objekte vom Durchschnitt entfernt liegen; am besten bei normalverteilten Daten. |
| <code>Head/Tail-Breaks</code> | Für Werte, bei denen wenige sehr groß sind. | Schiefe Daten, bei denen die Extreme zählen. |
| <code>Geometrische Intervalle</code> | Klassen, die um denselben Faktor breiter werden. Nur für Felder, deren Werte alle über 0 liegen; sonst ist die Methode nicht verfügbar. | Werte, die über Größenordnungen wachsen, etwa Einwohnerzahlen oder Preise. |
| <code>Manuelle Grenzen</code> | Sie geben die Untergrenze jeder Klasse ein. | Eigene Schwellenwerte, gleich über mehrere Karten. |

<code>Klassen</code> legt fest, wie viele: von <code>2 Klassen</code> bis <code>13 Klassen</code> bei Zahlen (Standard: 5) und <code>Alle Werte</code> (bis zu 256) oder die häufigsten (<code>Top 3</code>, <code>Top 5</code>, <code>Top 8</code> oder <code>Top 12</code>) bei Kategorien.

### Mehrere Klassifizierungen

Ein Layer kann mehrere Klassifizierungen haben, zum Beispiel die Füllfarbe nach Flächennutzung und die Umrissbreite nach Fläche. Sie gelten der Reihe nach; wo zwei dieselbe Eigenschaft setzen, gewinnt die spätere. Die Reihenfolge ändern Sie in der Legende unter <code>Inhalt</code> bei <code>Reihenfolge</code> (siehe [Legende](../legend.md)).

## Eine Klasse gestalten {#style-one-class}

Eine Klasse kann mit denselben Einstellungen wie der ganze Layer eine eigene Füllung, einen Umriss, ein Symbol, eine Beschriftung oder einen Zoombereich erhalten.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie im Kopf des Abschnitts <code>Polygone</code>, <code>Linien</code> oder <code>Punkte</code> auf <code>Alle Objekte</code> (erscheint, sobald der Layer Klassen hat). Das Menü <code>Eine Klasse gestalten</code> listet die Klassen aller Klassifizierungen.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Wählen Sie eine Klasse. Der Abschnitt zeigt <code>Nur … wird bearbeitet. Ein Punkt markiert, was sich von allen Objekten unterscheidet.</code> und zusätzlich <code>Sichtbar</code>, den eigenen Zoombereich der Klasse.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Ändern Sie die Zeilen wie gewohnt: Die Änderungen gelten nur für diese Klasse. Um einer Eigenschaft wieder den Wert aller Objekte zu geben, wählen Sie im Menü ihrer Schaltfläche <code>Zurücksetzen</code>. Eine Klasse kann einen Teil ausschalten, den der Layer zeigt; ein Teil, der für den ganzen Layer ausgeschaltet ist, zum Beispiel die Füllung, bleibt aber in jeder Klasse aus: Sein Schalter ist ausgegraut mit <code>Für den Layer ausgeschaltet</code>, und die Klasse behält ihre Einstellungen für den Fall, dass Sie den Teil für alle Objekte wieder einschalten. Die Zeile eines solchen Teils zeigt <code>Für alle aus</code>. Bei jedem Teil außer dem Hauptteil (die Füllung von Polygonen, die Linie von Linien, der Marker von Punkten) bietet der Editor der Klasse <code>Pro Klasse erlauben</code> an: Der Teil bleibt für alle Objekte aus, und Klassen können ihn einschalten.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Klicken Sie auf <code>Alle Objekte</code>, um wieder den ganzen Layer zu bearbeiten.</div>
</div>

## Nach Zoom {#by-zoom}

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf die Schaltfläche neben einer Eigenschaft und wählen Sie <code>Nach Zoom</code>. Der Editor öffnet sich mit einem Diagramm: die Zoomstufen von links nach rechts, der Wert an jedem Stopp und eine Markierung beim aktuellen Zoom der Karte. Zoomstufen, bei denen der Layer ausgeblendet ist, sind schattiert.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf einen Stopp, um ihn auszuwählen, an eine andere Stelle im Diagramm, um einen hinzuzufügen, und ziehen Sie einen Stopp, um ihn zu verschieben. Für den ausgewählten Stopp legen Sie unter <code>Stopp</code> seinen Zoom und unter <code>Wert</code> seinen Wert fest; bei mehr als zwei Stopps entfernt ihn das Papierkorb-Symbol neben <code>Stopp</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie unter <code>Übergang</code>, wie sich der Wert zwischen den Stopps ändert: <code>Linear</code>, <code>Weich</code> (erst langsam, zum nächsten Stopp hin schneller) oder <code>Stufen</code> (springt an jedem Stopp zum nächsten Wert). Werte wie eine Strichart oder ein Symbol wechseln immer an jedem Stopp. Auf einem Marker mit Form, einem Pin oder einem Symbol auf einem Kreis, auf dem Marker einer Fläche oder Linie und auf einem Muster ändert sich eine Farbe einmal je ganzer Zoomstufe: bei Zoom 12,5 hat sie ihren Wert von Zoom 12.</div>
</div>

**Größen, die einem Feld folgen und mit dem Zoom wachsen.** Legen Sie den Wert zuerst <code>Nach Attribut</code> fest und wählen Sie dann <code>Nach Zoom</code>: Jeder Stopp behält das Feld. Der <code>Wert</code> eines Stopps zeigt dann <code>Nach</code> und den Namen des Feldes; klicken Sie darauf, um für diesen Stopp <code>Kleinster Wert</code> und <code>Größter Wert</code> festzulegen, etwa größere Kreise bei einem höheren Zoom. Zwischen den Stopps gehen die Größen ineinander über, sodass die Kreise beim Wachsen ihre Verhältnisse behalten. Das gilt für jede Größe, Breite, Farbe, Deckkraft und Höhe, die sich <code>Nach Attribut</code> festlegen lässt.

## Farbpaletten {#color-palettes}

Die Palettenauswahl öffnet sich über <code>Palette</code> oder <code>Farben</code>. Sie zeigt die Paletten von GOAT nach Art (<code>Alle</code>, <code>Sequenziell</code>, <code>Divergierend</code> und <code>Kategorien</code>), die Paletten, die dieser Stil verwendet (<code>Verwendet</code>), und Ihre eigenen (<code>Eigene</code>). Unter <code>Alle</code> steht <code>Wissenschaft und Gelände</code> zuerst: die wahrnehmungsgleichen Verläufe Viridis, Magma, Cividis, Inferno und Plasma sowie Verläufe für Höhen und Vegetation (Elevation, Terrain, Hypsometric tints, NDVI), für Raster wie für Zahlenfelder. <code>Umkehren</code> dreht die Farben um.

| Art | Beispiel | Beschreibung |
| :-: | -------- | ------------ |
| <code>Sequenziell</code> | <img src={require('/img/map/styling/sequential_palette.png').default} alt="Sequenzielle Paletten"/> | **Für Werte in einer Reihenfolge**, etwa steigende oder fallende Zahlen: Die Farben laufen von einem Ende zum anderen. |
| <code>Divergierend</code> |   | **Für Werte um einen Mittelpunkt**, etwa positive und negative Werte. |
| <code>Kategorien</code> | <img src={require('/img/map/styling/qualitative_palette.png').default} alt="Paletten für Kategorien"/> | **Für unterschiedliche Kategorien** ohne Reihenfolge oder Rangordnung. |

Eine Farbe nach Attribut (ein stufenloser Verlauf) listet die Farben der Palette unten in ihrem Editor als Klassenliste (<code>Farbe</code> und <code>Wert</code>): Jede Zeile zeigt eine Farbe und den Feldwert, an dem sie liegt (den Farbcode, solange die Werte noch nicht bekannt sind); ein Klick auf das Farbfeld ändert sie, zeigen Sie auf eine Zeile (oder erreichen Sie sie mit der Tastatur), dann fügt das Plus eine Kopie ihrer Farbe dahinter ein (bis zu 12 Farben) und der Papierkorb entfernt ihre Farbe (solange mehr als zwei übrig sind), eine Zeile lässt sich an eine andere Stelle ziehen (oder mit Alt und der Pfeiltaste nach oben oder unten um eine Stelle verschieben, während eines ihrer Bedienelemente den Fokus hat), und <code>Farbe hinzufügen</code> fügt am Ende eine an. Die erste Änderung macht die Palette zu eigenen Farben (2 bis 12; eine umgekehrte Palette behält die Reihenfolge, in der sie gezeichnet wird), und eine Palette erneut zu wählen ersetzt sie. Dieselbe Liste steht unter <code>Farben</code> einer Heatmap und von H3-Sechsecken ohne Klassen. Klassen haben keine solche Liste: Ihre Zeilen sind die Farben zum Bearbeiten, und <code>Palette</code> färbt sie alle neu.

## Regeln {#rules}

Eine Regel ist eine Bedingung auf beliebigen Feldern und das, was sie für die passenden Objekte ändert, für das, was eine Klassifizierung nicht ausdrücken kann: mehrere Felder auf einmal, ein Schwellenwert neben Kategorien oder leere Werte. Regeln gelten nach den Klassifizierungen, in der Reihenfolge der Liste: Wo zwei Regeln dieselbe Eigenschaft ändern, gewinnt die weiter unten.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie im Abschnitt <code>Regeln</code> auf <code>Regel hinzufügen</code> (das Plus).</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie unter <code>Wenn</code> auf <code>Bedingung hinzufügen</code> und wählen Sie ein Feld. Der Editor der Bedingung öffnet sich neben der Regel: Wählen Sie unter <code>Bedingung</code> den Vergleich und legen Sie den Wert fest wie beim <a href="../../filter#nach-attributen-filtern">Filtern</a>, aus der Liste der Werte des Felds mit ihrer Häufigkeit oder mit dem Schieberegler über dem Histogramm. Jede Bedingung steht danach als Satz in ihrer Zeile: Ein Klick auf die Zeile ändert sie; zeigen Sie auf die Zeile und klicken Sie auf das Papierkorb-Symbol, um sie zu entfernen (eine Regel behält mindestens eine Bedingung). Ab zwei Bedingungen legt das Menü neben <code>Wenn</code> fest, ob Objekte jede Bedingung erfüllen (<code>Alle erfüllt</code>) oder mindestens eine (<code>Eine erfüllt</code>).</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Klicken Sie auf <code>Regel hinzufügen</code>. Der Editor der Regel öffnet sich.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Geben Sie unter <code>Name</code> einen Namen ein (ohne Eingabe gilt die Bedingung als Satz) und wählen Sie unter <code>Dann</code>, was sie bewirkt: <code>Zeigen</code> aus blendet die passenden Objekte aus, <code>Zoomstufen</code> zeigt sie bei weniger Zoomstufen, <code>In Legende</code> aus lässt die Regel in der Legende weg, und <code>Passende Objekte gestalten</code> öffnet die Regel im Symbol-Abschnitt, um ihnen eine eigene Füllung, einen Umriss, ein Symbol oder eine Beschriftung zu geben, wie bei <a href="#style-one-class">einer Klasse</a>.</div>
</div>

Die Zeilen des Abschnitts <code>Regeln</code> zeigen den Namen jeder Regel und was sie ändert. Mit den Pfeilen verschieben Sie eine Regel nach oben oder unten; das Papierkorb-Symbol im Kopf des Regel-Editors (<code>Regel entfernen</code>) entfernt sie. Eine Bedingung, die die Zeilen nicht darstellen können, öffnet sich als CQL2-Text (<code>Als CQL2 bearbeiten</code>).

:::tip HINWEIS
Um Ihre Gestaltung dieses Datensatzes auch in anderen Projekten zu nutzen, machen Sie sie zum Standardstil des Datensatzes: siehe [Benannte Stile](./styling.md#named-styles).
:::

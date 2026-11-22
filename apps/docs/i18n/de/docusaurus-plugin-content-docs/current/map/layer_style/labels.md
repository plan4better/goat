---
description: "Beschriften Sie Kartenobjekte mit einem Feld oder einem eigenen Text mit Feldwerten und legen Sie Zahlenformat, Größe, Farbe und Halo der Beschriftungen fest, ihren Textstil (Schrift, Schreibweise, Zeichenabstand, Zeilenhöhe, Umbruch) und ihre Platzierung (Position, Versatz, Wiederholungsabstand, Priorität, Überlappung, Abstand zu anderen)."
sidebar_position: 3
---

# Beschriftungen

**Beschriftungen zeigen Text auf Ihren Kartenobjekten, aus einem Feld oder aus einem eigenen Text.** So werden Ihre Karten leichter lesbar, weil wichtige Informationen direkt auf den Objekten stehen.

## Wie man eine Beschriftung hinzufügt

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie im <code>Layer</code>-Panel auf Ihren Layer. Rechts öffnet sich das Einstellungs-Panel des Layers; der Tab <code>Stil</code> ist ausgewählt.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie im Abschnitt <code>Polygone</code>, <code>Linien</code> oder <code>Punkte</code> auf <code>Beschriftung</code>. Ihr Editor öffnet sich neben dem Panel. Ist die Beschriftung aus, schalten Sie sie mit dem Schalter im Kopf des Editors ein.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Klicken Sie auf <code>Text</code> und wählen Sie das <strong>Feld</strong>, dessen Werte erscheinen sollen. <code>Vorschau</code> zeigt die Beschriftung des ersten Objekts.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Legen Sie <code>Größe</code> und <code>Farbe</code> des Textes fest. Die drei Zeilen darunter, <code>Halo</code>, <code>Textstil</code> und <code>Platzierung</code>, fassen jeweils ihre Einstellungen zusammen; ein Klick öffnet die Einstellungen neben dem Editor.</div>
</div>

Die Zeile im Abschnitt zeigt dann das Feld und die Größe, zum Beispiel <code>Name · 12 px</code>.

## Eigener Text

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Text</code> und wählen Sie oben in der Liste <code>Eigener Text</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Geben Sie den Text unter <code>Vorlage</code> ein. Felder stehen in geschweiften Klammern und werden durch den Wert jedes Objekts ersetzt, zum Beispiel <code>{"{name}"}, {"{population}"} Einwohner</code> oder <code>{"{area_km2}"} km²</code>. Mit <code>Feld einfügen</code> hängen Sie ein Feld an. Ein Zeilenumbruch in der Vorlage beginnt eine neue Zeile in der Beschriftung. Die Vorlage wird übernommen, wenn Sie das Feld verlassen oder <code>Strg+Enter</code> (<code>Cmd+Enter</code> auf dem Mac) drücken; eine Vorlage, die nicht gelesen werden kann, bleibt im Feld, mit einem Hinweis auf den Grund.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Bei einer Beschriftung mit mehreren Zeilen legt <code>Zeilenstile</code> <code>Größe</code>, <code>Farbe</code> und <code>Schrift</code> jeder Zeile fest, aus denselben Schriften wie die <code>Schrift</code> der Beschriftung. Eine Zeile ohne eigene Schrift zeigt die der Beschriftung.</div>
</div>

## Halo

<code>Halo</code> zeigt Farbe und Breite des Halos, zum Beispiel <code>1,5 px</code>, oder <code>Keiner</code>. Ein Klick darauf legt seine <code>Farbe</code> und <code>Breite</code> fest: einen Rand um die Buchstaben, der sie auf unruhigem Hintergrund lesbar hält.

## Textstil

<code>Textstil</code> nennt zuerst die Schrift, dann, was vom einfachen Text abweicht, zum Beispiel <code>Normal, Großbuchstaben, Zeichenabstand 24%</code>. Ist der Text gekürzt, erscheint er ganz, wenn Sie mit der Maus auf die Zeile zeigen oder sie mit der Tastatur ansteuern. Ein Klick darauf legt fest:

- <code>Schrift</code>: eine von acht Schriften, die Stärken <code>Normal</code>, <code>Fett</code>, <code>Mittel</code> und <code>Leicht</code>, jeweils unter <code>Aufrecht</code> und unter <code>Kursiv</code>. Das Feld nennt die ganze Schrift, zum Beispiel <code>Fett kursiv</code>; die normale Stärke kursiv heißt <code>Kursiv</code>. <code>Nach Zoom</code> ist jeder Stopp eine der acht; <code>Nach Klassen</code> wählt jede Klasse eine.
- <code>Schreibweise</code>: den Text <code>Wie geschrieben</code>, in <code>Großbuchstaben</code> oder in <code>Kleinbuchstaben</code>.
- <code>Zeichenabstand</code>: rückt die Buchstaben auseinander oder unter 0% enger zusammen, in Prozent der Textgröße.
- <code>Zeilenhöhe</code>: den Abstand von einer Zeile der Beschriftung zur nächsten, standardmäßig 120% der Textgröße.
- <code>Umbruch bei</code>: die Breite in px, bei der eine lange Beschriftung in die nächste Zeile umbricht.

## Zahlen

Zeigt der Text ein Zahlenfeld, öffnet <code>Zahlen</code> das <code>Zahlenformat</code>: <code>Dezimalstellen</code>, <code>Tausender</code> (ein Tausendertrennzeichen), <code>Abkürzen</code> (12,3k statt 12.345), <code>Vorzeichen</code> (immer + oder -), <code>Prozent</code> (ein Anteil von 1 als Prozent: 0,73 wird zu 73 %), <code>Präfix</code> und <code>Suffix</code>, etwa € oder km². Es gilt für jede Zahl in der Beschriftung; <code>Wie im Datensatz</code> behält das Format des Datensatzes. Enthält eine Vorlage mehrere Zahlenfelder, kann jedes ein eigenes Format erhalten (<code>Zahlen in</code> dem Feld).

## Platzierung {#position}

<code>Platzierung</code> nennt, wo die Beschriftungen stehen, mit einem kleinen Raster, das die Seite zeigt, zum Beispiel <code>Automatisch</code> oder <code>Entlang der Linie</code>. Ein Klick darauf legt fest:

- <code>Position</code>: bei Punkten <code>Automatisch</code>, <code>In der Mitte</code> oder eine feste Seite: <code>Oben</code>, <code>Unten</code>, <code>Links</code>, <code>Rechts</code>, <code>Oben links</code>, <code>Oben rechts</code>, <code>Unten links</code> oder <code>Unten rechts</code>. Ein kleines Raster neben jeder Wahl zeigt die Seite. <code>Automatisch</code> wählt für jede Beschriftung eine freie Seite; eine feste Seite hält jede Beschriftung auf dieser Seite, mit Abstand zum Marker, und lässt eine Beschriftung, die sich überschneiden würde, weg, statt sie zu verschieben. Neben dem Punkt richten sich die Zeilen einer Beschriftung an der Seite des Punktes aus. Polygone haben dieselbe Wahl rund um ihren [Marker](./style/styling.md#markers-on-polygons-and-lines), der an einem Punkt im Inneren jedes Polygons steht: <code>Automatisch</code> setzt die Beschriftung neben den Marker oder, solange das Polygon keinen Marker hat, in seine Mitte. Bei Linien <code>Entlang der Linie</code> oder eine Beschriftung in der Mitte jeder Linie, mit derselben Wahl rund um den Marker der Linie. Ohne Marker steht eine Beschriftung an einer festen Seite knapp neben dem mittleren Punkt des Polygons oder der Linie. Solange die Polygone eine [Höhe](./style/styling.md#height) haben, stehen ihre Beschriftungen auf den Dächern (<code>Auf dem Dach</code>).
- <code>Versatz x</code> und <code>Versatz y</code>: verschieben die Beschriftungen waagerecht oder senkrecht, in px.
- <code>Wiederholungsabstand</code>: bei Beschriftungen <code>Entlang der Linie</code>, in welchem Abstand sich die Beschriftung entlang der Linie wiederholt, standardmäßig 250 px.
- <code>Überlappen</code>: Aus werden Beschriftungen, die sich überschneiden würden, weggelassen; das hält die Karte übersichtlich, besonders bei niedrigen Zoomstufen. Die Position <code>Automatisch</code> versucht zuerst unten, dann oben, links und rechts. An wird jede Beschriftung gezeichnet, auch wo sie sich überlappen.
- <code>Priorität</code>: solange Überlappen aus ist, welche Beschriftungen zuerst bleiben: <code>Keine Priorität</code> oder größere oder kleinere Werte eines Zahlenfeldes zuerst, etwa die Städte mit den meisten Einwohnern.
- <code>Abstand zu anderen</code>: der freie Raum in px um jede Beschriftung, standardmäßig 2 px. So weit bleiben andere Beschriftungen entfernt; mehr Abstand zeigt also weniger Beschriftungen.

Unter <code>Platzierung</code> legt <code>Sichtbar</code> die Zoomstufen fest, bei denen die Beschriftungen erscheinen, zum Beispiel erst beim Hineinzoomen. Siehe [Zoom-Sichtbarkeit](./zoom.md).

:::tip
Eine Beschriftung kann je Klasse verschieden sein, etwa größer für Hauptstraßen: Geben Sie der Klasse eine eigene Beschriftung, wie unter [Eine Klasse gestalten](./style/attribute_based_styling.md#style-one-class) beschrieben. Größe und Farbe von Beschriftungen können sich auch [nach Zoom](./style/attribute_based_styling.md#by-zoom) ändern. Während Sie eine Klasse gestalten, zeigen <code>Halo</code>, <code>Textstil</code> und <code>Platzierung</code> die Werte der Klasse, mit einem Punkt, wenn die Klasse einen davon selbst festlegt. <code>Zeilenhöhe</code>, <code>Position</code>, <code>Wiederholungsabstand</code>, <code>Priorität</code>, <code>Überlappen</code> und <code>Abstand zu anderen</code> gelten für den ganzen Layer: Eine Klasse kann sie nicht ändern.
:::

## Bewährte Praktiken

- Verwenden Sie **kleinere Schriften für dichte Layer**, um visuelle Unordnung zu reduzieren.
- Fügen Sie **Halos mit kontrastierenden Farben** hinzu (helle Halos auf dunklen Karten, dunkle Halos auf hellen Karten), um die Lesbarkeit zu verbessern.
- Lassen Sie **Überlappen für eine übersichtlichere Karte aus** und legen Sie eine Priorität fest, damit die wichtigsten Beschriftungen bleiben, wenn der Platz knapp ist.
- Zeigen Sie ausführliche Beschriftungen **erst ab einer Zoomstufe** und testen Sie Ihre Beschriftungen bei verschiedenen Zoomstufen.

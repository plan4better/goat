---
description: "Beschriften Sie Kartenobjekte mit einem Feld oder einem eigenen Text mit Feldwerten und legen Sie Zahlenformat, Größe, Farbe, Schrift, Halo, Position, Versatz, Priorität und Überlappung der Beschriftungen fest."
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
  <div class="content">Legen Sie das Aussehen des Textes fest: <code>Größe</code>, <code>Farbe</code>, <code>Schrift</code> (<code>Normal</code> oder <code>Fett</code>) sowie eine <code>Halo</code>-Farbe mit ihrer <code>Halo-Breite</code>, einen Rand um die Buchstaben, der sie auf unruhigem Hintergrund lesbar hält.</div>
</div>

Die Zeile im Abschnitt zeigt dann das Feld und die Größe, zum Beispiel <code>Name · 12 px</code>.

## Eigener Text

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Text</code> und wählen Sie oben in der Liste <code>Eigener Text</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Geben Sie den Text unter <code>Vorlage</code> ein. Felder stehen in geschweiften Klammern und werden durch den Wert jedes Objekts ersetzt, zum Beispiel <code>{"{name}"}, {"{population}"} Einwohner</code> oder <code>{"{area_km2}"} km²</code>. Mit <code>Feld einfügen</code> hängen Sie ein Feld an. Ein Zeilenumbruch in der Vorlage beginnt eine neue Zeile in der Beschriftung.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Bei einer Beschriftung mit mehreren Zeilen legt <code>Zeilenstile</code> <code>Größe</code>, <code>Farbe</code> und <code>Fett</code> jeder Zeile fest.</div>
</div>

## Zahlen

Zeigt der Text ein Zahlenfeld, öffnet <code>Zahlen</code> das <code>Zahlenformat</code>: <code>Dezimalstellen</code>, <code>Tausender</code> (ein Tausendertrennzeichen), <code>Abkürzen</code> (12,3k statt 12.345), <code>Vorzeichen</code> (immer + oder -), <code>Präfix</code> und <code>Suffix</code>, etwa € oder km². Es gilt für jede Zahl in der Beschriftung; <code>Wie im Datensatz</code> behält das Format des Datensatzes. Enthält eine Vorlage mehrere Zahlenfelder, kann jedes ein eigenes Format erhalten (<code>Zahlen in</code> dem Feld).

## Position und Überlappung

- <code>Umbruch bei</code>: die Breite in px, bei der eine lange Beschriftung in die nächste Zeile umbricht.
- <code>Position</code>: bei Punkten <code>Automatisch</code>, <code>Oberhalb</code> oder <code>Mitte</code>; bei Linien <code>Entlang der Linie</code> oder <code>Mitte</code>. Beschriftungen von Polygonen stehen im Polygon und, solange die Polygone eine [Höhe](./style/styling.md#height) haben, auf den Dächern (<code>Auf dem Dach</code>).
- <code>Versatz x</code> und <code>Versatz y</code>: verschieben die Beschriftungen waagerecht oder senkrecht, in px.
- <code>Überlappen</code>: Aus werden Beschriftungen, die sich überschneiden würden, weggelassen; das hält die Karte übersichtlich, besonders bei niedrigen Zoomstufen. Die Position <code>Automatisch</code> versucht zuerst rechts, oben, links und unten. An wird jede Beschriftung gezeichnet, auch wo sie sich überlappen.
- <code>Priorität</code>: solange Überlappen aus ist, welche Beschriftungen zuerst bleiben: <code>Keine Priorität</code> oder größere oder kleinere Werte eines Zahlenfeldes zuerst, etwa die Städte mit den meisten Einwohnern.
- <code>Sichtbar</code>: die Zoomstufen, bei denen die Beschriftungen erscheinen, zum Beispiel erst beim Hineinzoomen. Siehe [Zoom-Sichtbarkeit](./zoom.md).

:::tip
Eine Beschriftung kann je Klasse verschieden sein, etwa größer für Hauptstraßen: Geben Sie der Klasse eine eigene Beschriftung, wie unter [Eine Klasse gestalten](./style/attribute_based_styling.md#style-one-class) beschrieben. Größe und Farbe von Beschriftungen können sich auch [nach Zoom](./style/attribute_based_styling.md#by-zoom) ändern.
:::

## Bewährte Praktiken

- Verwenden Sie **kleinere Schriften für dichte Layer**, um visuelle Unordnung zu reduzieren.
- Fügen Sie **Halos mit kontrastierenden Farben** hinzu (helle Halos auf dunklen Karten, dunkle Halos auf hellen Karten), um die Lesbarkeit zu verbessern.
- Lassen Sie **Überlappen für eine übersichtlichere Karte aus** und legen Sie eine Priorität fest, damit die wichtigsten Beschriftungen bleiben, wenn der Platz knapp ist.
- Zeigen Sie ausführliche Beschriftungen **erst ab einer Zoomstufe** und testen Sie Ihre Beschriftungen bei verschiedenen Zoomstufen.

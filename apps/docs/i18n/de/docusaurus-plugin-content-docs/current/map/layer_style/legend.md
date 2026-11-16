---
description: "Blenden Sie die Legende eines Layers ein oder aus, legen Sie Titel und Bildunterschrift fest und bestimmen Sie je Klassifizierung, ob sie in der Legende steht, ihre Überschrift, Einheit und ihr Zahlenformat; Klassennamen ersetzen die Werte."
sidebar_position: 5
---

# Legende

**Legenden helfen Benutzern, die Symbolik und Bedeutung Ihrer Karten-Layer zu verstehen.** GOAT zeichnet die Legende jedes Layers aus seinem Stil, unter der Zeile des Layers im <code>Layer</code>-Panel. Sie legen fest, ob sie erscheint, geben ihr einen Titel und eine Bildunterschrift und bestimmen, was sie enthält.

## Wie man die Legende eines Layers verwaltet

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie im <code>Layer</code>-Panel auf Ihren Layer. Rechts öffnet sich das Einstellungs-Panel des Layers; der Tab <code>Stil</code> ist ausgewählt. Der Abschnitt <code>Legende</code> steht weit unten in diesem Tab.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Mit dem Schalter <code>Anzeigen</code> <strong>blenden Sie die Legende ein oder aus</strong>: <code>In der Layerliste</code> oder <code>Ausgeblendet</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Geben Sie unter <code>Titel</code> den Titel der Legende ein. Ohne Eingabe verwendet die Legende den Namen des Layers.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Klicken Sie auf <code>Inhalt</code>. Der Editor öffnet sich mit der Legende, wie sie aussehen wird, oben und darunter den Einstellungen dazu, was sie enthält.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Fügen Sie unter <code>Bildunterschrift</code> eine Zeile hinzu, die <strong>den Inhalt des Layers erklärt</strong>, zum Beispiel seine Quelle. Die Bildunterschrift erscheint in der Legende unter dem Namen des Layers.</div>
</div>

## Was die Legende enthält

Ein Layer ohne Klassen zeigt ein Farbfeld. Jede Klassifizierung (siehe [Nach Klassen](./style/attribute_based_styling.md#by-classes)) fügt einen Abschnitt mit einem Eintrag je Klasse hinzu. <code>Andere</code> und <code>Keine Daten</code> folgen, wenn die Daten solche Objekte enthalten: Werte, die in keiner Klasse stehen, oder Objekte ohne Wert im Feld. Zwei Klassifizierungen desselben Felds mit denselben Klassen, zum Beispiel eine Größe und eine Farbe, teilen sich einen Abschnitt, dessen Einträge beides zeigen. Eine Farbe oder Größe [nach Attribut](./style/attribute_based_styling.md#by-attribute) erscheint als Verlauf oder als Beispiele mit den Enden ihres Bereichs, unter dem Namen des Felds. Regeln zeigen ihren Namen und ein Farbfeld dessen, was sie ändern; in einem Layer ohne Klassen folgt <code>Übrige Objekte</code> für alles, worauf keine Regel zutrifft. Die Werte eines Ja/Nein-Felds erscheinen als <code>Ja</code> und <code>Nein</code>.

Die Legende führt auf, was die Karte zeichnet:

- Eine mit dem Auge ausgeblendete Klasse und eine Regel, die Objekte ausblendet, haben keinen Eintrag.
- Ein als <code>Heatmap</code> dargestellter Layer zeigt einen Verlauf von <code>Niedrig</code> bis <code>Hoch</code>, ein als <code>H3-Sechsecke</code> dargestellter die Klassen oder den Verlauf der Sechsecke. Steht <code>Punkte</code> auf <code>Ab Zoom</code> mit einer Zoomstufe, wechselt die Legende ab dieser Zoomstufe zu den Klassen der Punkte.
- Ein als <code>Cluster</code> dargestellter Layer führt zuerst <code>Cluster</code> auf, solange die Karte bei der aktuellen Zoomstufe noch gruppiert.
- Farben, die sich mit dem Zoom ändern, folgen der Karte. Symbolgrößen nicht: Jedes Symbol behält in der Legende eine Größe, damit sich die Legende beim Zoomen nicht verschiebt. Nur Klassen nach Größe werden in verschiedenen Größen gezeichnet, im Verhältnis zueinander.
- Ein Name, der zu lang für seine Zeile ist, wird gekürzt. Halten Sie den Mauszeiger darüber, um ihn ganz zu lesen.

Unter <code>Inhalt</code> hat jede Klassifizierung diese Einstellungen:

- <code>In der Legende</code>: Aus lässt die Klassifizierung in der Legende weg.
- <code>Überschrift</code>: der Titel ihres Abschnitts. Ohne Eingabe gilt der Name des Feldes.
- <code>Einheit</code>: eine Einheit hinter Zahlenwerten, etwa km². Namen erhalten keine Einheit.
- <code>Zahlen</code> (bei Zahlenfeldern): wie die Klassengrenzen erscheinen, mit <code>Dezimalstellen</code>, <code>Tausender</code>, <code>Abkürzen</code>, <code>Vorzeichen</code>, <code>Präfix</code> und <code>Suffix</code>. <code>Wie im Datensatz</code> behält das Format des Datensatzes.
- <code>Reihenfolge</code> (bei mehreren Klassifizierungen): der Platz der Klassifizierung. Er ist auch die Reihenfolge, in der sie gelten: Wo zwei dieselbe Eigenschaft setzen, gewinnt die spätere.

Bei einem Raster mit Farbverlauf hat <code>Inhalt</code> außerdem <code>Einheit</code>, <code>Beschriftung unten</code> und <code>Beschriftung oben</code>, die die Endwerte des Verlaufs ersetzen.

Solange die Einstellungen der Legende vom Stil des Datensatzes abweichen, zeigt der Kopf des Editors <code>Auf den Stil des Datensatzes zurücksetzen</code> (ein kreisförmiger Pfeil); damit setzen Sie sie so zurück, wie sie der Stil des Datensatzes hat.

## Welche Klassen die Legende aufführt

Bei einem Layer mit Klassen hat <code>Inhalt</code> die Einstellung <code>Angezeigte Klassen</code>. Sie bestimmt, welche Klassen die Legende aufführt, überall, wo sie erscheint: im <code>Layer</code>-Panel, in der Legende oben in <code>Inhalt</code>, in Drucklayouts, in Dashboards und auf öffentlichen Karten.

- <code>Alle</code>: jede Klasse.
- <code>Vom Filter behaltene</code> (Standard): nur die Klassen, die unter dem [Filter](../filter.md) des Layers noch Objekte haben. Ein Layer ohne Filter führt jede Klasse auf. GOAT zählt die Klassen bei jeder Änderung des Filters neu.
- <code>Im Kartenausschnitt</code>: nur die Klassen, die im aktuellen Kartenausschnitt gezeichnet sind. Die Legende aktualisiert sich, sobald die Karte stillsteht, nicht während Sie verschieben oder zoomen. In einem Drucklayout zählt die Legende die Klassen im Ausschnitt der Karte, mit der sie verbunden ist; eine Legende ohne verbundene Karte führt jede Klasse auf.

<code>Andere</code> und <code>Keine Daten</code> folgen derselben Regel, und eine Klassifizierung ohne verbleibende Klassen hat keinen Abschnitt. Bleibt gar keine Klasse übrig, zeigt die Legende <code>Keine im Kartenausschnitt</code> oder <code>Keine vom Filter behalten</code>. Farbverläufe, Größenbeispiele und Höhen ändern sich nicht. Solange die Klassen gezählt werden, zeigt die Legende an ihrer Stelle graue Platzhalterzeilen, und ein Druck wartet auf die Zählung; schlägt die Zählung fehl, führt die Legende jede Klasse auf.

## Eigene Bezeichnungen für Klassen

Jede Klasse erscheint mit ihren Werten oder ihrem Bereich, zum Beispiel <code>2.800 bis 3.600</code>. Um stattdessen eine Bezeichnung wie <code>Niedrig</code>, <code>Mittel</code> oder <code>Hoch</code> zu zeigen, benennen Sie die Klasse:

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Öffnen Sie die Klassifizierung, zum Beispiel mit einem Klick auf die Zeile <code>Farbe</code> im Editor <code>Füllung</code>, solange sie <code>Nach Klassen</code> festgelegt ist.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Geben Sie in der Klassenliste die Bezeichnung als Namen der Klasse ein. Der Platzhalter zeigt den Standardtext; lassen Sie das Feld leer, um ihn zu behalten.</div>
</div>

Änderungen erscheinen sofort in der Legende; es gibt nichts anzuwenden. Bei einem Verlauf [nach Attribut](./style/attribute_based_styling.md#by-attribute) benennt <code>Titel in der Legende</code> in seinem Editor den Verlauf. Eine Regel erscheint unter ihrem Namen (<code>Name</code>); schalten Sie <code>In Legende</code> aus, um sie wegzulassen.

## Bewährte Praktiken

- **Verwenden Sie klare, beschreibende Titel und Bildunterschriften**, die erklären, was der Layer darstellt.
- **Benennen Sie die Klassen**, wenn ihre Werte oder Bereiche dem Leser wenig sagen.
- **Blenden Sie die Legende** von Layern aus, die keine Erklärung brauchen, etwa Referenz-Layer.
- **Lassen Sie Regeln in der Legende weg**, wenn sie nur die Zoomstufen von Objekten ändern. Eine Regel, die Objekte ausblendet, hat keinen Legendeneintrag.

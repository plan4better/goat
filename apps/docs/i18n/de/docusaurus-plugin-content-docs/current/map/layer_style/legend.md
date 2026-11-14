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

Ein Layer ohne Klassen zeigt ein Farbfeld. Jede Klassifizierung (siehe [Nach Klassen](./style/attribute_based_styling.md#by-classes)) fügt einen Abschnitt mit einem Eintrag je Klasse hinzu, dann <code>Andere</code> und <code>Keine Daten</code>, wenn sie vorkommen. Eine Farbe oder Größe [nach Attribut](./style/attribute_based_styling.md#by-attribute) erscheint als Verlauf oder als Beispiele mit den Enden ihres Bereichs. Regeln zeigen ihren Namen und ein Farbfeld dessen, was sie ändern.

Unter <code>Inhalt</code> hat jede Klassifizierung diese Einstellungen:

- <code>In der Legende</code>: Aus lässt die Klassifizierung in der Legende weg.
- <code>Überschrift</code>: der Titel ihres Abschnitts. Ohne Eingabe gilt der Name des Feldes.
- <code>Einheit</code>: eine Einheit hinter den Werten, etwa km².
- <code>Zahlen</code> (bei Zahlenfeldern): wie die Klassengrenzen erscheinen, mit <code>Dezimalstellen</code>, <code>Tausender</code>, <code>Abkürzen</code>, <code>Vorzeichen</code>, <code>Präfix</code> und <code>Suffix</code>. <code>Wie im Datensatz</code> behält das Format des Datensatzes.
- <code>Reihenfolge</code> (bei mehreren Klassifizierungen): der Platz der Klassifizierung. Er ist auch die Reihenfolge, in der sie gelten: Wo zwei dieselbe Eigenschaft setzen, gewinnt die spätere.

Bei einem Raster mit Farbverlauf hat <code>Inhalt</code> außerdem <code>Einheit</code>, <code>Beschriftung unten</code> und <code>Beschriftung oben</code>, die die Endwerte des Verlaufs ersetzen.

Solange die Einstellungen der Legende vom Stil des Datensatzes abweichen, zeigt der Kopf des Editors <code>Auf den Stil des Datensatzes zurücksetzen</code> (ein kreisförmiger Pfeil); damit setzen Sie sie so zurück, wie sie der Stil des Datensatzes hat.

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
- **Lassen Sie Regeln in der Legende weg**, wenn sie nur Objekte ausblenden oder ihre Zoomstufen ändern.

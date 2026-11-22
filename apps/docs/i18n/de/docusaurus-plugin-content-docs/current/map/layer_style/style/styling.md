---
description: "Öffnen Sie das Stil-Panel eines Layers, legen Sie mehrere benannte Stile je Layer an und stellen Sie Füllung, Umriss, Linie, Symbol und Größe von Punkten, Linien und Polygonen ein, oder zeigen Sie Punkte als Heatmap, Cluster oder H3-Sechsecke."
sidebar_position: 1
---

# Basis-Styling

**Das Stil-Panel legt fest, wie ein Layer auf der Karte aussieht.** GOAT gibt jedem neuen Layer einen Stil, der zu seinen Daten passt (Punkte, Linien, Polygone oder ein Raster). Im Panel ändern Sie Farben, Breiten und Symbole, legen mehrere Stile je Layer an und wechseln zwischen ihnen. Jede Änderung erscheint sofort auf der Karte und wird automatisch gespeichert.

## Das Stil-Panel öffnen

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie im <code>Layer</code>-Panel auf Ihren Layer. Rechts öffnet sich das Einstellungs-Panel des Layers mit den Tabs <code>Stil</code>, <code>Filtern</code> und <code>Metadaten</code>; der Tab <code>Stil</code> ist ausgewählt. Ein Raster-Layer hat die Tabs <code>Stil</code> und <code>Metadaten</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Der Kopf zeigt den Namen des Layers, einen Punkt in seiner Hauptfarbe und seinen Inhalt, zum Beispiel <code>Punkte · 1.250 Objekte</code>. Darunter zeigt die Stilzeile den Namen des aktiven Stils (siehe <a href="#named-styles">Benannte Stile</a>), ob Ihre Änderungen gespeichert sind, und die Schaltflächen <code>Rückgängig (Strg+Z)</code> und <code>Wiederholen (Strg+Umschalt+Z)</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Unter der Stilzeile folgen die Abschnitte des Panels. Klicken Sie auf eine Zeile, um ihren Editor neben dem Panel zu öffnen, und ändern Sie dort die Werte. Die Karte folgt jeder Änderung.</div>
</div>

:::info Speichern
Es gibt keine Speichern-Schaltfläche. Ein Häkchen in der Stilzeile bedeutet <code>Gespeichert</code>; solange eine Änderung unterwegs ist, steht dort <code>Wird gespeichert…</code>. Ohne Verbindung meldet das Panel <code>Offline, Änderungen bleiben erhalten, solange diese Seite offen ist</code> und speichert, sobald die Verbindung zurück ist. Hat jemand anderes denselben Stil inzwischen geändert, meldet das Panel <code>Jemand hat diesen Stil inzwischen geändert.</code> und bietet <code>Meine Änderungen übernehmen</code> oder <code>Meine Änderungen verwerfen</code> an.
:::

## So funktioniert das Panel

Die Abschnitte eines Vektor-Layers, von oben nach unten:

| Abschnitt | Inhalt |
| --------- | ------ |
| <code>Allgemein</code> | Nur Punkt-Layer: <code>Darstellen als</code>, siehe [Wie Punkte gezeichnet werden](#how-points-are-drawn). |
| <code>Heatmap</code>, <code>Cluster</code> oder <code>H3-Sechsecke</code> | Die Einstellungen der unter <code>Darstellen als</code> gewählten Darstellung. |
| <code>Polygone</code>, <code>Linien</code> oder <code>Punkte</code> | Das Symbol: eine Zeile je Teil, etwa <code>Füllung</code>, <code>Umriss</code> oder <code>Beschriftung</code>. |
| <code>Regeln</code> | Bedingungen auf Feldern und was sie ändern, siehe [Regeln](./attribute_based_styling.md#rules). |
| <code>Layer</code> | <code>Deckkraft</code>, <code>Sichtbar</code>, <code>Zeichenreihenfolge</code>, <code>Position</code> und <code>Zeit</code>, siehe [Layer-Einstellungen](#layer-settings). |
| <code>Legende</code> | Siehe [Legende](../legend.md). |
| <code>Popup</code> | Siehe [Popup](../popup.md). |

**Editoren.** Eine Zeile zeigt eine Zusammenfassung ihres Teils, etwa ein Farbfeld und eine Breite. Ein Klick darauf öffnet den Editor des Teils links neben dem Panel. Manche Zeilen in einem Editor öffnen einen weiteren Editor daneben, etwa die Farbauswahl oder den Editor eines Werts, der sich mit dem Zoom ändert. Mit `Esc` schließen Sie den zuletzt geöffneten. Die Regler für Breiten (Linie, Umriss, Randlinie und der Halo von Beschriftungen) bewegen sich in halben Pixeln. Zahlenfelder nehmen Dezimalzahlen mit Komma an, zum Beispiel <code>1,5</code>.

**Wie ein Wert festgelegt wird.** Rechts neben vielen Zeilen sitzt eine kleine Schaltfläche mit einem Symbol und einem Pfeil. Sie zeigt, wie der Wert festgelegt wird, und lässt Sie das ändern: <code>Fest</code> (ein Wert überall), <code>Nach Zoom</code>, <code>Nach Attribut</code>, <code>Feldwerte</code> oder <code>Nach Klassen</code>. Das Menü zeigt nur, was die Eigenschaft erlaubt. Siehe [Attributbasiertes Styling](./attribute_based_styling.md).

**Teile ein- und ausschalten.** Teile, auf die Sie verzichten können, etwa <code>Umriss</code>, <code>Randlinie</code>, <code>Pfeile</code>, <code>Beschriftung</code> oder <code>Symbol</code>, haben einen Schalter im Kopf ihres Editors. Ein Teil wie <code>Umriss</code>, <code>Randlinie</code>, <code>Pfeile</code>, <code>Beschriftung</code> oder <code>Marker</code>, der dort ausgeschaltet wurde, zeigt <code>Für alle aus</code> in seiner Zeile, einer, der nie eingeschaltet war, <code>Keine</code>. Der Schalter von <code>Symbol</code> und der Schalter <code>Füllung</code> von Punkten ändern stattdessen den Marker, ihre Zeilen zeigen <code>Keine</code>. Schalten Sie ihn wieder ein, kommen seine letzten Einstellungen zurück.

**Zurück zum Stil des Datensatzes.** Solange ein Teil vom Standardstil des Datensatzes abweicht, zeigt der Kopf seines Editors die Schaltfläche <code>Auf den Stil des Datensatzes zurücksetzen</code> (ein kreisförmiger Pfeil). Sie setzt diesen Teil so zurück, wie ihn der Stil des Datensatzes hat, einschließlich der Klassen. <code>Rückgängig</code> nimmt das zurück.

**Zoombereich eines Teils.** Jeder Editor eines Teils endet mit <code>Sichtbar</code>: den Zoomstufen, bei denen dieser Teil gezeichnet wird, innerhalb der Zoomstufen des Layers. Siehe [Zoom-Sichtbarkeit](../zoom.md).

## Polygone

Der Abschnitt <code>Polygone</code> hat die Zeilen <code>Füllung</code>, <code>Umriss</code>, <code>Höhe</code>, <code>Marker</code> und <code>Beschriftung</code>.

- <code>Füllung</code>: <code>Farbe</code>, <code>Deckkraft</code> und <code>Muster</code>. <code>Muster</code> öffnet die Muster: <code>Keines</code>, <code>Diagonale Linien</code>, <code>Diagonale Linien, andere Richtung</code>, <code>Senkrechte Linien</code>, <code>Waagerechte Linien</code>, <code>Kreuzschraffur</code>, <code>Raster</code> und <code>Punkte</code>. Bei einem Muster legen Sie seine <code>Linienfarbe</code> (<code>Punktfarbe</code> bei Punkten; standardmäßig <code>Wie die Füllung</code>), den <code>Abstand</code> und die <code>Stärke</code> (<code>Punktgröße</code> bei Punkten) fest. Das Muster liegt über der Füllfarbe.
- <code>Umriss</code>: <code>Farbe</code> (eine eigene Farbe oder <code>Wie die Füllung</code>), <code>Breite</code>, <code>Deckkraft</code>, <code>Strichart</code> (<code>Durchgehend</code>, <code>Gestrichelt</code>, <code>Gepunktet</code> oder <code>Strichpunkt</code>) und <code>Lage</code> (<code>Auf der Kante</code>, <code>Innen</code> oder <code>Außen</code>). <code>Innen</code> hält jeden Umriss in seinem eigenen Polygon, sodass sich die Umrisse benachbarter Polygone nicht überdecken.
- <code>Höhe</code>: hebt die Polygone in der 3D-Ansicht an, siehe [Höhe](#height).
- <code>Marker</code>: ein Marker auf jedem Polygon, an einem Punkt in seinem Inneren, zum Beispiel ein Schulsymbol auf dem Schulgelände oder ein Kreis, der mit der Einwohnerzahl jedes Stadtteils wächst. Siehe [Marker auf Polygonen und Linien](#markers-on-polygons-and-lines).
- <code>Beschriftung</code>: Text auf jedem Polygon, siehe [Beschriftungen](../labels.md).

## Linien

Der Abschnitt <code>Linien</code> hat die Zeilen <code>Linie</code>, <code>Randlinie</code>, <code>Pfeile</code>, <code>Marker</code> und <code>Beschriftung</code>.

- <code>Linie</code>: <code>Farbe</code>, <code>Breite</code>, <code>Deckkraft</code>, <code>Strichart</code> (<code>Durchgehend</code>, <code>Gestrichelt</code>, <code>Gepunktet</code> oder <code>Strichpunkt</code>), <code>Enden</code> (<code>Flach</code>, <code>Rund</code> oder <code>Eckig</code>, das um die halbe Breite über das Ende hinausreicht), <code>Ecken</code> (<code>Spitz</code>, <code>Rund</code> oder <code>Abgeschrägt</code>), <code>Versatz</code> und <code>Unschärfe</code>. <code>Versatz</code> verschiebt die Linie seitlich, damit beide Richtungen einer Straße sichtbar sind. Er verschiebt nur die Darstellung: Klicken und Fangen verwenden weiterhin die Linie selbst.
- <code>Randlinie</code>: ein Rand an beiden Seiten der Linie, wie ihn Straßen auf vielen Karten haben: <code>Farbe</code>, <code>Breite</code> (die zusätzliche Breite auf jeder Seite der Linie) und <code>Deckkraft</code>.
- <code>Pfeile</code>: <code>Symbol</code>, <code>Mit der Linie drehen</code>, <code>Richtung</code> (<code>Vorwärts</code>, in Zeichenrichtung der Linie, <code>Rückwärts</code> oder <code>In beide Richtungen</code>), <code>Größe</code>, <code>Farbe</code> (eine eigene Farbe oder <code>Wie die Linie</code>), <code>Position</code> (<code>Entlang der Linie</code>, <code>In der Mitte</code>, <code>Am Anfang</code>, <code>Am Ende</code> oder <code>An beiden Enden</code>) und, entlang der Linie, <code>Abstand</code>. <code>Symbol</code> öffnet die Symbolauswahl: oben der <code>Pfeil</code> von GOAT, darunter <code>Symbole</code>, <code>Emoji</code> und Ihre eigenen Symbole (<code>Eigene</code>). So kann sich jedes Symbol entlang einer Linie wiederholen, etwa für eine Bahnstrecke oder eine Grenze. Ist <code>Mit der Linie drehen</code> eingeschaltet, zeigt die Oberseite des Symbols dorthin, wohin der Pfeil zeigen würde; ausgeschaltet bleibt das Symbol aufrecht, so wie ein Baum oder ein Bussymbol stehen soll, und <code>Richtung</code> wird ausgeblendet. Wählen Sie den <code>Pfeil</code> von GOAT, wird es eingeschaltet, bei jedem anderen Symbol ausgeschaltet; danach können Sie es beliebig umschalten. Ein Symbol gilt für den ganzen Layer. Hochgeladene Symbole und Emoji behalten ihre eigenen Farben und haben daher keine Zeile <code>Farbe</code>. Die Legende zeigt das Symbol auf der Linie.
- <code>Marker</code>: ein Marker in der Mitte jeder Linie, siehe [Marker auf Polygonen und Linien](#markers-on-polygons-and-lines).
- <code>Beschriftung</code>: Text entlang oder auf jeder Linie, siehe [Beschriftungen](../labels.md).

### Marker auf Polygonen und Linien {#markers-on-polygons-and-lines}

Die Zeile <code>Marker</code> von Polygonen und Linien ist aus, bis Sie sie mit dem Schalter im Kopf ihres Editors einschalten. Jedes Polygon bekommt einen Marker, an dem Punkt in seinem Inneren, an dem auch seine Beschriftung steht, und jede Linie einen in ihrer Mitte. Der Editor hat die Zeilen des Markers von Punkten: <code>Symbol</code> mit der Form (siehe [Symbole und Markerformen](#icons-and-marker-shapes)), <code>Farbe</code>, <code>Symbolfarbe</code>, <code>Größe</code>, <code>Deckkraft</code>, <code>Drehung</code>, <code>Versatz x</code> und <code>Versatz y</code>, <code>Ankerpunkt</code> bei Pins und einzelnen Symbolen sowie <code>Überlappen</code>. <code>Größe</code> und <code>Farbe</code> können sich auch [nach Attribut](./attribute_based_styling.md#by-attribute) oder [nach Klassen](./attribute_based_styling.md#by-classes) ändern, etwa für Kreise, die mit einer Zahl wachsen.

- Der Marker liegt über dem Polygon oder der Linie und unter den Beschriftungen. Die Beschriftung eines Polygons und die Beschriftung einer Linie in ihrer Mitte nehmen die Positionen rund um den Marker an, wie bei Punkten: <code>Automatisch</code> rückt sie neben ihn, eine feste Seite hält sie auf dieser Seite, <code>In der Mitte</code> setzt sie auf ihn. Siehe [Beschriftungen](../labels.md#position).
- Der Marker hat keinen Umriss: Der <code>Umriss</code> eines Polygons ist sein Rand.
- Um einen Marker nur auf manchen Objekten zu zeigen, zum Beispiel ein Symbol auf Parks, wählen Sie ihre Klasse oben im Abschnitt aus und schalten Sie <code>Marker</code> für sie ein. Haben Sie den Marker für alle Objekte ein- und wieder ausgeschaltet, zeigt seine Zeile <code>Für alle aus</code>, und er bleibt in jeder Klasse aus; der Editor der Klasse bietet dann <code>Pro Klasse erlauben</code> an: Der Marker bleibt für alle Objekte aus, aber Klassen können ihn einschalten. Ein Marker, der nie eingeschaltet war, zeigt <code>Keine</code> und braucht diesen Schritt nicht.
- In der Legende zeigt das Musterfeld das Polygon oder die Linie mit dem Marker. Marker, deren Größe sich ändert, erscheinen allein, wie bei Punkten.

## Punkte

Der Abschnitt <code>Punkte</code> hat die Zeilen <code>Größe</code>, <code>Füllung</code>, <code>Umriss</code>, <code>Symbol</code> und <code>Beschriftung</code>.

- <code>Größe</code>: die Größe des Markers in px, direkt im Abschnitt mit dem Regler eingestellt.
- <code>Füllung</code>: <code>Farbe</code> und <code>Deckkraft</code> des Markers, bei einem einfachen Kreis außerdem <code>Versatz x</code> und <code>Versatz y</code>. Ist der Schalter im Kopf aus, werden die Marker hohl gezeichnet: Nur Umriss und Symbol sind zu sehen. Haben sie keins von beiden, warnt die Zeile <code>Marker sind unsichtbar: Schalten Sie den Umriss ein oder fügen Sie ein Symbol hinzu.</code>
- <code>Umriss</code>: <code>Farbe</code> (eine eigene Farbe oder <code>Wie die Füllung</code>), <code>Breite</code> und <code>Deckkraft</code>.
- <code>Symbol</code>: das Symbol auf dem Marker. Der Schalter im Kopf nimmt das Symbol weg, und die Punkte erscheinen wieder als einfache Kreise; eingeschaltet kommen Ihr letztes Symbol und Ihre letzte Form zurück.
- <code>Beschriftung</code>: Text neben jedem Punkt, siehe [Beschriftungen](../labels.md).

### Symbole und Markerformen {#icons-and-marker-shapes}

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie im Abschnitt <code>Punkte</code> auf <code>Symbol</code> und achten Sie darauf, dass der Schalter im Kopf des Editors eingeschaltet ist.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf die Zeile <code>Symbol</code>. Die Symbolauswahl öffnet sich mit den Tabs <code>Symbole</code>, <code>Emoji</code> und <code>Eigene</code>, jeweils mit eigener Suche. Klicken Sie auf ein Symbol, um es zu verwenden.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Oben in der Auswahl legt <code>Form</code> den Marker fest, auf dem das Symbol sitzt: <code>Kreis</code>, <code>Quadrat</code>, <code>Raute</code>, <code>Sechseck</code>, <code>Schild</code>, einer der <code>Pins</code> (<code>Pin</code>, <code>Runder Pin</code>, <code>Nadel</code>, <code>Eckiger Pin</code>, <code>Spitzer Pin</code> oder <code>Fahne</code>) oder <code>Nur Symbol</code> ohne Marker.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Legen Sie im Editor <code>Symbol</code> die <code>Symbolfarbe</code> (<code>Farbe</code> bei <code>Nur Symbol</code>), <code>Drehung</code>, <code>Versatz x</code> und <code>Versatz y</code> fest. Bei <code>Nur Symbol</code> oder einem Pin legt <code>Ankerpunkt</code> fest, welcher Punkt des Symbols auf dem Ort liegt: <code>Mitte</code>, <code>Unten</code> (die Spitze, wie bei Pins) oder eine andere Seite oder Ecke. Ist <code>Überlappen</code> an, werden die Marker auch dort gezeichnet, wo sie andere Symbole überlappen. Hochgeladene Symbole und Emoji behalten ihre eigenen Farben; für sie gibt es keine Farbe einzustellen.</div>
</div>

Für ein eigenes Symbol öffnen Sie den Tab <code>Eigene</code> und ziehen ein Bild darauf oder klicken auf das Upload-Feld, um eins auszuwählen (SVG, PNG, JPEG, WebP, BMP oder ICO, quadratisch, mit transparentem Hintergrund, bis 4 MB). Es wird sofort hochgeladen, nach der Datei benannt und als Symbol des Layers gesetzt. Ihre Symbole stehen unter <code>Deine Symbole</code>, wo Sie mit <code>Hochladen</code> ein weiteres hinzufügen; mit <code>Verwalten</code> benennen Sie sie um oder löschen sie. Layer, die ein gelöschtes Symbol verwenden, zeigen kein Symbol mehr; deshalb fragt GOAT vor dem Löschen nach.

:::tip
Um jeder Kategorie ein eigenes Symbol zu geben, legen Sie das Symbol <code>Nach Klassen</code> eines Feldes fest. Siehe [Attributbasiertes Styling](./attribute_based_styling.md).
:::

## Wie Punkte gezeichnet werden {#how-points-are-drawn}

Bei einem Punkt-Layer legt der Abschnitt <code>Allgemein</code> fest, wie die Punkte erscheinen (<code>Darstellen als</code>):

| Option | Was sie zeichnet |
| ------ | ---------------- |
| <code>Punkte</code> | Jedes Objekt als eigenes Symbol (Standard). |
| <code>Heatmap</code> | Die Punktdichte als Farbfläche. |
| <code>Cluster</code> | Nahe Punkte werden zu Kreisen mit ihrer Anzahl zusammengefasst. |
| <code>H3-Sechsecke</code> | Die Punkte je Sechseck gezählt oder summiert, auf dem Server berechnet. |

**Heatmap.** Der Abschnitt <code>Heatmap</code> hat <code>Farben</code> (die Palette), <code>Radius</code>, <code>Intensität</code>, <code>Deckkraft</code> und <code>Gewichtung</code>: <code>Jeder Punkt zählt einmal</code> oder <code>Nach</code> einem Zahlenfeld, mit dem <code>Bereich</code> des Feldes. <code>Punkte</code> legt fest, ob auch die einzelnen Punkte erscheinen: <code>Nie, nur Dichte</code> oder ab einer Zoomstufe. Solange sie nie erscheinen, sind die Abschnitte <code>Punkte</code>, <code>Regeln</code> und <code>Popup</code> ausgeblendet.

**Cluster.** Der Abschnitt <code>Cluster</code> hat <code>Aussehen</code> (<code>Kreis</code>, oder <code>Wie die Punkte</code>: jeder Cluster zeigt den Marker der Punkte, eine Größe oder Farbe nach einem Feld in der Mitte ihres Bereichs oder ihrer Palette; bei Symbolen oder Farben nach Kategorie die der Kategorie, die die meisten seiner Punkte haben; gezählt werden die ersten 12 Kategorien, Punkte der übrigen zählen als andere Werte), <code>Anzahl</code> (<code>In der Mitte</code>, oder <code>Oben rechts</code> auf einem kleinen Kreis oben rechts am Marker, weiß umrandet), <code>Wert</code> (<code>Anzahl der Punkte</code>, oder Summe, Mittelwert, Minimum oder Maximum eines Zahlenfeldes: die gezeigte Zahl und wonach die Kreise wachsen), <code>Farbe</code> (die Kreise oder der kleine Kreis), <code>Farbe der Zahl</code>, <code>Größe</code> (nur für Kreise: der kleinste und der größte Kreis; der Kreis eines Clusters wächst mit der Zahl seiner Punkte oder seinem Wert), <code>Bereich</code> (für einen Wert eines Feldes: die Werte, für die der kleinste und der größte Kreis stehen, zu Beginn der Bereich des Feldes, für eine Summe bis zum Zehnfachen seines höchsten Wertes), <code>Abstand für Cluster</code> (wie nah Punkte auf dem Bildschirm beieinanderliegen müssen, um zusammengefasst zu werden, in Pixeln), <code>Bis</code> (die Zoomstufe, bis zu der Punkte zusammengefasst werden, 0 bis 24) und <code>Kleinster</code> (die wenigsten Punkte eines Clusters, 2 bis 20). Die einzelnen Punkte behalten das Aussehen aus dem Abschnitt <code>Punkte</code>. Ein Layer, dessen Punkte ein Symbol oder eine andere Form als einen einfachen Kreis zeigen, beginnt seine Cluster wie die Punkte, mit der Anzahl oben rechts. Große Zahlen werden gekürzt, zum Beispiel 1,2 k für 1.234. Cluster werden im Browser berechnet und funktionieren für Layer bis 100.000 Objekte; für größere Layer verwenden Sie eine Heatmap oder H3-Sechsecke.

**H3-Sechsecke.** Der Abschnitt <code>H3-Sechsecke</code> hat <code>Größe</code> (<code>Automatisch</code>, mit kleineren Sechsecken beim Hineinzoomen, oder eine feste Auflösung), <code>Wert</code> (<code>Anzahl der Punkte</code> oder Summe oder Mittelwert eines Zahlenfeldes), <code>Farben</code>, <code>Klassen</code> (<code>Stufenlos</code> oder eine Klassifizierungsmethode, mit <code>Anzahl</code>), <code>Deckkraft</code>, <code>Höhe</code>, <code>Umriss</code> und <code>Punkte</code> (<code>Nie, nur Sechsecke</code> oder ab einer Zoomstufe).

### Höhe {#height}

Polygone und H3-Sechsecke können in der [3D-Ansicht](../../map_interface.md#3d-view) der Karte als Körper stehen.

**Polygone.** Klicken Sie im Abschnitt <code>Polygone</code> auf <code>Höhe</code>. Der Schalter im Kopf des Editors hebt die Polygone an oder legt sie flach. Im Editor legt <code>Oberkante</code> fest, wie hoch jedes Polygon steht; die Schaltfläche daneben wählt, wie:

- <code>Keine</code>: flach, ohne Höhe.
- <code>Fest</code>: eine Höhe für jedes Polygon, in Metern.
- <code>Nach Zoom</code>: Die Höhe wächst beim Hineinzoomen.
- <code>Nach Attribut</code>: die Höhe im Verhältnis zu einem Zahlenfeld, etwa der Dichte. Der Editor <code>Höhe nach Attribut</code> öffnet sich: Wählen Sie das <code>Feld</code>, die Höhen in Metern bei seinem kleinsten und größten Wert (<code>Kleinster Wert</code>, <code>Größter Wert</code>) und die <code>Skala</code>, wie unter [Attributbasiertes Styling](./attribute_based_styling.md#by-attribute) beschrieben.
- <code>Feldwerte</code>: die Höhen aus einem Zahlenfeld, etwa einer Höhe oder einer Geschosszahl. Felder mit Namen wie `height`, `render_height`, `building_height`, `levels`, `building_levels`, `storeys` oder `floors` stehen zuerst unter <code>Vorgeschlagen für die Höhe</code>. Für ein Feld, das Geschosse zählt, stellen Sie <code>Einheit</code> auf <code>Geschosse × 3 m</code>.
- <code>Nach Klassen</code>: eine Höhe je Klasse eines Feldes.

Solange eine Höhe gesetzt ist, legt <code>Unterkante</code> die Basishöhe auf dieselben Arten fest, nur ohne <code>Keine</code>: <code>Fest</code>, <code>Nach Zoom</code>, <code>Nach Attribut</code>, <code>Feldwerte</code> (etwa aus einem Feld `min_height`) oder <code>Nach Klassen</code>. Sie hebt den Körper vom Boden ab, etwa für eine Brücke oder ein oberes Geschoss. Ein angehobener Layer hat eine Deckkraft für den ganzen Layer und zeichnet kein Füllmuster; sein Umriss bleibt am Boden, und seine Beschriftungen stehen auf den Dächern. Wird eine Höhe gesetzt, während die Karte in 2D ist, wechselt sie zu 3D; kehren Sie zu 2D zurück, zeigt die Zeile <code>Ansicht in 2D.</code> mit dem Link <code>In 3D zeigen</code>.

**H3-Sechsecke.** Klicken Sie im Abschnitt <code>H3-Sechsecke</code> auf <code>Höhe</code> und schalten Sie sie ein: Die Sechsecke werden zu Säulen, so hoch wie ihr Wert. <code>Höchste</code> legt die Höhe der Säule mit dem höchsten Wert fest, <code>Basishöhe</code> hebt die Säulen an, und <code>Skala</code> wählt <code>Linear</code> oder <code>Quadratwurzel</code>. Säulen zeichnen keinen Umriss.

Die Legende nennt die Höhe unter den Farben des Layers.

## Layer-Einstellungen {#layer-settings}

Der Abschnitt <code>Layer</code> enthält, was für den ganzen Layer gilt:

- <code>Deckkraft</code>: die Deckkraft des ganzen Layers.
- <code>Sichtbar</code>: die Zoomstufen, bei denen der Layer gezeichnet wird, siehe [Zoom-Sichtbarkeit](../zoom.md).
- <code>Zeichenreihenfolge</code>: welche Objekte oben liegen: <code>Wie in den Daten</code>, <code>Erste Klasse oben</code> (bei Klassen, siehe [Attributbasiertes Styling](./attribute_based_styling.md)) oder die kleinsten oder größten Werte eines Zahlenfeldes oben.
- <code>Position</code>: wo der Layer zwischen den Layern der Grundkarte gezeichnet wird: <code>Oben</code>, <code>Unter den Beschriftungen der Grundkarte</code> oder <code>Unter den Straßen der Grundkarte</code>. Die Position gehört zum Layer in diesem Projekt, nicht zum Stil; sie bleibt also, wenn Sie den Stil oder die Grundkarte wechseln.
- <code>Zeit</code>: fügt unter der Zeile des Layers im <code>Layer</code>-Panel einen Zeitschieberegler hinzu. Die Optionen nennen das Feld: Ein Ganzzahlfeld wie `year` geht einen Wert nach dem anderen durch (<code>Jeweils ein Wert von year</code>), ein Datumsfeld nach Jahr, Monat oder Tag (zum Beispiel <code>date nach Monat</code>). Der Regler zeigt die Objekte eines Schritts und beginnt beim neuesten. <code>Aus</code> entfernt ihn.

## Benannte Stile {#named-styles}

Ein Layer kann bis zu 10 benannte Stile haben, zum Beispiel einen nach Bevölkerung und einen nach Baualter. Einer davon ist aktiv: Die Karte zeichnet ihn, und das Panel bearbeitet ihn.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie in der Stilzeile oben im Tab <code>Stil</code> auf den Namen des aktiven Stils. Neben dem Panel öffnet sich <code>Stile</code> mit den Stilen des Layers; der aktive ist mit einem Häkchen markiert.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf einen Stil, um ihn zu aktivieren. Mit <code>Neuer Stil</code> fügen Sie einen hinzu: Er wird aktiv, und Sie können gleich seinen Namen eingeben.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Doppelklicken Sie auf einen Stil, um ihn umzubenennen, oder öffnen Sie sein Menü (<code>Weitere Optionen</code>, die drei Punkte) für <code>Umbenennen</code>, <code>Duplizieren</code>, <code>Nach oben</code>, <code>Nach unten</code>, <code>Als Standard des Datensatzes festlegen</code>, <code>Auf den Stil des Datensatzes zurücksetzen</code> (beim aktiven Stil, solange er vom Stil des Datensatzes abweicht) und <code>Löschen</code>. Der letzte Stil eines Layers lässt sich nicht löschen.</div>
</div>

**Der Standardstil des Datensatzes.** Ein Datensatz hat einen eigenen Standardstil: Der erste Stil eines Layers in einem Projekt ist eine Kopie davon, und <code>Auf den Stil des Datensatzes zurücksetzen</code> kehrt zu ihm zurück. <code>Als Standard des Datensatzes festlegen</code> macht eine Kopie eines Stils zum Standard des Datensatzes. Die Option erscheint für Projektbearbeiter, die den Datensatz bearbeiten dürfen, und nie bei Katalog-Layern. Ein Stil, der dem Standard des Datensatzes entspricht, zeigt in der Liste <code>Standard des Datensatzes</code>.

**Einen Stil auf einen anderen Layer übertragen.** Klicken Sie unten in <code>Stile</code> auf <code>Stil kopieren</code>. Öffnen Sie dann den anderen Layer und klicken Sie dort auf <code>Stil einfügen</code>: Der kopierte Stil ersetzt den aktiven Stil dieses Layers, und <code>Rückgängig</code> nimmt das zurück. Stile lassen sich nur auf Layer derselben Art und Geometrie einfügen, zum Beispiel von einem Polygon-Layer auf einen anderen.

:::info Betrachter einer veröffentlichten Karte
In einem veröffentlichten Projekt können Betrachter in den Einstellungen eines Layers zwischen seinen Stilen wechseln (<code>Stil</code>). Ihre Wahl wird nicht gespeichert.
:::

## Raster-Layer und Kartendienste

Eine Rasterdatei hat die Abschnitte <code>Allgemein</code>, einen Abschnitt für ihre Farben, <code>Layer</code>, <code>Legende</code> und <code>Popup</code>.

- <code>Allgemein</code>: <code>Darstellen als</code> <code>Schummerung</code> (schattiertes Relief aus Höhendaten), <code>Farbskala</code> (eine Palette über die Zellwerte), <code>Kategorien</code> (eine Farbe je Zellwert) oder <code>Bild</code> (wie gespeichert). Bei mehreren Bändern wählen Sie das <code>Band</code> (bei einer Schummerung das Band, das sie schattiert, etwa das Geländemodell neben einem Oberflächenmodell in einer Datei), bei einem Bild die <code>Kombination</code>: <code>Echtfarben</code>, <code>Falschfarben</code> oder <code>Eigene</code>. Bei einer Farbskala oder einer Schummerung bietet <code>Band</code> auch Bandberechnungen: <code>NDVI</code> (Vegetation), <code>NDMI</code> (Feuchte) und <code>NDWI</code> (Wasser) berechnen einen Index aus zwei Bändern, die die Zeilen darunter benennen (<code>NIR</code>, <code>Rot</code>, <code>Grün</code>, <code>SWIR 1</code>). GOAT füllt sie aus, wo die Datei ihre Bänder kennzeichnet oder benennt (etwa <code>NIR</code> oder <code>Rot</code>, oder die Sentinel-2-Codes <code>B4</code> und <code>B8</code> in einer Datei, die auch <code>B8A</code> oder <code>B12</code> hat), sonst wählen Sie sie, und ein neuer Index beginnt als Farbskala von -1 bis 1 (für jedes Bild gleich, damit sich Indizes vergleichen lassen) in einer Palette mit der Mitte bei 0. <code>Formel</code> nimmt eine eigene Berechnung aus <code>b1</code>, <code>b2</code>, ... (den Bändern), Zahlen, <code>+ - * /</code> und Klammern, etwa <code>(b1 - b2) / (b1 + b2)</code>: Der Hinweis unter dem Feld sagt schon beim Tippen, was nicht stimmt, die Formel gilt, sobald Sie das Feld verlassen oder die Eingabetaste drücken, und ihr Bereich beginnt bei ihren Werten. <code>Band</code> zeigt dann den Index mit seinen Bändern (<code>NDVI (B8, B4)</code>) oder die Formel, und das Popup benennt den Wert danach; ein im Menü gewähltes Band ersetzt sie. Bei einer Datei mit einem Band bietet <code>Band</code> das Band und <code>Formel</code>; die Indizes brauchen zwei Bänder. Ein Bild wie gespeichert verwendet die Farbtabelle der Datei (GOAT zeichnet eine solche Karte aus ihren Zellwerten in den Farben der Tabelle, daher kann ihr Popup den Wert jeder Zelle zeigen, auch wo sich zwei Werte eine Farbe teilen; <code>Anpassungen</code> ändern diese Farben, wie sie jedes Bild ändern); ohne sie stellt <code>Echtfarben</code> die Bänder dar, die die Datei als Rot, Grün und Blau kennzeichnet, sonst ihre ersten drei Bänder.
- Die Farben, in einem Abschnitt, der nach der Darstellung benannt ist (<code>Farbskala</code>, <code>Schummerung</code> oder <code>Kategorien</code>): bei einer Farbskala öffnet <code>Farben</code> den Farbeditor, mit einer <code>Palette über einen Bereich</code> oder <code>Farben an Werten</code>. Eine Palette ist <code>Stufenlos</code> oder in <code>Klassen</code> nach einer <code>Methode</code> aufgeteilt, wie die Klassen eines Vektor-Layers: <code>Gleiche Intervalle</code> teilen den Bereich, <code>Quantile</code>, <code>Natürliche Unterbrechungen</code>, <code>Standardabweichung</code> und <code>Geometrische Intervalle</code> klassifizieren die Werte des Bands (GOAT berechnet sie beim Lesen der Datei, die einer Bandformel, sobald die Formel gesetzt ist, daher erscheinen eine Methode oder Klassenzahl sofort; <code>Geometrische Intervalle</code> brauchen ein Band, dessen Werte alle über 0 liegen), und <code>Manuelle Grenzen</code> beginnen als gleich breite Klassen, deren Grenzen Sie eingeben. Bei einer stufenlosen Palette stehen ihre Farben unten im Farbeditor, unter <code>Außerhalb</code>, in der Reihenfolge, in der sie gezeichnet werden, als Klassenliste (<code>Farbe</code> und <code>Wert</code>): Jede Zeile zeigt eine Farbe und den Wert, an dem sie im Bereich liegt, mit der Einheit der Legende; ein Klick auf das Farbfeld ändert sie, zeigen Sie auf eine Zeile (oder erreichen Sie sie mit der Tastatur), dann fügt das Plus eine Kopie ihrer Farbe dahinter ein (bis zu 12 Farben) und der Papierkorb entfernt ihre Farbe (solange mehr als zwei übrig sind), eine Zeile lässt sich an eine andere Stelle ziehen (oder mit Alt und der Pfeiltaste nach oben oder unten um eine Stelle verschieben, während eines ihrer Bedienelemente den Fokus hat), und <code>Farbe hinzufügen</code> fügt am Ende eine an. Die Farben verteilen sich gleichmäßig über den Bereich, Histogramm und Karte folgen. Die erste Änderung macht die Palette zu eigenen Farben (2 bis 12; eine umgekehrte Palette behält die Reihenfolge, in der sie gezeichnet wird); eine Palette erneut zu wählen ersetzt sie. Klassen haben keine solche Liste: Ihre Zeilen sind die Farben zum Bearbeiten, und <code>Palette</code> färbt sie alle neu. <code>Farben an Werten</code> behält seinen eigenen Editor. <code>Klassen</code> bietet 3 bis 13 Klassen für die berechneten Methoden und 2 bis 13 für gleiche Intervalle und manuelle Grenzen. Bei einem Band aus ganzen Zahlen (etwa einem 8- oder 16-Bit-Band) sind auch die berechneten Grenzen ganze Zahlen; Grenzen, die auf dieselbe Zahl fallen würden, bleiben nur einmal, daher kann es weniger Klassen geben. Wenn eine Farbskala oder Kategorien ein Band eines Bilds einfärben, sagt eine Zeile unter <code>Band</code>, welcher seiner Kanäle (Rot, Grün oder Blau) das Band ist. <code>Aus den Daten</code> setzt den Bereich auf das 2. bis 98. Perzentil des Bands. Bei Klassen gilt ein eingegebener Bereich, sobald Sie das Feld verlassen oder die Eingabetaste drücken; eine kontinuierliche Palette folgt den Ziffern schon beim Tippen. Darunter zeigt das Histogramm des Bands die Enden des Bereichs als durchgezogene und die Klassengrenzen als gestrichelte Linien, seinen kleinsten und größten Wert so geschrieben wie in den Feldern des Bereichs. Ziehen Sie ein Ende oder eine Grenze am Histogramm entlang, oder klicken Sie darauf und verwenden Sie die Pfeiltasten (mit Umschalt zehn Schritte auf einmal): Ein Ende ändert den Bereich wie eine Eingabe, und eine Grenze macht die Klassen zu <code>Manuelle Grenzen</code>, wobei die übrigen Grenzen bleiben. Eine Grenze bleibt einen Schritt innerhalb der Balken des Histogramms (bei <code>Transparent</code> innerhalb des Bereichs); bei einem Band aus ganzen Zahlen bewegen sich die Griffe in ganzen Zahlen. Die Klassen stehen mit Farbe, Bereich, Name und <code>Anteil</code> an den Zellen des Bands in einer Liste, jede mit einem Auge zum Ausblenden. <code>Außerhalb</code> legt fest, was die Zellen jenseits des Bereichs, der ersten und letzten Ihrer Farben oder der Klassen zeichnen: <code>Endfarben</code> zeichnet sie in der ersten oder letzten Farbe, <code>Transparent</code> lässt sie weg (Stile aus der Zeit vor GOAT Style lassen sie weg, wie GOAT es damals tat). Bei Klassen mit <code>Transparent</code> zeigt <code>Bereich</code>, wo die erste Klasse beginnt und die letzte endet (zunächst der Bereich oder der kleinste und größte Wert des Bands), das Histogramm graut die Werte jenseits davon aus, und Legende und Klassennamen lesen diese Enden; wenn Sie eines davon eingeben (es gilt, sobald Sie das Feld verlassen oder die Eingabetaste drücken), werden berechnete Klassen zu <code>Manuelle Grenzen</code>, und die Grenzen dazwischen bleiben, während <code>Gleiche Intervalle</code> den neuen Bereich wieder teilen. Bei Kategorien fasst <code>Farben</code> zusammen, was sie zeigen (<code>Alle 238 Kategorien</code>, <code>Top 10</code>), mit ihren Farben, und öffnet ihren Editor, so wie die Klassen eines Vektor-Layers ihren öffnen. Der Wechsel zu <code>Kategorien</code> ergibt eine Klasse je Wert, den das Band enthält: eine Datei mit Farbtabelle erhält jeden verwendeten Wert in den Farben der Tabelle, nach Wert geordnet; eine Datei ohne Farbtabelle erhält jeden Wert (bis zu 256, ein volles 8-Bit-Band), die häufigsten zuerst, und ein Band mit mehr Werten seine 50 häufigsten, die übrigen in einer Zeile <code>Andere Werte</code>. Im Editor zeigt <code>Klassen</code> alle Werte oder die 10, 20, 30 oder 50 häufigsten. <code>Reihenfolge</code> sortiert die Klassen nach Häufigkeit, nach Wert oder nach Name; ziehen Sie eine Klasse an die Stelle einer anderen, um sie zu verschieben (oder verschieben Sie sie mit Alt und der Pfeiltaste nach oben oder unten um eine Stelle, während eines ihrer Bedienelemente den Fokus hat), die Legende folgt der Reihenfolge. Eine andere Anzahl unter <code>Klassen</code> behält eine Sortierung nach Wert oder nach Name; Klassen in eigener Reihenfolge stehen dann wieder nach Häufigkeit. Jede Klasse hat ihre Farbe, ihren Namen (ein Klick darauf benennt sie um, ändert ihren Wert oder entfernt sie), ihren Anteil und ein Auge; die Zeile <code>Andere Werte</code> hat die Farbe und den Anteil der Werte ohne Klasse, und ihr Auge zeichnet sie oder lässt sie weg. Eine Liste mit mehr als 10 Klassen zeigt im Editor <code>N weitere anzeigen</code>; die Legende der Layerliste zeigt ihre ersten 10 Einträge und <code>N weitere anzeigen</code>, sobald sie mehr als 12 hat. <code>Klasse hinzufügen</code> listet die Werte ohne Klasse mit ihrem Anteil; bei einer Schummerung ihre <code>Methode</code>, <code>Licht aus</code>, <code>Lichthöhe</code>, <code>Stärke</code>, die Farben von <code>Schatten</code>, <code>Licht</code> und <code>Akzent</code> sowie <code>Farben</code> unter der Schattierung. Flaches Gelände wird vor dem Schattieren überhöht, damit auch Höhendaten aus dem Flachland ihr Relief zeigen; <code>Stärke</code> wirkt zusätzlich, und wenn das Gelände überhöht ist, nennt der Hinweis darunter den Faktor.
- <code>Layer</code>: <code>Deckkraft</code>, <code>Glättung</code> (<code>Weich</code> oder <code>Scharf</code>; Kategorien und ein Bild in den eigenen Farben seiner Datei bleiben immer scharf, da Zellwerte nie gemischt werden, daher zeigt die Zeile <code>Scharf</code> und lässt sich nicht ändern), <code>Anpassungen</code> bei einem Bild (<code>Helligkeit</code>, <code>Kontrast</code>, <code>Sättigung</code>, <code>Farbton</code>), <code>Keine Daten</code> (Zellwerte, die transparent gezeichnet werden; einen davon können Sie auf der Karte wählen; solange das Feld leer ist, gilt der Keine-Daten-Wert der Datei, den das Feld anzeigt), <code>Sichtbar</code> und <code>Position</code>, wie bei Vektorlayern (siehe [Layer-Einstellungen](#layer-settings)): Mit <code>Unter den Beschriftungen der Grundkarte</code> bleiben zum Beispiel Ortsnamen über Höhendaten lesbar. Ein Raster-Layer, der mit einer Farbskala, Kategorien oder einer Schummerung hinzugefügt wird, beginnt <code>Unter den Beschriftungen der Grundkarte</code>. Wenn Sie <code>Darstellen als</code> von <code>Bild</code> auf eine davon umstellen, während der Layer <code>Oben</code> liegt, bleibt er, wo er ist: Die Zeile <code>Position</code> weist darauf hin, dass die Farben die Ortsnamen der Grundkarte verdecken, und bietet <code>Unter die Beschriftungen verschieben</code> an; Sie können es annehmen oder lassen. Ein Bild bleibt oben, und ein duplizierter Layer liegt dort, wo das Original liegt.
- <code>Popup</code>: <code>Anzeigen bei</code> <code>Aus</code>, <code>Bei Klick</code>, <code>Nur beim Überfahren</code> oder <code>Bei Klick und beim Überfahren</code>; die beiden Möglichkeiten mit Überfahren fehlen, wo die Karte keine Werte zum Lesen hat, bei den meisten Bildern und wo der Server die Zellen einfärbt (siehe [Popups von Raster-Layern](../popup.md#popups-von-raster-layern)). Bei mehreren Bändern wählen Sie unter <code>Werte</code> <code>Dargestellte Werte</code> oder <code>Alle Bänder</code>.

Farbänderungen erscheinen sofort auf der Karte; ein anderes <code>Band</code>, eine Bandformel oder eine andere <code>Glättung</code> lädt das Raster neu, was einen Moment dauern kann. Die Zeilen, die Angaben aus der Datei brauchen (<code>Darstellen als</code>, <code>Farben</code>, <code>Keine Daten</code>), warten, bis GOAT die Datei gelesen hat; kann eine Datei nicht gelesen werden, steht oben in <code>Allgemein</code> ein Hinweis.

Ein Kartendienst (WMS, WMTS oder XYZ) liefert fertige Bilder: Er wird als Bild gezeichnet, in einem der Stile, die der Dienst anbietet (<code>Dienststil</code> unter <code>Allgemein</code>, wenn es eine Auswahl gibt). Sein Abschnitt <code>Layer</code> hat <code>Deckkraft</code>, <code>Glättung</code>, <code>Anpassungen</code>, <code>Sichtbar</code> und <code>Position</code>, und seine Legende zeigt das Legendenbild des Dienstes, sofern er eins hat.

:::tip Intelligentes Styling
Mit [attributbasiertem Styling](./attribute_based_styling.md) gestalten Sie Objekte nach ihren Datenwerten, nach Zoom oder mit Regeln.
:::

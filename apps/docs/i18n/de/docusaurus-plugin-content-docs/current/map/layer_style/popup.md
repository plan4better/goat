---
description: "Zeigen Sie Objektinformationen bei Klick oder beim Überfahren in einem Popup an, aus Blöcken wie Feldliste, Text, Bild, Schaltfläche, Abzeichen und Trenner oder aus eigenem HTML mit Feldwerten, und legen Sie Layout und Größe fest; das Popup einer Rasterdatei zeigt den Wert der Zelle unter dem Mauszeiger."
sidebar_position: 4
---

# Popup

**Popups zeigen relevante Informationen an, wenn Benutzer mit Kartenobjekten interagieren.** Das hält Ihre Karte übersichtlich und stellt gleichzeitig detaillierte Informationen auf Abruf bereit. Sie legen fest, wann das Popup erscheint, bauen seinen Inhalt aus Blöcken oder HTML und bestimmen seine Darstellung.

## Wie man Popups konfiguriert

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie im <code>Layer</code>-Panel auf Ihren Layer. Rechts öffnet sich das Einstellungs-Panel des Layers; der Tab <code>Stil</code> ist ausgewählt. Der Abschnitt <code>Popup</code> steht ganz unten in diesem Tab.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Wählen Sie unter <code>Anzeigen bei</code>: <code>Bei Klick</code>, <code>Nur beim Überfahren</code>, <code>Bei Klick und beim Überfahren</code> (kurzer Blick beim Überfahren, bleibt bei Klick offen) oder <code>Aus</code> für kein Popup. Schalten Sie das Popup aus, bleibt sein Inhalt erhalten: Schalten Sie es wieder ein, kommt der Inhalt zurück.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Klicken Sie auf <code>Inhalt</code>. Sein Editor öffnet sich neben dem Panel. Lassen Sie unter <code>Modus</code> die Option <code>Einfach</code> ausgewählt, um das Popup aus Blöcken zu bauen.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Klicken Sie auf <code>Block hinzufügen</code> und wählen Sie einen Block: <code>Text</code>, <code>Feldliste</code>, <code>Bild</code>, <code>Schaltfläche</code>, <code>Abzeichen</code> oder <code>Trenner</code>. Klicken Sie auf einen Block in der Liste, um ihn in seinem eigenen Editor zu bearbeiten; die Pfeile daneben verschieben ihn nach oben oder unten, und das Papierkorb-Symbol im Kopf des Block-Editors (<code>Diesen Block entfernen</code>) entfernt ihn.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Wählen Sie für einen <code>Feldliste</code>-Block unter <code>Layout</code> <code>Tabelle</code> oder <code>Liste</code>, klicken Sie auf <code>Attribut hinzufügen</code>, um die anzuzeigenden Felder auszuwählen (oder <code>Fügen Sie alle Felder hinzu</code>), und legen Sie optional unter <code>Zuerst zeigen</code> fest, wie viele Felder auf einmal erscheinen; die übrigen Felder zeigt ein "Mehr anzeigen"-Button.</div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">
  Klicken Sie auf <code>Darstellung</code> und legen Sie fest:
  <ul>
    <li><code>Layout</code>: <code>Popup</code> neben dem Objekt oder <code>Angeheftet</code> in einer Ecke der Karte, gewählt unter <code>Verankerung</code>.</li>
    <li><code>Breite</code>: eine feste Breite in px oder leer für <code>Auto</code>.</li>
    <li><code>Maximale Höhe</code>: eine maximale Höhe in px; längere Inhalte lassen sich scrollen.</li>
    <li><code>Kopfzeile</code>: <code>Standard</code>, <code>Kompakt</code> oder <code>Keine</code>.</li>
    <li><code>Hervorheben</code>: markiert das Objekt, dessen Popup offen ist.</li>
  </ul>
  </div>
</div>

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Schalten Sie <code>Vorschau</code> (<code>Auf der Karte</code>) ein, um das Popup eines Beispielobjekts auf der Karte anzuheften, während Sie es bearbeiten.</div>
</div>

Die Zeile <code>Inhalt</code> nennt die Blöcke, die Zeile <code>Darstellung</code> Layout und Kopfzeile. Solange das Popup vom Stil des Datensatzes abweicht, zeigen die Köpfe beider Editoren <code>Auf den Stil des Datensatzes zurücksetzen</code> (ein kreisförmiger Pfeil).

## HTML-Modus

Für vollständige Kontrolle über das Popup-Design wechseln Sie vom Modus **Einfach** in den **HTML**-Modus. Damit schreiben Sie eigenes HTML und CSS für ansprechende, individuell gestaltete Popups, mit Bildern, gestalteten Karten, eigenen Schriften und dynamischen Feldwerten.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Stellen Sie im Editor <code>Inhalt</code> den <code>Modus</code> auf <code>HTML</code>. Beim ersten Wechsel wandelt GOAT Ihre vorhandenen Blöcke in HTML um.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf die Zeile <code>HTML</code>, die die Länge Ihres Codes zeigt, um den Editor <code>Benutzerdefiniertes HTML</code> zu öffnen und Ihr Markup zu schreiben. Der Editor zeigt neben Ihrem Code eine Live-Vorschau und rechts die Einstellungen der Darstellung. Klicken Sie auf <code>Speichern</code>, um Ihre Änderungen zu übernehmen.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Verwenden Sie <code>{"{{feldname}}"}</code>-Platzhalter, um Attributwerte der Objekte in Ihr HTML einzufügen. Tippen Sie <code>{"{{"}</code>, um Feldvorschläge zu erhalten, oder wählen Sie ein Feld unter <code>Feld einfügen</code>.</div>
</div>

## Popups von Raster-Layern

Das Popup einer Rasterdatei zeigt den Wert der Zelle unter dem Mauszeiger. Es hat dieselben Einstellungen <code>Anzeigen bei</code>, <code>Inhalt</code> und <code>Darstellung</code> wie das Popup anderer Layer, ohne <code>Hervorheben</code> und <code>Vorschau</code>:

- **Wann es erscheint:** Ein Layer, der unter <code>Darstellen als</code> als <code>Farbskala</code>, <code>Kategorien</code> oder <code>Schummerung</code> dargestellt wird, öffnet sein Popup <code>Bei Klick</code>, solange Sie nichts anderes wählen: <code>Nur beim Überfahren</code>, <code>Bei Klick und beim Überfahren</code> oder <code>Aus</code>. Ein Layer, der als <code>Bild</code> dargestellt wird, hat kein Popup, bis Sie unter <code>Anzeigen bei</code> wählen, wann es erscheint. Ein Bild aus 8-Bit-Bändern, die unverändert dargestellt werden (ein übliches Luftbild oder Satellitenbild in Echtfarben), kann sein Popup auch beim Überfahren zeigen: seine Pixel sind seine Werte. Ebenso ein Bild in den eigenen Farben seiner Datei (eine Karte mit Farbtabelle): GOAT zeichnet es aus seinen Zellwerten, daher zeigt das Popup auf jeder Farbe den Wert der Zelle, auch wo sich zwei Werte der Farbtabelle eine Farbe teilen, mit der Farbe des Werts daneben. Wo der Server die Zellen einfärbt (andere Bilder, eine Farbskala über ein Band mit Dezimalwerten, deren Wertebereich nicht bekannt ist, und eine Farbskala mit sehr vielen Farben), erscheint das Popup nur bei Klick, und <code>Anzeigen bei</code> bietet kein Überfahren an.
- **Was es zeigt:** Ohne eigenen Inhalt den Wert mit der Einheit der Legende, beschriftet mit seinem Band (oder dem Namen der Formel), ein kleines Quadrat in der Farbe der Zelle (ihre Farbe in der Farbskala oder Klasse, ohne die Deckkraft des Layers und bei einer Schummerung ohne die Schattierung), und seine Klasse oder Kategorie als Abzeichen in ihrer Farbe. Bei einer Datei mit mehreren Bändern wählen Sie unter <code>Werte</code> <code>Dargestellte Werte</code> (das Band, das der Stil verwendet) oder <code>Alle Bänder</code>. Ein Bild zeigt die Bänder, die es darstellt; wo seine Pixel seine Werte sind, in einer Zeile: ein Quadrat in der Farbe des Pixels und die Werte der Bänder, beschriftet mit den Namen der Bänder, sonst mit <code>Rot, Grün, Blau</code>, wenn die Datei ihre Bänder so kennzeichnet, sonst mit <code>Farbe</code>. Ein Bild in den eigenen Farben seiner Datei zeigt seinen Wert neben einem Quadrat in dessen Farbe.
- **Eigener Inhalt:** Unter <code>Inhalt</code> hat eine Feldliste, die einen Wert zeigt, kein <code>Layout</code> und kein <code>Zuerst zeigen</code>; beides erscheint, sobald sie ein zweites Feld enthält. Blöcke und HTML verwenden die Felder <code>value</code> (der Wert, den der Stil einfärbt; bei einem Bild in den eigenen Farben seiner Datei der Wert der Zelle in der Farbtabelle der Datei), <code>class</code> (seine Klasse oder Kategorie) und <code>band_1</code>, <code>band_2</code> und so weiter (jedes Band der Datei mit Werten; ein Alphaband, die Transparenz eines Luftbilds, hat keine).
- **Woher die Werte kommen:** Beim Überfahren liest das Popup den Wert, den die Karte zeigt, ohne auf den Server zu warten, und folgt dem Mauszeiger. Ein Klick zeigt diesen Wert sofort, danach den genauen Wert und die Werte aller Bänder. Bandwerte erscheinen nur beim Klick, außer bei einem Bild, dessen Pixel seine Werte sind, oder einem Bild in den eigenen Farben seiner Datei; das Panel weist darauf hin, wenn ein Popup, das beim Überfahren erscheint, sie zeigt. Solange die Karte verschoben oder gezoomt wird, ist das Popup beim Überfahren ausgeblendet; es erscheint wieder bei der nächsten Bewegung des Mauszeigers. Es schließt sich, wenn der Mauszeiger die Karte verlässt, etwa auf ein Panel.
- **Mauszeiger:** Solange das Popup an ist, ganz gleich, wobei es erscheint, wird der Mauszeiger über dem, was das Popup zeigt, zur Hand, wie über den Objekten anderer Layer: über einer Zelle mit Wert oder einem Pixel, das die Karte von einem Bild darstellt. Über Zellen ohne Daten, außerhalb der Datei und über Zellen, die die Karte nicht zeichnet (eine ausgeblendete Klasse oder Kategorie, ein Wert ohne Kategorie, wenn die übrigen Werte keine Farbe haben, eine Zelle jenseits des Bereichs oder der Klassen, wenn <code>Außerhalb</code> auf <code>Transparent</code> steht), bleibt er ein Pfeil, und dort öffnet sich kein Popup.

## Bewährte Praktiken

- **Wählen Sie relevante Felder** aus, die Benutzern bedeutungsvollen Kontext bieten.
- **Verwenden Sie klare, beschreibende Namen** anstatt technischer Feldnamen.
- **Begrenzen Sie die Anzahl der Felder**, um Benutzer nicht mit Informationen zu überfordern.
- **Nutzen Sie Zuerst zeigen**, um Popups bei vielen Attributen kompakt zu halten.

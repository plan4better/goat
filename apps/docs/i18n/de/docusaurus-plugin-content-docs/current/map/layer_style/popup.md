---
description: "Zeigen Sie Objektinformationen bei Klick oder beim Überfahren in einem Popup an, aus Blöcken wie Feldliste, Text, Bild, Schaltfläche, Abzeichen und Trenner oder aus eigenem HTML mit Feldwerten, und legen Sie Layout und Größe fest."
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

Das Popup einer Rasterdatei zeigt die Zellwerte unter dem Mauszeiger. Wählen Sie unter <code>Anzeigen bei</code> <code>Bei Klick</code>, <code>Nur beim Überfahren</code> oder <code>Aus</code>; bei einer Datei mit mehreren Bändern wählen Sie unter <code>Werte</code> <code>Dargestellte Werte</code> (das Band, das der Stil verwendet) oder <code>Alle Bänder</code>.

## Bewährte Praktiken

- **Wählen Sie relevante Felder** aus, die Benutzern bedeutungsvollen Kontext bieten.
- **Verwenden Sie klare, beschreibende Namen** anstatt technischer Feldnamen.
- **Begrenzen Sie die Anzahl der Felder**, um Benutzer nicht mit Informationen zu überfordern.
- **Nutzen Sie Zuerst zeigen**, um Popups bei vielen Attributen kompakt zu halten.

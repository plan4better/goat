---
description: "Gestalten Sie ein Dashboard: Panels an jeder Kartenseite hinzufügen, Stil, Aussehen, Position und Breite anpassen und Widgets aus der Seitenleiste hineinziehen."
sidebar_position: 1
---


# Builder-Kartenoberfläche

Der Wechsel in den Builder-Modus öffnet die Builder-Kartenoberfläche, **in der Sie Dashboards gestalten können, indem Sie Panels und Widgets anordnen und Ihr Workspace-Layout anpassen.**

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/builder/builder_interface_de.webp').default} alt="Builder Interface Overview in GOAT" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>

:::info Speichern
GOAT speichert Ihre Änderungen am Dashboard, während Sie arbeiten. Wurde das Dashboard inzwischen an anderer Stelle gespeichert, etwa von einer anderen Person oder in einem anderen Tab, ersetzen Ihre Änderungen diese Fassung nicht. Ein Hinweis oben zeigt <code>Dieses Dashboard wurde an anderer Stelle geändert</code> mit der Angabe, wer es wann geändert hat, und bis Sie wählen, wird nichts gespeichert: Klicken Sie auf <code>Neu laden</code>, um die gespeicherte Fassung zu laden, oder auf <code>Meine behalten</code>, um Ihre Fassung darüber zu speichern.
:::

--- 

## Kartensteuerung

Die folgenden Steuerelemente sind auf der Dashboard-Karte verfügbar. Ihre Position kann in den [Einstellungen](./settings) konfiguriert werden.

- **Standortsuche**: suchen Sie nach einer Adresse oder einem Ort und zentrieren Sie die Karte darauf
- **Zoom-Steuerung**: Schaltflächen zum Vergrößern und Verkleinern
- **Grundkarten**: wechseln Sie zwischen verfügbaren Grundkarten. Siehe [Grundkarten](../map/basemaps)
- **Messen**: messen Sie Abstände, Flächen und Routen direkt auf der Karte. Siehe [Messen](../map/measurements)

## Panels

Panels sind die Hauptbereiche, in denen Sie Ihre Widgets organisieren. Sie können Panels hinzufügen, anordnen und stylen, um Ihr Dashboard-Layout zu erstellen.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Sie können auf die <code>+</code> Schaltfläche klicken, <b>um ein neues Panel hinzuzufügen</b> zu jeder Seite der Karte.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf das <code>Panel</code>, um die <b>Einstellungen zu öffnen</b> und das Erscheinungsbild zu bearbeiten.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Sie können auch auf den <code>Pfeil</code> an der Seite eines Panels klicken, um es auf volle Höhe/Breite zu erweitern.</div>
</div>


<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <Video src={require('/img/builder/new_panel.mp4').default} alt="Panel options and appearance" style={{ maxHeight: "auto", maxWidth: "80%", objectFit: "cover"}}/>
</div>

<p></p>


Unter **Optionen** können Sie einstellen:
- `Panelstil`: `Standard`, `Gerundet` oder `Schwebend`
- `Einklappbares Panel`: aktivieren, damit Betrachter das Panel im Betrachter-Modus einklappen können

Unter **Aussehen** können Sie ändern:
- `Hintergrundfarbe`: Hintergrundfarbe des Panels festlegen
- `Deckkraft` (0 = transparent, 1 = undurchsichtig)
- `Hintergrundunschärfe`
- `Schatten`

Unter **Position** können Sie einstellen:
- `Elemente ausrichten`: Start, Mitte oder Ende
- `Abstand`: Entfernung zwischen Widgets
- `Innenabstand`: innerer Abstand um den Panel-Inhalt

Unter **Größe** können Sie einstellen:
- `Breite (px)`: feste Breite des Panels in Pixeln

Um ein Panel zu löschen, klicken Sie unten in den Einstellungen auf `Panel löschen`.


## Widgets

**Widgets sind die Bausteine Ihres Dashboards**. Sie ermöglichen es Ihnen, Daten, Statistiken, Diagramme und Projektelemente wie Texte oder Bilder anzuzeigen. Jedes Widget ist hochgradig anpassbar: Sie können den Inhalt, das Erscheinungsbild und das Verhalten nach Ihren Bedürfnissen anpassen, egal ob Sie wichtige Kennzahlen hervorheben, Trends visualisieren oder Kontext mit Text und Grafiken hinzufügen möchten.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/builder/widgets_de.webp').default} alt="Builder Interface Overview in GOAT" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>

<div class="step">
  <div class="step-number">1</div>
  <div class="content"><b>Ziehen Sie</b> <code>Widgets</code> einfach per <b>Drag & Drop</b> aus der rechten Seitenleiste auf jedes Panel Ihres Dashboards.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf das <code>Widget</code>, um <b>dessen Einstellungen anzupassen</b>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content"><b>Um das Widget neu anzuordnen</b>, können Sie darauf klicken und es am <code>gepunkteten Symbol</code> ziehen.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Sie können auf das <code>Löschen-Symbol</code> klicken, um <b>das Widget zu entfernen</b> von Ihrem Dashboard.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Ändern Sie den <code>Titel</code>, der oben im Widget erscheint, und die <code>Beschreibung</code>, die unten im Widget angezeigt wird.</div>
</div>

Weitere Details finden Sie unter [Widgets](../category/widgets).

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <Video src={require('/img/builder/widget_drag.mp4').default} alt="recent datasets" style={{ maxHeight: "400px", maxWidth: "auto", objectFit: "cover"}}/>
</div>

## Einstellungen

In den Einstellungen können Sie die **Karte**, das **Branding**, die **Social-Sharing**-Optionen, **Allgemeine** Einstellungen und **Interaktionen** für Ihr Dashboard konfigurieren. Weitere Details finden Sie unter [Einstellungen](./settings).

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/builder/interface_settings_de.webp').default} alt="Dragging a widget to the panel" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>

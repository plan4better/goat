---
description: "Orientieren Sie sich auf der Kartenoberfläche: obere Leiste, Layer Panel, Suche, Werkzeuge und Messungen, Stil- und Filterbereich sowie die Kartennavigation."
sidebar_position: 1
---


# Karten-Oberfläche

**Das Öffnen eines Projekts führt Sie zur Karten-Oberfläche**. Hier können Sie Layer erstellen, organisieren und gestalten, räumliche Daten visualisieren und alle mächtigen räumlichen Analysefähigkeiten von GOAT nutzen.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/interface/map_interface_de.webp').default} alt="Kartenoberfläche Übersicht" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

### Obere Leiste

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/interface/upper_bar_de.webp').default} alt="Obere Leiste Oberflächenelemente" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

#### Linke Seite
- <code>Projektmenü</code>: <strong>Klicken Sie, um zurückzukehren</strong> zur Startseite, Projektmetadaten zu bearbeiten, das Projekt zu löschen, den Kartenausschnitt zu sperren oder die Datenschutzrichtlinie zu lesen.
- <code>Projektname</code>: <strong>Doppelklicken Sie, um zu bearbeiten</strong> den Projektnamen.
- <code>Zuletzt gespeichert</code>: <strong>Zeigt den Zeitstempel</strong> der letzten gespeicherten Änderung.

#### Rechte Seite
- <code>Projekt-Modus Umschalter</code>: <strong>Wechseln Sie zwischen</strong> den Karten-, Workflows-, Layouts- und Dashboard-Oberflächen.
- <code>Projekt teilen</code>: <strong>Verwalten Sie die Freigabeoptionen</strong>.
- <code>Support</code>: <strong>Öffnen Sie Ihre Support-Tickets, melden Sie ein Problem oder öffnen Sie die Dokumentation</strong>. Siehe [Support](../support/support.md).
- <code>Job Status</code>: <strong>Zeigen Sie den Status</strong> laufender und abgeschlossener Aufgaben an. Das Symbol erscheint, sobald Sie eine Aufgabe gestartet haben.
- <code>Benutzerprofil</code>: <strong>Zugriff auf Kontoeinstellungen</strong> und abmelden.


### Panels & Werkzeuge

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/interface/right-left_panels_de.webp').default} alt="aktuelle Datensätze" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

#### Layer Panel

Das Layer Panel auf der linken Seite der Kartenoberfläche bietet **Zugang zu allen Projektlayern**. Von hier aus können Benutzer ihre Daten verwalten, indem sie **neue Layer** mit <code>+ Layer hinzufügen</code> hinzufügen und sie mit <img src={require('/img/icons/layer.png').default} alt="Layer gruppieren" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/><code>Layer gruppieren</code> **organisieren**, um logische Sammlungen verwandter Datensätze zu erstellen.

#### Werkzeuge
Die Werkzeuge befinden sich auf der rechten Seite des Layer Panels:

- <img src={require('/img/icons/magnifying-glass.png').default} alt="Adressen- und Koordinatensuche" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Such-Button</code>: <strong>Suchen Sie nach Adressen</strong> oder Koordinaten, um schnell zu einem bestimmten Ort auf der Karte zu navigieren.

- <img src={require('/img/icons/toolbox.png').default} alt="Werkzeuge" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Werkzeuge</code>: <strong>Zugriff auf die Werkzeuge</strong>. Lesen Sie mehr in [Werkzeuge](../category/toolbox).

- <img src={require('/img/icons/ruler-horizontal.png').default} alt="Messungen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Messungen</code>: Benutzer können <strong>Distanzen und Flächen messen</strong>, wie z. B. Routen, Linien und Polygone.

#### Bearbeitungs- und Werkzeug-Panel

Wenn Sie einen Layer im Layer Panel auswählen, erscheint der Bearbeitungsbereich auf der rechten Seite der Kartenoberfläche. Dieses Panel bietet Zugriff auf verschiedene Optionen:

- <code>Stil</code>: <strong>Passen Sie das visuelle Erscheinungsbild an</strong> des ausgewählten Layers, indem Sie Farben, Deckkraft und andere Gestaltungsoptionen ändern. Lesen Sie mehr in [Layer-Styling](../category/layer-design).

- <code>Filter</code>: <strong>Wenden Sie Filter an</strong> auf den ausgewählten Layer, um nur bestimmte Objekte basierend auf Attributwerten anzuzeigen. Lesen Sie mehr in [Layer-Filterung](filter).

- <code>Metadaten</code>: <strong>Metadaten anzeigen und bearbeiten</strong> für den ausgewählten Layer.

### Kartennavigation

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/interface/map_navigation_de.webp').default} alt="Kartennavigation" style={{ maxHeight: "auto", maxWidth: "90%", objectFit: "cover"}}/>
</div>

<p></p>

- <img src={require('/img/icons/plus.png').default} alt="Hineinzoomen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Hineinzoomen</code>

- <img src={require('/img/icons/minus.png').default} alt="Rauszoomen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Rauszoomen</code>

- <img src={require('/img/icons/fullscreen.png').default} alt="Vollbildmodus" style={{ maxHeight: "16px", maxWidth: "16px", objectFit: "cover"}}/> <code>Vollbildmodus</code>

- <img src={require('/img/icons/map.png').default} alt="Grundkarte" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Grundkarte</code>: <strong>Wählen Sie zwischen</strong> den verfügbaren Grundkartenoptionen. Klicken Sie auf <code>+ Neue Basemap hinzufügen</code> am unteren Rand des Panels, um eine eigene Grundkarte hinzuzufügen. Wählen Sie im Tab <code>Basemap</code> den Typ (<code>Vektor</code> oder <code>Raster</code>), geben Sie die <strong>Basemap-URL</strong>, einen <strong>Titel</strong> und optional eine Beschreibung und Vorschaubild-URL ein. Alternativ können Sie im Tab <code>Einfarbig</code> eine Volltonfarbe als Kartenhintergrund festlegen. Klicken Sie auf <code>Basemap hinzufügen</code>, um zu speichern.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/basemap/add_basemap_de.webp').default} alt="Eigene Grundkarte in GOAT hinzufügen" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "cover"}}/>
</div>

### 3D-Ansicht {#3d-view}

Die Schaltfläche <code>Ansicht</code> mit dem Würfelsymbol, über <code>Hineinzoomen</code>, öffnet das Panel <code>Ansicht</code>. Es schaltet die Karte zwischen 2D und 3D um:

- <code>2D</code> | <code>3D</code>: <strong>Wechseln Sie zu 3D</strong>, um die Karte zu neigen und zu drehen. Zurück in <code>2D</code> wird die Karte wieder flach und nach Norden ausgerichtet.
- <code>Globus beim Herauszoomen</code>: <strong>Zeigt die Welt als Globus</strong>, wenn Sie herauszoomen. Der Globus schwebt im All, mit einem weichen Leuchten und schwachen Sternen ringsum. Das funktioniert in 2D und 3D; ab Zoomstufe 9 ist die Karte wieder flach.
- <code>Gelände</code> (nur in 3D): <strong>Zeigt Berge und Täler</strong> mit Schummerung. <code>Überhöhung</code> macht das Relief steiler (1x, 1,5x, 2x oder 3x). Über Satelliten- und anderen Bild-Grundkarten erhält das Gelände keine zusätzliche Schummerung. Auf dem Globus zeigt sich das Relief als Schummerung; das Gelände hebt sich, sobald die Karte wieder flach ist.
- <code>3D-Gebäude</code> (nur in 3D): <strong>Hebt die Gebäude der Grundkarte an</strong>, ab Zoomstufe 14. Hat einer Ihrer Layer eigene Höhen, sind die Gebäude der Grundkarte zunächst ausgeschaltet. <code>Deckkraft</code> macht die Gebäude durchscheinend (standardmäßig 60 %), damit die Layer am Boden darunter lesbar bleiben.
- <code>Himmel und Atmosphäre</code> (für Bearbeitende, in 3D oder mit Globus): <code>Auto</code> übernimmt die Himmelsfarben aus der Grundkarte, sodass der Horizont zur Karte passt, lässt das Licht aus Ihrer Blickrichtung kommen und zeichnet keinen Nebel. Schalten Sie <code>Auto</code> aus, um <code>Himmel</code>, <code>Nebel</code>, <code>Globusleuchten</code> und <code>Licht</code> selbst festzulegen; die Karte ändert sich erst, wenn Sie einen Bereich bearbeiten. Schalten Sie <code>Nebel</code> mit dem Schalter oben in seinem Bereich ein, um zum Horizont hin Dunst hinzuzufügen. Unter <code>Globusleuchten</code> legen <code>Stärke</code> und <code>Leuchtfarbe</code> das Leuchten um den herausgezoomten Globus fest; die Stärke 0 schaltet es aus. Unter <code>Licht</code> legen <code>Richtung</code> und <code>Höhe</code> fest, woher das Licht kommt, <code>Intensität</code> und <code>Farbe</code>, wie es wirkt. <code>Auf Auto zurücksetzen</code> stellt das automatische Aussehen wieder her.

**Neigen und drehen** Sie die Karte in 3D, indem Sie mit der rechten Maustaste ziehen, mit <code>Strg</code> + Ziehen oder mit <code>Umschalt</code> + den Pfeiltasten. Der Himmel und, falls eingeschaltet, der Nebel zeigen sich, wenn die Karte stark geneigt ist.

Solange die Karte geneigt oder gedreht ist, erscheint über der Schaltfläche <code>Ansicht</code> ein **Kompass** mit der Neigung, etwa <code>Neigung 55°</code>. Ein Klick richtet die Karte nach Norden aus, ein zweiter führt zurück zu 2D.

Was Bearbeitende hier wählen, wird mit dem Projekt gespeichert, sodass öffentliche Karten und Dashboards in derselben Ansicht öffnen. Betrachter können die Ansicht für sich ändern; ihre Änderungen werden nicht gespeichert.

Auch Ihre eigenen Polygon-Layer und H3-Sechsecke können in 3D stehen: siehe [Höhe](./layer_style/style/styling.md#height). Das Kartenelement eines Layouts druckt die geneigte Ansicht als Bild; siehe [Geneigte Karten](../layouts/layouts.md#tilted-maps).


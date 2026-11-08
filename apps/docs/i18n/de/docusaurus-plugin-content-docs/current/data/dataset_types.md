---
description: "Die Datensatz-Typen in GOAT: Feature-Datensätze, Tabellen, Overture-Straßennetze, GTFS-ÖPNV-Netze, Datenpakete sowie Raster über WMS, WMTS, XYZ oder COG."
sidebar_position: 1
---

# Datensatz-Typen

Auf GOAT können Sie mit Datensätzen aus Plan4Betters Katalog arbeiten, Ihre eigenen hochladen oder einen externen Dienst per URL einbinden (**WFS**, **WMS**, **WMTS**, **XYZ-Kacheln** oder **COG**). Es akzeptiert verschiedene Formate für sowohl **Feature-Datensätze** als auch **[Raster-Datensätze](https://www.plan4better.de/de/glossar/rasterdaten)** sowie [**Straßennetze**](#straßennetze) und [**ÖPNV-Netze**](#öpnv-netze). Hier erklären wir die verschiedenen Typen von Datensätzen, die Sie in GOAT verwenden können.

## Feature-Datensätze

### 1.1 Räumliche Features

Feature-Datensätze speichern **räumliche Features wie Punkte, Linien oder Polygone**. Auf GOAT können Sie Daten aus **Shapefiles**, **GeoPackages**, **GeoJSON**, **KML**, **ZIP** oder **Parquet**-Dateien hochladen oder eine **WFS**-externe-URL hinzufügen. Für externe Raster-Quellen (WMS, WMTS, XYZ-Kacheln, COG) siehe [Raster-Datensätze](#raster-datensätze) unten. Sie können diese Datensätze mit den verschiedenen Werkzeugen aus der Werkzeugkiste visualisieren, gestalten und analysieren.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/data/spatial_de.webp').default} alt="Räumliche Features in GOAT" style={{ maxHeight: "450px", maxWidth: "750px", objectFit: "cover"}}/>
  <p style={{ textAlign: 'center', fontStyle: 'italic', marginTop: '8px', color: '#666' }}> Beispiel für räumliche Features, die in GOAT angezeigt werden</p>
</div>

<p></p>

GOAT erkennt zwei Typen von Feature-Datensätzen basierend auf ihrer Quelle:

- **Feature-Datensatz Standard**: Dies sind die Datensätze, die Sie selbst hochladen (wie GeoJSON, GeoPackage, KML und ZIP-Dateien), einschließlich der Layer, die mit einem [Straßennetz](#straßennetze) oder einem [ÖPNV-Netz](#öpnv-netze) importiert werden. Betrachten Sie diese als Ihre "Rohmaterialien": die ursprünglichen Daten, die Sie in GOAT einbringen, um damit zu arbeiten.

- **Feature-Datensatz Werkzeug**: Dies sind Datensätze, die von GOATs Analyse-Werkzeugen erstellt werden. Wenn Sie eine Analyse durchführen (wie die Erstellung von [Einzugsgebieten](https://www.plan4better.de/de/glossar/einzugsgebiet) oder [Heatmaps](https://www.plan4better.de/de/glossar/heatmap)), werden die Ergebnisse zu diesem Typ von Datensatz.

### 1.2 Nicht-räumliche Datensätze

**Tabellen** sind **nicht-räumliche Datensätze** ohne geografische Referenzpunkte, daher können sie nicht auf der Karte visualisiert werden. Importieren Sie sie in **CSV**- oder **XLSX**-Formaten für Analyse und Datenmanagement.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/data/table.webp').default} alt="Nicht-räumliche Datensätze in GOAT" style={{ maxHeight: "450px", maxWidth: "750px", objectFit: "cover"}}/>
  <p style={{ textAlign: 'center', fontStyle: 'italic', marginTop: '8px', color: '#666' }}> Beispiel einer in GOAT angezeigten Tabelle</p>
</div>

## Straßennetze

Ein **Straßennetz** ist eine routingfähige Abbildung von Straßen, Wegen und Radwegen. GOAT stellt ein integriertes Netz bereit, und Sie können Ihr eigenes importieren, wenn das [Routing](https://www.plan4better.de/de/glossar/routing) auf Daten laufen soll, die Sie selbst verwalten: ein Netz, das Sie selbst pflegen, oder ein geplantes Netz, das Sie testen möchten, bevor es gebaut wird.

Ihre Daten müssen dem **[Overture](https://www.plan4better.de/de/glossar/overture-maps)**-Format entsprechen, Segments und Connectors als Parquet-Dateien, verpackt in einer `.zip`-Datei, deren Name `overture` enthält, zum Beispiel `overture.zip` oder `berlin_overture.zip`. Andere Straßendaten, einschließlich OpenStreetMap, werden derzeit nicht unterstützt.

Ein Straßennetz besteht aus zwei Layern, die GOAT zusammenhält:

- **Edges**: die routingfähigen Segmente. Dies ist der Layer, den Sie bearbeiten, wenn Sie das Netz ändern.
- **Nodes**: die Punkte, an denen Edges zusammentreffen. GOAT pflegt sie für Sie, sobald Sie eine Edge speichern, damit das Netz routingfähig bleibt.

Straßennetze sind die Grundlage für das Routing zu [Fuß](../routing/walking), mit dem [Fahrrad](../routing/bicycle), dem [E-Bike](../routing/bicycle) und dem [Auto](../routing/car) in GOAT. Zum Importieren siehe [Inhalte hinzufügen](../workspace/content.md#inhalte-hinzufügen); was das integrierte Netz von GOAT enthält und wie Sie eigene importieren, finden Sie unter [Netz-Datensätze](./builtin_datasets.md#eigene-netze-importieren).

## ÖPNV-Netze

Ein **ÖPNV-Netz** beschreibt die Haltestellen, Linien und Fahrpläne eines Verkehrssystems. GOAT stellt ein integriertes Netz bereit, und Sie können Ihr eigenes importieren, wenn Sie ein Angebot analysieren möchten, das Sie selbst verwalten: Ihren eigenen Feed oder einen Fahrplan, den Sie planen.

Ihre Daten müssen dem **[GTFS](https://www.plan4better.de/de/glossar/gtfs)**-Format entsprechen, verpackt in einer `.zip`-Datei, deren Name `gtfs` enthält, zum Beispiel `gtfs.zip` oder `vbb_gtfs.zip`. Die `.zip`-Datei darf höchstens **200 MiB** groß sein: GOAT erstellt den Fahrplan aus dem gesamten Feed auf einmal, daher lassen sich größere Feeds nicht importieren.

Die enthaltenen Layer entsprechen dem GTFS-Feed selbst: **Stops**, **Routes**, **Trips** und **Stop times** sind immer vorhanden, **Agency**, **Calendar** und **Shapes** kommen hinzu, sofern der Feed sie bereitstellt.

:::info Ein ÖPNV-Netz benötigt ein Straßennetz
GOAT verbindet Haltestellen mit Straßen, um den Weg zur und von der Haltestelle routen zu können. Deshalb wählen Sie beim Hochladen der GTFS-Datei ein Straßennetz aus, entweder das integrierte Netz `Standard` oder eines Ihrer eigenen, das dann zuerst importiert sein muss.
:::

ÖPNV-Netze sind die Grundlage für das [ÖPNV](../routing/public_transport)-Routing in GOAT. Zum Importieren siehe [Inhalte hinzufügen](../workspace/content.md#inhalte-hinzufügen); was das integrierte Netz von GOAT enthält und wie Sie eigene importieren, finden Sie unter [Netz-Datensätze](./builtin_datasets.md#eigene-netze-importieren).

## Datensätze aus mehreren Layern

Straßennetze und ÖPNV-Netze bestehen beide aus **mehreren Layern, die nur gemeinsam sinnvoll sind**. GOAT nennt einen solchen Datensatz **Datenpaket** und verwaltet ihn als Einheit: Seine Layer werden gemeinsam geteilt, sie erscheinen gemeinsam in einem Projekt, und beim Löschen des Datensatzes werden alle entfernt.

Der Begriff begegnet Ihnen bei der Arbeit: Der Upload-Dialog bestätigt, dass eine erkannte Datei *als Datenpaket importiert* wird, der [Katalog](../workspace/catalog.md) kennzeichnet einen Eintrag mit mehreren Layern als `Datenpaket`, und Teilen oder Löschen betrifft immer den gesamten Satz.

## Raster-Datensätze

Raster-Datensätze können direkt als **COG (Cloud Optimized GeoTIFF)**-Dateien hochgeladen oder aus externen Quellen über **WMS** (Web Map Service), **WMTS** (Web Map Tile Service), **XYZ-Kacheln** oder eine direkte **COG-URL** (.tif/.tiff-Link) verbunden werden. Sie bieten georeferenzierte Kartenbilder, wie topografische Karten, aber auf GOAT sind sie statisch, daher unterstützen sie keine Analyse oder Bearbeitung.

:::tip Hinweis
Raster-Styling hängt vom externen Service ab (z.B. GeoServer). Sie können das Farbschema oder die Feature-Darstellung in GOAT nicht ändern.
:::

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/data/raster_de.webp').default} alt="Raster-Datensätze in GOAT" style={{ maxHeight: "450px", maxWidth: "750px", objectFit: "cover"}}/>
  <p style={{ textAlign: 'center', fontStyle: 'italic', marginTop: '8px', color: '#666' }}> Beispiel eines in GOAT angezeigten Raster-Layers</p>

</div>

- **WMS (Web Map Service)**: Unterstützt Zoomen und Schwenken, ideal für Grundkarten, aber gibt statische Bilder aus und lädt langsamer.

- **WMTS (Web Map Tile Service)**: Verwendet vorgerenderte Kacheln für schnelles Laden und sanftes Zoomen. Am besten für große Gebiete und konsistente Kartenstile.

- **XYZ-Kacheln**: Bietet schnelles Zoomen und Schwenken mit Kacheln, die durch X (Längengrad), Y (Breitengrad) und Z (Zoom-Level) Koordinaten definiert sind. Ideal für schnell ladende Karten mit konsistenter Leistung auf verschiedenen Zoom-Leveln.

|   | **WMS** | **WMTS** und **XYZ-Kacheln** |
|----|-------------|--------------|
| **URL-Typ in GOAT**    | Capabilities-URL | Capabilities (nur WMTS), Direkte URL |
| **Datenausgabe** | Dynamische Kartenbilder | Vorgerenderte, zwischengespeicherte Kartenkacheln |
| **Struktur** | Keine Kacheln - Bilder werden spontan generiert | Strukturierte Kacheln basierend auf Raster |
| **Leistung** | Langsamer (Bilder werden pro Anfrage generiert) | Schneller (Kacheln zwischengespeichert) |
| **Anpassung** | Begrenzt | Begrenzt |
| **Skalierbarkeit** | Weniger skalierbar | Hoch skalierbar |
| **Zoom-Level** | Variabel, durch Anfrageparameter festgelegt | Fester Zoom-Level, vom Server vorbestimmt |
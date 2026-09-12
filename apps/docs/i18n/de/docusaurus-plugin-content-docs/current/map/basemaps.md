---
sidebar_position: 7
---

# Grundkarten

**Grundkarten bilden die Kartenbasis Ihres Projekts** und geben Ihren Daten geografischen Kontext — Straßen, Gelände, Satellitenbilder oder eine einfarbige Fläche. GOAT unterstützt alle Anbieter, die eine Style-JSON-URL (Vektor) oder eine XYZ-Kachel-URL (Raster) bereitstellen.

## So fügen Sie eine eigene Grundkarte hinzu

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie in der Kartenoberfläche auf die Schaltfläche <img src={require('/img/icons/map.png').default} alt="Grundkarte Symbol" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Grundkarte</code> in den Kartennavigations-Steuerelementen.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie am unteren Ende des Panels auf <code>+ Neue Basemap hinzufügen</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie den Tab <code>Basemap</code>. Wählen Sie <code>Vektor</code> für Style-JSON-Quellen oder <code>Raster</code> für XYZ-Kachelquellen.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Geben Sie die <strong>Basemap-URL</strong>, einen <strong>Titel</strong> und optional eine Beschreibung sowie eine Vorschaubild-URL ein. Klicken Sie auf <code>Basemap hinzufügen</code>, um zu speichern.</div>
</div>

:::tip Einfarbiger Hintergrund
Verwenden Sie den Tab <strong>Einfarbig</strong> anstelle einer URL, um eine Volltonfarbe als Kartenhintergrund festzulegen — nützlich für Drucklayouts oder minimalistische Dashboards.
:::

## Häufig verwendete Anbieter

### Mapbox

Mapbox bietet eine große Auswahl an Kartenstilen. Erstellen Sie ein kostenloses Konto auf [mapbox.com](https://www.mapbox.com), um Ihren Zugriffstoken zu erhalten.

**Beispiel-URL:**
```
https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}?access_token={IHR_ZUGRIFFSTOKEN}
```

:::info Sichtbarkeit des Zugriffstokens
Grundkarten, die zu einem **geteilten oder öffentlichen Projekt** hinzugefügt werden, machen Ihren Mapbox-Zugriffstoken für Betrachter sichtbar. Beschränken Sie den Token in Ihrem Mapbox-Konto auf Ihre Domain, um unbefugte Nutzung zu verhindern.
:::

---

### MapTiler

MapTiler bietet hochwertige Vektor-Grundkarten, die nahtlos mit der Karten-Engine von GOAT funktionieren. Erstellen Sie ein kostenloses Konto auf [maptiler.com](https://www.maptiler.com), um Ihren API-Schlüssel zu erhalten.

**Beispiel-URL:**
```
https://api.maptiler.com/maps/streets-v2/style.json?key={IHR_API_SCHLÜSSEL}
```

:::info Sichtbarkeit des API-Schlüssels
Ihr MapTiler-API-Schlüssel ist in geteilten Projekten sichtbar. Verwenden Sie die Schlüsselbeschränkungseinstellungen in der MapTiler Cloud, um die Nutzung auf Ihre Domain zu begrenzen.
:::

---

### Esri / ArcGIS

Esri bietet eine Vielzahl professioneller Grundkarten — kein Konto oder API-Schlüssel erforderlich.

**Beispiel-URL:**
```
https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
```

---

### OpenStreetMap

OpenStreetMap (OSM) bietet kostenlose, gemeinschaftlich gepflegte Grundkarten — kein Konto oder API-Schlüssel erforderlich.

**Beispiel-URL:**
```
https://tile.openstreetmap.org/{z}/{x}/{y}.png
```

:::info Nutzungsrichtlinien
Die Kachelserver von OpenStreetMap sind für geringen Datenverkehr ausgelegt. Für produktive oder stark frequentierte Projekte empfiehlt sich ein gehosteter Anbieter wie [OpenFreeMap](#openfreemap) oder [MapTiler](#maptiler), die OSM-basierte Kartenstile mit besserer Zuverlässigkeit anbieten.
:::

---

### OpenFreeMap

OpenFreeMap stellt kostenlose Vektor-Grundkarten auf Basis von OpenStreetMap-Daten bereit — ohne Konto, ohne API-Schlüssel und ohne Nutzungsbegrenzung. Die Kacheln folgen demselben OpenMapTiles-Schema, das auch die kommerziellen Anbieter verwenden, sodass sich Kartenstile weitgehend untereinander austauschen lassen. Die integrierten Vektor-Grundkarten von GOAT werden von hier ausgeliefert.

**Beispiel-URL:**
```
https://tiles.openfreemap.org/styles/liberty
```

Verfügbare Stile: `liberty`, `bright`, `positron`, `dark` und `fiord`.

:::info Keine Verfügbarkeitsgarantie
OpenFreeMap ist ein spendenfinanzierter Dienst ohne Verfügbarkeitsgarantie. Die Kacheln werden über ein CDN ausgeliefert und zwischengespeichert; zusätzlich wird der gesamte Planet zum Selbst-Hosten veröffentlicht.
:::

---

### Carto Dark Matter

Der Dark-Matter-Stil von Carto bietet eine dunkle, minimalistische Grundkarte, die sich besonders für datenintensive Karten eignet, bei denen helle Datenvisualisierungen hervorstechen sollen — kein Konto oder API-Schlüssel erforderlich.

**Beispiel-URL:**
```
https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json
```

:::tip Weitere Anbieter
Eine umfangreichere Liste kompatibler Grundkartenanbieter und Verbindungsanleitungen finden Sie im [GOAT-Blogbeitrag zu Grundkarten](https://www.plan4better.de/en/post/where-to-find-basemaps).
:::

## Basemap-Layer anordnen

Beim Bearbeiten einer eigenen Grundkarte ermöglicht der Tab **Layer** die einzelnen Teilebenengruppen der Grundkarte relativ zu Ihren eigenen Datenlayern anzuordnen — und einzelne Gruppen ein- oder auszublenden.

Um darauf zuzugreifen, klicken Sie auf das Bearbeitungssymbol einer eigenen Grundkarte im Grundkarten-Panel und wählen Sie dann den Tab **Layer**.

Die Grundkarte ist in fünf Layer-Gruppen unterteilt:

| Gruppe | Inhalt |
|--------|--------|
| **Straßen** | Straßennetz, Wege |
| **Gewässer** | Flüsse, Seen, Küsten |
| **Flächennutzung** | Wald, Parks, Felder |
| **Gebäude** | Gebäudegrundrisse |
| **Sonstiges** | Übrige Layer |

Für jede Gruppe können Sie:
- **Sichtbarkeit umschalten** — die Gruppe mit dem Schalter rechts vollständig ein- oder ausblenden
- **Position** — `Über` oder `Unter` wählen, um festzulegen, ob die Gruppe über oder unter Ihren eigenen Layern dargestellt wird
- **Bezugslayer** — auswählen, welcher Ihrer Layer als Referenz dient (Standard: *Alle meine Layer*)

Klicken Sie auf **Zurücksetzen**, um alle Gruppen auf ihre Standardpositionen und -sichtbarkeit zurückzusetzen.

:::tip Wann ist das sinnvoll?
Platzieren Sie **Straßen** über Ihren Daten, damit Straßen über Polygon-Overlays lesbar bleiben. Platzieren Sie **Gebäude** unter Ihren eigenen Layern, damit Ihre Daten über den Gebäudegrundrissen erscheinen.
:::

## Grundkarten in geteilten Dashboards

Wenn Sie ein Projekt als öffentliches Dashboard teilen, können Sie im **Dashboard** festlegen, zwischen welchen Grundkarten die Betrachter wechseln dürfen. Öffnen Sie im **Dashboard** den Tab **Einstellungen** und suchen Sie das Feld **Erlaubte Hintergrundkarten**. Wählen Sie die gewünschten Grundkarten aus — wenn keine Einschränkung festgelegt ist, werden alle Grundkarten für die Betrachter angezeigt.

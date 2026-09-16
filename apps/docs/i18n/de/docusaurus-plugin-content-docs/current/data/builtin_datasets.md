---
sidebar_position: 3
sidebar_label: Netz-Datensätze
---

# Netz-Datensätze

## Die Grundlage hinter GOATs Indikatoren


GOATs Erreichbarkeitsindikatoren und Analysetools basieren auf hochwertigen Netz-Datensätzen, die im Hintergrund arbeiten. **GOAT bringt integrierte Netze für ÖPNV und Straßen mit, und Sie können [eigene Netze importieren](#eigene-netze-importieren), wenn eine Analyse auf Daten laufen soll, die Sie selbst verwalten.**

Das Verständnis dieser zugrundeliegenden Datensätze hilft Ihnen:
- **Die Datenqualität zu kennen**, die Sie von GOATs Indikatoren erwarten können
- **Die geografische Abdeckung** verschiedener Analyse-Werkzeuge zu verstehen
- **Ergebnisse zu interpretieren** mit Kenntnis der Datenquellen

:::info Netze vs. eigene Datensätze
Auf dieser Seite geht es um die **Netz-Datensätze**, die hinter GOATs Routing- und Erreichbarkeitsanalysen stehen. Wie Sie eigene Datensätze hochladen oder fertige verwenden, erfahren Sie unter [Inhalt](../workspace/content.md) und im [Katalog](../workspace/catalog.md).
:::

## Die integrierten Netze von GOAT

GOAT umfasst umfassende Netzwerk-Datensätze, die alle routing-basierten Erreichbarkeitsindikatoren und Analyse-Werkzeuge antreiben.

### Öffentliches Verkehrsnetz

Unser öffentliches Verkehrsnetz deckt mehrere Verkehrsmittel ab, einschließlich Bus, Tram, U-Bahn, Bahn und Fähre. Dieses Netzwerk ermöglicht GOATs [Öffentlicher Verkehr](../routing/public_transport) Routing-Funktionen.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/data/data_basis/pt_network_banner.png').default} alt="Öffentliches Verkehrsnetz" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>

**Was enthalten ist:**
- **Haltestellen**: Namen, Standorte, Typen und Barrierefreiheitsinformationen
- **Routen**: Service-Typen, Barrierefreiheitsdetails und Routeninformationen  
- **Fahrpläne**: Abfahrtszeiten, Service-Häufigkeit und Betriebstage
- **Umsteigeverbindungen**: Umsteigeangaben und Bahnhofsverbindungen
- **Fahrtmuster**: Haltestellensequenzen und Zeitinformationen
- **Routenverläufe**: Geospatiale Darstellung von Verkehrslinien

**Datenquellen:**
- **Deutschland**: [DELFI](https://www.delfi.de/) - Deutschlands nationale Datenplattform für öffentliche Verkehrsmittel
- **Straßenebene-Daten**: [OpenStreetMap (OSM)](https://wiki.openstreetmap.org/) - Für Bahnhofszugang, Fußgängerverbindungen und multimodales Routing

**Wie wir die Daten verarbeiten:**
1. **Import**: Daten werden im [GTFS (General Transit Feed Specification)](https://gtfs.org/)-Format gesammelt
2. **Überprüfen & Korrigieren**: Wir validieren Haltestellenbeziehungen, Bahnsteigverbindungen und Service-Typ-Klassifizierungen
3. **Optimieren**: Netzwerke werden optimiert, um nur die repräsentativsten Service-Muster für jede Route zu enthalten
4. **Fahrplan-Typen**: Die Analyse unterstützt drei Tagestypen - **Werktag** (typischerweise Dienstag), **Samstag** und **Sonntag**

### Straßennetzwerk und Topografie

Unser Straßennetzwerk repräsentiert reale Verkehrsinfrastruktur einschließlich Straßen, Autobahnen, Fahrradwegen und Fußwegen. Dies ermöglicht GOATs [Zu Fuß](../routing/walking), [Fahrrad](../routing/bicycle), [Pedelec](../routing/bicycle) und [Auto](../routing/car) Routing.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/data/data_basis/street_network_banner.png').default} alt="Straßennetzwerk" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>

**Netzwerk-Komponenten:**
- **Segmente (Kanten)**: Kontinuierliche Wegabschnitte zwischen Kreuzungen
- **Kreuzungen (Knoten)**: Punkte, an denen sich verschiedene Wege treffen oder kreuzen

**Datenquellen:**
- **Straßennetze**: [Overture Maps Foundation](https://overturemaps.org/) - Hochwertige, europaweite Verkehrsdaten
- **Höhendaten**: [Copernicus](https://www.copernicus.eu/en) Digitales Höhenmodell (DEM) für genaue Steigungsberechnungen

**Verarbeitungsworkflow:**
1. **Datenimport**: Straßennetzwerkdaten werden im Geoparquet-Format aus Overture Maps' [Transportation theme](https://docs.overturemaps.org/guides/transportation/) importiert
2. **Höhenverarbeitung**: Europäische DEM-Kacheln werden verarbeitet, um topografische Informationen zu extrahieren
3. **Räumliche Indexierung**: Netzwerksegmente werden mit [Ubers H3-Gittersystem](../further_reading/glossary#h3-grid) für effiziente Verarbeitung organisiert
4. **Steigungsberechnung**: Oberflächengfäle und Steigungswiderstand werden für jedes Straßensegment berechnet
5. **Attributanalyse**: Straßenklassifizierungen, Geschwindigkeitsbegrenzungen, Abbiegebeschränkungen und Einbahnstraßenbezeichnungen werden identifiziert und standardisiert
6. **Geschwindigkeitsbegrenzungs-Interpolation**: Fehlende Geschwindigkeitsbegrenzungen werden basierend auf Straßentyp und modalen Geschwindigkeiten geschätzt

## Eigene Netze importieren

Die oben beschriebenen Netze sind die integrierten Netze von GOAT und werden standardmäßig verwendet. Sie können auch **eigene Netze importieren** — ein Netz, das Sie selbst pflegen, eine Region, die Sie mit Ihren eigenen Daten analysieren möchten, oder ein geplantes Netz, das Sie testen möchten, bevor es gebaut wird.

Nach dem Import wird Ihr Netz genauso verwendet wie das integrierte: Die Routing- und Erreichbarkeitswerkzeuge bieten es neben `Standard (Europa)` an, und Sie wählen aus, auf welchem Netz eine Analyse laufen soll.

### Eigenes Straßennetz

Ihre Daten müssen dem [Overture-Maps-Schema](https://docs.overturemaps.org/) entsprechen. Dafür gibt es drei Wege:

**Fragen Sie uns nach einem Export.** Teilen Sie Plan4Better mit, welche Region Sie benötigen, und wir bereiten eine Datei vor, die Sie direkt hochladen können. Dafür müssen Sie nichts installieren — der schnellste Weg, wenn Sie die Daten nicht selbst aufbereiten möchten.

**Holen Sie die Daten selbst.** Installieren Sie das [Kommandozeilenwerkzeug overturemaps](https://docs.overturemaps.org/getting-data/overturemaps-py/), ermitteln Sie den Begrenzungsrahmen Ihres Gebiets mit einem Werkzeug wie [boundingbox.klokantech.com](https://boundingbox.klokantech.com/) im CSV-Format und laden Sie dann die beiden Layer herunter, die GOAT benötigt:

```bash
overturemaps download --bbox=<Ihre Region> -f geoparquet --type=segment -o segment.geoparquet
overturemaps download --bbox=<Ihre Region> -f geoparquet --type=connector -o connector.geoparquet
zip -j overture.zip ./segment.geoparquet ./connector.geoparquet
```

Verwenden Sie für beide Downloads denselben Begrenzungsrahmen — Segments und Connectors müssen dasselbe Gebiet abdecken, sonst fügt sich das Netz nicht zusammen.

**Lassen Sie es einen KI-Assistenten erledigen.** Wenn Sie mit einem Coding-Assistenten arbeiten, der Befehle ausführen kann — Claude Code, Cursor, Copilot im Agent-Modus — kopieren Sie den folgenden Prompt, tragen Sie Ihre Region ein und fügen Sie ihn dort ein. Der Assistent führt die oben beschriebenen Schritte aus und übergibt Ihnen die fertige `.zip`-Datei.

<details>
<summary>Prompt für einen KI-Assistenten</summary>

```text
Erstelle eine einzelne Datei, overture.zip, mit Overture-Maps-Verkehrsdaten für
die unten genannte Region, bereit zum Upload in ein GOAT-Projekt.

REGION: <Ihr Gebiet, z. B. München, Deutschland>

Arbeite die Schritte der Reihe nach ab. Führe die Befehle selbst aus, zeige mir
die tatsächliche Ausgabe und brich ab, wenn ein Schritt fehlschlägt.

1. Installiere die overturemaps-CLI in einer isolierten Umgebung:
     python3 -m venv .overture-venv
     source .overture-venv/bin/activate
     pip install --upgrade pip
     pip install overturemaps
   Prüfe mit: overturemaps --help

2. Ermittle den Begrenzungsrahmen der Region in EPSG:4326, in der Reihenfolge
   west,south,east,north. Nachschlagen lässt er sich mit Nominatim:
     curl -s 'https://nominatim.openstreetmap.org/search?q=ORT&format=json&limit=1' \
       -H 'User-Agent: goat-docs/1.0' \
     | python3 -c "import sys,json; b=json.load(sys.stdin)[0]['boundingbox']; print(f'{b[2]},{b[0]},{b[3]},{b[1]}')"
   Nominatim liefert [south,north,west,east], die Werte müssen also umsortiert
   und nicht übernommen werden. Zeige mir den Rahmen und ungefähr, welches
   Gebiet er abdeckt, bevor du weitermachst. Warne mich, wenn er mehr als etwa
   1 Grad in einer Richtung umfasst — der Download wird dann sehr groß.

3. Lade die Segments herunter:
     overturemaps download --bbox=BBOX -f geoparquet --type=segment -o segment.geoparquet

4. Lade die Connectors mit genau demselben Begrenzungsrahmen herunter:
     overturemaps download --bbox=BBOX -f geoparquet --type=connector -o connector.geoparquet

5. Prüfe, ob beide Dateien vorhanden und nicht leer sind:
     ls -lh segment.geoparquet connector.geoparquet
   Eine leere Datei bedeutet meist, dass die Koordinaten in der falschen
   Reihenfolge standen. Gehe in dem Fall zurück zu Schritt 2.

6. Erstelle das Archiv ausdrücklich aus den beiden Dateinamen, nie mit einem
   Platzhalter:
     rm -f segment.geoparquet.state connector.geoparquet.state
     zip -j overture.zip ./segment.geoparquet ./connector.geoparquet
     unzip -l overture.zip
   Die Auflistung muss genau segment.geoparquet und connector.geoparquet zeigen.

7. Nenne mir den Pfad zu overture.zip, die Dateigröße, den verwendeten
   Begrenzungsrahmen und die Zeilenzahl jedes Layers.
```

</details>

Ein importiertes Straßennetz lässt sich **auf der Karte bearbeiten**: Zeichnen Sie eine Straße, und GOAT teilt und verbindet die Topologie, pflegt die Nodes und erstellt die Routing-Daten aus Ihren Änderungen neu. So können Sie eine geplante Verbindung testen — eine neue Brücke, eine gesperrte Straße, einen Radweg — und eine Analyse darauf erneut ausführen.

### Eigenes ÖPNV-Netz

Ihre Daten müssen ein Feed nach der [offiziellen GTFS-Spezifikation](https://gtfs.org/documentation/schedule/reference/) sein. Solche Feeds stammen üblicherweise aus einer von drei Quellen:

**Fragen Sie uns nach einem Export.** Teilen Sie Plan4Better mit, welche Region Sie benötigen, und wir bereiten eine Datei vor, die Sie direkt hochladen können. Der schnellste Weg, wenn Sie nicht selbst nach einem Feed suchen möchten.

**Gehen Sie zur Quelle.** Verkehrsunternehmen veröffentlichen ihre Feeds selbst, und viele Länder sammeln sie zentral — in Deutschland übernimmt das [DELFI](https://www.delfi.de/) bundesweit. So erhalten Sie die aktuellsten Daten und die klarsten Lizenzbedingungen.

**Nutzen Sie einen Aggregator.** Die [Mobility Database](https://mobilitydatabase.org/) und [transit.land](https://www.transit.land/) erfassen Feeds von Betreibern weltweit — der einfachste Weg, einen Feed zu finden, wenn Sie nicht wissen, wer ihn veröffentlicht.

Da GOAT den Weg zu und von jeder Haltestelle routet, muss ein ÖPNV-Netz mit einem **Straßennetz verknüpft** sein. Sie wählen dieses Netz beim Hochladen aus, das Straßennetz muss also bereits vorhanden sein.

:::info Außerhalb Europas zuerst ein Straßennetz hochladen
Das integrierte Netz `Standard (Europa)` deckt nur Europa ab. Liegen Ihre Fahrplandaten außerhalb, importieren Sie zuerst ein Straßennetz für diese Region — sonst gibt es nichts, womit sich die Haltestellen verbinden ließen.
:::

Die Verknüpfung mit Ihrem eigenen Straßennetz sorgt außerdem dafür, dass eine Fahrplananalyse die Straßen berücksichtigt, die Sie geändert haben.

Aus welchen Dateiformaten diese Netze importiert werden und aus welchen Layern sie bestehen, erfahren Sie unter [Datensatz-Typen](./dataset_types.md#straßennetze). Die Importschritte finden Sie unter [Inhalte hinzufügen](../workspace/content.md#inhalte-hinzufügen).
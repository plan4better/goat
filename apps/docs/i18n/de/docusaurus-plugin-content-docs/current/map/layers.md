---
description: "Fügen Sie Layer per Upload, als neuen Layer, über WFS, WMS, WMTS, XYZ oder COG, mit Daten aus OpenStreetMap oder Overture Maps, aus Ihren Datensätzen oder dem Katalog hinzu und ordnen oder gruppieren Sie sie."
sidebar_position: 2
---


import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';



# Layer

**Im Layer-Bereich können Layer hinzugefügt und organisiert werden**. Unter anderem kann die Layer-Reihenfolge angepasst, Layer aktiviert/deaktiviert, dupliziert, umbenannt, heruntergeladen und entfernt werden.

<iframe width="100%" height="500" src="https://www.youtube.com/embed/McjAUSq2p_k?si=2hh0hU10l95Tkjqt" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>



## Wie Sie Ihre Layer verwalten

Das Layer Panel ist Ihre zentrale Anlaufstelle für die Organisation und Steuerung aller Daten in Ihrem GOAT-Projekt. Hier können Sie neue Datensätze hinzufügen, die Layer-Reihenfolge für eine optimale Visualisierung anordnen, verwandte Layer gruppieren und die Sichtbarkeit steuern. Dieser Abschnitt führt Sie durch alle wesentlichen Layer-Verwaltungsfunktionen, um Ihnen beim Erstellen gut organisierter und visuell effektiver Karten zu helfen.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/layers/add_layer_de.webp').default} alt="Layer in GOAT hinzufügen" style={{ maxHeight: "flex", maxWidth: "flex", objectFit: "cover"}}/>
</div>

### Layer hinzufügen

Sie können Layer aus [verschiedenen Quellen](../data/dataset_types) zu Ihrer Karte hinzufügen:

**Neue Daten**

- **Datensatz hochladen**: ein Datensatz von Ihrem Gerät (GeoPackage, GeoJSON, Shapefile, KML, CSV, XLSX, Parquet sowie [GTFS](https://www.plan4better.de/de/glossar/gtfs)- und [Overture](https://www.plan4better.de/de/glossar/overture-maps)-Archive)
- **Layer erstellen**: ein neuer, leerer Layer, in den Sie zeichnen
- **Dienst verbinden**: ein Layer, der über WFS, WMS, WMTS, XYZ-Kacheln oder COG bereitgestellt wird, per URL eingebunden, oder Features aus OpenStreetMap oder Overture Maps für ein Gebiet

**Vorhandene Daten**

- **Meine Datensätze**: alles, was bereits in Ihren Bereichen liegt
- **Katalog**: fertige Datensätze von offiziellen Anbietern

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie in der linken Leiste auf <code>+ Layer hinzufügen</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Wählen Sie, woher der Layer stammt.</div>
</div>

<Tabs>
  <TabItem value="Upload" label="Datensatz hochladen" default className="tabItemBox">

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Ziehen Sie eine Datei auf den Ablagebereich oder klicken Sie, um eine auszuwählen. Die unterstützten Formate stehen darüber.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Geben Sie dem Datensatz einen Namen und bei Bedarf eine Beschreibung. Bei CSV- oder XLSX-Dateien können Sie zusätzlich über <code>Spalten einrichten</code> das Arbeitsblatt wählen und angeben, ob die erste Zeile die Spaltennamen enthält.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Klicken Sie auf <code>Hochladen</code>.</div>
</div>

<div class="content"><strong>Straßennetze und GTFS-Feeds:</strong> ein GTFS- oder Overture-Archiv wird als [Datenpaket](../data/dataset_types#datensätze-aus-mehreren-layern) importiert, nicht als einzelner Layer. Bei einem ÖPNV-Feed werden Sie außerdem gebeten, ihn mit einem Straßennetz zu verknüpfen. Woher Sie diese Daten bekommen und was beim Import geschieht, steht unter [Netz-Datensätze](../data/builtin_datasets#eigene-netze-importieren).</div>

  </TabItem>
  <TabItem value="Create" label="Layer erstellen" className="tabItemBox">

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Geben Sie einen <strong>Layer-Namen</strong> ein, wählen Sie den <strong>Geometrietyp</strong> (<code>Punkt</code>, <code>Linie</code>, <code>Polygon</code> oder <code>Tabelle</code>) und legen Sie die <strong>Felder</strong> fest. Ausführlich beschrieben in [Layer bearbeiten](./layer_editing).</div>
</div>

  </TabItem>
  <TabItem value="My datasets" label="Meine Datensätze" className="tabItemBox">

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Durchsuchen Sie Ihre Bereiche nach dem gewünschten Datensatz.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie einen oder mehrere aus und klicken Sie auf <code>Layer hinzufügen</code> (<code>3 Layer hinzufügen</code>, wenn Sie drei ausgewählt haben).</div>
</div>

  </TabItem>
  <TabItem value="Catalog" label="Katalog" className="tabItemBox">

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Durchsuchen und filtern Sie den [Katalog](../workspace/catalog) nach dem passenden Datensatz. Es stehen dieselben Filter wie auf der Katalog-Seite zur Verfügung.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie einen oder mehrere Datensätze aus und klicken Sie auf <code>Layer hinzufügen</code>. GOAT bereitet eine Kopie für Ihr Projekt vor; der Layer zeigt währenddessen <code>Daten werden vorbereitet …</code>.</div>
</div>

  </TabItem>
  <TabItem value="External" label="Dienst verbinden" className="tabItemBox">

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie links <code>OGC-Dienste</code>, um einen Webdienst über seine Adresse einzubinden, oder <code>OpenStreetMap</code> bzw. <code>Overture Maps</code>, um deren Features für ein Gebiet hinzuzufügen.</div>
</div>

<Tabs>
  <TabItem value="OGC" label="OGC-Dienste" default className="tabItemBox">

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Geben Sie die <code>URL</code> des Dienstes ein und folgen Sie den Schritten für die Art der Quelle, die Sie einbinden.</div>
</div>

<Tabs>
  <TabItem value="WFS" label="WFS" default className="tabItemBox">
    <div class="step">
      <div class="content"><p>Für einen WFS-Layer benötigen Sie einen <strong>GetCapabilities</strong>-Link.</p>Anschließend wählen Sie den gewünschten Layer. <strong>Es lässt sich jeweils nur ein Layer hinzufügen.</strong></div>
    </div>
  </TabItem>

  <TabItem value="WMS" label="WMS" className="tabItemBox">
    <div class="step">
      <div class="content"><p>Auch ein WMS-Layer benötigt einen <strong>GetCapabilities</strong>-Link.</p>Hier können Sie mehrere Layer auswählen, GOAT <strong>führt sie jedoch zu einem zusammen</strong>.</div>
    </div>
  </TabItem>

  <TabItem value="WMTS" label="WMTS" className="tabItemBox">
    <div class="step">
      <div class="content"><p>Ein WMTS lässt sich über eine <strong>direkte URL</strong> oder einen <strong>GetCapabilities</strong>-Link einbinden. Enthält die URL mehrere Layer, kann jeweils nur einer hinzugefügt werden.</p>Die Projektion muss <strong>Web Mercator (EPSG:3857)</strong> und GoogleMaps-kompatibel sein. Andernfalls unterscheiden sich die Zoomstufen, und die Quelle erscheint nicht in der Liste.</div>
    </div>
  </TabItem>

  <TabItem value="XYZ" label="XYZ" className="tabItemBox">
    <div class="step">
      <div class="content"><p>Ein <strong>XYZ-Kacheln</strong>-Layer ist jede Kachel-URL mit <code>&#123;z&#125;/&#123;x&#125;/&#123;y&#125;</code>-Platzhaltern. Die Adresse ist der Layer, es gibt also keine Layerliste zur Auswahl &mdash; prüfen Sie, ob die Vorschau zeigt, was Sie erwarten.</p></div>
    </div>
  </TabItem>

  <TabItem value="COG" label="COG" className="tabItemBox">
    <div class="step">
      <div class="content"><p>Ein <strong>Cloud Optimized GeoTIFF (COG)</strong> wird über einen direkten <code>.tif</code>/<code>.tiff</code>-Link eingebunden. Die Datei wird stückweise direkt von ihrem Speicherort gelesen, es wird nichts zu GOAT hochgeladen.</p></div>
    </div>
  </TabItem>
</Tabs>

  </TabItem>

  <TabItem value="OpenData" label="OpenStreetMap / Overture Maps" className="tabItemBox">

GOAT hält eine Kopie von [OpenStreetMap](https://www.openstreetmap.org) und [Overture Maps](https://overturemaps.org) vor und kopiert die gewählten Features in einen neuen Layer, den Sie anschließend gestalten, filtern und analysieren können. Der Layer ist eine Momentaufnahme: Spätere Änderungen an der Quelle erscheinen darin nicht.

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie, was Sie hinzufügen möchten. Bei OpenStreetMap sind das <code>Punkte</code>, <code>Linien</code> oder <code>Polygone</code>, bei Overture Maps eines der Themen, etwa <code>Orte</code>, <code>Gebäude</code> oder <code>Verwaltungsgebiete</code>. Ein Layer hat eine Geometrie; enthält ein Thema mehrere, wählen Sie eine unter <code>Feature-Typ</code>.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Legen Sie das <code>Gebiet</code> fest: den <code>Kartenausschnitt</code>, bei dem Sie die Karte verschieben und zoomen, bis der gestrichelte Rahmen das Gebiet zeigt, oder eine <code>Region</code>, einen <code>Punkt + Umkreis</code> oder ein <code>Polygon</code>, jeweils über <code>Wählen</code>. Hinzugefügt wird jedes Feature, das das Gebiet berührt, auch eines, das über seine Grenze hinausreicht.</div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content"><p>Um nur einen Teil der Features hinzuzufügen, klicken Sie unter <code>Tag-Filter</code> (OpenStreetMap) bzw. <code>Attributfilter</code> (Overture Maps) auf <code>Filter hinzufügen</code>. Wählen Sie ein <code>Tag</code> bzw. <code>Attribut</code> und einen oder mehrere <code>Werte</code>; ohne Werte bleibt jedes Feature, das das Tag hat. Die Listen zeigen, was im Gebiet vorkommt, und, sobald gezählt, wie viele Features. Bei mehreren Filtern wählen Sie, ob Features <code>alle</code> oder <code>eine</code> der Bedingungen erfüllen müssen. Die Info-Schaltfläche neben einem Filter öffnet die Bedeutung des Tags im OpenStreetMap-Wiki bzw. die Dokumentation von Overture Maps.</p>Für eine Bedingung, die der Baukasten nicht abbildet, wechseln Sie zu <code>SQL</code> und schreiben sie selbst, zum Beispiel <code>tags['amenity'] IN ('school', 'kindergarten')</code>.</div>
</div>

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Prüfen Sie den <code>Layername</code> und den Ort unter <code>Speichern in</code> und klicken Sie auf <code>Layer hinzufügen</code>. Der Layer erscheint, sobald der Job fertig ist.</div>
</div>

:::info

Ein Layer umfasst bis zu 1.000.000 Features. Liegen im Gebiet mehr, fordert GOAT Sie auf, <code>Werte für einen Filter oder ein kleineres Gebiet</code> zu wählen. Ein sehr großes Gebiet, etwa ein ganzes Land bei Gebäuden, wird auch mit Filtern abgelehnt: Zoomen Sie hinein oder wählen Sie ein kleineres Gebiet. <code>Layer hinzufügen</code> wartet, während GOAT die Größe des Gebiets prüft.

:::

Die Lizenz der Daten steht oben im Bereich: OpenStreetMap steht unter der ODbL, Overture Maps unter der ODbL, Orte unter CDLA-Permissive 2.0. Nennen Sie die Quelle, wenn Sie damit erstellte Karten weitergeben.

  </TabItem>
</Tabs>

  </TabItem>
</Tabs>

:::tip Tipp

Sie können alle Ihre Datensätze auf der [Inhalt-Seite](../workspace/content) verwalten. 

:::

### Layer-Reihenfolge

Bei der Visualisierung mehrerer Datensätze gleichzeitig ist die Layer-Reihenfolge entscheidend für die Erstellung klarer, lesbarer Karten. Daher <strong>kann die Layer-Reihenfolge interaktiv geändert werden</strong>.

Klicken Sie auf den Layer in der Layer-Liste und <strong>ziehen Sie ihn per Drag-and-drop</strong> an die gewünschte Position.


### Layer anzeigen / ausblenden

Klicken Sie auf das <img src={require('/img/icons/eye.png').default} alt="Layer anzeigen in GOAT" style={{ maxHeight: "flex", maxWidth: "flex", objectFit: "cover"}}/> Symbol neben dem Layer-Namen, um einen Layer vorübergehend aus der Kartenansicht <strong>auszublenden</strong>. Ein erneuter Klick auf das Auge macht den Layer <strong>wieder sichtbar</strong>.

### Layer gruppieren

Klicken Sie auf die <img src={require('/img/icons/layer.png').default} alt="Layer gruppieren" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code> Layer gruppieren</code> Schaltfläche oben im Layer Panel, um **Layer-Gruppen zu erstellen**, die dabei helfen, verwandte Datensätze zusammen zu organisieren.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf die <code>Layer gruppieren</code> Schaltfläche <img src={require('/img/icons/layer.png').default} alt="Layer gruppieren" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> oben im Layer Panel.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Geben Sie einen <strong>Namen für Ihre Layer-Gruppe</strong> in das erscheinende Dialogfeld ein.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Klicken Sie auf <code>Erstellen</code>, um <strong>die neue Layer-Gruppe zu erstellen</strong>.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content"><strong>Ziehen Sie Layer</strong> aus der Haupt-Layer-Liste in Ihre neu erstellte Gruppe, um sie zu organisieren.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Verwenden Sie den <strong>Aufklappen/Zuklappen-Pfeil</strong> neben dem Gruppennamen, um den Gruppeninhalt anzuzeigen oder zu verbergen.</div>
</div>

### Optionen

Durch Klicken auf das <code>weitere Optionen</code> <img src={require('/img/icons/3dots.png').default} alt="Optionen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> Symbol haben Sie weitere Optionen zur <strong>Verwaltung und Organisation</strong> des ausgewählten Layers.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<img src={require('/img/map/layers/layer_options_de.webp').default} alt="Layer-Optionen" style={{ maxHeight: "auto", maxWidth: "420px", objectFit: "cover", alignItems: 'center'}}/>
</div>

<p></p>

:::tip Tipp

Möchten Sie das Design Ihrer Layer ändern? Siehe [Layer-Styling](../category/style).  
Möchten Sie nur Teile Ihres Datensatzes visualisieren? Siehe [Filter](./filter). 

:::

### Features bearbeiten

Verwenden Sie <code>Features bearbeiten</code> aus dem <code>Weitere Optionen</code>-Menü des Layers, um Feature-Daten direkt auf der Karte zu aktualisieren.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Features bearbeiten</code> in den Layer-Optionen, um den <strong>Bearbeitungsmodus zu starten</strong>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf ein Feature auf der Karte, um dessen <strong>Attribute</strong> im rechten Panel zu öffnen.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Aktualisieren Sie die gewünschten Werte im Panel <code>Feature-Attribute</code>.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Klicken Sie auf <code>Fertig</code>, um die Feature-Bearbeitung zu bestätigen.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Klicken Sie auf <code>Speichern</code>, um alle ausstehenden Änderungen zu übernehmen, oder auf <code>Verwerfen</code>, um sie zu verwerfen.</div>
</div>

---
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

- **Datei hochladen**: ein Datensatz von Ihrem Gerät (GeoPackage, GeoJSON, Shapefile, KML, CSV, XLSX, Parquet sowie GTFS- und Overture-Archive)
- **Layer erstellen**: ein neuer, leerer Layer, in den Sie zeichnen
- **Dienst verbinden**: ein Layer, der über WFS, WMS, WMTS, XYZ-Kacheln oder COG bereitgestellt wird, per URL eingebunden

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
  <TabItem value="Upload" label="Datei hochladen" default className="tabItemBox">

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

<div class="content"><strong>Straßennetze und GTFS-Feeds:</strong> ein GTFS- oder Overture-Archiv wird als <a href="../data/dataset_types#datensätze-aus-mehreren-layern">Datenpaket</a> importiert, nicht als einzelner Layer. Bei einem ÖPNV-Feed werden Sie außerdem gebeten, ihn mit einem Straßennetz zu verknüpfen. Woher Sie diese Daten bekommen und was beim Import geschieht, steht unter <a href="../data/builtin_datasets#eigene-netze-importieren">Netz-Datensätze</a>.</div>

  </TabItem>
  <TabItem value="Create" label="Layer erstellen" className="tabItemBox">

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Geben Sie einen <strong>Layer-Namen</strong> ein, wählen Sie den <strong>Geometrietyp</strong> (<code>Punkt</code>, <code>Linie</code>, <code>Polygon</code> oder <code>Tabelle</code>) und legen Sie die <strong>Felder</strong> fest. Ausführlich beschrieben in <a href="./layer_editing">Layer bearbeiten</a>.</div>
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
  <div class="content">Durchsuchen und filtern Sie den <a href="../workspace/catalog">Katalog</a> nach dem passenden Datensatz. Es stehen dieselben Filter wie auf der Katalog-Seite zur Verfügung.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie einen oder mehrere Datensätze aus und klicken Sie auf <code>Layer hinzufügen</code>. GOAT bereitet eine Kopie für Ihr Projekt vor; der Layer zeigt währenddessen <code>Daten werden vorbereitet …</code>.</div>
</div>

  </TabItem>
  <TabItem value="External" label="Dienst verbinden" className="tabItemBox">

<div class="step">
  <div class="step-number">3</div>
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

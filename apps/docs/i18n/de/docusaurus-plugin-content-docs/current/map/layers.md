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

### Layer hinzufügen

Sie können Layer aus [verschiedenen Quellen](../data/dataset_types) zu Ihrer Karte hinzufügen. Sie können entweder:
- **Datensätze aus Ihrem Datensatz-Explorer oder dem Katalog-Explorer integrieren**
- Neue **Datensätze von Ihrem lokalen Gerät hochladen** (GeoPackage, GeoJSON, Shapefile, KML, CSV oder XLSX)
- Externe Layer durch Eingabe der **URL der externen Quelle** hinzufügen (WMS, WMTS oder MVT)

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/layers/add_layer.webp').default} alt="Layer in GOAT hinzufügen" style={{ maxHeight: "flex", maxWidth: "flex", objectFit: "cover"}}/>
</div>

<p></p>
<div class="step">
  <div class="step-number">1</div>
  <div class="content">Navigieren Sie zum <code>Layer</code>-Menü über die <strong>linke Seitenleiste</strong>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf <code>+ Layer hinzufügen</code>, um <strong>die Layer-Optionen zu öffnen</strong>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie aus, ob Sie einen Datensatz über folgende Optionen integrieren möchten: <code>Datensatz-Explorer</code>, <code>Datensatz-Upload</code>, <code>Externer Datensatz</code> oder <code>Datensatz-Katalog</code>, um <strong>Ihre Datenquelle zu wählen</strong>.</div>
</div>

<Tabs>
  <TabItem value="Dataset Explorer" label="Datensatz-Explorer" default className="tabItemBox">


<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie die Datei aus, die Sie <strong>importieren</strong> möchten.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Klicken Sie auf <code>+ Layer hinzufügen</code>, um <strong>die ausgewählte Datei hinzuzufügen</strong>.</div>
</div>


</TabItem>
<TabItem value="Dataset Upload" label="Datensatz-Upload" className="tabItemBox">


<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie die Datei aus, die Sie **importieren** möchten.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Definieren Sie den Namen des Datensatzes und <strong>fügen Sie eine Beschreibung hinzu</strong>, wenn Sie möchten.</div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Überprüfen Sie die Informationen und klicken Sie auf <code>Hochladen</code>, um <strong>den Datensatz hochzuladen</strong>.</div>
</div>


  </TabItem>
  <TabItem value="Catalog Explorer" label="Katalog-Explorer" className="tabItemBox">

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Durchsuchen Sie den <code>GOAT Datensatz-Katalog</code>, um <strong>verfügbare Datensätze zu erkunden</strong>.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Wählen Sie den Datensatz aus, den Sie <strong>importieren</strong> möchten.</div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Klicken Sie auf <code>+ Layer hinzufügen</code>, um <strong>den ausgewählten Datensatz hinzuzufügen</strong>.</div>
</div>


 </TabItem>
  <TabItem value="Dataset External" label="Externer Datensatz" default className="tabItemBox">
  
<div class="step">
  <div class="step-number">4</div>
  <div class="content">Geben Sie Ihre <code>externe URL</code> ein und <strong>folgen Sie den Schritten</strong> abhängig vom Typ des Datensatzes, den Sie hinzufügen möchten.</div>
</div>

<Tabs>
  <TabItem value="WFS" label="WFS" default className="tabItemBox">

  <div class="step">
      <div class="content"> <p>Wenn Sie einen WFS-Layer hinzufügen möchten, benötigen Sie einen <strong>GetCapabilities</strong>-Link. </p>
      Im nächsten Schritt können Sie wählen, welchen Layer Sie zu Ihrem Datensatz hinzufügen möchten. <strong>Sie können nur einen Layer zur Zeit auswählen.</strong></div>
      </div>
     </TabItem>

  <TabItem value="WMS" label="WMS" className="tabItemBox">
     
  <div class="step">
      <div class="content"> <p>Wenn Sie einen WMS-Layer hinzufügen möchten, benötigen Sie einen <strong>GetCapabilities</strong>-Link.</p> Hier haben Sie die Option, mehrere Layer auszuwählen, aber wenn sie zu GOAT hinzugefügt werden, <strong>werden sie zu einem Layer zusammengeführt.</strong> </div>
      </div>
      </TabItem>

  <TabItem value="WMTS" label="WMTS" className="tabItemBox">

  <div class="step">
      <div class="content"> <p>Sie können einen WMTS zu Ihrem Datensatz über eine <strong>direkte URL</strong> oder einen <strong>GetCapabilities</strong>-Link hinzufügen. Sie können nur <strong>einen Layer</strong> zur Zeit auswählen, wenn Ihre URL mehr als einen Layer enthält.</p>
      Die Projektion muss <strong>Web Mercator (EPSG:3857) und GoogleMaps-kompatibel</strong> sein. Da sie verschiedene Zoomstufen haben, würde der Datensatz nicht in der Liste der verfügbaren Layer erscheinen, wenn er nicht beide Anforderungen erfüllt.</div>
      </div>
    </TabItem>
  </Tabs>
</TabItem>
</Tabs>


:::tip Tipp

Sie können alle Ihre Datensätze auf der [Datensätze-Seite](../workspace/datasets) verwalten. 

:::

### Layer organisieren

Sobald Sie einen Datensatz zur Karte hinzugefügt haben, wird er in der **Layer-Liste** sichtbar. Von dort aus können Sie die verschiedenen Layer organisieren.


#### Layer-Reihenfolge

Bei der Visualisierung mehrerer Datensätze gleichzeitig ist die Layer-Reihenfolge entscheidend für die Erstellung klarer, lesbarer Karten. Daher <strong>kann die Layer-Reihenfolge interaktiv geändert werden</strong>.

Fahren Sie mit der Maus über den <strong>linken Rand</strong> des Layers in der Layer-Liste, bis ein Pfeilsymbol erscheint, dann <strong>ziehen und lassen Sie los, um</strong> den Layer an die gewünschte Position zu verschieben.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/map/layers/layer_order.gif').default} alt="Layer-Reihenfolge" style={{ maxHeight: "flex", maxWidth: "flex", objectFit: "cover"}}/>
</div> 


#### Layer anzeigen / ausblenden

Klicken Sie auf das <img src={require('/img/icons/eye.png').default} alt="Layer anzeigen in GOAT" style={{ maxHeight: "flex", maxWidth: "flex", objectFit: "cover"}}/> Symbol neben dem Layer-Namen, um einen Layer vorübergehend aus der Kartenansicht <strong>auszublenden</strong>. Ein erneuter Klick auf das Auge macht den Layer <strong>wieder sichtbar</strong>.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/map/layers/hide_layers.gif').default} alt="Layer ausblenden" style={{ maxHeight: "flex", maxWidth: "flex", objectFit: "cover"}}/>
</div> 

#### Layer gruppieren

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

Layer-Gruppen ermöglichen es Ihnen:
- **Verwandte Layer** in logische Sammlungen zu organisieren
- **Ganze Gruppen auf- oder zuzuklappen** für bessere Arbeitsbereich-Verwaltung
- **Gruppenebenen-Operationen** wie das Anzeigen/Verbergen aller Layer in einer Gruppe anzuwenden
- **Visuelle Hierarchie** in komplexen Projekten mit vielen Layern zu erhalten


#### Optionen

Durch Klicken auf das <code>weitere Optionen</code> <img src={require('/img/icons/3dots.png').default} alt="Optionen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> Symbol haben Sie weitere Optionen zur <strong>Verwaltung und Organisation</strong> des ausgewählten Layers.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<img src={require('/img/map/layers/layer_options.webp').default} alt="Layer-Optionen" style={{ maxHeight: "250px", maxWidth: "250px", objectFit: "cover", alignItems: 'center'}}/>
</div>

<p></p>


:::tip Tipp

Möchten Sie das Design Ihrer Layer ändern? Siehe [Layer-Styling](../category/style).  
Möchten Sie nur Teile Ihres Datensatzes visualisieren? Siehe [Filter](./filter). 

:::

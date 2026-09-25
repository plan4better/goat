---
sidebar_position: 3
---

# Inhalt

Auf der Seite **Inhalt** liegen Ihre Projekte, Datensätze und Vorlagen. Alles, worauf Sie zugreifen können, ist in **Bereiche** gegliedert: Ihren eigenen, die Ihrer Teams und den Ihrer Organisation. Inhalte gehören damit zu einem Bereich und nicht zu einer Person, und sie bleiben dort, wenn jemand hinzukommt oder das Team verlässt.

Auf der Seite Inhalt können Sie:

- **Alles in einem Bereich durchsuchen**, in Ordnern, die Sie selbst anlegen
- **Sehen, was andere mit Ihnen geteilt haben**, und was Sie zuletzt geöffnet haben
- **Teilen, verschieben, umbenennen, übertragen oder löschen**, wofür Sie verantwortlich sind
- **Wiederherstellen**, was Sie versehentlich gelöscht haben

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workspace/content/content_general_de.webp').default} alt="Die Seite Inhalt in GOAT" style={{ maxHeight: "auto", maxWidth: "100%"}}/>
</div>

## Bereiche

Es gibt drei Arten von Bereichen:

- **Meine Inhalte** gehören Ihnen. Was Sie erstellen, landet hier, sofern Sie es nicht woanders ablegen.
- **Team-Bereiche**, einer je Team, dem Sie angehören. Alle im Team können auf die Inhalte zugreifen.
- **Organisation**, freigegeben für alle in Ihrer Organisation.

Drei weitere Ansichten durchsuchen alle Bereiche zugleich, sodass Sie nicht wissen müssen, wo etwas liegt: **Mit mir geteilt** für alles, wozu andere Ihnen Zugriff gegeben haben, **Zuletzt bearbeitet** für das, was Sie zuletzt geöffnet haben, und **Papierkorb** für Gelöschtes, das sich noch zurückholen lässt.

Wenn Sie einen Bereich öffnen, sehen Sie seine Inhalte nach Art gruppiert: **Ordner**, **Projekte**, **Vorlagen** und **Datensätze**. Jede Gruppe zeigt eine Anzahl und lässt sich einklappen, eine leere Gruppe wird weggelassen, und mit `Mehr laden` holen Sie den Rest einer langen Gruppe.

Eine fünfte Gruppe, **Verknüpfungen**, erscheint erst, wenn etwas aus dem Bereich übertragen wurde. Siehe [Teilen und Übertragen](#teilen-und-übertragen-sind-zweierlei).

## Sich zurechtfinden

Die Werkzeugleiste über den Inhalten bietet:

- **Suche** innerhalb des Bereichs, in dem Sie sich befinden
- Ansicht als **Kacheln** oder **Liste**
- **Filtern** nach Inhaltstyp
- **Sortieren**, etwa nach `Zuletzt aktualisiert`
- **Einzelheiten**, öffnet eine Leiste mit Angaben zum ausgewählten Element
- **Neu**, um ein Projekt anzulegen, einen Datensatz hochzuladen oder einen Ordner hinzuzufügen

## Inhalte verwalten

Wählen Sie ein Element aus, oder mehrere, um damit zu arbeiten. Das Menü auf einer Karte und die Aktionsleiste bieten:

| Aktion | Was sie bewirkt |
|--------|-----------------|
| **Teilen** | Gibt anderen Zugriff. Sie bleiben Besitzer. |
| **Verschieben** | Legt das Element in einen anderen Ordner. |
| **Umbenennen** | Ändert den Namen. |
| **Rechte übertragen** | Übergibt das Element dauerhaft an jemand anderen. |
| **Löschen** | Verschiebt es in den Papierkorb. |

### Teilen und Übertragen sind zweierlei

**Teilen** gewährt Zugriff, während Sie Besitzer bleiben. Das ist sinnvoll, wenn Kolleginnen und Kollegen etwas sehen oder bearbeiten sollen, das weiterhin in Ihrer Verantwortung liegt.

**Rechte übertragen** verschiebt das Element dauerhaft in den Bereich einer anderen Person. Das ist der richtige Weg, wenn ein Projekt tatsächlich den Besitzer wechselt, etwa bei einer Übergabe vor dem Wechsel aus einem Team.

Im Ursprungsbereich bleibt eine **Verknüpfung** zurück, als solche gekennzeichnet und mit dem echten Namen des Elements. Sie ist ein Verweis: Ein Klick darauf führt Sie zum Element an seinem neuen Ort.

:::info Wer was sehen kann
Ein Element zeigt seine **Sichtbarkeit**: privat, mit einzelnen Personen geteilt, mit einem Team oder der Organisation geteilt, oder öffentlich. Ordner und Datenpakete können mit Teams und der Organisation geteilt werden.
:::

### Papierkorb und Wiederherstellen

Gelöschte Inhalte verschwinden nicht sofort: Sie landen im **Papierkorb**, aus dem der Besitzer sie **Wiederherstellen** kann. Sie bleiben dort, bis sie endgültig entfernt werden. Ein versehentliches Löschen lässt sich also rückgängig machen.

## Inhalte hinzufügen

`Neu` auf der Seite Inhalt bietet:

- **Neuer Ordner**, um Inhalte so zu gruppieren, wie es Ihnen passt
- **Leeres Projekt** oder **Projekt importieren**
- **Datensatz**, um eine Datei von Ihrem Gerät hochzuladen (GeoPackage, GeoJSON, Shapefile, KML, CSV, XLSX, Parquet sowie GTFS- und Overture-Archive)
- **Dienst verbinden**, um einen externen Layer per URL hinzuzufügen (WFS, WMS, WMTS, XYZ-Kacheln oder COG)
- **Dokument hochladen**, für eine Datei, die zur Arbeit gehört, ohne selbst Daten zu sein

Ein Projekt lässt sich auch von der Startseite aus beginnen.

### Ein Projekt erstellen

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Öffnen Sie über die Seitenleiste die Seite <code>Inhalt</code> und wechseln Sie in den Ordner, in dem das Projekt liegen soll.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf <code>Neu</code> und wählen Sie <code>Leeres Projekt</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Geben Sie dem Projekt einen Namen und klicken Sie auf <code>Projekt erstellen</code>. Es wird in dem Ordner angelegt, den Sie gerade geöffnet haben, und öffnet sich direkt.</div>
</div>

Um eine **Beschreibung** oder **Tags** hinzuzufügen oder das Projekt später umzubenennen, öffnen Sie dessen Menü `Weitere Optionen` und wählen `Metadaten bearbeiten`. Um es in einen anderen Ordner zu legen, verwenden Sie `Verschieben` aus demselben Menü.

### Ein Projekt importieren

Sie können ein Projekt importieren, das aus GOAT als `.zip`-Datei exportiert wurde.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Neu</code> und wählen Sie <code>Projekt importieren</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Wählen Sie die <code>.zip</code>-Datei aus.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Geben Sie bei Bedarf einen <code>Projektnamen</code> ein, oder lassen Sie das Feld leer, um den exportierten Namen beizubehalten. Wählen Sie unter <code>Ziel</code> den Bereich und den <code>Ordner</code>.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Klicken Sie auf <code>Importieren</code>. Der Import läuft im Hintergrund; den Fortschritt sehen Sie im Job-Menü.</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workspace/projects/project_import_de.webp').default} alt="Ein Projekt in GOAT importieren" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "cover"}}/>
</div>

### Einen Datensatz hochladen

GOAT unterstützt mehrere Dateiformate zum Hochladen: **GeoPackage**, **GeoJSON**, **Shapefile**, **KML**, **CSV**, **XLSX**, **ZIP**, **Parquet** und **COG**-Dateien sowie **GTFS**-Archive (`gtfs.zip`) für [ÖPNV-Netze](../data/dataset_types.md#öpnv-netze) und **Overture**-Archive (`overture.zip`) für [Straßennetze](../data/dataset_types.md#straßennetze).

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Öffnen Sie über die Seitenleiste die Seite <code>Inhalt</code> und wechseln Sie in den Ordner, in dem der Datensatz liegen soll.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf <code>Neu</code> und wählen Sie <code>Datensatz</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Ziehen Sie eine Datei auf die Ablagefläche oder klicken Sie, um eine auszuwählen. Die unterstützten Formate stehen darüber.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Die Datei erscheint als Zeile. Ihr <code>Layer-Name</code> ist zunächst der Dateiname und lässt sich dort ändern. Über die Ordner-Schaltfläche ändern Sie, wo der Datensatz gespeichert wird, und mit <code>Beschreibung hinzufügen</code> beschreiben Sie ihn.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content"><strong>Nur für CSV- und XLSX-Dateien:</strong> Klicken Sie auf <code>Spalten einrichten</code>, um eine Vorschau der ersten Zeilen zu prüfen.
    <ul>
      <li><code>Arbeitsblatt</code>: Bei XLSX-Dateien mit mehreren Blättern wählen Sie aus, welches Blatt importiert werden soll.</li>
      <li><code>Erste Zeile ist Kopfzeile</code>: standardmäßig aktiviert. Deaktivieren Sie die Option, wenn die erste Zeile Daten enthält; die Spaltennamen werden dann erzeugt und können später in den Layer-Einstellungen umbenannt werden.</li>
    </ul>
    Klicken Sie auf <code>Bestätigen</code>, um zur Datei zurückzukehren.
  </div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Klicken Sie auf <code>Hochladen</code>.</div>
</div>

### Eine externe Quelle verbinden

Ein Dienst, der die Daten bereits veröffentlicht, etwa ein **Web Feature Service (WFS)**, **Web Map Service (WMS)**, **Web Map Tile Service (WMTS)**, **XYZ-Kacheln** oder ein **Cloud Optimized GeoTIFF (COG)**, wird mit `Dienst verbinden` hinzugefügt. Klicken Sie auf dieser Seite auf `Neu` und wählen Sie `Dienst verbinden`, um ihn zum aktuellen Ordner hinzuzufügen. Innerhalb eines Projekts erreichen Sie die Funktion außerdem über `+ Layer hinzufügen` in der Karte. Die Schritte finden Sie unter [Layer hinzufügen](../map/layers#layer-hinzufügen).

Nach dem Hinzufügen erscheint ein verbundener Layer auf dieser Seite wie jeder andere Datensatz, mit zwei Unterschieden, die die Herkunft der Daten kennzeichnen:

- Ein **`Verbunden`**-Tag bedeutet, dass der Layer **live vom externen Dienst gezeichnet** wird und nicht in GOAT gespeichert ist. Sein Inhalt kann sich ändern oder verschwinden, wenn sich der Dienst ändert.
- Eine **Quellenzeile** zeigt Format und Host an, zum Beispiel `WMS, verbunden mit wms.nrw.de`. Ein **WFS**-Layer wird stattdessen als Kopie in GOAT importiert und zeigt `Aus WFS importiert (wfs.nrw.de)`.

## Mit einem Datensatz arbeiten

### Datensatz-Metadaten und Vorschau

Klicken Sie auf den Namen eines Datensatzes, um ihn zu öffnen. Der Reiter `Zusammenfassung` beschreibt ihn und führt auf, was der Datengeber hinterlegt hat. Wenn der Datensatz Zeilen zum Anzeigen hat, enthält ein Reiter `Daten` eine Auswahl davon sowie die Spalten und ihre Typen.

Um Name oder Beschreibung eines Datensatzes zu ändern oder Tags hinzuzufügen, öffnen Sie dessen Menü `Weitere Optionen` und wählen `Metadaten bearbeiten`.

### Einen Datensatz herunterladen

Beim Herunterladen eines räumlichen Datensatzes können Sie im Dialog Folgendes auswählen:

- **Download-Typ**: das Exportdateiformat (z. B. GeoPackage, GeoJSON, Shapefile).
- **Koordinatenreferenzsystem**: das KRS, in das die Daten vor dem Download umprojiziert werden. GOAT schlägt automatisch KRS-Optionen basierend auf der geografischen Ausdehnung des Datensatzes vor: Globale Optionen (WGS 84, Web Mercator) sind immer verfügbar, zusätzlich die passende UTM-Zone sowie relevante nationale oder regionale KRS. Der Standardwert ist **WGS 84 (EPSG:4326)**.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workspace/datasets/managing_datasets_de.webp').default} alt="Datensatz-Verwaltungsoptionen" style={{ maxHeight: "auto", maxWidth: "100%"}}/>
</div>

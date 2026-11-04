---
description: "Filtern Sie den Katalog nach Stichwort, Ort, Kategorie, Datengeber oder Lizenz, speichern Sie Favoriten und fügen Sie Katalog-Datensätze einem Projekt hinzu."
sidebar_position: 4
---

# Katalog

Der **Daten-Katalog** ist Ihr Zugang zur Erkundung von Plan4Betters umfassender Sammlung hochwertiger [Geodaten](https://www.plan4better.de/de/glossar/geodaten). **Diese kuratierte Bibliothek bietet zuverlässige, sofort einsatzfähige Daten von offiziellen Open-Data-Anbietern und anderen vertrauenswürdigen Quellen**, die es Ihnen ermöglichen, sofort mit der Analyse und Visualisierung in Ihren GOAT-**Projekten** zu beginnen. Aus dem **Katalog** können Sie:

- **Unsere Datensatz-Sammlung erkunden**, die mehrere thematische Bereiche und geografische Regionen umfasst
- **Durchsuchen und filtern** nach Stichwort, Ort, Kategorie, Datengeber, Lizenz und mehr
- **Häufig genutzte Datensätze speichern** und direkt zu einem Projekt hinzufügen

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workspace/catalog/catalog_general_de.webp').default} alt="Daten-Katalog" style={{ maxHeight: "auto", maxWidth: "100%"}}/>
</div>

## Einen Datensatz finden

Öffnen Sie den **Katalog** über die Seitenleiste oder aus einem Projekt heraus über `+ Layer hinzufügen`. Die Seite listet alle Datensätze des Katalogs auf. Suche, Filter und Sortierung schränken diese Liste ein, und wenn Sie den Link der Seite kopieren, teilen Sie das Ergebnis. Wer ihn öffnet, sieht dieselben Datensätze wie Sie.

### Suche

Tippen Sie in das Suchfeld, um Titel, Beschreibung und Schlagwörter eines Datensatzes zu durchsuchen.

Gesucht wird nach ganzen oder Teilwörtern, Groß- und Kleinschreibung spielt keine Rolle: `grünfläche` findet *Grünflächen*. Umgekehrt gilt das nicht. Ein längeres Wort als das in den Daten findet nichts. Wählen Sie daher den kürzeren Wortstamm, wenn eine Suche leer bleibt.

### Filter

Die Seitenleiste schränkt die Liste ein, in dieser Reihenfolge:

- **Meine Favoriten anzeigen**: nur die Datensätze, die Sie mit einem Stern gespeichert haben
- **Ort**: `Räumlichen Filter setzen` schränkt den Katalog auf Datensätze ein, die ein Gebiet abdecken, beschrieben auf [drei Wegen](#raeumlicher-filter)
- **Kategorie**: das Thema des Datensatzes, etwa Verkehr, Umwelt, Bevölkerung oder Landnutzung. Die Seitenleiste zeigt alle Kategorien, die der Katalog derzeit enthält
- **Datenart**: ob der Datensatz ein Feature-Layer, eine Tabelle, ein Raster oder ein Datenpaket ist
- **Geometrie**: welche Art von Form seine Objekte haben
- **Datengeber**: wer den Datensatz bereitstellt
- **Lizenz**: zu welchen Bedingungen er veröffentlicht ist
- **Sprache**: die Sprache der Metadaten
- **Zeitraum**: ein `Von`- und `Bis`-Datum, um Daten zu einem bestimmten Zeitraum zu finden

Jeder Abschnitt zeigt die Werte, die der Katalog tatsächlich enthält, die häufigsten zuerst, mit einer Anzahl daneben. Die Zahlen passen sich an, während Sie einschränken, und ein Wert, der auf nichts mehr zutrifft, bleibt ausgegraut mit der Anzahl 0 in der Liste. Gesetzte Filter erscheinen als Chips über den Ergebnissen, sodass Sie einzelne entfernen können, ohne die Seitenleiste zu öffnen. `Zurücksetzen` im Kopf der Seitenleiste entfernt alle.

### Nach Ort filtern {#raeumlicher-filter}

`Räumlichen Filter setzen` schränkt den Katalog auf Datensätze ein, die ein bestimmtes Gebiet abdecken. Dafür gibt es drei Wege:

- **Region**: nach Land, Bundesland oder Bezirk suchen. Mehrere lassen sich kombinieren; ein Datensatz passt, sobald er eine davon abdeckt.
- **Puffer**: auf die Karte klicken, um einen Punkt zu setzen, dann einen Radius festlegen
- **Polygon**: auf die Karte klicken, um die Eckpunkte eines Gebiets zu zeichnen

Die Ergebnisse werden danach sortiert, wie viel eines Datensatzes in Ihrem Gebiet liegt. Datensätze, die es am besten abdecken, stehen oben.

:::tip Regionen in ihrer eigenen Sprache suchen
Die Regionen stammen aus der [NUTS-Klassifikation](https://ec.europa.eu/eurostat/web/nuts) von Eurostat, die jede Region so benennt, wie das Land selbst es tut. `Germany` findet nichts, `Deutschland` schon. Ebenso `Italia` statt Italien und `München` statt Munich.

Tippen Sie die ersten Buchstaben und wählen Sie aus den Vorschlägen; das geht meist schneller, als den Namen vorher zu kennen. Eurostat veröffentlicht außerdem die vollständigen [Korrespondenztabellen](https://ec.europa.eu/eurostat/web/nuts/correspondence-tables), falls Sie eine Region nachschlagen möchten.
:::

### Sortierung und Ansichten

Sortieren Sie nach **Relevanz**, **Zuletzt aktualisiert** oder Titel **A–Z** / **Z–A**, und wechseln Sie zwischen **Liste** und **Kacheln**. Die Relevanz stellt Datensätze mit deutschen Metadaten nach vorn, da der Katalog überwiegend deutschsprachig ist.

### Häufig genutzte Datensätze speichern

Mit dem <img src={require('/img/icons/star.png').default} alt="Star" style={{ maxHeight: "16px", maxWidth: "16px", verticalAlign: "middle"}}/> auf einer Datensatz-Karte speichern Sie einen Datensatz. `Meine Favoriten anzeigen` schränkt den Katalog dann auf Ihre gespeicherten Datensätze ein. Diese bleiben über Sitzungen hinweg erhalten und stehen auch in der `+ Layer hinzufügen`-Auswahl im Projekt zur Verfügung.

## Was eine Datensatz-Seite zeigt

Klicken Sie auf einen Datensatz, um ihn zu öffnen. Der Reiter **Zusammenfassung** zeigt die Beschreibung des Datengebers und daneben eine Leiste mit dem, was er zum Datensatz hinterlegt hat:

- **Typ**, bei einem Feature-Datensatz zusätzlich **Geometrietyp**. Bei einem Datenpaket steht dort, wie viele Layer es enthält.
- **Kategorie**
- **Region**, die der Datensatz abdeckt
- **Sprache** seiner Metadaten
- **Lizenz**, mit Link zu den Bedingungen an der Quelle, sofern der Datengeber einen angibt
- Aus welcher Zeit die Daten stammen. Je nach Datensatz steht dort **Referenzjahr** für ein einzelnes Jahr oder **Zeitraum** für eine Spanne.
- **Zuletzt aktualisiert**
- **Datengeber**, mit Kontaktdaten und einem Link zu seinen eigenen Metadaten, sofern vorhanden

Wenn der Datensatz Zeilen zum Anzeigen hat, enthält ein Reiter **Daten** eine Auswahl davon sowie die Spalten und ihre Typen.

Ein Datensatz aus mehreren Layern ist als `Datenpaket` gekennzeichnet und listet die **Layer in diesem Datenpaket**. Öffnen Sie einen davon, sehen Sie, zu welchem Datenpaket er gehört. Siehe [Datensatz-Typen](../data/dataset_types.md#datensätze-aus-mehreren-layern).

## Katalog-Daten zu einem Projekt hinzufügen

Datensätze werden aus einem Projekt heraus hinzugefügt, der Dialog `+ Layer hinzufügen` ist also der Ort dafür. Die Katalog-Seite für sich dient dem Finden und Speichern von Datensätzen; ihre Schaltfläche `Zum Projekt hinzufügen` (`Alle zum Projekt hinzufügen` bei einem Datenpaket) ist noch nicht aktiv.


<div class="step">
  <div class="step-number">1</div>
  <div class="content">Öffnen Sie in Ihrem Projekt den Reiter <strong>Layer</strong> und klicken Sie auf <code>+ Layer hinzufügen</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Wählen Sie <code>Katalog</code>, um dieselben Datensätze mit derselben Suche und denselben Filtern zu durchsuchen.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie einen oder mehrere Datensätze aus und klicken Sie auf <code>Layer hinzufügen</code> (<code>3 Layer hinzufügen</code>, wenn Sie drei ausgewählt haben).</div>
</div>

<p></p>

Wird ein Katalog-Datensatz zum ersten Mal hinzugefügt, bereitet GOAT eine Kopie davon für Ihr Projekt vor. Der Layer zeigt währenddessen `Daten werden vorbereitet …` und steht zur Verfügung, sobald das abgeschlossen ist.

:::info Katalog-Layer sind schreibgeschützt
Ein aus dem Katalog hinzugefügter Layer ist mit `Katalog · schreibgeschützt` gekennzeichnet. Sie können ihn wie jeden anderen Layer gestalten, filtern, analysieren und herunterladen, seine Zeilen und Spalten lassen sich jedoch nicht bearbeiten, denn die Daten gehören dem Datengeber und bleiben so, wie er sie veröffentlicht hat.
:::

Sobald eine neuere Fassung eines Datensatzes veröffentlicht ist, zeigt ein Layer in Ihrem Projekt `Aktualisierung im Katalog verfügbar`. So entscheiden Sie selbst, wann Sie die neuen Daten übernehmen.

:::tip Hinweis
Nach dem Hinzufügen des Layers können Sie [Filter](../map/filter.md "Datensatz filtern") anwenden, um große Datensätze auf die für Ihre Analyse benötigten Gebiete oder Attribute einzuschränken.
:::

## Was der Katalog enthält

Der Katalog vereint zwei Arten von Daten: offene Daten aus öffentlichen Portalen und Datensätze, die Plan4Better selbst aufbereitet.

### Offene Daten aus öffentlichen Portalen

Öffentliche Verwaltungen veröffentlichen große Mengen an Geodaten in Open-Data-Portalen. Sie zu nutzen bedeutet sonst: das richtige Portal kennen, die Metadaten lesen, eine Datei herunterladen und sie konvertieren, bevor überhaupt eine Analyse beginnen kann. GOAT erntet diese Portale, sodass die Daten direkt nutzbar sind. Sie stammen unter anderem aus:

- [GovData](https://www.govdata.de/)
- [data.gv.at](https://www.data.gv.at/)
- [geocat.ch](https://www.geocat.ch/)
- [data.europa.eu](https://data.europa.eu/)

Diese Portale enthalten weit mehr, als die Raumplanung benötigt, etwa Haushaltstabellen, Rechtstexte und historische Karten. Eine KI-gestützte Pipeline liest daher jeden veröffentlichten Datensatz und wählt diejenigen aus, die eine planerische Frage beantworten. Nur diese werden heruntergeladen, konvertiert und im Katalog veröffentlicht.

### Datensätze von Plan4Better

Neben den geernteten Portalen enthält der Katalog Datensätze, die Plan4Better selbst aufbereitet und pflegt. [Points of Interest](https://www.plan4better.de/de/glossar/point-of-interest) entstehen aus OpenStreetMap über eine Pipeline, die die Rohdaten-Tags in planerische Kategorien überführt und korrigiert. Haltestellen, Bahnhöfe und Linien des öffentlichen Verkehrs werden aus den [GTFS](https://www.plan4better.de/de/glossar/gtfs)-Feeds der Verkehrsunternehmen abgeleitet, für den Nah-, Regional- und Fernverkehr.

## Datenqualität und Pflege

**Auswahl der Quellen.** Wir ernten offizielle Open-Data-Portale und weitere öffentliche Initiativen.

**Auswahl nach Relevanz.** Eine KI-gestützte Pipeline liest jeden veröffentlichten Datensatz und behält nur die, die eine planerische Frage beantworten.

**Vereinheitlichung der Formate.** Verschiedene Formate wie Shapefile und GeoJSON werden in einheitliche Schemata überführt.

:::info Was wir nicht verändern
Die Werte selbst werden nicht bereinigt, ergänzt oder korrigiert. Geerntete Daten erreichen Sie genau so, wie ihr Herausgeber sie veröffentlicht hat. Für ihre Richtigkeit und Vollständigkeit steht damit der Herausgeber ein. Datensätze, die Plan4Better aufbereitet, folgen unseren eigenen Qualitätsstandards; diese können auf Anfrage eingesehen werden.
:::

**Laufender Ausbau.** Wir suchen und integrieren fortlaufend weitere Datensätze auf Grundlage der Anforderungen unserer Nutzerinnen und Nutzer. Wichtige Datensätze können auf Anfrage aktualisiert oder ergänzt werden.

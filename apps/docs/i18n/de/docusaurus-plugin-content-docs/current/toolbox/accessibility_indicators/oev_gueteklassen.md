---
description: "Klassifizieren Sie die ÖV-Qualität von A bis F mit Puffern um Haltestellen, nach GTFS-Abfahrtsfrequenz und Stationstyp, für beliebige Tage und Uhrzeiten."
sidebar_position: 7
---


# ÖV-Güteklassen

Der ÖV-Güteklassen Indikator **klassifiziert die Qualität der öffentlichen Verkehrsdienste in einem bestimmten Gebiet** und hilft Planern und Interessengruppen dabei, gut versorgte und [unterversorgte Standorte](https://www.plan4better.de/de/glossar/defizitgebiet) schnell zu identifizieren.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="https://www.youtube.com/embed/hX0Lau9-slg?si=jBL2tJB2QLp83qAZ&amp;start=46" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

## 1. Erklärung

ÖV-Güteklassen (Qualitätsklassen öffentlicher Verkehrsmittel) bieten eine standardisierte Methode zur **Bewertung und Visualisierung der Attraktivität öffentlicher Verkehrsdienste**. Die Klassen reichen von **A** (sehr gut) bis **F** (sehr schlecht) und basieren auf der Servicefrequenz, dem Stationstyp und der räumlichen Abdeckung.

Der ÖV-Güteklassen-Indikator ist entscheidend und kann verwendet werden, um Defizite im öffentlichen Verkehrsangebot hervorzuheben und gut versorgte Standorte als attraktive Entwicklungsgebiete zu identifizieren.

:::info

Die Berechnung der ÖV-Güteklassen ist für Gebiete verfügbar, in denen [GTFS-Daten](https://www.plan4better.de/de/glossar/gtfs) des öffentlichen Verkehrs in GOAT integriert sind. Derzeit unterstützte Regionen umfassen **Deutschland, die Schweiz und die Region Haut-Rhin in Frankreich**. Wenn Sie Analysen außerhalb dieser Regionen benötigen, können Sie [ein eigenes ÖPNV-Netz importieren](../../data/builtin_datasets.md#eigenes-öpnv-netz) oder uns gerne [kontaktieren](https://plan4better.de/de/contact/), damit wir das für Sie übernehmen.

:::

## 2. Anwendungsbeispiele

- Wie gut ist das Angebot an öffentlichen Verkehrsmitteln in verschiedenen Teilen der Stadt?
- Wie viele Menschen sind unterversorgt mit öffentlichen Verkehrsmitteln? Wo besteht Bedarf an weiteren Angeboten?
- Wie unterscheidet sich die Qualität der öffentlichen Verkehrsmittel zu verschiedenen Zeiten der Woche und des Tages?

## 3. Wie wird der Indikator verwendet?

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Werkzeuge</code> <img src={require('/img/icons/toolbox.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>. </div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Unter <code>Erreichbarkeitsindikatoren</code> wählen Sie <code>ÖV-Güteklassen</code>, um das Einstellungsmenü zu öffnen.</div>
</div>

### Berechnungszeit

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Setzen Sie <code>Tag</code>, <code>Startzeit</code> und <code>Endzeit</code> für Ihre Analyse.</div>
</div>

### Konfiguration

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wählen Sie den <code>Einzugsgebietstyp</code>: <b>Buffer</b>.</div>
</div>

:::info

**Buffer** stellen Bereiche rund um öffentliche Verkehrsstationen dar, gemessen in Luftlinie.

:::

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Wählen Sie das <code>Referenzgebiet</code>: einen Polygon-Layer, der das Untersuchungsgebiet definiert.</div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Optional: Klicken Sie auf <code>Haltestellenkonfiguration</code>, um zu ändern, wie Haltestellen klassifiziert werden. Der Dialog geht von einem vorgefertigten Profil aus und lässt Sie die Taktgrenzen, die Verkehrsmittelgruppen, die Haltestellenkategorien und die Güteklasse je Pufferabstand anpassen. Klicken Sie auf <code>Anwenden</code>, um Ihre Änderungen zu übernehmen. Siehe <a href="#haltestellenkonfiguration">Haltestellenkonfiguration</a> für die Bedeutung der einzelnen Einstellungen.</div>
</div>

### Ergebnis-Layer

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Legen Sie den <code>Name des Ergebnis-Layers</code> für den Ausgabe-ÖV-Güteklassen-Layer fest.</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Legen Sie den <code>Name des Stationen-Layers</code> für den Ausgabe-Stationen-Layer fest.</div>
</div>

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Klicken Sie auf <code>Ausführen</code>, um die Berechnung zu starten.</div>
</div>

### Ergebnisse

Nach der Berechnung werden zwei Layer zur Karte hinzugefügt:
- **ÖV-Güteklassen**: Zeigt die Qualitätsklasse für jedes Gebiet.
- **ÖV-Güteklassen Stationen**: Zeigt alle Stationen, die in der Berechnung verwendet wurden (graue Punkte = zu niedrige Frequenz, tragen zu keiner ÖV-Qualitätsklasse bei).

Wenn Sie auf ein ÖV-Güteklassen-Ergebnis klicken, sehen Sie weitere Details wie **ÖV-Klasse** und **ÖV-Klassennummer**. Beide zeigen dieselbe Qualität des öffentlichen Verkehrs in diesem Gebiet an (siehe [Berechnung](#berechnung) für weitere Details).

Wenn Sie auf eine beliebige Station klicken, können Sie Details wie den **Haltestellennamen**, die **durchschnittliche Frequenz** und die **Stationskategorie** sehen.



## 4. Technische Details

### Wissenschaftlicher Hintergrund

Die Qualität und Häufigkeit von Verkehrsangeboten ist ein **entscheidender** Indikator in der öffentlichen Verkehrspolitik und Raumplanung. Er kann verwendet werden, um Defizite im Verkehrsangebot aufzuzeigen und gut versorgte Standorte als attraktive Entwicklungsgebiete zu identifizieren. Der Ansatz der ÖV-Güteklassen ist **methodisch überlegen** gegenüber den üblichen [Einzugsgebieten](https://www.plan4better.de/de/glossar/einzugsgebiet). 2011 begann das [Schweizer Bundesamt für Raumentwicklung (ARE)](https://www.are.admin.ch/are/de/home.html) mit der Nutzung des Indikators ÖV-Güteklassen, um die **Attraktivität des öffentlichen Verkehrs** in die Bewertung der Entwicklungsqualität einzubeziehen; seitdem werden diese als wichtiges Instrument in formellen Planungsprozessen in der Schweiz betrachtet. Zudem diente das Schweizer Modell als Inspiration für die Anwendung in Österreich (z.B. Vorarlberg) und findet erste Anwendungen in Deutschland (z.B. durch [KCW](https://www.plan4better.de/de/references/calculation-of-public-transport-quality-classes-in-germany) und [Agora Verkehrswende](https://www.plan4better.de/de/references/accessibility-analyses-for-the-mobility-guarantee-and-public-transport-atlas-projects)).

Die Institutionalisierung des Indikators im deutschsprachigen Raum sowie die nachvollziehbare und zugleich differenzierte Berechnungsmethodik sind wichtige Vorteile der ÖV-Güteklassen.

### Berechnung

In der Schweizer Version des Indikators wird die Berechnung der Güteklassen üblicherweise für Abfahrten an Werktagen zwischen 6 Uhr und 20 Uhr durchgeführt. Für die Nutzung in GOAT wurde der **Berechnungszeitraum** flexibler gestaltet, sodass der Indikator **für jeden Wochentag und jede Tageszeit** berechnet werden kann.

Die Berechnungen werden basierend auf **GTFS-Daten** durchgeführt (siehe [Netz-Datensätze](../../data/builtin_datasets)):
Zunächst wird die Anzahl der Abfahrten pro öffentlichem Verkehrsmittel (Zug, U-Bahn, Straßenbahn und Bus) für jede Station dynamisch berechnet. Die Summe der Abfahrten wird durch zwei geteilt, um die Frequenz zu berechnen und die Hin- und Rückrichtungen zu eliminieren. Im nächsten Schritt wird die **durchschnittliche Frequenz** für das ausgewählte Zeitintervall berechnet. Das höherwertige Verkehrsmittel wird als **Stationstyp** ausgewählt, falls mehrere Verkehrsmittel die Station bedienen. Zum Beispiel ist bei Bus und Zug der Zug das höherwertige Verkehrsmittel. Mit Hilfe der unten stehenden Tabelle sowie dem Stationstyp und der Frequenz kann nun die Stationskategorie bestimmt werden.

### Berechnungsschritte

1. **Abfahrten pro Station**: Berechnung der Anzahl der Abfahrten pro Verkehrsmittel (Zug, U-Bahn, Straßenbahn, Bus) für jede Station mit **GTFS-Daten** (siehe [Netz-Datensätze](../../data/builtin_datasets)).
2. **Frequenz**: Die Summe der Abfahrten wird durch zwei geteilt, um die Hin- und Rückrichtungen zu eliminieren.
3. **Stationstyp**: Für jede Station wird das höchstrangige Verkehrsmittel bestimmt (z.B. wenn sowohl Bus als auch Zug verfügbar sind, wird die Station als Bahnstation klassifiziert).
4. **Kategorienzuweisung**: Verwendung des Stationstyps und der Frequenz zur Bestimmung der Kategorie (siehe Tabelle unten).
5. **Einzugsgebiete**: Erstellung von Pufferzonen für jede Stationskategorie.
6. **Zusammenführung der Gebiete**: Überlappende Gebiete werden zusammengeführt, wobei die höhere Qualitätsklasse Vorrang hat.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-start', gap: '20px', flexWrap: 'wrap', marginBottom: '20px' }}>
    <img src={require('/img/toolbox/accessibility_indicators/gueteklassen/classification_stations_de.webp').default} alt="Klassifikation der Verkehrshaltestellen" style={{ maxHeight: "auto", maxWidth: "45%", objectFit: "cover"}}/>
    <img src={require('/img/toolbox/accessibility_indicators/gueteklassen/determination_oev_gueteklasse_de.webp').default} alt="Bestimmung der ÖV-Güteklassen" style={{ maxHeight: "auto", maxWidth: "45%", objectFit: "cover"}}/>
  </div>

  <img src={require('/img/toolbox/accessibility_indicators/gueteklassen/oev_figure_de.png').default} alt="ÖV-Güteklassen Berechnung" style={{ maxHeight: "400px", maxWidth: "100%", objectFit: "contain", marginTop: "24px"}}/>
</div>

<div></div>

### Haltestellenkonfiguration

Standardmäßig klassifiziert GOAT Haltestellen mit dem oben beschriebenen Standardschema des Schweizer ARE-Modells. Wenn Sie ein anderes Schema benötigen, öffnen Sie im Werkzeug die <code>Haltestellenkonfiguration</code> und passen es an. Der Dialog besteht aus fünf Teilen, die in dieser Reihenfolge zusammenwirken: Das durchschnittliche Taktintervall einer Haltestelle und ihr Verkehrsmittel bestimmen ihre **Kategorie**, und Kategorie und Pufferabstand bestimmen dann die **Güteklasse**, die jeder Ring des Einzugsgebiets erhält.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/toolbox/accessibility_indicators/gueteklassen/station_configuration_de.webp').default} alt="Der Dialog Haltestellenkonfiguration mit seinen Standardwerten" style={{ maxWidth: "100%", objectFit: "contain"}}/>
</div>
<p> </p>

- <code>Konfigurationsprofil</code>: ein vorgefertigter Ausgangspunkt. Es gibt drei Profile: <code>Takt bis 60 Minuten</code>, <code>Takt bis 120 Minuten</code> (Standard) und <code>Takt bis 210 Minuten</code>. Sie unterscheiden sich darin, wie viele Taktstufen sie abdecken, und damit in ihren Haltestellenkategorien und darin, wie weit jede Kategorie reicht; <code>Takt bis 210 Minuten</code> ergänzt einen Ring von <code>1250</code> m und eine Güteklasse G. Sobald Ihre Einstellungen zu keinem Profil mehr passen, zeigt die Auswahl <code>Benutzerdefiniert</code>.

- <code>Taktgrenzen (Minuten)</code>: die Taktintervalle, nach denen Haltestellen einsortiert werden, als Minutenwerte eingegeben (Standard <code>5, 10, 20, 40, 60, 120</code>). Jeder Wert ist die Obergrenze eines Intervalls, sodass die Stufen "bis 5 Minuten", "über 5 bis 10 Minuten" und so weiter lauten. Eine Haltestelle wird nach ihrer **durchschnittlichen Taktung** einer Stufe zugeordnet: Je häufiger sie bedient wird, desto höher die Stufe. Eine Haltestelle, deren durchschnittliches Intervall länger als die letzte Grenze ist, erhält keine Kategorie und kein Einzugsgebiet. Mit einer niedrigeren letzten Grenze, etwa bei <code>Takt bis 60 Minuten</code>, fallen selten bediente Haltestellen daher aus dem Ergebnis.

- <code>Verkehrsmittelgruppen</code>: Jedes Verkehrsmittel gehört zu einer von drei Gruppen, <code>A</code>, <code>B</code> oder <code>C</code>. Standardmäßig sind <code>Bahn</code> und <code>U-Bahn</code> in Gruppe A, <code>Tram</code> und <code>Standseilbahn</code> in Gruppe B sowie <code>Bus</code> und <code>Gondelbahn</code> in Gruppe C. Fähren und manche Seilbahnen haben keine eigene Zeile: Je nachdem, wie die Fahrplandaten sie codieren, gehören sie zu Gruppe C oder bleiben in der Berechnung unberücksichtigt. Gruppe A hat den höchsten Rang. Wird eine Haltestelle von mehreren Verkehrsmitteln bedient, bestimmt die höchste vorhandene Gruppe ihren Typ.

- <code>Haltestellenkategorien</code>: eine Tabelle mit einer Zeile je Taktstufe und einer Spalte je Verkehrsmittelgruppe (A, B, C). Jede Zelle enthält die **Kategorie**, die eine Haltestelle in dieser Stufe und Gruppe erhält. Dies ist die zentrale Zuordnung, die Takt und Verkehrsmittel zu einer einzigen Haltestellenkategorie zusammenführt.

- <code>Distanzklassen</code>: eine Tabelle mit einer Zeile je Haltestellenkategorie und einer Spalte je Pufferabstand in Metern (<code>300</code>, <code>500</code>, <code>750</code> und <code>1000</code> m, bei <code>Takt bis 210 Minuten</code> zusätzlich <code>1250</code> m). Die Abstände gehören zum Profil und lassen sich nicht ändern; Sie legen die Klasse in jeder Zelle als Buchstaben fest. Eine leere Zelle bedeutet keinen Ring in diesem Abstand. Jede Zelle enthält die **Güteklasse**, die ein Pufferring dieser Größe um eine Haltestelle dieser Kategorie erhält. Damit wird festgelegt, wie weit jede Kategorie reicht. Wo sich Ringe verschiedener Haltestellen überlappen, gewinnt die bessere Klasse.

### Visualisierung

Die erstellten Puffer-Einzugsgebiete werden um die Haltestellen in den entsprechenden Farben visualisiert, um die **Güteklasse** (<span style={{color: "#199741"}}>A</span>-<span style={{color: "#E4696A"}}>F</span>, bei <code>Takt bis 210 Minuten</code> zusätzlich G) hervorzuheben.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/toolbox/accessibility_indicators/gueteklassen/visualization.webp').default} alt="Visualisierung der ÖV-Güteklassen" style={{ maxHeight: "400px", maxWidth: "100%", objectFit: "cover"}}/>
</div>

## 5. Weitere Lektüre

Beispielprojekte, in denen ÖV-Güteklassen verwendet wurden:

- [Deutschlandweite Bewertung der ÖV-Erschließung mittels ÖV-Güteklassen Whitepaper](https://www.plan4better.de/de/whitepapers/ov-erschliessung)
- [Erreichbarkeitsanalysen für die Projekte "Mobilitätsgarantie" und "ÖPNV-Atlas"](https://www.plan4better.de/de/references/accessibility-analyses-for-the-mobility-guarantee-and-public-transport-atlas-projects)
- [Berechnung der ÖV-Güteklassen in Österreich](https://www.plan4better.de/de/references/guteklassen-osterreich)
- [Berechnung der ÖV-Güteklassen in Deutschland](https://www.plan4better.de/de/references/calculation-of-public-transport-quality-classes-in-germany)

## 6. Referenzen

Bundesamt für Raumentwicklung ARE, 2022. [ÖV-Güteklassen Berechnungsmethodik ARE (Grundlagenbericht)](https://www.are.admin.ch/dam/de/sd-web/AZsFQRE7tiOY/oev-gueteklassen-berechnungsmethodikare.pdf "Open Reference").

Hiess, H., 2017. [Entwicklung eines Umsetzungskonzeptes für österreichweite ÖV-Güteklassen](https://web.archive.org/web/20251005162909/https://www.oerok.gv.at/fileadmin/user_upload/Bilder/2.Reiter-Raum_u._Region/1.OEREK/OEREK_2011/PS_RO_Verkehr/OeV-G%C3%BCteklassen_Bericht_Final_2017-04-12.pdf "Open Reference").

metron, 2017. [Bedienungsqualität und Erschließungsgüte im Öffentlichen Verkehr](https://vorarlberg.at/documents/302033/472144/1-+Schlussbericht.pdf/81c5f0d7-a0f0-54c7-e951-462cd5cf2831?t=1616147848364 "Open Reference").

Shkurti, Majk, 2022. "Spatio-temporal public transport accessibility analysis and benchmarking in an interactive WebGIS". url: https://www.researchgate.net/publication/365790691_Spatio-temporal_public_transport_accessibility_analysis_and_benchmarking_in_an_interactive_WebGIS


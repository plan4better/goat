---
sidebar_position: 3

---

# Öffentliche Verkehrsmittel

Das **Verkehrsmittel ÖPNV** in GOAT ist essentiell für die Durchführung von Analysen, welche Fahrten mit öffentlichen Verkehrsmitteln beinhalten.

## 1. Zielsetzung

Das ÖPNV-Routing erleichtert die **intermodale Analyse** durch die Wahl von Zu- und Abgang, wie z.B. zu Fuß, mit dem Fahrrad oder mit dem Auto zum und vom Bahnhof. Dies ist komplexer als die anderen Routing-Modi, da es die Zusammenführung verschiedener Datensätze (z. B. Bürgersteige und Radwege, Haltestellen und Fahrpläne des öffentlichen Verkehrs usw.) und Berechnungsansätze erfordert.

Das Routing im öffentlichen Verkehr wird in GOAT für Indikatoren wie [Einzugsgebiete](../toolbox/accessibility_indicators/catchments) und [Heatmaps](../toolbox/accessibility_indicators/connectivity) verwendet.


## 2. Daten

### ÖV-Daten

Verwendet Daten im Format **[GTFS](https://gtfs.org/)** (General Transit Feed Specification) für statische Informationen zum öffentlichen Verkehrsnetz (Haltestellen, Linien, Fahrpläne, Umsteigeverbindungen und mehr).


### Straßen und Wege

Integriert straßenbezogene Informationen aus **[OpenStreetMap](https://wiki.openstreetmap.org/)** zur Unterstützung multimodaler Routenführung und realistischer Wegeketten (einschließlich Gehwegen, Radwegen und Zebrastreifen).


## 3. Technische Einzelheiten

Eine ÖPNV-Fahrt besteht aus drei Abschnitten: dem **Zugangsweg** vom Startpunkt zur Haltestelle, dem **Fahrt-Abschnitt** durch das ÖV-Netz und dem **Abgangsweg** von der Haltestelle zum Ziel. Zugangs- und Abgangsart können unabhängig voneinander konfiguriert werden.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '1.5rem' }}>
  <img src={require('/img/routing/pt_trip_structure_de.png').default} alt="Struktur und Beispielkombinationen einer ÖPNV-Fahrt" style={{ maxWidth: "100%", objectFit: "contain"}}/>
</div>

Das Routing für den öffentlichen Verkehr wird von GOATs eigener leistungsstarker Routing-Engine durchgeführt, die die Open-Source-Bibliothek **[nigiri](https://github.com/motis-project/nigiri)** einbindet. Nigiri ist eine C++-Bibliothek aus dem **[MOTIS-Projekt](https://github.com/motis-project/motis)**, die eine One-to-All-Verbindungssuche im öffentlichen Verkehr mithilfe des **RAPTOR**-Algorithmus bereitstellt.

Die **Transit-Etappe** wird von nigiri berechnet, während die **Zugangs- und Abgangs-Etappen** (erste und letzte Meile) GOATs eigene **Dijkstra**-Implementierung verwenden – dasselbe Routing wie für aktive Mobilität und Auto. Dadurch bleibt das straßenbasierte Routing über alle Verkehrsträger hinweg konsistent.


### Routing-Optionen

#### Modi

Analysen für die folgenden öffentlichen Verkehrsmodi werden derzeit von GOAT unterstützt. Wählen Sie einen oder mehrere aus – beachten Sie dabei, dass einige Modi nicht in allen Regionen verfügbar sind.

`Bus`, `Straßenbahn`, `Bahn`, `U-Bahn`, `Fähre`, `Seilbahn`, `Gondel`, `Standseilbahn`.

#### Reisezeitlimit

Die maximale Reisedauer, die beim Routing im öffentlichen Verkehr berücksichtigt wird. Aktuell wird ein Maximum von `90 Minuten` unterstützt. Dies beinhaltet auch die Zeit für den Zugang und Abgang zu bzw. von den ÖPNV-Haltestellen.

#### Tag

Der Wochentag, der beim Routing im öffentlichen Verkehr berücksichtigt wird. Wählen Sie zwischen `Werktag`, `Samstag` und `Sonntag`. Dies ist nützlich, um Unterschiede im Verkehrsangebot zwischen Werktagen und Wochenenden zu analysieren.

#### Start- und Endzeit

Ein Zeitfenster für das Routing im öffentlichen Verkehr. Die Engine wertet **jede Abfahrtsminute** innerhalb dieses Zeitfensters aus und behält die **schnellste** Verbindung zu jedem erreichbaren Ort – es handelt sich nicht um einen Durchschnitt über das Zeitfenster. Das Ergebnis ist daher das bestmögliche, größtmögliche Einzugsgebiet vom angegebenen Startpunkt.  
Eine Verbindung gilt als innerhalb des Zeitfensters liegend, **ausschließlich basierend auf ihrer Startzeit** – unabhängig von ihrer Endzeit oder Gesamtdauer.


:::note

Bestimmte Indikatoren unterstützen möglicherweise nur eine **einzelne Abfahrts- oder Ankunftszeit** anstelle eines Zeitfensters. In diesem Fall wertet die Engine nur Verbindungen aus, die zu oder nach einer Abfahrtszeit beginnen oder zu oder vor einer Ankunftszeit enden.

:::


#### Maximale Umstiege

Die maximale Anzahl an Umstiegen, die eine ÖV-Verbindung enthalten darf. Es werden maximal `5` Umstiege unterstützt.

#### Zugang und Abgang

Die **Zugangs-Etappe** (vom Ausgangsort zur ÖV-Haltestelle) und die **Abgangs-Etappe** (von der ÖV-Haltestelle zum Ziel) können unabhängig voneinander konfiguriert werden. Für jede werden derzeit die folgenden Optionen unterstützt.

| Tool | Verkehrsmittel | Berechnung nach | Limit |
|------|----------------|-----------------|-------|
| Einzugsgebiet | <code>Zu Fuß</code>, <code>Fahrrad</code>, <code>Pedelec</code>, <code>Auto</code> | <code>Zeit</code> oder <code>Entfernung</code> | Bis zum gesamten <code>Limit</code> |
| Heatmaps | <code>Zu Fuß</code> | <code>Zeit</code> | 30 Minuten |
| Huff-Modell | <code>Zu Fuß</code> | <code>Zeit</code> | 30 Minuten |
| Reisekostenmatrix | <code>Zu Fuß</code>, <code>Fahrrad</code>, <code>Pedelec</code>, <code>Auto</code> | <code>Zeit</code> oder <code>Entfernung</code> | Bis zum gesamten <code>Limit</code> |

- **Geschwindigkeit** — die für die Etappe verwendete Reisegeschwindigkeit (bei Berechnung nach `Zeit`).

Standardmäßig verwenden die Zugangs- und die Abgangs-Etappe `Zu Fuß`, ein `Zeit`-Limit von `15 Min` und eine Geschwindigkeit von `5 km/h`.
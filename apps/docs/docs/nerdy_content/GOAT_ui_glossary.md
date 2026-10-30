# GOAT Glossary

This glossary lists the English and German labels of the main tools, features and terms in the GOAT interface. Use it to find the exact German label the app shows for an English one when you move between the English documentation and the German interface.

## Core Interface Elements

| English | German | Description |
|---------|--------|-------------|
| **Interface** | **Kartenoberfläche** | Main map interface |
| Upper Bar | Obere Leiste | Top bar of the map interface |
| Navigation Bar | Navigationsleiste | Left sidebar of the workspace (Home, Content, Catalog, Settings) |
| Map Navigation | Kartennavigation | Map control tools |
| Project Menu | Projektmenü | Project menu in the upper bar |
| Home | Startseite | Project menu entry and workspace page that opens the home page |
| Edit metadata | Metadaten bearbeiten | Project menu entry to edit the project's name, description and thumbnail |
| Map | Karte | Map view of a project (upper bar switch) |
| Last Saved | Zuletzt gespeichert | Timestamp of last changes |
| Share | Teilen | Share project functionality |
| Open Documentation | Dokumentation öffnen | Link to help documentation |
| Job status | Job Status | Status of running calculations |
| User Profile | Benutzerprofil | User account menu |

## Main Navigation Tools

| English | German | Description |
|---------|--------|-------------|
| **Layers** | **Layer** | Layer management panel |
| Add layer | Layer hinzufügen | Add new layer to project |
| Create Group | Gruppe erstellen | Group layers in the Layers panel |
| Layer settings | Layer-Einstellungen | Panel that opens for the selected layer |
| **Style** | **Stil** | Layer styling tab |
| **Legend** | **Legende** | Map legend display |
| **Properties** | **Eigenschaften** | Layer information and settings |
| **Filter** | **Filtern** | Data filtering tab |
| **Toolbox** | **Werkzeugkasten** | Spatial analysis panel |
| Tools | Werkzeuge | Toolbox button and the tab listing the analysis tools |
| **Workflows** | **Workflows** | Visual analysis workflow editor |

## Spatial Analysis Tools

### Geoprocessing Tools
| English | German | Description |
|---------|--------|-------------|
| Geoprocessing | Geoverarbeitung | Spatial data processing operations |
| Geoanalysis | Geoanalyse | Spatial data analysis |
| **Buffer** | **Puffer** | Create buffer zones around features |
| Buffer Distances | Pufferabstände | Distances for buffer creation |
| Merge overlapping buffers | Überlappende Puffer zusammenführen | Combine buffer polygons |
| Polygon Difference | Polygon Difference | Subtract the smaller buffer step from the larger one |
| **Clip** | **Ausschneiden** | Extract features within clip geometry |
| **Intersection** | **Überschneiden** | Geometric intersection of two layers |
| **Union** | **Vereinigen** | Combine features from multiple layers |
| **Erase** | **Radieren** | Remove portions that overlap with erase geometry |
| **Centroid** | **Mittelpunkt** | Create point features at geometric center |
| **Dissolve** | **Zusammenführen (Dissolve)** | Merge features that share field values |
| Dissolve Settings | Auflösungseinstellungen | Dissolve configuration section |
| Group By Fields | Gruppierungsfelder | Fields whose values define the dissolved features |
| Calculate Statistics | Statistiken berechnen | Add statistics of the merged features |
| Overlay Layer | Überlagerungs-Layer | Second layer used by Clip, Intersection, Union and Erase |
| Overlay Fields Prefix | Überlagerungsfeld-Präfix | Prefix for the fields taken from the overlay layer |
| Field Selection | Feldauswahl | Choose which fields to include |
| Input Fields | Eingabefelder | Fields kept from the input layer |
| Overlay Fields | Überlagerungsfelder | Fields kept from the overlay layer |

### Geocoding & Geoanalysis
| English | German | Description |
|---------|--------|-------------|
| **Geocoding** | **Geokodierung** | Convert addresses to coordinates |
| Input Mode | Eingabemodus | Choose between one address field and separate fields |
| Full Address | Vollständige Adresse | Complete address in single field |
| Structured | Strukturiert | Address components in separate fields |
| Address Field | Adressfeld | Field containing the full address |
| Street Address | Straße und Hausnummer | Street and house number field |
| Postal Code | Postleitzahl | ZIP/postal code field |
| City/Town | Stadt/Gemeinde | City/town name field |
| State/Province | Bundesland/Region | State or region field |
| Country Field | Land | Country name field |
| **Aggregate Points** | **Punkte aggregieren** | Point aggregation analysis |
| **Aggregate Polygons** | **Polygone aggregieren** | Polygon aggregation analysis |
| Layer to Aggregate | Zu aggregierender Layer | Section for the layer whose features are aggregated |
| Summary Areas | Aggregierungspolygone | Aggregation target areas |
| Area Type | Flächentyp | Polygon layer or H3 grid as summary areas |
| Area Layer | Flächen-Layer | Polygon layer used as summary areas |
| H3 Grid | H3-Gitter | Hexagonal spatial indexing system |
| H3 Resolution | H3-Auflösung | Hexagonal grid detail level |
| Statistics Configuration | Statistik-Konfiguration | Statistic and field calculated per summary area |
| Select operation | Operation auswählen | Statistic to calculate (Count, Sum, Mean, …) |
| Weight by Intersection Area | Nach Schnittfläche gewichten | Aggregation weight based on overlap area |
| Group Fields | Gruppenfelder | Fields used to group aggregated results |
| **Spatial Clustering** | **Räumliches Clustering** | Group features into spatial zones |
| **Origin-Destination** | **Quell-Ziel-Beziehungen** | Origin-destination analysis |
| Geometry Layer | Geometrie-Layer | Layer with the origin and destination geometries |
| Matrix Layer | Matrix-Layer | Table with the origin-destination matrix |
| Unique ID Column | Eindeutige ID-Spalte | Identifier field of the geometry layer |
| Origin Column | Quellspalte | Origin identifier field |
| Destination Column | Zielspalte | Destination identifier field |
| Weight Column | Gewichtungsspalte | Field used to weight OD connections |

### Data Management & Joining
| English | German | Description |
|---------|--------|-------------|
| Data Management | Datenmanagement | Toolbox category |
| **Join Features** | **Objekte verbinden** | Spatial and attribute-based joins |
| Target Layer | Ziel-Layer | Destination layer for join |
| Join Layer | Join-Layer | Source layer for joining |
| Spatial Match | Räumliche Zuordnung | Join based on spatial relationship |
| Spatial Relationship | Räumliche Beziehung | Spatial rule that matches features |
| Attribute Match | Attribut-Zuordnung | Join based on attribute values |
| Match Fields | Zuordnungsfelder | Pairs of target and join fields |
| Target Field | Ziel-Feld | Target field for join |
| Join Field | Join-Feld | Field used for joining |
| Match Handling | Übereinstimmungen | One-to-one or one-to-many join |
| Join Type | Verbindungstyp | Inner or left join |
| Add Join Fields | Verknüpfungsfelder hinzufügen | Copy fields from the join layer |
| Join Fields | Verknüpfungsfelder | Fields chosen for output |
| **Merge** | **Zusammenführen (Merge)** | Combine several layers into one |

### Catchment Area Analysis
| English | German | Description |
|---------|--------|-------------|
| **Catchment Area** | **Einzugsgebiet** | Service area analysis for walking, cycling, car or public transport |
| Calculate by | Berechnen nach | Limit the catchment area by time or distance |
| Limit | Limit | Maximum travel time or distance |
| Travel speed (km/h) | Reisegeschwindigkeit (km/h) | Travel speed setting |
| Number of steps | Anzahl der Schritte | Number of catchment area steps |
| Step sizes | Schrittgrößen | Size of each catchment area step |
| Catchment area shape | Form des Einzugsgebiets | Shape type used for catchment area output |
| Network | Netzwerk | Catchment area shape: street network |
| Hexagonal grid | Sechseckiges Gitter | Catchment area shape: hexagonal grid |
| Point grid | Punktraster | Catchment area shape: point grid |
| Isochrone | Isochrone | Area reachable within time limit |

### Heatmap Analysis
| English | German | Description |
|---------|--------|-------------|
| Heatmap Connectivity | Heatmap Konnektivität | Network connectivity analysis |
| Heatmap Gravity | Heatmap Gravity | Gravity model accessibility |
| Heatmap Closest Average | Heatmap Durchschnitt Reisezeit | Average travel time to closest destinations |
| Heatmap 2SFCA | Heatmap 2SFCA | Supply-demand ratio (two-step floating catchment area) |
| Huff Model | Huff-Modell | Probability of choosing a destination |
| Opportunities | Gelegenheiten | Destination points for analysis |
| Number of destinations | Anzahl der Ziele | Closest destinations included in the average |
| Sensitivity | Sensitivität | Distance decay parameter |
| Impedance function | Widerstandsfunktion | Function controlling distance decay in gravity models |
| Gaussian | Gauß | Impedance function option |
| Linear | Linear | Impedance function option |
| Exponential | Exponentiell | Impedance function option |
| Power | Potenz | Impedance function option |
| Cumulative | Kumulativ | Impedance function option |
| Destination Potential | Destinationspotenzial | Attractiveness weighting factor |
| Potential field | Potenzialfeld | Field that sets the destination potential |
| Reference area | Referenzgebiet | Area the heatmap is calculated for |
| Demand layer | Nachfrage-Layer | Layer with the demand (2SFCA, Huff Model) |

### Accessibility Indicators
| English | German | Description |
|---------|--------|-------------|
| Accessibility Indicators | Erreichbarkeitsindikatoren | Accessibility measurements |
| ÖV-Güteklassen | ÖV-Güteklassen | Public transport quality classes |
| Station configuration | Haltestellenkonfiguration | ÖV-Güteklassen classification settings |
| Calculation Time | Berechnungszeit | Day and time window of the calculation |
| Trip Count Platform | Anzahl Abfahrten Haltepunkte | Public transport departures |
| **Travel Cost Matrix** | **Reisekostenmatrix** | Travel time or distance between origins and destinations |
| Origins layer | Startpunkte-Layer | Starting points of the matrix |
| Destinations layer | Zielpunkte-Layer | Destinations of the matrix |
| GTFS Data | GTFS-Daten | General Transit Feed Specification |
| Quality Classes | Güteklassen | Service quality assessment levels |

## Workflows Interface

| English | German | Description |
|---------|--------|-------------|
| **Workflows** | **Workflows** | Visual analysis workflow system |
| Workflow | Workflow | Collection of connected analysis steps |
| Workflow Canvas | Workflow-Leinwand | Visual editing area for workflows |
| Workflow Editor | Workflow-Editor | Visual workflow design interface |
| Node | Knoten | Individual workflow element (dataset, tool, export) |
| Edge | Verbindung | Connection between workflow nodes |
| **Dataset Node** | **Datensatz-Knoten** | Input data source in workflow |
| **Tool Node** | **Werkzeug-Knoten** | Analysis process in workflow |
| **Export Node** | **Export-Knoten** | Output/save step in workflow |
| Add dataset | Datensatz hinzufügen | Node palette entry for a dataset node |
| Data I/O | Daten I/O | Node palette group for dataset and export nodes |
| Control | Steuerung | Node palette group for the Conditional node |
| Conditional | Bedingung | Node that branches the workflow on a condition |
| Text card | Textkarte | Text note on the canvas, added with the Text tool |
| Canvas | Leinwand | Visual workspace for building workflows |
| Handle | Anschluss | Connection point on nodes |
| Run | Ausführen | Execute entire workflow |
| Stop | Stopp | Stop a running workflow |
| Execution status | Ausführungsstatus | Current state of workflow node |
| Idle | Inaktiv | Node ready to run |
| Pending | Ausstehend | Node queued for execution |
| Running | Läuft | Node currently executing |
| Completed | Abgeschlossen | Node finished successfully |
| Cancelled | Abgebrochen | Node execution was cancelled |
| Error | Fehler | Node execution failed |
| **Variables** | **Variablen** | Workflow-level parameters |
| Add Variable | Variable hinzufügen | Create a workflow variable |
| Add description | Beschreibung hinzufügen | Give a workflow variable help text |
| Default | Standard | Initial parameter value |
| Description | Beschreibung | Help text of a workflow variable |
| Edit description | Beschreibung bearbeiten | Change a workflow variable's help text |
| Label | Bezeichnung | Name users see for a workflow variable |
| Number | Zahl | Variable type |
| String | Text | Variable type |
| Zoom In | Hineinzoomen | Canvas zoom in |
| Zoom Out | Rauszoomen | Canvas zoom out |
| Fit View | Ansicht anpassen | Fit all nodes into view |
| Lock | Sperren | Lock the canvas |
| Unlock | Entsperren | Unlock the canvas |
| Minimap | Minimap | Canvas overview navigator |
| New | Neu | Create a new workflow |
| From scratch | Neu erstellen | Start an empty workflow |
| From template | Aus Vorlage | Start a workflow from a template |
| Duplicate | Duplizieren | Copy existing workflow |
| Rename Workflow | Workflow umbenennen | Change workflow name |
| Replace datasets… | Datensätze ersetzen… | Swap the datasets a workflow uses |
| Save as template… | Als Vorlage speichern… | Save the workflow as a template |
| Delete Workflow | Workflow löschen | Remove workflow |
| Temporary output | Temporäre Ausgabe | Intermediate workflow result |
| Filter | Filtern | Data filtering within workflow |
| Geometry type | Geometrietyp | Spatial data type (point, line, polygon) |
| **Custom SQL** | **Benutzerdefiniertes SQL** | Custom SQL query node in workflow |
| Custom SQL Editor | SQL-Editor | Code editor for writing SQL queries |
| SQL Query | SQL-Abfrage | Query of a Custom SQL node |
| Save dataset | Datensatz speichern | Save workflow result as a permanent dataset |
| Save as dataset | Als Datensatz speichern | Export workflow output as a new dataset |

## Layouts & Print

| English | German | Description |
|---------|--------|-------------|
| **Layouts** | **Layouts** | Report layout and printing system |
| Layout | Layout | Map layout for reports |
| From scratch | Neu erstellen | Create an empty layout |
| From template | Aus Vorlage | Create a layout from a template |
| Rename Layout | Layout umbenennen | Change layout name |
| Delete Layout | Layout löschen | Remove a layout |
| Print Layout | Layout drucken | Generate PDF/PNG reports |
| Print Report | Bericht drucken | Print job in the job status list |
| Settings | Einstellungen | Layout configuration panel |
| Map Elements | Kartenelemente | Element group: map, legend, north arrow, scalebar |
| Content | Inhalt | Element group: text, image, divider |
| Map | Karte | Map component in layout |
| Text | Text | Text component in layout |
| Image | Bild | Image component in layout |
| Legend | Legende | Map legend in layout |
| Scalebar | Maßstabsleiste | Map scale indicator |
| North Arrow | Nordpfeil | North direction indicator |
| Divider | Trennlinie | Line element that separates layout content |
| Title | Titel | Layout title text |
| Page Settings | Seiteneinstellungen | Page size and orientation |
| Orientation | Ausrichtung | Portrait or landscape |
| Horizontal | Horizontal | Horizontal page orientation |
| Vertical | Vertikal | Vertical page orientation |
| DPI | DPI | Print resolution (dots per inch) |
| Margin | Rand | Margin around the feature in the map element |
| Export format | Exportformat | PDF or PNG output |
| Atlas / Map Series | Atlas / Kartenserie | Multi-page report generation |
| Coverage Layer | Abdeckungs-Layer | Layer whose features define the atlas pages |
| Template | Vorlage | Pre-designed layout template |
| Connected map | Verbundene Karte | Map element a legend, scalebar or north arrow is linked to |
| Map rotation | Kartenrotation | Rotate the map element |
| Compass | Kompass | North arrow style |
| Fit to screen | An Bildschirm anpassen | Fit the page into the canvas |

## Routing & Transportation

| English | German | Description |
|---------|--------|-------------|
| **Routing** | **Routing** | Route calculation |
| Transport mode | Verkehrsmittel | Transportation mode |
| Walk | Zu Fuß | Walking |
| Bicycle | Fahrrad | Cycling |
| Pedelec | Pedelec | Electric bicycle |
| Car | Auto | Car |
| Public Transport | ÖPNV | Public transport |
| Flight Distance | Luftlinie | Straight-line distance (Travel Cost Matrix) |
| Choose PT modes | ÖV-Modi wählen | Public transport modes included in the calculation |
| Bus | Bus | Bus |
| Tram | Straßenbahn | Tram |
| Subway | U-Bahn | Subway/Metro |
| Rail | Bahn | Train |
| Ferry | Fähre | Ferry |
| Cable Car | Seilbahn | Cable car |
| Funicular | Standseilbahn | Funicular railway |
| Gondola | Gondel | Gondola lift |
| Access mode | Zugangsart | Mode used to reach the first public transport stop |
| Max. transfers | Max. Umstiege | Maximum number of public transport transfers |
| Street Network | Straßennetz | Street network used for routing |
| Public Transport Network | ÖPNV-Netz | Public transport network used for routing |

## Data Management

| English | German | Description |
|---------|--------|-------------|
| **Data** | **Daten** | Data management |
| Datasets | Datensätze | Data collections |
| Upload dataset | Datensatz hochladen | Upload a data file as a dataset (Add layer, Add new, Home) |
| My datasets | Meine Datensätze | Browse your datasets when adding a layer |
| Create layer | Layer erstellen | Create an empty layer |
| Fetch / Connect data | Daten abrufen / verbinden | Add a layer from data GOAT provides (OpenStreetMap, Overture Maps, the street network) or from an external web service |
| Fetch data | Daten abrufen | Workflow node that fetches OpenStreetMap or Overture Maps data for a study area on every run |
| **Catalog** | **Katalog** | Data catalog |
| Metadata | Metadaten | Data information |
| Data source | Datenquelle | Data source information |
| Data Reference Year | Referenzjahr | Reference year for the dataset |
| Attribution | Namensnennung | Data source credit/attribution |
| Data Category | Kategorie | Thematic category of the dataset |
| License | Lizenz | Data usage license |

## Layer Management

| English | German | Description |
|---------|--------|-------------|
| Dataset Types | Layertypen | Filter for different layer categories |
| Feature | Feature | Layer with geometries |
| Table | Tabelle | Layer without geometries |
| Raster | Raster | Raster data layer |
| Point | Punkt | Point geometry |
| Line | Linie | Line geometry |
| Polygon | Polygon | Polygon geometry |
| Hide Layer | Layer ausblenden | Toggle layer visibility off |
| Show Layer | Layer anzeigen | Toggle layer visibility on |
| Zoom to | Zoomen auf | Zoom the map to the layer |
| View Data | Daten ansehen | Open the layer's attribute table |
| View Chart | Diagramm anzeigen | Open a chart of the layer's data |
| Edit features | Features bearbeiten | Start editing the layer's features |
| Data source info | Datenquelle | View layer metadata and details |
| Delete Layer | Layer löschen | Remove layer from project |
| Zoom Visibility | Zoom-Sichtbarkeit | Control at which zoom levels a layer is visible |

## Project Management

| English | German | Description |
|---------|--------|-------------|
| **Project** | **Projekt** | GOAT project |
| Content | Inhalt | Workspace page with your projects, datasets and folders |
| New project | Neues Projekt | Create new project |
| Create project | Projekt erstellen | Menu entry to create a project |
| Blank project | Leeres Projekt | Start a project without a template |
| Project Name | Projektname | Name of project |
| Duplicate Project | Projekt duplizieren | Copy an existing project |
| Save project as template… | Projekt als Vorlage speichern… | Project menu entry to save the project as a template |
| Delete Project | Projekt löschen | Remove a project |
| **Workspace** | **Workspace** | User workspace |
| **Folder** | **Ordner** | Organization folder |
| Create folder | Ordner erstellen | Create new folder |
| Move to folder | In den Ordner verschieben | Organize content |

## Teams & Organizations

| English | German | Description |
|---------|--------|-------------|
| **Team** | **Team** | Group of users collaborating on projects |
| New Team | Neues Team | Create a new team |
| Team name | Teamname | Name of the team |
| Member | Mitglied | User who belongs to a team |
| Owner | Eigentümer | User with ownership rights over a team |
| Leave team | Team verlassen | Remove yourself from a team |
| Delete team | Team löschen | Permanently remove a team |
| Manage members | Mitglieder verwalten | Add or remove team members |
| **Organization** | **Organisation** | Company or institutional account |
| Organization Name | Organisationsname | Name of the organization |
| Organization type | Organisationstyp | Category of the organization |
| **Publish to web** | **Im Web veröffentlichen** | Make a project publicly accessible |
| Republish | Aktualisieren | Update the published version of a project |
| Unpublish | Veröffentlichung aufheben | Revert a project to private access |
| Copy link | Link kopieren | Copy the link of a published project |
| Embed Code | Code einbetten | iframe code to embed a published project |

## Styling & Visualization

| English | German | Description |
|---------|--------|-------------|
| **Style** | **Stil** | Visual styling options |
| Appearance | Aussehen | Appearance settings of a dashboard panel or popup |
| Color | Farbe | Color settings |
| Preset Colors | Standardfarben | Predefined colors in the color picker |
| Fill Color | Füllfarbe | Fill color for polygons |
| Stroke Color | Strichfarbe | Outline color |
| Stroke Width | Strichbreite | Line thickness |
| Cap | Linienende | Line end style in the Style panel |
| Join | Linienverbindung | Line corner style in the Style panel (not the Join Features tool) |
| Opacity | Deckkraft | Transparency level |
| Marker | Marker | Point symbol |
| Custom Marker | Benutzerdefiniertes Symbol | Custom icon |
| Marker Size | Symbolgröße | Size of point marker icon |
| Color based on | Farbe basierend auf | Field used to drive color classification |
| Marker based on | Symbol basierend auf | Field used to assign different icons |
| Label by | Beschriftung nach | Field used for map label text |
| **Labels** | **Beschriftungen** | Text labels |
| Label Settings | Beschriftungseinstellungen | Label configuration |
| Color scale | Farbskala | Color ramp for classified visualization |
| Equal Interval | Gleiches Intervall | Classification with equal-width breaks |
| Quantile | Quantil | Classification with equal-count breaks |
| Custom Breaks | Benutzerdefinierte Schritte | User-defined classification thresholds |
| Sequential | Sequenziell | Single-hue color progression |
| Diverging | Divergierend | Two-hue color progression from center |
| Base Color | Grundfarbe | Primary color for styling |
| Hover Color | Hover-Farbe | Color shown on mouse hover |
| Selection Color | Auswahlfarbe | Color shown when a feature is selected |

## Dashboards & Widgets

| English | German | Description |
|---------|--------|-------------|
| **Dashboard** | **Dashboard** | Interactive data visualization panel |
| Widgets | Widgets | Tab with the widgets you can add to a panel |
| Panel | Panel | Individual dashboard container |
| Delete Panel | Panel löschen | Remove a dashboard panel |
| Map view | Kartenansicht | Map view settings of the dashboard |
| **Chart** | **Diagramm** | Data visualization chart |
| Charts | Diagramme | Widget group for charts |
| Categories | Kategorien | Chart comparing values across categories |
| Line chart | Liniendiagramm | Chart showing trends over a continuous axis |
| Vertical bar chart | Vertikales Balkendiagramm | Bars displayed vertically |
| Horizontal bar chart | Horizontales Balkendiagramm | Bars displayed horizontally |
| Pie chart | Kreisdiagramm | Circular chart showing proportions |
| Histogram | Histogramm | Chart showing frequency distribution |
| Number of Bins | Anzahl Klassen | Number of intervals in a histogram |
| Numbers | Zahlen | Widget showing a single value |
| Divider | Trennlinie | Widget that separates panel content |
| Value labels | Wertbeschriftungen | Show data values on chart elements |
| Selection Response | Auswahlverhalten | How a widget reacts to map selection |
| **Interactions** | **Interaktionen** | Rules linking dashboard elements so one action triggers a change in another |
| Manage Interactions | Interaktionen verwalten | Open the interactions editor |
| Add Interaction | Interaktion hinzufügen | Create a new interaction rule |
| Enabled | Aktiviert | Toggle an individual interaction on or off |
| When | Wenn | The trigger condition of an interaction |
| Layer group activated | Layer-Gruppe aktiviert | Trigger: a layer group is activated |
| Layer visibility changed | Layer-Sichtbarkeit geändert | Trigger: a layer is shown or hidden |
| Switch tab | Tab wechseln | Action: switch the active tab of a Tabs widget |
| Sync visibility | Sichtbarkeit synchronisieren | Action: mirror a layer's visibility onto other layers |
| Target widget | Ziel-Widget | The Tabs widget whose active tab is changed |
| Layer group | Layer-Gruppe | The layer group used as an interaction source |
| Tab | Tab | The tab a widget switches to |
| Add mapping | Zuordnung hinzufügen | Add a layer group → tab pair |
| Source layer | Quell-Layer | The layer whose visibility is watched |
| Target layers | Ziel-Layer | Layers that mirror the source layer's visibility |
| Add target layer | Ziel-Layer hinzufügen | Add a target layer to sync |

## Expression & Formula Builder

| English | German | Description |
|---------|--------|-------------|
| **Formula Builder** | **Formel-Editor** | Interface for building custom expressions |
| Expression | Ausdruck | Custom formula or calculation |
| Add Expression | Ausdruck hinzufügen | Add a new expression |
| Fields | Felder | Fields you can insert into an expression |
| Operators | Operatoren | Operators you can insert into an expression |
| Functions | Funktionen | Available built-in functions |
| Math | Mathematik | Mathematical function category |
| Aggregate | Aggregieren | Aggregation function category |
| Conditional | Bedingt | Conditional/logical function category |
| Date/Time | Datum/Zeit | Date and time function category |
| Spatial | Räumlich | Spatial function category |
| Text | Text | String/text function category |
| Window | Fenster | Window function category |

## Basemaps & Background

| English | German | Description |
|---------|--------|-------------|
| **Basemaps** | **Grundkarten** | Background maps |
| Map Style | Kartenstil | Basemap selection panel |
| Satellite | Satellit | Satellite imagery |
| High Fidelity | Hohe Wiedergabetreue | Detailed street basemap |
| Dark | Dunkel | Dark theme map |
| Light | Hell | Light theme map |
| BKG (Germany) | BKG (DE) | Basemap from German Federal Agency for Cartography |
| BKG (World) | BKG (Weltweit) | Worldwide basemap from the German Federal Agency for Cartography |
| Grayscale | Grau | Grayscale basemap |
| Relief | Relief | Terrain relief basemap |
| Landuse | Flächennutzung | Land use basemap |
| Color | Farbe | Color basemap variant |

## Map Controls

| English | German | Description |
|---------|--------|-------------|
| **Search** | **Suche** | Location search |
| Search places and data... | Orte und Daten suchen... | Placeholder of the search field |
| Find location | Standort finden | Location finder |
| **Zoom controls** | **Zoom-Steuerung** | Map zoom tools |
| Zoom In | Hineinzoomen | Zoom closer |
| Zoom Out | Rauszoomen | Zoom further |
| Zoom to feature | Zum Objekt zoomen | Focus on feature |
| **Fullscreen** | **Vollbildmodus** | Full screen mode |
| Recenter Map | Karte zentrieren | Pan map back to default center |
| Lock map extent | Kartenausdehnung sperren | Project menu entry that restricts map pan/zoom to the current extent |
| Unlock map view | Kartenansicht entsperren | Allow map pan/zoom beyond the locked extent |
| **Measure** | **Messen** | Measurement tools |
| Open Measure Tools | Messwerkzeuge öffnen | Open the measurement tools |
| Line | Linie | Measure length along a drawn line |
| Polygon | Polygon | Measure area of a drawn polygon |
| Circle | Kreis | Measure a circle's radius and area |
| Flight Distance | Luftlinie | Straight-line (as-the-crow-flies) distance |
| Walking | Zu Fuß | Measure a walking route |
| Car | Auto | Measure a car route |

## Feature Editing

| English | German | Description |
|---------|--------|-------------|
| **Draw** | **Zeichnen** | Draw new features on the map |
| Add new feature | Neues Objekt hinzufügen | Add a new spatial feature to a layer |
| Modify attributes | Attribute ändern | Edit feature attribute values |
| Modify geometry | Geometrie ändern | Edit the spatial shape of a feature |
| Delete feature | Objekt löschen | Remove a feature from a layer |
| Stop editing | Bearbeitung beenden | Leave feature editing mode |

## Data Analysis & Statistics

| English | German | Description |
|---------|--------|-------------|
| **Statistics** | **Statistiken** | Statistical calculations |
| Count | Anzahl | Count of features |
| Sum | Summe | Sum calculation |
| Mean | Durchschnitt | Average value |
| Median | Median | Median value |
| Min | Min | Minimum value |
| Max | Max | Maximum value |
| Standard Deviation | Standardabweichung | Statistical deviation |

## Filtering & Selection

| English | German | Description |
|---------|--------|-------------|
| **Filter** | **Filtern** | Data filtering |
| Filter results | Filter Ergebnisse | Filtered data |
| Clear Filter | Filter löschen | Remove filters |
| Filter viewport | Nach Kartenausschnitt filtern | Filter data within current map view |
| Zoom to selection | Zoomen zur Auswahl | Automatically pan map view to filtered data |
| Map Extent | Kartenausdehnung | Spatial filter by the current map extent |
| **Expression** | **Ausdruck** | Filter expression |
| Logical Expression | Logischer Ausdruck | Boolean logic |
| Spatial Expression | Räumlicher Ausdruck | Spatial filter |
| Contains the text | Enthält den Text | String filter: value contains substring |
| Does not contain the text | Enthält nicht den Text | String filter: value does not contain substring |
| Starts with | Beginnt mit | String filter: value starts with string |
| Ends with | Endet mit | String filter: value ends with string |
| Is between | Liegt zwischen | Numeric filter: value within range |
| Is not between | Liegt nicht dazwischen | Numeric filter: value outside range |
| Is blank | Ist leer | Filter: field has no value |
| Is not blank | Ist nicht leer | Filter: field has a value |

## User Interface Actions

| English | German | Description |
|---------|--------|-------------|
| **Add** | **Hinzufügen** | Add new item |
| **Edit** | **Bearbeiten** | Edit existing item |
| **Delete** | **Löschen** | Remove item |
| **Save** | **Speichern** | Save changes |
| **Cancel** | **Abbrechen** | Cancel operation |
| **Apply** | **Anwenden** | Apply settings |
| **Run** | **Ausführen** | Execute analysis |
| **Upload** | **Hochladen** | Upload file |
| **Download** | **Herunterladen** | Download data |
| **Share** | **Teilen** | Share content |
| **Duplicate** | **Duplizieren** | Copy item |
| **Rename** | **Umbenennen** | Change name |
| **Import** | **Importieren** | Import data |
| **Export** | **Exportieren** | Export data |
| **New** | **Neu** | Create a new item |
| Select all | Alle auswählen | Select all items in a list |

## User Preferences

| English | German | Description |
|---------|--------|-------------|
| **Preferences** | **Einstellungen** | User account preferences |
| Theme | Erscheinungsbild | UI color theme |
| Light | Hell | Light color theme |
| Dark | Dunkel | Dark color theme |
| Language | Sprache | Interface language |

## Analysis Configuration

| English | German | Description |
|---------|--------|-------------|
| **Settings** | **Einstellungen** | Configuration options |
| Advanced options | Erweiterte Optionen | Advanced options |
| **Configuration** | **Konfiguration** | Setup parameters |
| **Parameters** | **Parameter** | Analysis parameters |
| Starting Points | Startpunkte | Analysis origin points |
| Reference area | Referenzgebiet | Reference data layer |
| Input layer | Eingabe-Layer | Source data layer |
| Result layer | Ergebnis-Layer | Result data layer |
| Result layer name | Name des Ergebnis-Layers | Name of the result layer |
| CRS | CRS | Coordinate Reference System |
| Output CRS | Ausgabe-CRS | Coordinate reference system of the result |
| EPSG Code | EPSG-Code | Standard spatial reference identifier |

## Time & Scheduling

| English | German | Description |
|---------|--------|-------------|
| **Time** | **Zeit** | Time settings |
| Start Time | Startzeit | Beginning time |
| End Time | Endzeit | Ending time |
| Arrival time | Ankunftszeit | Arrival time at the destinations |
| Date | Datum | Date of the public transport timetable |
| Day | Tag | Day selection |
| Weekday | Wochentag | Weekday |
| Saturday | Samstag | Saturday |
| Sunday | Sonntag | Sunday |

## Status & Feedback

| English | German | Description |
|---------|--------|-------------|
| **Status** | **Status** | Current state |
| Idle | Inaktiv | Process or node ready to run |
| Pending | Ausstehend | Process queued, not yet started |
| Running | Läuft | Process running |
| Completed | Abgeschlossen | Process finished successfully |
| Successful | Erfolgreich | Successful operation |
| Cancelled | Abgebrochen | Process was cancelled |
| Error | Fehler | Error occurred |
| Failed | Fehlgeschlagen | Process failed |
| **Job status** | **Job Status** | Analysis job status |

## Units & Measurements

| English | German | Description |
|---------|--------|-------------|
| **Distance** | **Entfernung** | Distance measurement |
| **Speed** | **Geschwindigkeit** | Speed setting |
| Metric | Metrisch | Metric system |
| Imperial | Imperial | Imperial system |
| **Radius** | **Radius** | Circular distance |
| Meters | Meter | Distance in meters |
| Kilometers | Kilometer | Distance in kilometers |
| Miles | Meilen | Distance in miles |
| Feet | Fuß | Distance in feet |
| Distance Units | Entfernungseinheit | Unit of the buffer distances |
| Distance Source | Abstandsquelle | Type of buffer operation |
| Constant | Konstant | Same distance for all features |
| Field | Feld | Different distance per feature |
| Distance Field | Abstandsfeld | Field containing distance values |
| Cap Style | Endkappenstil | Buffer end cap style |
| Join Style | Verbindungsstil | Buffer corner style |
| Round | Rund | Rounded buffer style |
| Square | Quadratisch | Square buffer style |
| Flat | Flach | Flat buffer end style |
| Mitre Limit | Gehrungsgrenze | Mitre join limit parameter |
| Curve Smoothness | Kurvenglättung | Number of segments for curves |

## Data Formats

| English | German | Description |
|---------|--------|-------------|
| **Format** | **Format** | Data format |
| GeoJSON | GeoJSON | Geographic JSON |
| Shapefile | Shapefile | ESRI Shapefile |
| GeoPackage | GeoPackage | OGC GeoPackage |
| CSV | CSV | Comma-separated values |
| KML | KML | Keyhole Markup Language |
| XLSX | XLSX | Excel spreadsheet |
| Parquet | Parquet | Apache Parquet columnar data format |

---

This glossary is a reference for the German labels of the GOAT interface. It helps bridge the gap between the English documentation and the German user interface, so both use the same terms.

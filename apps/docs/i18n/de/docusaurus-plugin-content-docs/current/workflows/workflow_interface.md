---
description: "Erstellen Sie Workflows auf der Leinwand aus verbundenen Datensatz-, Werkzeug- und Bedingung-Knoten, führen Sie sie aus und speichern Sie sie als Vorlage."
sidebar_position: 1
---

# Workflow-Benutzeroberfläche

**Workflows** in GOAT bieten ein mächtiges visuelles Automatisierungssystem zur Erstellung anspruchsvoller räumlicher Analysepipelines. Anstatt einzelne Werkzeuge nacheinander auszuführen, können Sie mehrere Analyseschritte mit einer Drag-and-Drop-Leinwand verbinden und dabei eine automatisierte Datenverarbeitung erstellen, die wiederholende manuelle Arbeit eliminiert.

Die Workflows können bei verschiedenen Datensätzen und Szenarien wiederverwendet werden. Jeder Workflow besteht aus verschiedenen Arten von Knoten, die durch Kanten verbunden sind, und ermöglicht Ihnen:

- **Automatisierung komplexer analytischer Pipelines**: Verketten Sie mehrere Werkzeuge, bei denen die Ausgabe einer Analyse automatisch in die nächste eingespeist wird
- **Erstellen von Multi-Source-Daten-Workflows**: Bauen Sie anspruchsvolle Analyseprozesse auf, die mehrere Datensätze und Verarbeitungsschritte integrieren
- **Dokumentieren automatisierter Prozesse**: Fügen Sie Textanmerkungen hinzu, um Methodik und analytische Entscheidungen zu erklären
- **Ausführung mit flexibler Automatisierung**: Führen Sie einzelne Knoten aus, führen Sie Workflow-Segmente aus oder automatisieren Sie ganze Pipelines
- **Erstellen wiederverwendbarer Automatisierungsvorlagen**: Speichern Sie Workflows innerhalb von Projekten für die Wiederholbarkeit bei verschiedenen Szenarien
- **Nutzen erweiterter Automatisierungsfeatures**: Verwenden Sie [Workflow-Variablen](variables.md) und [benutzerdefinierte SQL](custom_sql.md) für anspruchsvolle parametrisierte Analysen

Die visuelle Leinwand-Benutzeroberfläche macht komplexe räumliche Analyseautomatisierung für Benutzer aller technischen Ebenen zugänglich und bewahrt dabei die vollständige Dokumentation des analytischen Prozesses für Reproduzierbarkeit und Zusammenarbeit.

## 1. Benutzeroberflächen-Komponenten

Die Workflow-Benutzeroberfläche besteht aus zwei Hauptpanels und der Workflow-Leinwand und bietet einen intuitiven Arbeitsbereich für die visuelle Workflow-Konstruktion.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workflows/workflows_canvas-bars_de.webp').default} alt="Kartenoberfläche Übersicht" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

### Workflow-Management und Projekt-Ebenen Panel
Dieses Panel befindet sich links und ist in zwei Bereiche unterteilt:

**Workflow-Management**

- **Neu**: Klicken Sie auf <code>+ Neu</code> und wählen Sie <code>Neu erstellen</code> oder <code>Aus Vorlage</code>, um neue analytische Pipelines zu erstellen
- **Workflow-Liste**: Verwalten Sie vorhandene Workflows mit Optionen zum Umbenennen, Duplizieren und Löschen

**Projekt-Ebenen**

- **Ebenenbaum**: Schreibgeschützte Anzeige der Datenebenen des Projekts. Sie können sie per Drag-and-Drop auf die Leinwand ziehen, um den Workflow zu erstellen.
- **Ebene hinzufügen**: Fügen Sie neue Ebenen zum Projekt hinzu, um sie im Workflow- und Kartenmodus zu verwenden.

### Workflow-Leinwand

**Leinwand-Arbeitsbereich**

Der Leinwand-Arbeitsbereich ist der Ort, wo Sie Knoten per Drag-and-Drop bewegen, zoomen, schwenken und Elemente auswählen können. Er enthält mehrere Steuerungsbereiche:

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workflows/workflows_interface_de.webp').default} alt="Kartenoberfläche Übersicht" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

**Leinwand-Ansichtsleiste**: Befindet sich in der unteren linken Ecke der Leinwand:
-  <img src={require('/img/icons/plus.png').default} alt="Hineinzoomen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Hineinzoomen</code>: <strong>Vergrößert</strong> die Leinwand-Vergrößerung für detaillierte Arbeit
-  <img src={require('/img/icons/minus.png').default} alt="Rauszoomen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Rauszoomen</code>: <strong>Verringert</strong> die Leinwand-Vergrößerung, um mehr vom Workflow zu sehen
-  <img src={require('/img/icons/fit-view.png').default} alt="Ansicht anpassen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Ansicht anpassen</code>: <strong>Passt die Ansicht an</strong>, um den gesamten Workflow auf einmal anzuzeigen
-  <img src={require('/img/icons/lock.png').default} alt="Sperren" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Sperren</code>: <strong>Verhindert versehentliche Änderungen</strong>: Solange die Leinwand gesperrt ist, lassen sich Knoten und Textkarten nicht verschieben, verbinden oder löschen. Schwenken und Zoomen funktionieren weiterhin. Mit <code>Entsperren</code> können Sie wieder bearbeiten
  
**Symbolleisten-Steuerung**: Befindet sich am mittleren unteren Rand der Leinwand:
- <img src={require('/img/icons/cursor.png').default} alt="Auswählen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Auswählen</code>: <strong>Standard-Cursor</strong> zum Auswählen und Bewegen von Knoten
- <img src={require('/img/icons/text-card.png').default} alt="Textkarte" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Textkarte</code>: <strong>Fügen Sie Textanmerkungen hinzu</strong> zur Dokumentation von Workflow-Schritten
- <img src={require('/img/icons/redo.png').default} alt="Wiederholen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Wiederholen</code>: <strong>Stellt die letzte rückgängig gemachte Aktion wieder her</strong>
- <img src={require('/img/icons/undo.png').default} alt="Rückgängig" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Rückgängig</code>: <strong>Macht die letzte Aktion rückgängig</strong>
- <img src={require('/img/icons/variables.png').default} alt="Variablen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Variablen</code>: <strong>Erstellen und verwalten Sie</strong> [Workflow-Variablen](variables) für wiederverwendbare Parameter
- <img src={require('/img/icons/play.png').default} alt="Ausführen" style={{ maxHeight: "40px", maxWidth: "40px", objectFit: "cover"}}/> <code>Ausführen</code>: <strong>Führt den gesamten Workflow aus</strong>

**Minimap**: Befindet sich in der unteren rechten Ecke der Leinwand und bietet einen Übersichtsnavigator für komplexe Workflows.

**Datenansicht-Steuerung**: Befindet sich am unteren Rand der Leinwand. Wählen Sie einen Knoten aus, um das Panel zu aktivieren. Es zeigt die Daten des Layers dieses Knotens:
- <code>Tabelle</code>: Öffnet die Attributtabelle des ausgewählten Knotens
- <code>Karte</code>: Öffnet eine Kartenvorschau des Layers des ausgewählten Knotens (nur verfügbar, wenn der Layer Geometrie enthält)

### Tastenkürzel

Unter macOS verwenden Sie `⌘` statt `Strg`.

| Tastenkürzel | Aktion |
|---|---|
| `Entf` oder `Rücktaste` | Ausgewählten Knoten, ausgewählte Textkarte oder Verbindung löschen |
| `Strg+Z` | Letzte Änderung rückgängig machen |
| `Strg+Umschalt+Z` oder `Strg+Y` | Zuletzt rückgängig gemachte Änderung wiederholen |
| `Strg` + Klick | Knoten oder Textkarte zur Auswahl hinzufügen |
| Pfeiltasten | Ausgewählten Knoten oder ausgewählte Textkarte verschieben |
| `Esc` | Auswahl aufheben |

Mit der Maus ziehen Sie auf einer leeren Stelle der Leinwand, um sie zu verschieben, und scrollen, um zu zoomen.

- Rückgängig und Wiederholen wirken nicht, während Sie in einem Feld tippen, etwa in einer Textkarte oder einer Werkzeugeinstellung.
- Das Verschieben von Knoten und Textkarten lässt sich noch nicht rückgängig machen.
- Solange die Leinwand mit <code>Sperren</code> gesperrt ist, löscht `Entf` nichts.

### Werkzeuge und Konfigurations-Panel
Das rechte Panel ändert sich je nachdem, ob ein Knoten ausgewählt ist oder nicht. Wenn kein Knoten ausgewählt ist, wird das **Werkzeuge und Verlauf Panel** sichtbar. Wenn ein Werkzeug-Knoten ausgewählt ist, erscheint das **Konfigurations-Panel**, und wenn ein Datensatz-Knoten ausgewählt ist, erscheint das **Datensatz-Panel**.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/workflows/workflow_right-panel_de.webp').default} alt="Kartenoberfläche Übersicht" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div> 

**Werkzeuge und Verlauf Panel**

**Werkzeuge Tab**

Dieser Tab enthält kategorisierte Werkzeuge, die für die Workflow-Konstruktion verfügbar sind, ähnlich der Karten-Modus-Toolbox. Ziehen Sie Werkzeuge per Drag-and-Drop auf die Leinwand, um sie zu Ihrem Workflow hinzuzufügen. Die Werkzeuge sind in die folgenden Kategorien unterteilt:

- **Daten I/O**
  - <code>+ Datensatz hinzufügen</code>: Erstellt Datensatz-Knoten
  - <code>Daten abrufen</code>: Ruft OpenStreetMap- oder Overture-Maps-Features aus der Kopie von GOAT ab, bei jeder Ausführung neu. Der Knoten hat keinen Eingang. Beschrieben unten unter **Knoten Daten abrufen**.
  - <code>Als Datensatz speichern</code>: Speichert Workflow-Ergebnisse als permanente Datensätze. Konfigurieren Sie den **Datensatznamen** (Feld <code>Datensatzname</code>), aktivieren Sie **Zum Projekt hinzufügen**, um das Ergebnis automatisch zur Projektlayerliste hinzuzufügen, und aktivieren Sie **Bei erneutem Ausführen überschreiben**, um das zuvor exportierte Dataset bei jeder Ausführung des Workflows zu ersetzen, anstatt einen neuen Datensatz zu erstellen.

:::tip Gute Praxis
Vergeben Sie für jeden **Als Datensatz speichern**-Knoten einen aussagekräftigen Namen und aktivieren Sie **Bei erneutem Ausführen überschreiben**, wenn Sie denselben Workflow mehrfach ausführen. So bleibt Ihr Projekt übersichtlich und es entstehen keine doppelten Layer nach jeder Ausführung.
:::

**Knoten Daten abrufen**

Ein <code>Daten abrufen</code>-Knoten braucht keinen Eingangslayer. Er ruft OpenStreetMap- oder Overture-Maps-Features ab und tut das bei jeder Ausführung erneut, sodass das Ergebnis der Quelle folgt.

1. Ziehen Sie <code>Daten abrufen</code> auf die Leinwand und klicken Sie den Knoten an. Das Panel zeigt einen Abschnitt <code>Quelle</code> mit der Schaltfläche <code>Daten wählen</code>.
2. Klicken Sie auf <code>Daten wählen</code>. Es öffnet sich derselbe Dialog wie bei <code>OpenStreetMap</code> und <code>Overture Maps</code> in Layer hinzufügen: Wählen Sie Layertyp, Gebiet sowie Tag- oder Attributfilter oder SQL. Details finden Sie unter [Layer](../map/layers.md#layer-hinzufügen).
3. Klicken Sie auf <code>Im Workflow verwenden</code>, um die Auswahl im Knoten zu speichern. Der Knoten übernimmt einen vorgeschlagenen Namen wie „OSM points“. Mit <code>Bearbeiten</code> öffnen Sie die Auswahl erneut.

Es wird noch nichts abgerufen, daher können die folgenden Knoten schon vor der ersten Ausführung eingerichtet werden. Solange nichts gewählt ist, zeigt der Knoten ein Achtung-Symbol. Es können höchstens 1.000.000 Features abgerufen werden, und sehr große Gebiete werden abgelehnt.

- **Erreichbarkeitsindikatoren**: Alle Werkzeuge, die im Abschnitt [Erreichbarkeitsindikatoren](../category/accessibility-indicators) der Toolbox verfügbar sind
- **Geoanalyse**: Alle Werkzeuge, die im Abschnitt [Geoanalyse](../category/geoanalysis) der Toolbox verfügbar sind
- **Geoprozessierung**: Alle Werkzeuge, die im Abschnitt [Geoprozessierung](../category/geoprocessing) der Toolbox verfügbar sind
- **Datenmanagement**
  - [Verknüpfen](../toolbox/data_management/join.md), [Zusammenführen](../toolbox/data_management/merge.md) und andere Datenmanipulations-Werkzeuge
  - [Benutzerdefiniertes SQL](custom_sql.md): Erweiterte Datenverarbeitung mit SQL-Abfragen
- **Steuerung**: Fügen Sie einen <code>Bedingung</code>-Knoten hinzu, der den Layer basierend auf definierten Bedingungen in einen <strong>Wahr</strong>- oder <strong>Falsch</strong>-Pfad weiterleitet. Siehe [Bedingung](if_clause).

**Verlauf Tab**

Hier können Sie Folgendes sehen:
- **Ausführungsprotokoll**: Vorherige Workflow-Läufe mit Zeitstempeln und Status
- **Ausführungsdetails**: Dauer, Erfolg-/Fehlerstatus und Fehlermeldungen
- **Ergebniszugriff**: Links zu vorherigen Workflow-Ausgaben

**Konfigurations-Panel (Werkzeug-Knoten ausgewählt)**

Wenn ein Werkzeug-Knoten ausgewählt ist, zeigt das rechte Panel das **Werkzeug-Konfigurations**-Panel an. Konfigurieren Sie alle werkzeugspezifischen Parameter für die ausgewählte Analyse. Sie können auch [Workflow-Variablen](variables.md) in Parameterfeldern für dynamische Werte verwenden.

**Datensatz Panel (Datensatz-Knoten ausgewählt)**

Wenn ein **Datensatz-Knoten** ausgewählt ist, erscheint das Datensatz-Panel mit zwei verfügbaren Tabs:

**Quelle Tab**: Zeigen Sie Metadaten aus der Datenquelle an und greifen Sie auf Tabellen- und Kartenansichten zu. Sie können auch den dem Knoten zugewiesenen Datensatz von diesem Tab aus ändern.

Ein leerer Datensatz-Knoten zeigt <code>Datensatz hinzufügen</code> mit zwei Quellen: <code>Aus Projekt</code> und <code>Meine Datensätze</code>. Sobald ein Datensatz gesetzt ist, wählen Sie mit <code>Datensatz ändern</code> einen anderen.

**Filter Tab** schon vor der ersten Ausführung eingerichtet werden können. Mit <code>Bearbeiten</code> öffnen Sie die Auswahl erneut.
- Jede Ausführung holt die Daten neu, das Ergebnis folgt also Änderungen in der Quelle.
- Kann die Verbindung nicht ausgeführt werden, zeigt der Knoten ein Hinweis-Symbol mit dem Grund, zum Beispiel wenn eine Ausführung stoppte, weil der WFS nicht erreichbar war.
- Es werden höchstens 1.000.000 Features abgerufen, sehr große Gebiete werden abgelehnt. <code>Im Workflow verwenden</code> bleibt deaktiviert, bis die Auswahl gültig ist, und nennt den Grund.

**Filter Tab**: Wenden Sie spezifische Filter für den Workflow an, ohne die ursprüngliche Ebene zu beeinträchtigen.

## 2. Beispielhafte Anwendungsfälle

- **Erreichbarkeitsanalyse-Pipeline**: Erstellen Sie [Einzugsgebiete](../toolbox/accessibility_indicators/catchments.md), überschneiden Sie mit Bevölkerungsdaten, berechnen Sie Erreichbarkeitsindikatoren und exportieren Sie Ergebnisse
- **Standorteignungsbewertung**: [Puffern](../toolbox/geoprocessing/buffer.md) Sie Beschränkungen, führen Sie räumliche Überlagerungen durch, wenden Sie Gewichtungsfaktoren an und bewerten Sie geeignete Standorte
- **Multi-Source-Datenintegration**: [Verknüpfen](../toolbox/data_management/join.md) Sie mehrere Datensätze, wenden Sie räumliche Filter an, aggregieren Sie Statistiken und erstellen Sie umfassende analytische Ausgaben
- **Qualitätsbewertungs-Workflow**: Validieren Sie Datenqualität, prüfen Sie räumliche Beziehungen, generieren Sie Validierungsberichte mit [benutzerdefinierter SQL](custom_sql.md)
- **Vergleichende Szenarioanalyse**: Verwenden Sie [Workflow-Variablen](variables.md), um identische Analysen mit unterschiedlichen Parametern oder Datensätzen durchzuführen

## 3. Wie man die Workflow-Benutzeroberfläche verwendet

:::tip Erste Schritte
Beginnen Sie mit einfachen 2-3 Knoten-Workflows, um die Benutzeroberfläche zu verstehen, und bauen Sie dann schrittweise komplexere analytische Pipelines auf, wenn Sie sich mit dem System vertraut gemacht haben.
:::

### Erstellen Ihres ersten Workflows

<div class="step">
  <div class="step-number">1</div>
  <div class="content"><strong>Navigieren Sie zu Workflows</strong>: Klicken Sie auf den Tab <code>Workflows</code> in GOATs Hauptnavigation, um auf die Workflow-Benutzeroberfläche zuzugreifen.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content"><strong>Erstellen Sie einen neuen Workflow</strong>: Klicken Sie auf <code>+ Neu</code> im linken Panel und wählen Sie <code>Neu erstellen</code>, um mit einer leeren Leinwand zu beginnen, oder <code>Aus Vorlage</code>, um von einem fertigen Workflow zu starten (siehe <a href="#mit-einer-vorlage-starten">Mit einer Vorlage starten</a>). Ein neuer Workflow wird mit einem Standardnamen zur Liste hinzugefügt.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content"><strong>Benennen Sie ihn um</strong>: Öffnen Sie das <code>Weitere Optionen</code>-Menü des Workflows und wählen Sie <code>Umbenennen</code>, um ihm einen Namen zu geben, der Ihr analytisches Ziel widerspiegelt (z.B. „Städtische Erreichbarkeitsanalyse").</div>
</div>

### Erstellen Ihres Workflows

<div class="step">
  <div class="step-number">1</div>
  <div class="content"><strong>Datenquellen hinzufügen</strong>: Fügen Sie Daten zu Ihrem Workflow hinzu, indem Sie entweder <code>+ Datensatz hinzufügen</code> vom Werkzeuge Tab des rechten Panels auf die Leinwand ziehen oder indem Sie Ebenen direkt vom Projekt-Ebenen Panel links ziehen. Konfigurieren Sie den Datensatz-Knoten so, dass er auf Ihre Eingangsdaten-Ebenen verweist.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content"><strong>Analysewerkzeuge hinzufügen</strong>: Durchsuchen Sie die kategorisierten Werkzeugabschnitte und ziehen Sie die erforderlichen Analysewerkzeuge auf Ihre Leinwand. Werkzeuge sind nach Funktionen organisiert (Erreichbarkeit, Geoprozessierung, usw.).</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content"><strong>Workflow-Elemente verbinden</strong>: Erstellen Sie Kanten, indem Sie von Ausgabehandles zu Eingabehandles ziehen. GOAT validiert automatisch die Geometriekompatibilität.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content"><strong>Parameter konfigurieren</strong>: Klicken Sie auf jeden Werkzeug-Knoten, um Analyseparameter zu setzen. Verwenden Sie Workflow-Variablen für flexible, wiederverwendbare Konfigurationen.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content"><strong>Dokumentieren Sie Ihren Prozess</strong>: Fügen Sie Textanmerkungen hinzu, um Ihre Methodik und analytischen Entscheidungen zu erklären.</div>
</div>

### Ausführung und Verwaltung von Workflows

<div class="step">
  <div class="step-number">1</div>
  <div class="content"><strong>Workflow ausführen</strong>: Verwenden Sie die Option <code>Workflow ausführen</code>, um den gesamten Workflow von Anfang bis Ende auszuführen.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content"><strong>Ausführung überwachen</strong>: Beobachten Sie die Fortschrittsindikatoren und prüfen Sie den Job-Status in der Hauptbenutzeroberfläche für Ausführungsupdates.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content"><strong>Ergebnisse überprüfen</strong>: Verwenden Sie die Schaltflächen <code>Tabelle</code> und <code>Karte</code> am unteren Rand der Leinwand, um die Ergebnisse des ausgewählten Knotens zu inspizieren, sobald der Workflow abgeschlossen ist.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content"><strong>Ergebnisse speichern</strong>: Fügen Sie Export-Knoten hinzu und konfigurieren Sie sie, um wichtige Ergebnisse als permanente Datensätze in Ihrem Projekt zu speichern.</div>
</div>

:::info Auto-Speicher-Feature
Workflows speichern Änderungen automatisch, während Sie sie erstellen. Das System bewahrt alle Konfigurationen, Verbindungen und Ausführungszustände auf.
:::

### Mit einer Vorlage starten

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie im <code>Workflows</code>-Panel auf <code>Aus Vorlage</code>, um die Vorlagenübersicht zu öffnen, gefiltert auf Workflow-Vorlagen.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Suchen oder blättern Sie, wählen Sie eine Vorlage für die <strong>Vorschau</strong> und klicken Sie auf <code>Vorlage verwenden</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Der Workflow wird zu Ihrem Projekt hinzugefügt. Wo die Vorlage eine Eingabe offen gelassen hat, wählen Sie einen Layer, sobald er im Projekt vorhanden ist.</div>
</div>

### Einen Workflow als Vorlage speichern

Sobald ein Workflow eingerichtet ist, können Sie ihn als **Vorlage** speichern, damit er ohne erneute Einrichtung mit anderen Daten oder von anderen Personen wiederverwendet werden kann.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Öffnen Sie das <code>Weitere Optionen</code>-Menü des Workflows und wählen Sie <code>Als Vorlage speichern…</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Geben Sie der Vorlage einen <code>Namen</code> und optional eine <code>Beschreibung</code> sowie Kategorien.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie den <code>Speicherort</code> (einen Bereich und Ordner), an dem die Vorlage gespeichert wird. Alle, die diesen Ordner öffnen können, können die Vorlage verwenden.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Entscheiden Sie in der <code>Eingaben</code>-Tabelle für jeden Eingabe-Layer, ob er <strong>mit der Vorlage mitgeliefert</strong> wird oder die Vorlage <strong>bei der Verwendung nach einem Layer fragt</strong>. Ein mitgelieferter Layer wird zusammen mit der Vorlage geteilt, damit andere sie ausführen können. Für einen mitgelieferten Layer können Sie auch <code>Kopie für jeden Nutzer (mit Inhalt)</code> oder <code>Leere Kopie für jeden Nutzer</code> wählen, damit alle eine eigene bearbeitbare Kopie statt Ihres schreibgeschützten Layers erhalten (siehe <a href="../getting_started/start_from_a_template#datensätze-in-einer-vorlage">Datensätze in einer Vorlage</a>).</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Klicken Sie auf <code>Speichern</code>.</div>
</div>

:::tip Ihr Styling kommt mit
Wenn Sie einen Export-Knoten ausgeführt und seinen Ergebnis-Layer gestylt haben, übernimmt die Vorlage dieses Styling. Wer die Vorlage nutzt, sieht Ihr Styling schon beim ersten Ausführen. Ein Export, der ein früheres Ergebnis überschreibt, behält das Styling dieses Layers.
:::

:::info Aktualisieren statt duplizieren
Wenn aus diesem Workflow bereits eine Vorlage gespeichert wurde, können Sie sie **aus der Quelle aktualisieren** mit der aktuellen Version, anstatt ein Duplikat zu erstellen. Da die Eingaben Teil des gespeicherten Snapshots sind, verwenden Sie <code>Vorlage aus Quelle aktualisieren</code>, um sie zu ändern.
:::

## 4. Workflows aus der Kartenansicht ausführen

Workflows können auch direkt aus der **Kartenansicht** ausgeführt werden, ohne den Workflow-Editor zu öffnen. Öffnen Sie die **Toolbox**, klicken Sie auf den Tab **Workflows** und wählen Sie einen Workflow aus der Liste. Wenn der Workflow [Variablen](variables.md#workflows-mit-variablen-aus-der-kartenansicht-ausf%C3%BChren) enthält, erscheint ein Abschnitt **Variablen**, in dem Sie Werte vor der Ausführung festlegen können.

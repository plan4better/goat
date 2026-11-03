---
description: "Erstellen Sie ein erstes Projekt, fügen Sie Layer hinzu, nutzen Sie die Werkzeuge, gestalten Sie die Karte und veröffentlichen Sie sie per Link oder iframe."
sidebar_position: 3
---

# Schnellstartanleitung
Willkommen bei GOAT! Diese Schnellstartanleitung hilft Ihnen dabei, schnell loszulegen. Folgen Sie diesen Schritten, um ein Projekt zu erstellen, Daten hinzuzufügen, Ihre erste Analyse durchzuführen, Ihre Karte zu gestalten und Ihre Arbeit zu teilen.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="https://www.youtube.com/embed/oYdsVw0slLc?si=tpjSR3xi-r0dZ1cU&amp;start=46" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

## Neues Projekt erstellen

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Nach der Anmeldung landen Sie auf der <code>Startseite</code>. Klicken Sie auf <code>Neues Projekt</code> und wählen Sie <code>Leeres Projekt</code>. Bei Ihrem ersten Besuch klicken Sie stattdessen in der Checkliste <code>Arbeitsbereich einrichten</code> auf <code>Neues Projekt</code>. Alternativ scrollen Sie nach unten zu <code>Mit einer Vorlage starten</code>, klicken auf eine Vorlage, dann auf <code>Vorlage verwenden</code> und folgen dem Dialog.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Geben Sie einen <b>Projektnamen</b> ein und klicken Sie auf <code>Projekt erstellen</code>. Das Projekt öffnet sich in der Kartenansicht.</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <Video src={require('/img/getting_started/new-project.mp4').default} alt="Workspace bei GOAT" style={{ maxHeight: "auto", maxWidth: "75%", objectFit: "cover"}}/>
</div>

## Daten zu Ihrem Projekt hinzufügen
Sie sind in der Kartenansicht Ihres neuen Projekts gelandet. Jetzt ist es Zeit, einige Daten hinzuzufügen.

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Klicken Sie oben im Panel <code>Layer</code> auf der linken Seite auf <code>Layer hinzufügen</code>. In einem leeren Projekt befindet sich die Schaltfläche in der Mitte des Panels. Wählen Sie unter <code>Neue Daten</code> <code>Datensatz hochladen</code>, <code>Layer erstellen</code>, um einen leeren Layer anzulegen, oder <code>Daten abrufen / verbinden</code> für eine WMS-, WMTS-, WFS-, XYZ- oder COG-Quelle. Wählen Sie unter <code>Vorhandene Daten</code> <code>Meine Datensätze</code> oder <code>Katalog</code>, um einen Datensatz hinzuzufügen, der bereits in GOAT vorhanden ist. Weitere Details zu den einzelnen Optionen finden Sie unter [Layer](../map/layers).</div>
</div>

## Analysewerkzeuge erkunden
Je nach den Layern, die Sie hinzugefügt haben, können Sie verschiedene Analysen aus dem Werkzeugkasten ausführen.

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Klicken Sie auf der Karte, direkt rechts neben dem Panel <code>Layer</code>, auf das Werkzeugkasten-Symbol <img src={require('/img/icons/toolbox.png').default} alt="Werkzeugkasten" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>. Der <code>Werkzeugkasten</code> öffnet sich auf der rechten Seite.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Im Tab <code>Werkzeuge</code> sind die Werkzeuge in <code>Erreichbarkeitsindikatoren</code>, <code>Geoverarbeitung</code>, <code>Geoanalyse</code> und <code>Datenmanagement</code> gruppiert. Klicken Sie auf das Werkzeug, das Sie verwenden möchten, und vervollständigen Sie seine Einstellungen. Weitere Details finden Sie unter [Werkzeugkiste](../category/toolbox).</div>
</div>

## Ihre Karte gestalten
Sobald Sie die Layer zu Ihrer Karte hinzugefügt und die Analyse berechnet haben, können Sie deren Erscheinungsbild anpassen, um die Visualisierung zu verbessern.

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Klicken Sie im Panel <code>Layer</code> auf einen Layer. Seine Einstellungen öffnen sich rechts mit ausgewähltem Tab <code>Stil</code>. Wählen Sie im Abschnitt <code>Stil</code> unter <code>Füllfarbe</code> (bei einem Linien-Layer <code>Farbe</code>) die gewünschte Farbe aus. Wenn Sie nach Attribut gestalten möchten, klicken Sie daneben auf das Optionen-Symbol <img src={require('/img/icons/options.png').default} alt="Optionen-Symbol" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> und wählen Sie unter <code>Farbe basierend auf</code> ein Feld aus.</div>
</div>

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Sie können im Abschnitt <code>Stil</code> weitermachen: Wählen Sie eine <code>Palette</code> für die attributbasierten Farben, legen Sie die <code>Strichfarbe</code> fest oder aktivieren Sie bei einem Punkt-Layer <code>Benutzerdefiniertes Symbol</code>, um ein Icon als Marker zu verwenden.</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Öffnen Sie in den Abschnitten darunter <code>Beschriftungen</code> und wählen Sie unter <code>Beschriftung nach</code> ein Feld aus, aktivieren Sie das <code>Popup</code> und richten Sie seinen Inhalt ein, und legen Sie unter <code>Legende</code> fest, ob der Layer angezeigt wird, und fügen Sie einen <code>Untertitel</code> hinzu. Weitere Details finden Sie unter [Layer-Stil](../map/layer_style/style/styling).</div>
</div>

## Bereit, Ihre Arbeit zu teilen
Nachdem Sie Ihr erstes Projekt in GOAT erstellt haben, ist es Zeit, es mit anderen zu teilen. Sie können es als öffentlichen Link oder iframe veröffentlichen oder in den Tabs <code>Personen</code> und <code>Teams</code> des Dialogs <code>Teilen</code> mit Kolleginnen und Kollegen teilen.

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Klicken Sie auf <code>Teilen</code> in der oberen rechten Ecke der Karte.</div>
</div>

<div class="step">
  <div class="step-number">10</div>
  <div class="content">Öffnen Sie den Tab <code>Öffentlich</code> und klicken Sie auf <code>Im Web veröffentlichen</code>, um Ihre Karte öffentlich zu machen.</div>
</div>

<div class="step">
  <div class="step-number">11</div>
  <div class="content">Klicken Sie unter <code>Adresse</code> auf <code>Link kopieren</code>, um einen direkten Link zu teilen. Klicken Sie unter <code>Einbetten</code> neben <code>Code einbetten</code> auf <code>Kopieren</code>, um den iframe-Code für eine Website zu kopieren. Weitere Details finden Sie unter [Öffentliches Teilen](../sharing/public).</div>
</div>

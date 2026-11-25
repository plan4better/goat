---
description: "Erstellen Sie Punkt-, Linien-, Polygon- oder Tabellen-Layer, bearbeiten Sie Features auf der Karte und Attribute in der Tabelle und ergänzen Sie Formelfelder."
sidebar_position: 3
---

# Layer-Bearbeitung

In GOAT können Sie **eigene Layer erstellen** und **Features direkt auf der Karte bearbeiten**. So können Sie neue Daten digitalisieren, Attribute hinzufügen und vorhandene Features anpassen, ohne die Kartenansicht zu verlassen.

## Layer erstellen

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie im linken Panel auf <code>+ Layer hinzufügen</code> und wählen Sie <code>Layer erstellen</code>. Der Dialog zeigt alles auf einer Seite: den Namen des Layers, seinen Geometrietyp und seine Felder.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Geben Sie einen <b>Layername</b> ein und wählen Sie den <b>Geometrietyp</b>: <code>Punkt</code>, <code>Linie</code>, <code>Polygon</code> oder <code>Tabelle</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Unter <b>Felder</b> hat der Layer zunächst ein <code>name</code>-Feld. Klicken Sie auf <code>+ Feld hinzufügen</code>, um weitere Felder hinzuzufügen. Geben Sie den Namen jedes Felds in der Liste links ein und wählen Sie ein Feld aus, um rechts seinen <code>Feldtyp</code> festzulegen: <code>Text</code>, <code>Zahl</code>, <code>Datum</code>, <code>Boolesch</code>, <code>Laufende Nummer</code> oder <code>UUID (eindeutige Kennung)</code>. Felder vom Typ <code>Laufende Nummer</code> und <code>UUID (eindeutige Kennung)</code> befüllt GOAT für jedes neue Feature selbst (siehe <a href="../data/data_types">Feldtypen</a>); bei einer Laufenden Nummer legen Sie unter <code>Beginnt bei</code> die erste Nummer fest. Um ein Feld zu entfernen, zeigen Sie mit der Maus darauf und klicken Sie auf das <code>—</code>-Symbol daneben. Klicken Sie auf <code>Layer erstellen</code>, wenn Sie fertig sind.</div>
</div>

## Features bearbeiten

Sobald der Layer erstellt wurde, können Sie Features direkt auf der Karte hinzufügen und bearbeiten.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf das <img src={require('/img/icons/3dots.png').default} alt="Optionen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Weitere Optionen</code>-Symbol neben Ihrem Layer und wählen Sie <code>Features bearbeiten</code>, um den <strong>Bearbeitungsmodus zu aktivieren</strong>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Verwenden Sie die <strong>Bearbeitungsleiste</strong> am unteren Kartenrand: Klicken Sie auf <code>+</code>, um ein <strong>neues Feature hinzuzufügen</strong>, und klicken Sie auf die Karte, um die Geometrie zu zeichnen. Das Panel <b>Feature-Attribute</b> öffnet sich auf der rechten Seite. <strong>Füllen Sie die Attributwerte</strong> aus und klicken Sie auf <code>Fertig</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wenn Sie fertig sind, klicken Sie in der unteren Leiste auf <code>Speichern</code>, um Ihre <strong>Änderungen zu speichern</strong>, oder auf <code>Verwerfen</code>, um sie zu verwerfen. Die Leiste zeigt auch die Anzahl der <strong>ausstehenden Änderungen</strong> an.</div>
</div>

## Daten ansehen

**Daten ansehen** ermöglicht es Ihnen, Ihre Layer-Daten als Tabelle anzuzeigen und zu bearbeiten. Öffnen Sie die Ansicht über das <img src={require('/img/icons/3dots.png').default} alt="Optionen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Weitere Optionen</code>-Menü des Layers, um Felder zu verwalten, Attributwerte direkt in der Tabelle zu bearbeiten oder den Bearbeitungsmodus zu starten.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf das <img src={require('/img/icons/3dots.png').default} alt="Optionen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>Weitere Optionen</code>-Symbol neben Ihrem Layer und wählen Sie <code>Daten ansehen</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie in der Tabellen-Symbolleiste auf <code>Felder bearbeiten</code>, um den Dialog <b>Felder bearbeiten</b> zu öffnen, und klicken Sie dann auf <code>+ Feld hinzufügen</code>. Ein neues Feld wird der Liste hinzugefügt. Wählen Sie rechts seinen <b>Feldtyp</b> (<code>Text</code>, <code>Zahl</code>, <code>Datum</code>, <code>Boolesch</code>, <code>Laufende Nummer</code>, <code>UUID (eindeutige Kennung)</code> oder <code>Formel</code>, ein berechnetes Feld, siehe <a href="#formelfelder">Formelfelder</a> unten). Ein neues Feld vom Typ <code>Laufende Nummer</code> oder <code>UUID (eindeutige Kennung)</code> wird beim Speichern für alle vorhandenen Features befüllt und benennen Sie das Feld in der Liste um. Um ein Feld zu entfernen, klicken Sie auf das <code>—</code>-Symbol daneben. Klicken Sie auf <code>Speichern</code>, wenn Sie fertig sind.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Klicken Sie auf <code>Features bearbeiten</code> in der Tabellen-Leiste, um den Bearbeitungsmodus zu aktivieren. Sie können <strong>direkt auf eine Zelle klicken</strong>, um Attributwerte inline zu bearbeiten, den <strong>Auswahl-Cursor</strong> auf der Karte verwenden, um ein vorhandenes Feature auszuwählen und dessen Attribute im Panel <b>Feature-Attribute</b> zu aktualisieren, oder <code>+</code> nutzen, um ein neues Feature zu zeichnen. Klicken Sie auf <code>Speichern</code> oder <code>Verwerfen</code>, wenn Sie fertig sind.</div>
</div>

### Formelfelder

Der Wert eines <b>Formel</b>-Felds wird aus einem Ausdruck berechnet, den Sie schreiben, ähnlich wie eine Formelspalte in einer Tabellenkalkulation. Der Ausdruck kann Ihre anderen Felder referenzieren (teilen Sie zum Beispiel die Bevölkerung durch die Fläche, um die Dichte zu erhalten) oder Textfelder zusammenführen. Das Ergebnis wird auf jedes Feature im Layer angewendet.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Felder bearbeiten</code>, um den Dialog <b>Felder bearbeiten</b> zu öffnen, klicken Sie auf <code>+ Feld hinzufügen</code>, und setzen Sie bei ausgewähltem neuen Feld rechts seinen <code>Feldtyp</code> auf <code>Formel</code> (und benennen Sie das Feld in der Liste um).</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf <code>Formel hinzufügen</code>, um den <b>Formel-Editor</b> zu öffnen. Schreiben Sie einen Ausdruck und referenzieren Sie Ihre anderen Felder über ihren Namen in doppelten Anführungszeichen (zum Beispiel <code>"population"</code>). Über den Tab <b>Aufbau</b> können Sie Felder, Operatoren und Funktionen einfügen, und der Tab <b>Vorschau</b> zeigt ein Beispielergebnis. Ein grünes Häkchen bestätigt, dass der Ausdruck gültig ist.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Klicken Sie auf <code>Anwenden</code> und anschließend im Dialog „Felder bearbeiten" auf <code>Speichern</code>. GOAT berechnet die Werte für alle Features und hält sie automatisch aktuell.</div>
</div>

**Beispiele:**

- <code>"population" / "area_km2"</code>: Bevölkerungsdichte
- <code>round("population" / "area_km2", 1)</code>: Dichte auf eine Nachkommastelle gerundet
- <code>concat_ws(', ', "city", "country")</code>: Textfelder zusammenführen (z. B. `Berlin, Germany`)
- <code>if("population" &gt; 100000, 'large', 'small')</code>: nach einem Schwellenwert klassifizieren

:::info
Die Werte einer Formel werden automatisch aktualisiert, wenn sich die referenzierten Felder ändern. Eine Formel muss einen Zahlen-, Text-, Wahr/Falsch- oder Datumswert ergeben. Formelfelder sind nur für bereits vorhandene Layer verfügbar.
:::

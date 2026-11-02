---
description: "Verwalten Sie Profil, Präferenzen, Teams und Organisation, richten Sie den KI-Assistenten ein, behalten Sie die Nutzung Ihrer Organisation im Blick und richten Sie eigene Domains und Matomo-Analytics für veröffentlichte Dashboards ein."
sidebar_position: 5
---

# Einstellungen

Auf der **Einstellungen**-Seite können Sie Ihre Präferenzen und Einstellungen bezüglich Ihres **Kontos, Teams, Organisation, KI-Assistenten und Ihrer Nutzung** anzeigen und ändern. 

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/workspace/settings/settings_de.webp').default} alt="GOAT - Profil-Einstellungen" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "cover"}}/>
</div> 


## Konto-Einstellungen

Unter den **Konto-Einstellungen** können Sie Ihr Profil und Ihre Präferenzen anpassen. 

- Im <code>Profil</code>-Tab können Sie Ihren **Vornamen, Nachnamen** und Ihre **E-Mail-Adresse** aktualisieren und ein **Profilbild** **hochladen**.
- Im <code>Präferenzen</code>-Tab können Sie Ihre bevorzugte **Sprache** (Englisch oder Deutsch) und **Erscheinungsbild** (heller und dunkler Modus) wählen.

:::info

Wenn Sie Ihr **Konto löschen** möchten, können Sie dies auch in diesem Bereich tun. Bitte klicken Sie nur auf diese Schaltfläche, wenn Sie sich über diesen Schritt sicher sind, da dies nicht rückgängig gemacht werden kann. 

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/workspace/settings/delete_account_de.webp').default} alt="Konto löschen" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "cover"}}/>
</div> 
:::

<p>
</p>


## Team-Einstellungen

Durch einfaches Klicken auf ein Team öffnen sich die **Team-Einstellungen**. Hier können Sie:
- Ein neues Team erstellen, indem Sie auf die <code>+ Neues Team</code>-Schaltfläche klicken
- Ein bereits erstelltes Team betreten:
  - Im <code>Profil</code>-Tab können Sie, wenn Sie der **Besitzer des Teams** sind, es **umbenennen**, **die Beschreibung ändern** oder **ein Logo oder Bild hochladen**. Wenn Sie ein **Mitglied des Teams** sind, können Sie nur die Team-Informationen anzeigen.
  - Im <code>Mitglieder</code>-Tab können Sie, wenn Sie der **Besitzer des Teams** sind, **Mitglieder hinzufügen** oder **löschen**. Wenn Sie ein **Mitglied des Teams** sind, können Sie nur die Mitgliederliste anzeigen.

:::info

Wenn Sie im Profil-Tab nach unten zur Gefahrenzone scrollen, finden Sie auch eine Option zum **Löschen Ihres Teams**. Bitte klicken Sie nur auf diese Schaltfläche, wenn Sie sich über diesen Schritt sicher sind, da dies nicht rückgängig gemacht werden kann. 

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/workspace/settings/delete_team_de.webp').default} alt="Team löschen" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "cover"}}/>
</div> 
:::

## Organisations-Einstellungen

Unter den **Organisations-Einstellungen** können Sie das Profil Ihrer Organisation anpassen und die Organisationsmitglieder verwalten:

- Im <code>Profil</code>-Tab können Sie den **Namen Ihrer Organisation** ändern und **ein Logo oder Bild hochladen**. 
- Im <code>Mitglieder</code>-Tab können Sie die **Mitgliederliste** Ihrer Organisation anzeigen. Durch Klicken auf die drei Punkte <img src={require('/img/icons/3dots.png').default} alt="Optionen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> können Sie **ihre Rollen verwalten** und persönliche Informationen. Außerdem können Sie **neue Mitglieder einladen**, Ihrer Organisation per E-Mail beizutreten.

:::info

Wenn Sie zur Gefahrenzone nach unten scrollen, finden Sie auch eine Option zum **Löschen Ihrer Organisation**. Bitte klicken Sie nur auf diese Schaltfläche, wenn Sie sich über diesen Schritt sicher sind, da dies nicht rückgängig gemacht werden kann. 

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/workspace/settings/delete_organization_de.webp').default} alt="Organisation löschen" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "cover"}}/>
</div> 
:::

<p>
</p>

## KI

Unter **KI** können Eigentümer und Administratoren der Organisation **den KI-Assistenten für die Organisation einrichten**. Dieser Menüeintrag erscheint nur, wenn der KI-Assistent auf Ihrer GOAT-Instanz läuft.

- Aktivieren Sie `KI für diese Organisation aktivieren`, damit alle Mitglieder den Assistenten mit ihren eigenen GOAT-Berechtigungen nutzen können.
- Wählen Sie unter `Aktive Verbindung` die Modellverbindung, die Ihre Mitglieder nutzen. `GOAT AI (inklusive)` ist die integrierte Verbindung; wenn Ihre Instanz es angibt, zeigt die Option, wo GOAT AI gehostet wird, z. B. `Gehostet in der EU`. Ihre eigenen Verbindungen können Sie auswählen, sobald ihr Test bestanden ist.
- Wählen Sie unter `Datenrichtlinie` zwischen `Standard` (der Assistent darf alles an das Modell senden, was ein Mitglied sehen kann) und `Eingeschränkt` (nur Feldnamen, Typen, Anzahlen und Statistiken werden gesendet).
- Fügen Sie unter `Verbindungen` mit `Verbindung hinzufügen` Ihren eigenen Anbieter, Schlüssel und Ihr eigenes Modell hinzu und prüfen Sie die Verbindung mit `Verbindung testen`.

Klicken Sie auf `Speichern`, um Ihre Änderungen zu übernehmen.

<p>
</p>

## Nutzung

Unter **Nutzung** können Eigentümer und Administratoren der Organisation **verfolgen, wie viel der Kontingente der Organisation genutzt wird**. Dieser Menüeintrag erscheint nur, wenn GOAT mit Abrechnung betrieben wird; selbst gehostete Instanzen haben ihn nicht.

Die Seite zeigt fünf Kacheln: `Credits`, `KI-Credits`, `Speicher`, `Projekte` und `Bearbeiter`. Jede Kachel zeigt, wie viel ihres Limits genutzt ist; ein Punkt markiert eine Kachel, die 90 % ihres Limits erreicht oder überschritten hat. Klicken Sie auf eine Kachel, um darunter ihre Details zu öffnen:

- `Credits` und `KI-Credits`: die genutzte Menge, ein Diagramm pro Tag und eine Liste, die Sie über `Gruppierung` ordnen (`Workflows`, `Werkzeuge`, `Layer`, `Mitglieder` oder `Zeiträume` bei Credits; `Mitglieder`, `Tage` oder `Zeiträume` bei KI-Credits). Wählen Sie den Zeitraum, z. B. `Dieser Zeitraum`, `Letzte 30 Tage` oder `Eigener Zeitraum`, grenzen Sie die Details auf ein Mitglied ein und laden Sie die Liste mit `CSV exportieren` herunter.
- `Speicher`: die Layer der Organisation, die größten zuerst. Filtern Sie sie nach Besitzer, Typ oder `In keinem Projekt` und laden Sie die Liste mit `CSV exportieren` herunter.
- `Projekte`: die Projekte der Organisation, die neuesten zuerst. Durchsuchen Sie sie und filtern Sie sie nach Besitzer.
- `Bearbeiter`: die Plätze für Bearbeiter und Betrachter, mit den Credits und KI-Credits, die jedes Mitglied in diesem Zeitraum genutzt hat. Klicken Sie auf ein Mitglied, um seine Nutzung unter `Credits` oder `KI-Credits` zu öffnen.

:::info

Um ein Limit zu erhöhen, klicken Sie in den Details einer Kachel auf `Mehr anfragen` oder kontaktieren Sie jederzeit den **[Support](https://plan4better.de/en/contact/ "Support kontaktieren")**. 

:::

<p>
</p>

## White Label

Unter **White Label** können Sie Dashboards auf Ihrer eigenen Domain veröffentlichen und Analytics-Tracking für veröffentlichte Dashboards konfigurieren. White-Label-Einstellungen gelten für die gesamte Organisation und sind für Organisationsinhaber zugänglich.

### Eigene Domains

**Veröffentlichen Sie Ihre Dashboards unter Ihrer eigenen Domain.** Jede Domain bedient ein veröffentlichtes Projekt. Um eine Domain einem Projekt zuzuweisen, wählen Sie sie im Dialog `Teilen` des Projekts im Tab `Öffentlich` unter `Adresse`; siehe [Öffentliches Teilen](../sharing/public).

**So fügen Sie eine eigene Domain hinzu:**

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Erste Domain hinzufügen</code> (Leer-Zustand) oder auf <code>+ Eigene Domain hinzufügen</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Geben Sie im Dialog <strong>Eigene Domain hinzufügen</strong> Ihren <code>Domainnamen</code> ein, entweder eine Subdomain (z. B. <code>dashboards.example.com</code>) oder eine Apex-Domain (z. B. <code>example.com</code>). Klicken Sie auf <code>Weiter</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">
  Der Schritt <strong>DNS konfigurieren</strong> öffnet sich und zeigt den genauen Eintrag, den Sie bei Ihrem DNS-Anbieter erstellen müssen. Der Eintragstyp hängt von Ihrer Domain ab:
    <br/><br/>
    <strong>Subdomain</strong> (z. B. <code>maps.example.com</code>):
    <table><thead><tr><th>Typ</th><th>Host</th><th>Ziel</th><th>TTL</th></tr></thead><tbody><tr><td>CNAME</td><td>maps</td><td>cname.goat.plan4better.de</td><td>3600</td></tr></tbody></table>
    <br/>
    <strong>Apex-Domain</strong> (z. B. <code>example.com</code>):
    <table><thead><tr><th>Typ</th><th>Host</th><th>Ziel</th><th>TTL</th></tr></thead><tbody><tr><td>A</td><td>@</td><td>46.225.38.48</td><td>3600</td></tr></tbody></table>
    <br/>
    Der Dialog enthält Kopierschaltflächen für jeden Wert. GOAT prüft die DNS-Propagierung automatisch alle 30 Sekunden. Klicken Sie auf <code>Jetzt erneut prüfen</code> für eine sofortige Prüfung oder auf <code>Fertig</code>, um den Dialog zu schließen und im Hintergrund zu warten.
  </div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Sobald DNS verifiziert ist, zeigt der Dialog eine <strong>DNS verifiziert</strong>-Bestätigung und GOAT stellt automatisch ein SSL-Zertifikat von <strong>Let's Encrypt</strong> aus, meist in unter 2 Minuten. Der Domain-Status wechselt zu <strong>Zertifikat wird ausgestellt</strong> und danach zu <strong>Aktiv</strong>.</div>
</div>

**Domain-Status in der Liste:**

| Status | Beschreibung | Verfügbare Aktionen |
| --- | --- | --- |
| Warte auf DNS | DNS-Eintrag noch nicht erkannt | DNS anzeigen, Erneut prüfen |
| Zertifikat wird ausgestellt | DNS verifiziert, SSL-Zertifikat wird ausgestellt | Details |
| Aktiv | Domain ist aktiv und bedient Dashboards | Zuweisung aufheben (wenn zugewiesen), Löschen |
| Fehlgeschlagen | DNS- oder Zertifikat-Provisioning fehlgeschlagen | Details, Erneut versuchen, Löschen |

Um DNS-Eintragsdetails anzuzeigen oder eine fehlgeschlagene Domain zu analysieren, klicken Sie auf **Details** oder **DNS anzeigen**, um die Domain-Detailansicht zu öffnen. Diese zeigt den aktuellen DNS- und Zertifikatstatus sowie eine Schaltfläche **Jetzt erneut prüfen**.

Um eine Domain von einem Projekt zu entfernen, ohne sie zu löschen, verwenden Sie den **Teilen**-Dialog des Projekts. Die Schaltfläche **Zuweisung aufheben** in der Domain-Liste wird nur angezeigt, wenn die Domain aktiv und zugewiesen ist.

### Analytics

**Konfigurieren Sie Analytics-Tracking für Ihre veröffentlichten Dashboards.** Sie können mehrere Analytics-Instanzen hinzufügen, eine pro Matomo-Site. Das Tracking erfolgt per Opt-in pro Dashboard über den Teilen-Dialog.

GOAT unterstützt derzeit **Matomo** als Analytics-Anbieter.

**So fügen Sie eine Analytics-Instanz hinzu:**

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>+ Analytics hinzufügen</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">
  Füllen Sie im Dialog <strong>Analytics hinzufügen</strong> folgende Felder aus:
    <ul>
      <li><code>Name</code>: ein Label zur Unterscheidung der Instanzen, z. B. <code>Client XY Matomo</code>.</li>
      <li><code>Anbieter</code>: wählen Sie <code>Matomo</code>.</li>
      <li><code>Matomo-URL</code>: die URL Ihrer Matomo-Instanz inklusive abschließendem Schrägstrich (z. B. <code>https://matomo.example.org/</code>).</li>
      <li><code>Site-ID</code>: zu finden in Matomo → Administration → Websites.</li>
    </ul>
  </div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Klicken Sie auf <code>Speichern</code>.</div>
</div>

Jede Instanz in der Liste zeigt die Matomo-URL, Site-ID und wie viele veröffentlichte Dashboards sie verwenden. Über die Symbole rechts können Sie eine Instanz **bearbeiten** oder **entfernen**. Mit **Dashboards verwalten** können Sie Dashboards einer Analytics-Instanz zuweisen oder die Zuweisung aufheben.

:::tip
Fügen Sie jede Ihrer eigenen Domains zur URL-Liste Ihrer Matomo-Site hinzu und konfigurieren Sie benutzerdefinierte Dimension 1 als "Project ID", damit eine projektweise Auswertung in Matomo funktioniert.
:::
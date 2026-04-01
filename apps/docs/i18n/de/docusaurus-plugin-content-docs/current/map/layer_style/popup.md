---
sidebar_position: 4
---
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';


# Popup

**Popups zeigen relevante Informationen an, wenn Benutzer auf Karten-Features klicken.** Dies hält Ihre Karte sauber, während detaillierte Informationen auf Anfrage bereitgestellt werden. Standardmäßig zeigen Popups alle Attributfelder an, aber Sie können anpassen, welche Felder erscheinen und wie sie beschriftet sind.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/map/styling/popup.webp').default} alt="Popup zeigt Feature-Informationen an" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>


## Wie man Popups konfiguriert

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Wählen Sie Ihren Layer und navigieren Sie zu <code>Layer Design</code> <img src={require('/img/icons/styling.png').default} alt="Styling Icon" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> und finden Sie den <code>Popup-Bereich</code></div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Wählen Sie Ihre <code>Anzeigen</code> Option: <code>Bei Klick</code> um Popup mit ausgewählten Feldern beim Klicken auf Features zu zeigen, oder <code>Niemals</code> für kein Popup</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Klicken Sie auf <code>+ Inhalt hinzufügen</code> und wählen Sie die <strong>Attributfelder</strong> aus, die Sie im Popup anzeigen möchten (Sie können mehrere Felder auswählen)</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Sie können die Felder <strong>umbenennen</strong> und sie <strong>anordnen</strong>, wie Sie möchten</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/map/styling/popup_adding.gif').default} alt="Popup-Felder und -Beschriftungen anpassen" style={{ maxHeight: "auto", maxWidth: "500px", objectFit: "cover"}}/>
</div>
<p></p>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Klicken Sie auf <code>Speichern</code>, um <strong>Ihre Änderungen anzuwenden</strong></div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Sie können jetzt auf jedes Feature in Ihrem Layer klicken, um das angepasste Popup zu sehen und zu überprüfen, dass Ihre umbenannten Attribute korrekt erscheinen</div>
</div>


## Bewährte Praktiken

- **Wählen Sie relevante Felder** aus, die Benutzern bedeutungsvollen Kontext bieten
- **Verwenden Sie klare, beschreibende Namen** anstatt technischer Feldnamen
- **Begrenzen Sie die Anzahl der Felder**, um Benutzer nicht mit Informationen zu überfordern
- **Testen Sie Ihre Popups**, um sicherzustellen, dass die Informationen nützlich und gut formatiert sind

:::info Kommt bald
Zusätzliche Popup-Anpassungsfunktionen sind in Entwicklung.
:::

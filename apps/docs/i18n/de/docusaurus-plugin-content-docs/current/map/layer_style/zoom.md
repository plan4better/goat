---
sidebar_position: 1
---
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';



# Zoom-Sichtbarkeit

**Die Zoom-Sichtbarkeitsfunktion kontrolliert den Zoom-Bereich, in dem jeder Layer auf Ihrer Karte erscheint.** Dies hilft Ihnen, die relevantesten Daten bei verschiedenen Zoom-Stufen anzuzeigen und die Kartenleistung zu optimieren.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/styling/zoom.webp').default} alt="Zoom-Sichtbarkeitsskala in GOAT" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>


## Zoom-Stufen verstehen

GOAT verwendet Zoom-Stufen von **0 (Weltansicht) bis 22 (Straßenebenen-Detail)**:

| Zoom-Stufe | Typischer Anwendungsfall         |
| ---------- | -------------------------------- |
| **0-8**    | Globaler bis regionaler Kontext  |
| **9-14**   | Stadt- bis Nachbarschaftsanalyse |
| **15-22**  | Straßenebenen-Details            |

:::info Standardeinstellungen
Alle Layer sind über die Zoom-Stufen 1-22 sichtbar, sofern nicht anders konfiguriert.
:::


## Wie man Zoom-Sichtbarkeit einstellt

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Wählen Sie Ihren Layer und navigieren Sie zu <code>Layer Design</code> <img src={require('/img/icons/styling.png').default} alt="Styling Icon" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> und finden Sie den <code>Zoom-Sichtbarkeitsbereich</code></div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Stellen Sie Ihren Bereich ein, indem Sie <strong>die Griffe auf der Skala ziehen oder Werte manuell eingeben.</strong></div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/map/styling/zoom_adjust.gif').default} alt="Zoom-Sichtbarkeitseinstellungen anpassen" style={{ maxHeight: "400px", maxWidth: "400px", objectFit: "cover"}}/>
</div>


## Bewährte Praktiken

<b>Detaillierte Features</b> (Gebäude, POIs): Verwenden Sie höhere Zoom-Stufen (14-22), um Durcheinander zu vermeiden.

<b>Regionale Daten</b> (Demografie, Grenzen): Verwenden Sie mittlere Stufen (8-16) für Kontext.

<b>Hintergrund-Layer</b> (Straßen, Wasser): Verwenden Sie den vollen Bereich (1-22) für konsistente Referenz.

<b>Zusammenfassende Daten</b> (Heatmaps, Aggregiert): Verwenden Sie niedrigere Stufen (1-14) für Überblick.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/styling/zooming_out.gif').default} alt="Zoom-Sichtbarkeits-Demonstration" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>

<p></p>

:::tip Profi-Tipp
Testen Sie Ihre Einstellungen, indem Sie hinein- und herauszoomen, um zu sehen, wie Layer bei verschiedenen Maßstäben erscheinen.
:::

:::info Verwandte Funktionen
Erkunden Sie andere [Layer-Styling](../../category/style) Optionen und kombinieren Sie mit [Filter](../filter) für erweiterte Datenpräsentation.
::: 

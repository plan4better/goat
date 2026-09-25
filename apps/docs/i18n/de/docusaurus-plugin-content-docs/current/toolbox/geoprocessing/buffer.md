---
sidebar_position: 1
---


import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';



# Puffer

Dieses Werkzeug ermöglicht es Ihnen, **Zonen um Punkte, Linien oder Polygone mit einem bestimmten Abstand zu erstellen**.

<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="https://www.youtube.com/embed/Yboi3CwOLPM?si=FuSPRmK6zTB-GVJ1" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

## 1. Erklärung

Ein Puffer ist ein Werkzeug, das verwendet wird, um **das Einzugsgebiet um einen bestimmten Punkt, eine Linie oder ein Polygon abzugrenzen und die Ausdehnung des Einflusses oder der Reichweite von diesem Feature zu veranschaulichen.** Benutzer können die ``Entfernung`` des Puffers definieren und damit den Radius des abgedeckten Bereichs anpassen.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

  <img src={require('/img/toolbox/geoprocessing/buffer/buffer_types.png').default} alt="Puffer-Typen" style={{ maxHeight: "400px", maxWidth: "400px", objectFit: "cover"}}/>

</div> 

## 2. Beispiel-Anwendungsfälle

- Analyse der Bevölkerung innerhalb von 500m um Bahnstationen
- Zählung der Geschäfte, die innerhalb von 1000m von Bushaltestellen erreichbar sind


## 3. Wie wird das Werkzeug verwendet?


<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf <code>Werkzeugleiste</code> <img src={require('/img/icons/toolbox.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>. </div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie im Menü <code>Geoprozessierung</code> auf <code>Puffer</code>.</div>
</div>

### Layer zum Puffern auswählen

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Wählen Sie den <code>Layer zum Puffern</code>, um den Sie den Puffer erstellen möchten.</div>
</div>

### Puffer-Einstellungen

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Definieren Sie über die <code>Puffer-Entfernung</code>: wie viele Meter von Ihren Punkten, Linien oder Formen der Puffer erstrecken soll.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Definieren Sie in wie viele <code>Puffer-Schritte</code> der Puffer unterteilt werden soll.</div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Konfigurieren Sie die <code>Polygon-Vereinigung</code> Einstellung:
    <ul>
      <li><b>Deaktiviert</b>: GOAT generiert einzelne Puffer um jede Eingabegeometrie</li>
      <li><b>Aktiviert</b>: GOAT erstellt eine <b>geometrische Vereinigung aller Schritte der Puffer-Polygone</b>. Der Puffer mit der größten Ausdehnung umfasst auch alle Pufferbereiche der kleineren Ausdehnung. Dieser Ansatz ist nützlich, wenn Sie die Gesamtfläche sehen möchten, die von allen Ihren Pufferschritten zusammen abgedeckt wird.</li>
    </ul>
  </div>
</div>

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Wenn Sie die <b>Polygon-Vereinigung aktiviert haben</b>, können Sie die `Polygon-Differenz` aktivieren. GOAT erstellt eine <b>geometrische Differenz der Puffer</b>. Es subtrahiert ein Polygon von einem anderen, was zu Polygonformen führt, bei denen sich die <b>Puffer nicht überlappen</b>.</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

  <img src={require('/img/toolbox/geoprocessing/buffer/polygon_union_difference.webp').default} alt="Polygon-Vereinigung + Polygon-Differenz Ergebnis in GOAT" style={{ maxHeight: "auto", maxWidth: "60%", objectFit: "cover"}}/>
</div> 

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Klicken Sie auf <code>Ausführen</code>. Dies startet die Berechnung des Puffers. Sobald diese Aufgabe abgeschlossen ist, wird der resultierende Layer namens <b>"Puffer"</b> zu Ihrer Karte hinzugefügt.</div>
</div>

<p></p>

:::tip Tipp

Möchten Sie Ihre Puffer stylen und schön aussehende Karten erstellen? Siehe [Styling](../../map/layer_style/style/styling).

:::
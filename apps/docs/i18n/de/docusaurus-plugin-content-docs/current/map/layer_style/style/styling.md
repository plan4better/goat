---
description: "Legen Sie Füll- und Strichfarbe, Deckkraft, Strichbreite, Linienstil, Clustering, eigene Marker und Punktgröße fest und kopieren Sie Stile in andere Layer."
sidebar_position: 1
---


# Basis-Styling

**Layer-Styling ermöglicht es Ihnen, das visuelle Erscheinungsbild Ihrer Daten anzupassen, um klare, ansprechende Karten zu erstellen.** GOAT weist automatisch Standard-Stile basierend auf Ihrem Datentyp (Punkte, Linien oder Polygone) zu, aber Sie können Farben, Striche, Transparenz und andere visuelle Eigenschaften anpassen.

<iframe width="100%" height="500" src="https://www.youtube.com/embed/R7nefHqPnBk?si=KWndAFlcb2uuC7CZ" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>


## Wie Sie Ihre Layer gestalten

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie im <code>Layer</code>-Panel auf Ihren Layer. Rechts öffnet sich das Einstellungs-Panel des Layers mit den Tabs <code>Stil</code>, <code>Filtern</code> und <code>Metadaten</code>; der Tab <code>Stil</code> ist ausgewählt. Die Styling-Optionen finden Sie dort im Bereich <code>Stil</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Wählen Sie die Styling-Kategorie, die Sie ändern möchten: <code>Füllfarbe</code> (Punkt- und Polygon-Layer), <code>Strichfarbe</code> (bei Linien-Layern mit <code>Farbe</code> beschriftet), <code>Strichbreite</code>, <code>Linienstil</code> (nur Linien-Layer), <code>Clustering</code>, <code>Benutzerdefiniertes Symbol</code> und <code>Punkteinstellungen</code> (nur Punkt-Layer).</div>
</div>


### Füllfarbe
Füllfarbe definiert das Innere Erscheinungsbild von Punkt- und Polygon-Features.


<div class="step">
  <div class="step-number">3</div>
  <div class="content">
    Bei <code>Farbe</code> verwenden Sie den <strong>Farbwähler, um Ihre Farbe auszuwählen</strong> oder die <strong>Standardfarben, um aus der vordefinierten Farbpalette zu wählen</strong>.
  </div>
</div>


<div class="step">
  <div class="step-number">4</div>
  <div class="content">Klicken Sie neben <code>Füllfarbe</code> auf das Optionen-Symbol <img src={require('/img/icons/options.png').default} alt="Options Icon" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>, um die erweiterten Optionen einzublenden. Bewegen Sie unter <code>Deckkraft</code> den Regler oder geben Sie einen Wert zwischen 0 (transparent) und 1 (undurchsichtig) ein, um <strong>die Transparenz zu steuern</strong>.</div>
</div>


:::info
<code>Deckkraft</code> gilt nur für die Füllung. <code>Strichfarbe</code> hat keine Einstellung für die Deckkraft: Umrisse von Punkten und Polygonen werden immer vollständig deckend gezeichnet. Linien-Layer haben keine Füllung, daher finden Sie ihren Regler <code>Deckkraft</code> in den erweiterten Optionen von <code>Farbe</code>.
:::

### Strichfarbe
Strichfarbe gilt für die Umrisse und Kanten von Karten-Features. Sie hilft dabei, Features zu unterscheiden und ihre Sichtbarkeit zu verbessern.


<div class="step">
  <div class="step-number">5</div>
  <div class="content">Bei <code>Farbe</code> verwenden Sie den <strong>Farbwähler</strong> oder die <strong>Standardfarben</strong>, um <strong>das Strich-Erscheinungsbild anzupassen</strong>.</div>
</div>


### Strichbreite

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Bei <code>Strichbreite</code> bewegen Sie den Regler, um <strong>die Dicke</strong> von Linien und Feature-Umrissen <strong>anzupassen</strong>.</div>
</div>


### Linienstil

Der Abschnitt **Linienstil** ist nur für **Linien-Layer** verfügbar und steuert das Muster und die Dekoration von Linien.

**Muster:**

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Wählen Sie unter <code>Muster</code>, wie die Linie gezeichnet wird: <code>Durchgezogen</code>, <code>Gestrichelt</code>, <code>Gepunktet</code> oder <code>Strich-Punkt</code>. Bei einem nicht-durchgezogenen Muster erscheint ein <code>Dichte</code>-Dropdown mit den Optionen <code>Eng</code>, <code>Normal</code> oder <code>Weit</code>.</div>
</div>

**Pfeile:**

<div class="step">
  <div class="step-number">8</div>
  <div class="content">
  Wählen Sie unter <code>Pfeile</code> die Pfeilrichtung: <code>Keine</code>, <code>Vorwärts</code>, <code>Rückwärts</code> oder <code>Beide</code>. Bei Auswahl einer Richtung erscheinen weitere Einstellungen:
    <ul>
      <li><code>Position</code>: wo die Pfeile platziert werden (<code>Wiederholen entlang der Linie</code>, <code>Linienanfang</code>, <code>Linienende</code>, <code>Beide Enden</code> oder <code>Mitte (eine pro Linie)</code>).</li>
      <li><code>Pfeilgröße</code>: Regler zur Steuerung der Pfeilgröße.</li>
      <li><code>Pfeilabstand</code>: Regler zum Steuern des Abstands zwischen wiederholten Pfeilen (nur sichtbar wenn Position <code>Wiederholen entlang der Linie</code> ist).</li>
      <li><code>Überlappung zulassen</code>: Checkbox, um zu verhindern, dass Pfeile bei Überlappung ausgeblendet werden.</li>
    </ul>
  </div>
</div>

**Erweiterte Optionen** (aufklappen für Zugriff):

<div class="step">
  <div class="step-number">9</div>
  <div class="content">
  Erweitern Sie <code>Erweiterte Optionen</code>, um folgende Einstellungen vorzunehmen:
    <ul>
      <li><code>Linienende</code>: wie Linienendpunkte dargestellt werden (<code>Stumpf</code>, <code>Rund</code> oder <code>Quadratisch</code>).</li>
      <li><code>Linienverbindung</code>: wie Ecken zwischen Liniensegmenten aussehen (<code>Abgeschrägt</code>, <code>Rund</code> oder <code>Spitz</code>).</li>
      <li><code>Versatz</code>: verschiebt die Linie visuell nach links oder rechts von ihrer tatsächlichen Geometrie. Nützlich für parallele Straßen oder Richtungsfahrbahnen. Hinweis: nur visuell. Auswahl und Fangen verwenden weiterhin die Originalgeometrie.</li>
    </ul>
  </div>
</div>

### Clustering
Clustering fasst nahe beieinander liegende Punkt-Features zu einem einzelnen Marker mit einer Zählung zusammen und hält die Karte übersichtlich, wenn viele Punkte übereinander liegen.

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Aktivieren Sie den <code>Clustering</code>-Schalter, um das Clustering für Ihren Punkt-Layer zu aktivieren.</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Verwenden Sie den <code>Cluster-Radius</code>-Regler, um festzulegen, wie nah Punkte beieinander sein müssen, um zu einem Cluster zusammengefasst zu werden. Ein größerer Radius gruppiert mehr Punkte zusammen.</div>
</div>

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Erweitern Sie optional <code>Erweiterte Optionen</code>, um <code>Minimale Clustergröße</code>, <code>Max. Zoom für Clustering</code>, <code>Clusterfarbe</code> und <code>Textfarbe</code> weiter zu konfigurieren.</div>
</div>

### Benutzerdefinierte Symbole
Für Punkt-Layer können Sie benutzerdefinierte Marker anstelle von Grundformen verwenden.


<div class="step">
  <div class="step-number">10</div>
  <div class="content">Im Styling-Menü schalten Sie den <code>Benutzerdefiniertes Symbol</code>-Umschalter ein, um <strong>benutzerdefinierte Marker zu aktivieren</strong>.</div>
</div>


<div class="step">
  <div class="step-number">11</div>
  <div class="content">Klicken Sie auf <code>Symbol auswählen</code> und <strong>durchsuchen Sie die Symbol-Bibliothek</strong> oder <strong>laden Sie Ihren eigenen Marker hoch</strong>, indem Sie auf den <code>Benutzerdefiniert</code>-Tab klicken und Ihre Datei hochladen (JPEG-, PNG- oder SVG-Format).</div>
</div>


<div class="step">
  <div class="step-number">12</div>
  <div class="content">Benennen Sie Ihr Symbol (dieser Name wird für die Suche verwendet). Sie können später auf <code>Symbole verwalten</code> klicken, um <strong>hochgeladene Symbole umzubenennen oder zu löschen</strong>.</div>
</div>


<div class="step">
  <div class="step-number">13</div>
  <div class="content">Bei <code>Größe</code> passen Sie die <strong>Marker-Größe</strong> mit dem Regler an.</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <Video src={require('/img/map/styling/custom_marker.mp4').default} alt="Benutzerdefinierte Marker-Auswahl" style={{ maxHeight: "450px", maxWidth: "auto", objectFit: "cover"}}/>
</div>
<p></p>


:::info
Sie können nur die Farbe von Symbolen aus der Bibliothek bearbeiten, nicht von hochgeladenen benutzerdefinierten Symbolen.
:::


### Punkteinstellungen

<div class="step">
  <div class="step-number">14</div>
  <div class="content">Unter <code>Punkteinstellungen</code>, bei <code>Größe</code> <strong>passen Sie den Radius an</strong> mit dem Regler oder geben Sie präzise Werte in das Textfeld für exakte Kontrolle ein.</div>
</div>


### Höhe {#height}

Polygone und H3-Sechsecke können in der [3D-Ansicht](../../map_interface.md#3d-view) der Karte als Körper stehen.

**Polygone.** In den Polygon-Einstellungen legt <code>Höhe</code> fest, wie hoch jedes Polygon steht:

- <code>Keine</code>: flach, ohne Höhe.
- <code>Fest</code>: eine Höhe für jedes Polygon, in Metern.
- <code>Nach Zoom</code>: Die Höhe wächst beim Hineinzoomen.
- <code>Nach Attribut</code>: die Höhe aus einem Zahlenfeld, etwa einer Höhe oder einer Geschosszahl. Felder mit Namen wie `height`, `render_height`, `building_height`, `levels`, `building_levels`, `storeys` oder `floors` werden zuerst vorgeschlagen. Für ein Feld, das Geschosse zählt, stellen Sie <code>Einheit</code> auf <code>Geschosse × 3 m</code>.
- <code>Nach Klassen</code>: eine Höhe je Klasse eines Feldes.

Solange <code>Höhe</code> gesetzt ist, hebt <code>Basishöhe</code> den Körper vom Boden ab, etwa für eine Brücke oder ein oberes Geschoss. Ein angehobener Layer hat eine Deckkraft für den ganzen Layer und zeichnet kein Füllmuster; seine Kontur bleibt am Boden, und seine Beschriftungen stehen auf den Dächern. Wird eine Höhe gesetzt, während die Karte in 2D ist, wechselt sie zu 3D.

**H3-Sechsecke.** <code>Höhe</code> macht die Sechsecke zu Säulen, so hoch wie ihr Wert. <code>Größte Höhe</code> legt die Höhe der Säule mit dem höchsten Wert fest, und <code>Skala</code> wählt <code>Linear</code> oder <code>Quadratwurzel</code>.

Die Legende nennt die Höhe unter den Farben des Layers.

## Stil kopieren und einfügen

Der Tab <code>Stil</code> im Einstellungs-Panel eines Layers bietet oben drei Schnellzugriff-Symbole zur Verwaltung von Stilen zwischen Layern: **Stil kopieren**, **Stil einfügen** und **Als Standard setzen**. So können Sie einen einheitlichen Stil auf mehrere Layer anwenden, ohne jeden einzeln zu konfigurieren.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie im <code>Layer</code>-Panel auf den Layer, dessen Stil Sie kopieren möchten. Sein Einstellungs-Panel öffnet sich mit ausgewähltem Tab <code>Stil</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Klicken Sie auf das Symbol <code>Stil kopieren</code> oben im Tab.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Klicken Sie im <code>Layer</code>-Panel auf den Ziel-Layer und oben in dessen Tab <code>Stil</code> auf <code>Stil einfügen</code>, um den kopierten Stil anzuwenden.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Klicken Sie optional auf <code>Als Standard setzen</code>, um den aktuellen Stil als Standard für zukünftige Verwendungen dieses Datensatzes zu speichern.</div>
</div>

:::tip Intelligentes Styling
Erkunden Sie [attributbasiertes Styling](./attribute_based_styling) für erweiterte Visualisierungsoptionen basierend auf Ihren Datenwerten.
:::

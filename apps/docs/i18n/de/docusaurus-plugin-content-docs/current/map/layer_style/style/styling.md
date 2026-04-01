---
sidebar_position: 1
---


# Basis-Styling

**Layer-Styling ermöglicht es Ihnen, das visuelle Erscheinungsbild Ihrer Daten anzupassen, um klare, ansprechende Karten zu erstellen.** GOAT weist automatisch Standard-Stile basierend auf Ihrem Datentyp (Punkte, Linien oder Polygone) zu, aber Sie können Farben, Striche, Transparenz und andere visuelle Eigenschaften anpassen.

<iframe width="100%" height="500" src="https://www.youtube.com/embed/R7nefHqPnBk?si=KWndAFlcb2uuC7CZ" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>


## Wie Sie Ihre Layer gestalten

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Wählen Sie Ihren Layer aus und navigieren Sie zu <code>Layer-Design</code> <img src={require('/img/icons/styling.png').default} alt="Styling-Symbol" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> und finden Sie den <code>Stil-Bereich</code></div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Wählen Sie die Styling-Kategorie, die Sie ändern möchten: <code>Füllfarbe</code>, <code>Strichfarbe</code>, <code>Strichbreite</code>, <code>Benutzerdefinierter Marker</code> und <code>Punkt-Einstellungen</code> (bei Punktdaten).</div>
</div>


### Füllfarbe
Füllfarbe definiert das Innere Erscheinungsbild von Punkt- und Polygon-Features.


<div class="step">
  <div class="step-number">3</div>
  <div class="content">
    Bei <code>Farbe</code> verwenden Sie den <strong>Farbwähler, um Ihre Farbe auszuwählen</strong> oder die <strong>Vordefinierten Farben, um aus der vordefinierten Farbpalette zu wählen</strong>.
  </div>
</div>


<div class="step">
  <div class="step-number">4</div>
  <div class="content">Verwenden Sie den <code>Transparenz-Regler</code> oder geben Sie einen Wert zwischen 0 (transparent) und 1 (undurchsichtig) ein, um <strong>die Transparenz zu steuern</strong>.</div>
</div>


### Strichfarbe
Strichfarbe gilt für die Umrisse und Kanten von Karten-Features. Sie hilft dabei, Features zu unterscheiden und ihre Sichtbarkeit zu verbessern.


<div class="step">
  <div class="step-number">5</div>
  <div class="content">Bei <code>Farbe</code> verwenden Sie den <strong>Farbwähler</strong> oder die <strong>Vordefinierten Farben</strong>, um <strong>das Strich-Erscheinungsbild anzupassen</strong>.</div>
</div>


### Strichbreite

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Bei <code>Strichbreite</code> bewegen Sie den Regler, um <strong>die Dicke</strong> von Linien und Feature-Umrissen <strong>anzupassen</strong>.</div>
</div>


### Benutzerdefinierte Marker
Für Punkt-Layer können Sie benutzerdefinierte Marker anstelle von Grundformen verwenden.


<div class="step">
  <div class="step-number">7</div>
  <div class="content">Im Styling-Menü schalten Sie den <code>Benutzerdefinierter Marker</code>-Umschalter ein, um <strong>benutzerdefinierte Marker zu aktivieren</strong>.</div>
</div>


<div class="step">
  <div class="step-number">8</div>
  <div class="content">Klicken Sie auf <code>Marker auswählen</code> und <strong>durchsuchen Sie die Symbol-Bibliothek</strong> oder <strong>laden Sie Ihren eigenen Marker hoch</strong>, indem Sie auf den <code>Benutzerdefiniert</code>-Tab klicken und Ihre Datei hochladen (JPEG-, PNG- oder SVG-Format).</div>
</div>


<div class="step">
  <div class="step-number">9</div>
  <div class="content">Benennen Sie Ihr Symbol (dieser Name wird für die Suche verwendet). Sie können später auf <code>Symbole verwalten</code> klicken, um <strong>hochgeladene Symbole umzubenennen oder zu löschen</strong>.</div>
</div>


<div class="step">
  <div class="step-number">10</div>
  <div class="content">Bei <code>Größe</code> passen Sie die <strong>Marker-Größe</strong> mit dem Regler an.</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/map/styling/custom_marker.gif').default} alt="Benutzerdefinierte Marker-Auswahl" style={{ maxHeight: "500px", maxWidth: "auto", objectFit: "cover"}}/>
</div>
<p></p>


:::info
Sie können nur die Farbe von Symbolen aus der Bibliothek bearbeiten, nicht von hochgeladenen benutzerdefinierten Symbolen.
:::


### Punkt-Einstellungen

<div class="step">
  <div class="step-number">11</div>
  <div class="content">Unter <code>Punkt-Einstellungen</code>, bei <code>Größe</code> <strong>passen Sie den Radius an</strong> mit dem Regler oder geben Sie präzise Werte in das Textfeld für exakte Kontrolle ein.</div>
</div>


## Standard-Einstellungen

Wenn Sie einen Stil erstellt haben, der Ihnen gefällt, können Sie ihn als Standard für zukünftige Verwendungen dieses Datensatzes speichern, sodass **wann immer Sie den Datensatz kopieren oder erneut hinzufügen, Ihre benutzerdefinierten Stile automatisch angewendet werden**.


<div class="step">
  <div class="step-number">1</div>
  <div class="content">Klicken Sie auf die <code>Weitere Optionen</code> <img src={require('/img/icons/3dots.png').default} alt="Optionen" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> neben <code>Aktiver Layer</code>.</div>
</div>


<div class="step">
  <div class="step-number">2</div>
  <div class="content">
    <p>Wählen Sie Ihre Aktion:</p>
    <ul>
      <li><code>Als Standard speichern</code> – <strong>Aktuelle Stile auf zukünftige Verwendungen dieses Datensatzes anwenden</strong></li>
      <li><code>Zurücksetzen</code> – <strong>Zu den ursprünglichen Standard-Stilen zurückkehren</strong></li>
    </ul>
  </div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/map/styling/save_default.webp').default} alt="Standard-Einstellungen Menü" style={{ maxHeight: "300px", maxWidth: "300px", objectFit: "cover"}}/>
</div>

<p></p>

:::tip Intelligentes Styling
Erkunden Sie [attributbasiertes Styling](./attribute_based_styling) für erweiterte Visualisierungsoptionen basierend auf Ihren Datenwerten.
:::

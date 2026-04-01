---
sidebar_position: 1
---

# Basic styling

**Layer styling allows you to customize the visual appearance of your data to create clear, appealing maps.** GOAT automatically assigns default styles based on your data type (points, lines, or polygons), but you can customize colors, strokes, opacity, and other visual properties.

<iframe width="100%" height="500" src="https://www.youtube.com/embed/R7nefHqPnBk?si=KWndAFlcb2uuC7CZ" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>

## How to style your layers

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Select your layer and navigate to <code>Layer design</code> <img src={require('/img/icons/styling.png').default} alt="Styling Icon" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> and find the <code>Style section</code></div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Choose the styling category you want to modify: <code>Fill color</code>, <code>Stroke color</code>, <code>Stroke width</code>, <code>Custom Marker</code> and <code>Point settings</code> (if point data).</div>
</div>

### Fill color
Fill color defines the interior appearance of point and polygon features.

<div class="step">
  <div class="step-number">3</div>
  <div class="content">
    <p>
     On <code>Color</code> use the <strong>Color picker to select your color</strong> or the <strong>Preset colors to choose from the predefined color palette</strong>.
    </p>
  </div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content"> Use the <code>opacity slider</code> or enter a value between 0 (transparent) and 1 (opaque) to <strong>control transparency</strong>.</div>
</div>

### Stroke color
Stroke color applies to the outlines and edges of map features. It helps distinguish features and enhance their visibility.

<div class="step">
  <div class="step-number">5</div>
  <div class="content">  On <code>Color</code> use the <strong>Color picker</strong> or the <strong>Preset colors</strong> to <strong>customize stroke appearance</strong>.</div>
</div>

### Stroke width

<div class="step">
  <div class="step-number">6</div>
  <div class="content">  On <code>Stroke width</code> move the slider to <strong>adjust the thickness</strong> of lines and feature outlines.</div>
</div>

### Custom markers
For point layers, you can use custom markers instead of basic shapes.

<div class="step">
  <div class="step-number">7</div>
  <div class="content">In the styling menu, turn on the <code>Custom Marker</code> toggle to <strong>enable custom markers</strong></div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content"> Click on <code>Select Marker</code> and <strong>browse the icon library</strong> or <strong>upload your own marker</strong> by clicking on the <code>Custom</code> tab and uploading your file (JPEG, PNG, or SVG format).</div>
</div>

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Name your icon (this name will be used for searching). You can later click on <code>Manage icons</code> to <strong>rename or delete uploaded icons</strong></div>
</div>

<div class="step">
  <div class="step-number">10</div>
  <div class="content">On <code>Size</code> adjust the <strong>marker size</strong> using the slider</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/map/styling/custom_marker.gif').default} alt="Custom marker selection" style={{ maxHeight: "500px", maxWidth: "auto", objectFit: "cover"}}/>
</div>
<p></p>

:::info
You can only edit the color of icons from the library, not uploaded custom icons.
:::

### Point settings 

<div class="step">
  <div class="step-number">11</div>
  <div class="content">
  Under <code>Point settings</code>, on <code>Size</code> <strong>adjust the radius</strong> using the slider or enter precise values in the text box for exact control.
  </div>
</div>

## Default settings

When you have created a style you like, you can save it as the default for future uses of this dataset, so **whenever you copy or re-add the dataset, your custom styles are applied automatically**.

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click on the <code> More options </code> <img src={require('/img/icons/3dots.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> next to <code> Active layer </code></div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">

  <p>Choose your action:</p>
    <ul>
      <li><code>Save as default</code> - <strong>Apply current styles to future uses</strong> of this dataset</li>
      <li><code>Reset</code> - <strong>Return to original default styles</strong></li>
    </ul>
  </div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/map/styling/save_default.webp').default} alt="Default settings menu" style={{ maxHeight: "300px", maxWidth: "300px", objectFit: "cover"}}/>
</div>

<p></p>

:::tip Smart styling
Explore [attribute-based styling](./attribute_based_styling) for advanced visualization options based on your data values.
:::

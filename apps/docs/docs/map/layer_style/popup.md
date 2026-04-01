---
sidebar_position: 4
---
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';


# Popup

**Popups display relevant information when users click on map features.** This keeps your map clean while providing detailed information on demand. By default, popups show all attribute fields, but you can customize which fields appear and how they're labeled.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/map/styling/popup.webp').default} alt="Popup displaying feature information" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>
</div>

## How to configure popups

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Select your layer and navigate to <code>Layer design</code> <img src={require('/img/icons/styling.png').default} alt="Styling Icon" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> and find the <code>Popup section</code></div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Choose your <code>Show</code> option: <code>On click</code> to show popup with selected fields when clicking features, or <code>Never</code> for no popup</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Click on <code>+ Add content</code> and select the <strong>attribute fields</strong> you want to display in the popup (you can choose multiple fields)</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">You can <strong>rename the fields and arrange them as</strong>  you want</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/map/styling/popup_adding.gif').default} alt="Customizing popup fields and labels" style={{ maxHeight: "auto", maxWidth: "500px", objectFit: "cover"}}/>
</div>
<p></p>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Click on <code>Save</code> to <strong>apply your changes</strong></div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">You can now click on any feature in your layer <strong>to view the customized popup and verify</strong> that your renamed attributes appear correctly</div>
</div>

## Best practices

- **Choose relevant fields** that provide meaningful context to users
- **Use clear, descriptive names** instead of technical field names
- **Limit the number of fields** to avoid overwhelming users with information
- **Test your popups** to ensure the information is useful and well-formatted

:::info Coming soon
Additional popup customization features are in development.
:::


---
sidebar_position: 4
---
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';


# Filter

**Filter limits data visibility on your map** using logical expressions (e.g., supermarkets with specific names) or spatial expressions (e.g., points within a bounding box). **The filter allows you to focus on relevant information without altering original data.** It works with **point layers** and **polygon layers** containing `number` and `string` data types. 

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/filter/filter_clicking.gif').default} alt="Filter tool in GOAT" style={{ maxHeight: "auto", maxWidth: "80%", objectFit: "cover"}}/>
</div> 

## How to use the filter

### Single Expression Filtering

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Select the layer to filter and click on the <code>Filter</code> <img src={require('/img/icons/filter.png').default} alt="Filter Icon" style={{ maxHeight: "20px", maxWidth: "20px"}}/> icon on the <b>tools bar</b> on the right.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">The <code>Active Layer</code> selector <strong>shows the currently selected layer</strong> for filtering.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Click <code>+ Add Expression</code> to <strong>add a new filter expression</strong>.</div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Choose <code>Logical Expression</code> or <code>Spatial Expression</code> to <strong>define your filter type</strong>.</div>
</div>

<Tabs>
  <TabItem value="Logical expression" label="Logical expression" default className="tabItemBox">

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Select the <code>Field</code> (attribute) to <strong>filter by</strong>.</div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Choose the <code>Operator</code>. Available options vary by data type: number and string.</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

| Expressions for `number` | Expressions for `string` |
| -------|----|
| is  | is |
| is not  | is not |
| includes  | includes  |
| excludes  |  excludes |
| is at least  | starts with |
| is less than | ends with |
| is at most | contains the text |
| is greater than | doesn't contain the text |
| is between | is empty string |
|  | is not empty string |

</div>


:::tip Hint
For the expressions **"includes"** and **"excludes"**, multiple values can be selected.
:::

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Set your filter criteria. The map updates automatically and shows a filter icon on the filtered layer.</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/filter/filter_atlayer.webp').default} alt="Filter Result in GOAT" style={{ maxHeight: "auto", maxWidth: "80%", objectFit: "cover"}}/>
</div> 
</TabItem>

<TabItem value="Spatial expression" label="Spatial expression" default className="tabItemBox">
<div class="step">
  <div class="step-number">5</div>
  <div class="content">Select the <code>intersection method</code> for spatial boundary.</div>
</div>

<Tabs>
  <TabItem value="Map extent" label="Map extent" default className="tabItemBox">
<div class="step">
  <div class="step-number">6</div>
  <div class="content">Layer <strong>automatically crops to current map extent</strong>. To change the filter, zoom in/out and refresh the map extent.</div>
</div>

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>

  <img src={require('/img/map/filter/Map_extend.gif').default} alt="Attribute Selection" style={{ maxHeight: "auto", maxWidth: "auto", objectFit: "cover"}}/>

</div> 
</TabItem>

<TabItem value="Boundary" label="Boundary" default className="tabItemBox">

:::info coming soon

This feature is currently under development. 🧑🏻‍💻

:::
</TabItem>
</Tabs>

</TabItem>
</Tabs>

### Multiple Expressions Filtering

**Combine multiple filters** by repeating steps 3-7 for each expression. In <code>Filter results</code>, choose **Match all filters** (AND) or **Match at least one filter** (OR) to **control how filters interact**.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/filter/filter-results.png').default} alt="Logic Operators" style={{ maxHeight: "auto", maxWidth: "30%", objectFit: "cover"}}/>
</div>

### Delete Expressions and Filters

**Remove single expressions**: Click on the <code>more options</code> <img src={require('/img/icons/3dots-horizontal.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> menu next to the expression, then click <code>Delete</code> to **remove the expression**.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/map/filter/filter_delete_clear.webp').default} alt="Delete expressions and clear filters" style={{ maxHeight: "auto", maxWidth: "30%", objectFit: "cover"}}/>
</div>

**Remove whole filter**: Click <code>Clear Filter</code> at the bottom of the Filter menu to **remove all filters**.



---
description: "Route a layer to the True or False branch of a workflow with the Conditional node, using logical or statistic expressions combined with AND or OR."
---

# Conditional

The **Conditional** node routes an input layer to the **True** or **False** branch based on a condition you define. The layer is passed through unchanged. A condition is true when at least one feature satisfies it.

## Node Structure

| Handle | Position | Description |
|---|---|---|
| **Input** | Left | Receives the layer from an upstream node |
| **True** | Upper right | Layer flows here when the condition is met |
| **False** | Lower right | Layer flows here when the condition is not met |

## How to use

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In the right panel <strong>Tools</strong> tab, find the <strong>Control</strong> section and drag the <strong>Conditional</strong> card onto the canvas.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Connect an upstream dataset or tool node to the Conditional node's input handle.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">
  Click the Conditional node to open its configuration. Click <strong>Add Expression</strong> and choose a condition type:
    <ul>
      <li><strong>Logical Expression</strong>: Select a field from the upstream layer, choose an operator (e.g. greater than, contains), and enter a value. <strong>Is true</strong> and <strong>Is false</strong> take no value; <strong>Is between</strong> and <strong>Is not between</strong> take two, <strong>From</strong> and <strong>To</strong>.</li>
      <li><strong>Statistic Expression</strong>: Choose an aggregate method (<code>count</code>, <code>sum</code>, <code>mean</code>, <code>median</code>, <code>min</code>, <code>max</code>), optionally select a numeric field, choose a comparison operator, and enter a threshold value.</li>
    </ul>
  </div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">If you add two or more expressions, select whether the node requires <strong>Match all filters</strong> (AND) or <strong>Match at least one filter</strong> (OR).</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Connect the <strong>True</strong> and <strong>False</strong> output handles to the next nodes in each branch.</div>
</div>

:::tip Variable references
Click the <code>{"{}"}</code> icon in any value field to insert a workflow variable as a dynamic threshold. See [Variables](variables.md).
:::

## Execution status

After running, the Conditional node shows a status chip (**Completed**, **Failed**, or **Skipped**) indicating which branch was taken. To remove all conditions, click **Clear Filter**.

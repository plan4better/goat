---
description: "Manage your profile and preferences, teams and organization members, set up the AI assistant, follow your organization's usage, and set up custom domains and Matomo analytics for published dashboards."
sidebar_position: 5
---

# Settings

On the Settings page, **you can view and modify your preferences and settings** related to your account, teams, organization, AI assistant and usage. 

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/workspace/settings/settings.webp').default} alt="GOAT - Profile Settings" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "cover"}}/>
</div> 


## Account Settings

Under the **Account Settings**, you can adjust your profile and your preferences. 

- In the <code>Profile</code> tab, you can update your **first name, last name**, and **email address** and upload a **profile picture**.
- In the <code>Preferences</code> tab, you can choose your preferred **language** (English or German) and **theme** (light and dark mode). The language you choose is also used on the sign-in pages and in the emails GOAT sends you; a new account starts in the language of the sign-in page or of your browser.

:::info

If you wish to **delete your account**, you can also do this in this section. Please only click on this button if you are certain about this step, as this cannot be undone. 

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/workspace/settings/delete_account.webp').default} alt="Delete Account" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "cover"}}/>
</div> 
:::

<p>
</p>


## Teams Settings

Simply clicking on a team, the Teams Settings will open. Here you can:
- Create a new team by clicking on the <code>+ New Team</code> button
- Enter an already created teams:
  - In the <code>Profile</code> tab, if you are the **owner of the team, you can rename it, modify the description or upload a logo or picture**. If you are a **member of the team you can only view the team information**.
  - In the <code>Members</code> tab, if you are the **owner of the team, you can add or delete members**. If you are a **member of the team you can only view the members list**.

:::info

If you scroll down to the Danger zone on the Profile Tab, you also find an option to **delete your team**. Please only click on this button if you are certain about this step, as this cannot be undone. 

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/workspace/settings/delete_team.webp').default} alt="Delete Team" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "cover"}}/>
</div> 
:::

## Organization Settings

Under the Organization Settings, **you can adjust the profile of your organization and manage the organization members**:

- In the <code>Profile</code> tab, you can **change your organization's name and upload a logo or picture**. 
- In the <code>Members</code> tab, you can **view the members list of your organization**. By clicking on the <img src={require('/img/icons/3dots.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>more options</code> button you can **manage their roles and personal information**. Furthermore, you can **invite new members** to join your organization by email.

:::info

If you scroll down to the Danger zone, you also find an option to **delete your organization**. Please only click on this button if you are certain about this step, as this cannot be undone. 

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/workspace/settings/delete_organization.webp').default} alt="Delete Organization" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "cover"}}/>
</div> 
:::

<p>
</p>

## AI

Under **AI**, organization owners and admins can **set up the AI assistant for the organization**. This menu entry only appears where the AI assistant runs on your GOAT instance. What the assistant can do is described on the [GOAT AI](../goat_ai.md) page.

- Switch on `Enable AI for this organization` to let every member use the assistant with their own GOAT permissions.
- Under `Active connection`, choose the model connection your members use. `GOAT AI (included)` is the built-in connection; where your instance names it, the option shows where GOAT AI is hosted, e.g. `Hosted in the EU`. Your own connections can be selected once their test has passed.
- Under `Data policy`, choose `Standard` (the assistant may send everything a member can see to the model) or `Restricted` (only field names, types, counts and statistics are sent).
- Under `Connections`, add your own provider, key and model with `Add connection` and check it with `Test connection`.

Click `Save` to apply your changes.

<p>
</p>

:::danger[Screenshot placeholder]
The organization's AI settings page.
:::

## Usage

Under **Usage**, organization owners and admins can **follow how much of the organization's quotas is used**. This menu entry only appears where GOAT runs with billing; self-hosted instances don't have it.

The page shows five tiles: `Credits`, `AI credits`, `Storage`, `Projects` and `Editors`. Each tile shows what is used of its limit; a dot marks a tile that is at 90 % of its limit or over it. Click a tile to open its details below:

- `Credits` and `AI credits`: the amount used, a chart per day and a list you arrange with `Group by` (`Workflows`, `Tools`, `Layers`, `Members` or `Periods` for credits; `Members`, `Days` or `Periods` for AI credits). Choose the date range, e.g. `This period`, `Last 30 days` or a `Custom range`, narrow the details to one member, and download the list with `Export CSV`.
- `Storage`: the organization's layers, largest first. Filter them by owner, type or `Not in any project`, and download the list with `Export CSV`.
- `Projects`: the organization's projects, newest first. Search them and filter them by owner.
- `Editors`: the editor and viewer seats, with the credits and AI credits each member used this period. Click a member to open their usage under `Credits` or `AI credits`.

:::info

To raise a limit, click `Ask for more` in a tile's details, or contact the **[Support](https://plan4better.de/en/contact/ "Contact support")** anytime. 

:::

<p>
</p>

:::danger[Screenshot placeholder]
The Usage page with its tiles (Credits, AI credits, Storage, Projects, Editors), and one detail view.
:::

## White Label

Under **White Label**, you can publish dashboards on your own domain and configure analytics tracking for published dashboards. White Label settings apply to the whole organization and are accessible to organization owners.

### Custom Domains

**Publish your dashboards on your own domain.** Each domain serves one published project. To assign a domain to a project, choose it under `Address` on the `Public` tab of the project's `Share` dialog; see [Public Sharing](../sharing/public).

**To add a custom domain:**

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click <code>+ Add your first domain</code> (empty state) or <code>+ Add custom domain</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">In the <strong>Add custom domain</strong> dialog, enter your <code>Domain name</code>: either a subdomain (e.g. <code>dashboards.example.com</code>) or an apex domain (e.g. <code>example.com</code>). Click <code>Continue</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">
  The <strong>Configure DNS</strong> step opens, showing the exact record to create at your DNS provider. The record depends on your domain type:
    <br/><br/>
    <strong>Subdomain</strong> (e.g. <code>maps.example.com</code>):
    <table><thead><tr><th>Type</th><th>Host</th><th>Target</th><th>TTL</th></tr></thead><tbody><tr><td>CNAME</td><td>maps</td><td>cname.goat.plan4better.de</td><td>3600</td></tr></tbody></table>
    <br/>
    <strong>Apex domain</strong> (e.g. <code>example.com</code>):
    <table><thead><tr><th>Type</th><th>Host</th><th>Target</th><th>TTL</th></tr></thead><tbody><tr><td>A</td><td>@</td><td>46.225.38.48</td><td>3600</td></tr></tbody></table>
    <br/>
    The dialog includes copy buttons for each value. GOAT checks DNS propagation every 30 seconds automatically. Click <code>Recheck now</code> to trigger an immediate check, or <code>Done</code> to close and wait in the background.
  </div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Once DNS is verified, the dialog shows a <strong>DNS verified</strong> confirmation and GOAT issues an SSL certificate from <strong>Let's Encrypt</strong> automatically, usually under 2 minutes. The domain status changes to <strong>Issuing</strong> and then <strong>Active</strong> once the certificate is ready.</div>
</div>

**Domain statuses in the list:**

| Status | Description | Available actions |
| --- | --- | --- |
| Waiting for DNS | DNS record not yet detected | Show DNS, Recheck |
| Issuing | DNS verified, SSL certificate being issued | Details |
| Active | Domain is live and serving dashboards | Unassign (if assigned), Delete |
| Failed | DNS or certificate provisioning failed | Details, Retry, Delete |

To view DNS record details or troubleshoot a failed domain, click **Details** or **Show DNS** to open the domain detail drawer, which shows the current DNS and certificate status messages and a **Recheck now** button.

To remove a domain from a project without deleting it, use the project's **Share** dialog. The **Unassign** button in the domain list is only shown when the domain is active and assigned.

### Analytics

**Configure analytics tracking for your published dashboards.** You can add multiple analytics instances, one per Matomo site. Tracking is opt-in per dashboard via the Share dialog.

GOAT currently supports **Matomo** as the analytics provider.

**To add an analytics instance:**

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click <code>+ Add analytics</code>.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">
  In the <strong>Add analytics</strong> dialog, fill in:
    <ul>
      <li><code>Name</code>: a label to tell instances apart, e.g. <code>Client XY Matomo</code>.</li>
      <li><code>Provider</code>: select <code>Matomo</code>.</li>
      <li><code>Matomo URL</code>: your Matomo instance URL including trailing slash (e.g. <code>https://matomo.example.org/</code>).</li>
      <li><code>Site ID</code>: found in Matomo → Administration → Websites.</li>
    </ul>
  </div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Click <code>Save</code>.</div>
</div>

Each instance in the list shows the Matomo URL, Site ID, and how many published dashboards use it. You can **edit** or **remove** an instance using the icons on the right, and use **Manage dashboards** to assign or unassign dashboards to that analytics instance.

:::tip
Add each of your custom domains to your Matomo site's URL list, and configure Custom Dimension 1 as "Project ID" so per-dashboard breakdown works in Matomo.
:::
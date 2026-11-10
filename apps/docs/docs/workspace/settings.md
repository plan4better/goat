---
description: "Manage your profile, language and appearance, your organization, its members and teams, custom domains and Matomo analytics, the AI assistant and the organization's usage."
sidebar_position: 5
---

# Settings

**Settings** holds your own account and your organization. It opens on your **Profile**. The menu on the left has two groups:

- **Account**: <code>Profile</code> and <code>Language and appearance</code>. Everyone has these.
- **Organization**: <code>Profile</code> and <code>Teams</code> for everyone. Owners and admins also see <code>Members</code>, <code>White Label</code> with <code>Domains</code> and <code>Analytics</code> (where your organization's plan includes White Label), <code>AI</code> (where the AI assistant runs) and <code>Usage</code> (where usage is billed).

On a phone, the button under the title names the page you are on; it opens the same sections.

Each page is made of cards. A card with text fields has a bar at its bottom: <code>Save</code> keeps your changes, <code>Discard</code> drops them. Switches and choices save at once.

## Account

### Profile

How other members see you in GOAT, for example when sharing and in teams.

- **Personal details**: your first name, last name and email address, and a picture (<code>Upload picture</code>: PNG, JPG or GIF, at most 1 MB; without a picture GOAT shows your initials). If you change the email address, GOAT asks you to confirm it with <code>Change and sign out</code>, saves it and signs you out; then you sign in with the new address.
- **Your organization**: your organization, your role with a line on what it may do, and your teams. Owners, admins and team owners set your role and teams, so this card is read-only. <code>Open teams</code> leads to the Teams page.
- **Delete account**: deletes your sign-in account; afterwards you can no longer sign in. What you put in teams and in the organization stays there, so download first what you want to keep yourself. To confirm, enter your email address and click <code>Delete account for good</code>. As the owner of the organization you can delete your account only once the organization is deleted.

### Language and appearance

Choose the **language** of the interface (Deutsch or English) and the **appearance** (Light or Dark). A choice applies at once and to your account on every device. Your content and data do not change, and maps keep their own style. The language you choose is also used on the sign-in pages and in the emails GOAT sends you; a new account starts in the language of the sign-in page or of your browser.

## Organization

### Profile

**Owners and admins** change the organization's name and logo here (logo: square, PNG, JPG or GIF, at most 1 MB; name: at most 50 characters). All members see them, in the navigation and in invitations. **Editors and viewers** see the organization, its number of members and their own role.

The **Owners and admins** card lists the people to ask about roles, seats, domains or AI, each with an email link. Owners and admins find links to <code>All members</code> and, where usage is billed, to <code>Seats and usage</code> there.

**Delete organization** is for the owner alone; admins see its button disabled. Deleting ends access to the organization for all members, with all its teams, projects, layers and datasets, and signs you out. Download first what you want to keep. To confirm, enter the organization's name and click <code>Delete for good</code>.

### Members

Only owners and admins see this page. It shows who belongs to the organization and who is invited, and the roles that decide what each person may do:

| Role | May do |
| --- | --- |
| Owner | Everything, including deleting the organization. |
| Admin | Manages members, White Label, AI and usage, and can do everything editors can. |
| Editor | Creates and edits projects, workflows, layouts and dashboards. |
| Viewer | Opens what is shared with them. Takes no editor seat. |

<code>Roles explained</code> shows this as a table.

**Seats.** The tiles at the top show the **Editors** seats (taken by the owner, admins and editors), the **Viewers** seats and the **Open invitations**. An open invitation holds its seat until it is accepted or withdrawn. When all seats of a kind are taken, a notice says how to free one, with <code>Ask for more seats</code> where your instance offers support. A tile also filters the list.

**The list** can be searched by name or email and filtered by <code>Role</code> and <code>Status</code>. Each member's role is a menu: choose <code>Admin</code>, <code>Editor</code> or <code>Viewer</code> and the role changes at once; the message that confirms it has <code>Undo</code>. A role that needs a seat while none is free is greyed out with the reason. The owner's role cannot be changed, and your own role is changed by another admin. Each member's row says since when they are a member (<code>Member since</code> month and year), each invitation when it was sent. Admin and editor share the editor seats, so switching between them needs no free seat.

**Inviting people.** Click <code>Invite members</code>, enter one or more email addresses (separated by a comma, a space or Enter, at most 20 at once), choose the role and click <code>Send invitation</code>. Each person gets an email of their own with the link to the organization. A role is greyed out while fewer of its seats are free than there are addresses. If some invitations fail, the dialog keeps those addresses and names the reason for each.

**The <img src={require('/img/icons/3dots.png').default} alt="More actions" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> menu of a row**:

- <code>Copy email address</code>.
- <code>Remove from organization</code>: the person loses access to the organization and its teams, and their seat is free at once. Under <code>Hand personal content to</code> you choose who gets what the person has under <code>My Content</code> (you, unless you choose someone else). Content in teams and in the organization stays where it is.
- For an invitation, <code>Resend invitation</code>: sends the invitation again, at most once every 10 minutes; until then the item says from when. While the invitee has not set a password yet, GOAT sends the email to set it, otherwise the invitation email.
- For an invitation, <code>Withdraw invitation</code>: the link in the email no longer works, and the seat is free at once.

### Teams

A team shares projects and data: each team has a space of its own under <code>Content</code>. The Teams page lists the teams you are a member of, with a search and the filter <code>All</code> | <code>I am owner</code>; owners and admins see every team of the organization, and a team whose owner has left shows <code>No owner</code>.

**Creating a team.** Owners, admins and editors create teams with <code>New team</code>: enter a <code>Team name</code> (at most 50 characters), optionally a <code>Description</code>, and click <code>Create team</code>. You become the team's owner. Viewers can be members of teams but cannot create them.

**A team's page** opens when you click its card:

- **Members**: the team's owner and the organization's owners and admins add people of the organization with <code>Add members</code> and remove someone with <code>Remove from the team</code> in the row's menu. The person stays a member of the organization. The team's owner cannot be removed; a new owner comes first.
- <code>Make owner</code> in a member's row makes that member the team's owner (for those who may change the team profile). The previous owner stays a member. Viewers cannot own a team. Owners and admins use it to name an owner for a team whose owner has left the organization; the team's page says when a team has none.
- **Team profile**: the name, description and picture. The team's owner changes them (unless they are a viewer in the organization), and so do the organization's owners and admins, in every team. Everyone else sees them read-only.
- <code>Team space under Content</code> opens the team's space.
- **Delete team** (for those who may change the profile): deletes the team and all shares with the team. Content in the team's space must be moved or transferred first; content in the trash counts until it is deleted for good. The members' personal content stays.
- **Leave team** (for every member except the team's owner): you lose access to the team's space, and what you put there stays in the team. The team's owner or an admin can bring you back. The team's owner cannot leave; they first make another member the owner.

## White Label

Owners and admins publish dashboards under their own address and measure visits to them. White Label appears where your organization's plan includes it.

### Domains

Each domain shows one published project. You assign a domain to a project in the project's <code>Share</code> dialog under <code>Public</code>; see [Public Sharing](../sharing/public).

The card **How a domain points to GOAT** shows the DNS record a domain needs:

- a **subdomain** (for example `maps.your-city.example`): a CNAME record to the target the card names;
- a **main domain** (for example `your-city.example`): an A record to the IP address the card names (where your instance offers main domains).

**To add a domain:**

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click <code>Add domain</code> (<code>Add first domain</code> while there is none), enter the <code>Domain name</code> without https:// and without a path, and click <code>Next</code>. A subdomain is easiest.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Create the record the dialog shows at your DNS provider. While the dialog is open, GOAT checks every 30 seconds, and <code>Check now</code> checks at once. After a change at the DNS provider it can take a few minutes. You can click <code>Done</code> and check later with <code>Check again</code> on the domain.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Once DNS is confirmed, the SSL certificate is created on the first visit to the address, usually in under 2 minutes. Then assign the domain in a project's <code>Share</code> dialog.</div>
</div>

**Each domain** shows its status (<code>Active</code>, <code>Waiting for DNS</code>, <code>Certificate being issued</code> or <code>Failed</code>), when it was added and the project it is assigned to. A domain that waits for DNS or failed has <code>Check again</code> or <code>Try again</code>. <code>Failed</code> also means the DNS record points somewhere else; fix it and click <code>Try again</code>. <code>Show details</code> shows the DNS record, what GOAT found and when it last checked; for a domain that waits or failed the details are open from the start. The domain's menu offers <code>Remove assignment</code> (for an active, assigned domain; the message has <code>Undo</code>), <code>Check again</code> and <code>Delete domain</code>. A deleted domain serves nothing any more, so a dashboard assigned to it is no longer reachable at that address.

If custom domains are not set up on your instance, the page says so and no domain can be added.

### Analytics

Measure visits to published dashboards with your own **Matomo** instance.

**To connect Matomo**, click <code>Connect Matomo</code> and fill in:

- <code>Name</code>: to tell instances apart, for example `Matomo dashboards`.
- <code>Provider</code>: Matomo.
- <code>Matomo URL</code>: your Matomo instance, starting with https://. A slash at the end is added.
- <code>Site ID</code>: found in Matomo under Administration, Websites.

Then click <code>Save</code>.

Each instance shows which dashboards it measures. <code>Assign dashboards</code> lists the published dashboards to tick; a dashboard is measured by one instance only, so ticking one that another instance measures moves it to this one. You can also choose the instance in the project's <code>Share</code> dialog. The instance's menu offers <code>Edit</code> and <code>Remove</code>; removing it stops the tracking on the dashboards that use it.

:::tip
In Matomo, add each of your own domains to the site's URL list and set up custom dimension 1 as "Project ID". Then Matomo shows the visits per dashboard.
:::

## AI

Owners and admins set up the AI assistant here, where the instance runs it. What the assistant can do is described on the [GOAT AI](../goat_ai.md) page. The assistant works for all members with their own GOAT permissions. While AI is on, the chosen provider processes the messages and the data the assistant reads, so check that your organization allows this. Every switch and choice on this page applies at once.

- **AI for this organization**: the switch turns the assistant on or off for all members. Where usage is billed, the card also shows the AI credits used in this period and leads to them on the Usage page.
- **What the assistant answers with**: one connection is active. <code>GOAT AI (included)</code> shows where it is hosted; the operator of GOAT chooses its model. With <code>Own connection</code> you add your provider, your key and your model; <code>Save and test</code> saves it and tests it. An own connection can be chosen only after a passed test (<code>Test</code>), and your organization's agreement with the provider applies. While an own connection is active and GOAT AI is available, <code>Fall back to GOAT AI if your provider fails</code> lets GOAT AI answer when your provider fails; such answers are marked in the conversation. A connection's menu offers <code>Edit</code> and <code>Delete connection</code> (not for the active one).
- **Data policy**: what the assistant may send to the model, for every connection. <code>Standard</code> allows everything a member can see, including sample rows and query results. <code>Restricted</code> sends only field names, types, counts and statistics, never single rows, features or geometries.

## Usage

Where usage is billed, owners and admins see the organization's quotas on <code>Usage</code>; self-hosted instances don't have this page. It shows five tiles: `Credits`, `AI credits`, `Storage`, `Projects` and `Editors`. Each tile shows what is used of its limit; a quota at 90 % of its limit or over it shows in the colour of its figure and bar. Click a tile to open its details below:

- `Credits` and `AI credits`: the amount used, a chart per day and a list you arrange with `Group by` (`Workflows`, `Tools`, `Layers`, `Members` or `Periods` for credits; `Members`, `Days` or `Periods` for AI credits). Choose the date range, e.g. `This period`, `Last 30 days` or a `Custom range`, narrow the details to one member, and download the list with `Export CSV`.
- `Storage`: the organization's layers, largest first. Filter them by owner, type or `Not in any project`, and download the list with `Export CSV`.
- `Projects`: the organization's projects, newest first. Search them and filter them by owner.
- `Editors`: the editor and viewer seats, with the credits and AI credits each member used this period. Click a member to open their usage under `Credits` or `AI credits`.

:::info

To raise a limit, click `Ask for more` in a tile's details, or contact the **[Support](https://plan4better.de/en/contact/ "Contact support")** anytime.

:::

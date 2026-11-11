---
description: "Verwalten Sie Team-Mitglieder, teilen Sie Datensätze, Projekte und Ordner mit Personen, Teams oder der Organisation, übertragen Sie Inhalte an ein Team und stellen Sie Gelöschtes aus dem Papierkorb wieder her."
sidebar_position: 6
slug: /sharing
---


# Teams & Mitglieder

Das Teilen von Datensätzen und Projekten ermöglicht einen effizienteren Arbeitsablauf, da **das Gewähren von Zugriff auf andere Mitglieder ihnen erlaubt, Ihre Datensätze oder Projekte gleichzeitig zu bearbeiten und/oder anzusehen**.

::::info
Das Teilen **dupliziert nicht** Ihre Daten, sondern gewährt nur Zugriff darauf.
::::

## Teams und Mitglieder verwalten

<div class="step">
   <div class="step-number">1</div>
   <div class="content">Gehen Sie zu <code>Einstellungen</code> und öffnen Sie <code>Teams</code>. Sie sehen die Teams, in denen Sie Mitglied sind. Teams können Abteilungen oder Gruppen innerhalb Ihrer Organisation darstellen.</div>
</div>
<div class="step">
   <div class="step-number">2</div>
   <div class="content">Klicken Sie auf ein Team, um <b>seine Mitglieder</b> zu sehen und wer Eigentümer des Teams ist.</div>
</div>
<div class="step">
   <div class="step-number">3</div>
   <div class="content">
   Wenn Sie <b>Eigentümer des Teams</b> sind, können Sie:
      <ul>
         <li>Auf <code>Mitglieder hinzufügen</code> klicken, um Personen Ihrer Organisation zum Team hinzuzufügen.</li>
         <li>Auf das Menü <code>Weitere Aktionen</code> <img src={require('/img/icons/3dots.png').default} alt="Weitere Aktionen" style={{ maxHeight: '20px', maxWidth: '20px', verticalAlign: 'middle'}}/> eines Mitglieds und dann auf <code>Aus dem Team entfernen</code> klicken.</li>
      </ul>
   </div>
</div>

In die Organisation kommen Personen über eine Einladung: Eigentümer und Admins laden sie unter <code>Organisation</code> › <code>Mitglieder</code> ein und legen ihre Rolle fest; siehe [Einstellungen](../workspace/settings.md#mitglieder).

:::important
Wenn Sie einen Datensatz/ein Projekt mit einem Team oder einer Organisation teilen, haben alle Mitglieder Zugriff darauf.
:::

---

## Zugriff auf einen Datensatz, ein Projekt oder einen Ordner verwalten

Öffnen Sie das <code>Weitere Optionen</code>-Menü <img src={require('/img/icons/3dots.png').default} alt="Weitere Optionen" style={{ maxHeight: '20px', maxWidth: '20px'}}/> des Inhalts und wählen Sie <code>Teilen</code>. Der Dialog hat diese Tabs:

- **Personen**: einen **Datensatz, ein Projekt oder eine Vorlage** mit einer **einzelnen Person** aus Ihrer Organisation teilen. Suchen Sie sie; der Inhalt erscheint bei ihr unter `Mit mir geteilt` und bleibt, wo er liegt. Ordner und Datenpakete lassen sich nur mit Teams und der Organisation teilen.
- **Teams**: mit einem ganzen **Team oder einer Organisation** teilen. Gewähren Sie den Mitgliedern <code>Betrachter</code>- oder <code>Bearbeiter</code>-Zugriff, oder <code>Kein Zugriff</code>, um ihn zu entziehen.
- **Öffentlich** (nur Datensätze und Projekte): einen **Datensatz** für alle GOAT-Nutzer öffentlich machen; bei einem **Projekt** eine öffentliche Momentaufnahme veröffentlichen, die jeder ohne GOAT-Konto öffnen kann. Beides wird unter [Öffentliches Teilen](./public.md) behandelt.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/sharing/share_dialog_tabs_de.webp').default} alt="Teilen öffnen und die Tabs Personen, Teams und Öffentlich" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "contain"}}/>
</div>
<p> </p>

:::info
Um den Zugriff zu entziehen, öffnen Sie den <code>Teilen</code>-Dialog erneut und setzen Sie die Rolle zurück auf <code>Kein Zugriff</code>.
:::

### Einen Ordner teilen

Sie können auch einen ganzen **Ordner** auf einmal teilen. Das Teilen eines Ordners gewährt Zugriff auf **alle darin enthaltenen Datensätze und Projekte**, sodass Sie nicht jedes Element einzeln teilen müssen.

<div class="step">
   <div class="step-number">1</div>
   <div class="content">Klicken Sie bei einem Ordner, den Sie besitzen, auf <code>Weitere Optionen</code> <img src={require('/img/icons/3dots.png').default} alt="Weitere Optionen" style={{ maxHeight: '20px', maxWidth: '20px'}}/> und wählen Sie <code>Teilen</code>.</div>
</div>
<div class="step">
   <div class="step-number">2</div>
   <div class="content">Wählen Sie eine <code>Organisation</code> oder ein <code>Team</code> und gewähren Sie <code>Betrachter</code>- oder <code>Bearbeiter</code>-Zugriff nach Bedarf.</div>
</div>

:::info
Ein Ordner kann gleichzeitig mit mehreren Teams und der Organisation geteilt werden. Elemente in einem geteilten Ordner erben den Zugriff des Ordners, sodass ein individuelles Teilen nicht erforderlich ist.
:::

### Geteilte Elemente aufrufen

Alles, was mit Ihnen geteilt wurde, persönlich oder über ein Team oder die Organisation, erscheint unter <code>Mit mir geteilt</code> im Panel <code>Bereiche</code> unter [Inhalt](../workspace/content.md).

## Rechte übertragen

Sie können einen Inhalt **an ein Team oder eine Organisation übergeben**, sodass er nicht mehr Ihnen persönlich gehört. Dies funktioniert für Datensätze, Projekte, Ordner, Datenpakete und Vorlagen, die Ihnen in **Meine Inhalte** gehören; bei Inhalten in einem Team- oder Organisationsbereich erscheint die Option nicht. Unter [Inhalt](../workspace/content.md#teilen-und-übertragen-sind-zweierlei) steht, wie sich das vom Teilen unterscheidet.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/sharing/transfer_ownership_de.webp').default} alt="Rechte übertragen im Tab Teams des Teilen-Dialogs" style={{ maxHeight: "450px", maxWidth: "480px", objectFit: "contain"}}/>
</div>
<p> </p>

<div class="step">
   <div class="step-number">1</div>
   <div class="content">Öffnen Sie das <code>Weitere Optionen</code>-Menü <img src={require('/img/icons/3dots.png').default} alt="Weitere Optionen" style={{ maxHeight: '20px', maxWidth: '20px'}}/> des Inhalts, wählen Sie <code>Teilen</code> und öffnen Sie den Tab <code>Teams</code>. Klicken Sie in der Zeile <code>Rechte übertragen</code> auf <code>Übertragen…</code>.</div>
</div>
<div class="step">
   <div class="step-number">2</div>
   <div class="content">Wählen Sie unter <code>An</code> das Team oder die Organisation, das/die den Inhalt besitzen soll.</div>
</div>
<div class="step">
   <div class="step-number">3</div>
   <div class="content">Bei einem Projekt legen Sie fest, <strong>welche Datensätze mitwandern</strong>: Alle Datensätze, die Ihnen gehören, sind zunächst angekreuzt; entfernen Sie das Häkchen bei denen, die Sie behalten möchten. Datensätze anderer lassen sich nicht ankreuzen. Angekreuzte Datensätze gehören dann ebenfalls dem Team, sodass das Projekt sie nicht verliert, wenn Sie es verlassen. Nicht angekreuzte <strong>bleiben, wo sie sind</strong>, und das Team sieht sie weiterhin über das Projekt.</div>
</div>
<div class="step">
   <div class="step-number">4</div>
   <div class="content"><code>Verknüpfung am alten Ort hinterlassen</code> ist standardmäßig aktiviert, damit der Inhalt weiterhin von seinem bisherigen Ort erreichbar ist. Deaktivieren Sie die Option, wenn Sie keine Verknüpfung möchten, und bestätigen Sie die Übertragung.</div>
</div>

Nach einer Übertragung:

- Der Inhalt verlässt **„Meine Inhalte“** und gehört dem Team (oder der Organisation). Er bleibt beim Team, auch wenn Sie es später verlassen.
- **Alle im Team oder in der Organisation erhalten Zugriff.** Persönliche Freigaben für einzelne Personen werden entfernt, da die Mitgliedschaft im Bereich übernimmt.
- Datensätze, die weiterhin **von Projekten anderswo genutzt werden, behalten Lesezugriff**, sodass diese Projekte weiter funktionieren.

:::info
Das Übertragen der Rechte ändert, wem der Inhalt gehört, und ersetzt dessen persönliche Freigaben. Wenn Sie anderen nur Zugriff geben möchten, ohne ihn zu übergeben, verwenden Sie stattdessen <code>Teilen</code>.
:::

## Papierkorb

Gelöschte Inhalte werden nicht sofort entfernt. Sie **wandern zuerst in den Papierkorb**.

Jeder Bereich hat einen eigenen Papierkorb. Wählen Sie unter <code>Inhalt</code> im Panel <code>Bereiche</code> links einen Bereich; wenn Sie ihn besitzen, erscheint unten im Panel sein <code>Papierkorb</code>. Nur der Eigentümer eines Bereichs kann dessen Papierkorb öffnen und Inhalte wiederherstellen; in einem Team-Bereich wenden Sie sich also an den Eigentümer des Teams.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/sharing/trash_de.webp').default} alt="Papierkorb unten im Panel Bereiche unter Inhalt" style={{ maxHeight: "auto", maxWidth: "100%", objectFit: "contain"}}/>
</div>
<p> </p>

- Beim Löschen wird ein Inhalt in den **Papierkorb** verschoben, wo er **30 Tage lang wiederhergestellt** werden kann.
- Öffnen Sie den Papierkorb, um einen Inhalt <code>Wiederherstellen</code> zu lassen, oder belassen Sie ihn dort: Inhalte werden **30 Tage nach dem Löschen** endgültig entfernt.

:::info
Wenn Sie die Rechte an einem Ordner übertragen, wandern darin enthaltene, gelöschte Inhalte mit und bleiben im Papierkorb.
:::

## Rollen

Siehe die Tabelle unten, um zu erfahren, was jeder Benutzer innerhalb einer Organisation/eines Teams und in einem geteilten Datensatz/Projekt tun kann:

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/sharing/sharing_roles_table.png').default} alt="Rollen-Tabelle in GOAT" style={{ maxHeight: "auto", maxWidth: "80%", objectFit: "cover"}}/>
</div>
<p> </p>

:::info Wichtig

Das Löschen eines Datensatzes aus einem geteilten Projekt, **das Sie besitzen**, entfernt ihn *auch für andere Benutzer*. Er landet in Ihrem Papierkorb, sodass Sie ihn innerhalb von 30 Tagen wiederherstellen können.

**Als Bearbeiter**: Wenn Sie einen Datensatz oder eine Ebene aus dem Projekt löschen, bleibt dieser *für den Eigentümer weiterhin im persönlichen Datensatz erhalten*.

:::

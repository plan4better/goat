---
description: "Fragen Sie GOAT AI, den KI-Assistenten, zu Ihren Projekten und Daten: Er findet Datensätze in Ihrem Workspace und im Katalog, liest Layer und Statistiken, schlägt Kartenansichten und Filter vor, erstellt, ändert und startet Workflows und erklärt GOAT selbst anhand dieser Dokumentation. Antworten von GOAT AI verbrauchen KI-Credits."
sidebar_position: 2.5
---

# GOAT AI

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <Video src={require('/img/goat_ai/goat_ai_de.mp4').default} alt="GOAT AI beantwortet eine Planungsfrage in einem Projekt" />
</div>

GOAT AI ist der **in GOAT integrierte KI-Assistent**. Bitten Sie ihn in Ihren eigenen Worten, Projekte und Datensätze zu finden, zu erklären, was ein Layer enthält, Statistiken zu berechnen oder eine Analyse als Workflow zu erstellen und auszuführen. Er arbeitet mit Ihren eigenen GOAT-Berechtigungen und sieht und ändert daher nur, was auch Sie sehen und ändern dürften.

## 1. Erklärung

Der Assistent öffnet sich in einer Seitenleiste neben der Seite, auf der Sie arbeiten. Sie schreiben eine Nachricht, und der Assistent antwortet mit Text, mit Karten für das, was er gefunden hat, und mit Vorschlägen, die Sie anwenden können. Für seine Antworten nutzt er GOATs eigene Werkzeuge: Er durchsucht Ihren Workspace und den Daten-Katalog, liest die Layer eines Projekts und erstellt Workflows aus den Werkzeugen der Toolbox. Alles, was er über Ihre Daten sagt, etwa Namen, Anzahlen und Werte, stammt aus diesen Werkzeugen. Allgemeine Fragen, zum Beispiel zu Planungsbegriffen oder Orten, beantwortet er aus seinem eigenen Wissen.

- **Er arbeitet mit Ihren Berechtigungen.** Jeder Schritt läuft mit Ihrer Anmeldung: Der Assistent findet nur, was Sie öffnen können, und ändert nur, was Sie bearbeiten dürfen. In einem Projekt, das Sie nur ansehen können, beantwortet er Fragen, erstellt und ändert aber nichts.
- **Er kennt die Seite, auf der Sie sind.** Jede Nachricht teilt dem Assistenten mit, von welcher Seite, aus welchem Projekt und welcher Ansicht sie kommt und was dort ausgewählt ist. In einem Projekt antwortet er zu dessen Layern, auf der Seite Katalog zum Katalog.
- **Ihre Organisation legt fest, wie er arbeitet.** Administratoren der Organisation schalten KI ein oder aus und wählen die Modellverbindung (siehe [KI-Einstellungen](./workspace/settings.md#ki)). Nutzt Ihre Organisation **GOAT AI (inklusive)**, verbrauchen Antworten [KI-Credits](#ai-credits).

:::info
Der Assistent ist in der Beta-Phase, und KI-Antworten können fehlerhaft sein. Prüfen Sie Ergebnisse, bevor Sie sie verwenden. Ist eine Antwort falsch oder fehlt etwas, sagen Sie es uns mit den Feedback-Schaltflächen darunter (siehe [Antworten](#answers)).
:::

## 2. Den Assistenten öffnen

Klicken Sie in der oberen Leiste auf <code>KI fragen</code>. Die Schaltfläche fehlt, wenn KI für Ihre Organisation ausgeschaltet oder auf Ihrer GOAT-Instanz nicht eingerichtet ist. Ein weiterer Klick auf die Schaltfläche schließt den Assistenten.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/goat_ai/dock_de.webp').default} alt="Der GOAT AI-Assistent neben einem Projekt geöffnet" style={{ maxWidth: "100%", objectFit: "cover"}}/>
  <p style={{ textAlign: 'center', fontSize: '0.9em' }}>Der KI-Assistent öffnet sich rechts neben dem Projekt. Eine leere Unterhaltung zeigt Vorschläge für die Seite, auf der Sie sind.</p>
</div>

## 3. Eine Frage stellen

Geben Sie Ihre Frage in <code>Stellen Sie eine Frage</code> ein und drücken Sie `Enter` oder klicken Sie auf <code>Senden</code>. `Umschalt+Enter` beginnt eine neue Zeile.

- **Kontext.** Unter dem Text zeigen kleine Chips, was die Nachricht dem Assistenten über die Seite mitteilt, zum Beispiel Projekt und Ansicht, <code>Ausgewählter Layer</code>, <code>Kartenansicht</code>, <code>Ausgewählter Workflow</code> oder auf der Seite Katalog die Suche und die Filter. Entfernen Sie einen Chip, wenn der Assistent ihn nicht nutzen soll.
- **Weitere Projekte als Quellen.** Klicken Sie auf <code>@ Quelle hinzufügen</code> oder geben Sie `@` ein, und wählen Sie ein anderes Projekt, das Sie öffnen können. Der Assistent darf dieses Projekt dann ebenfalls lesen, etwa um es mit dem geöffneten zu vergleichen. Eine Nachricht kann bis zu 10 Quellen nutzen.
- **Während eine Antwort läuft.** <code>Stopp</code> beendet die Antwort. Sie können Ihre nächste Nachricht auch schreiben, während der Assistent noch antwortet: Sie wartet als <code>In Warteschlange</code> über dem Eingabefeld und wird gesendet, sobald die Antwort endet. <code>Jetzt senden</code> stoppt die laufende Antwort und sendet sie sofort; <code>Entfernen</code> legt ihren Text zurück in das Eingabefeld.
- **Datendateien.** Legen Sie eine Datendatei auf dem Assistenten ab, öffnet GOAT den gewohnten Dialog zum Hochladen. Dateien werden nie an eine Nachricht angehängt.

Der Assistent antwortet in der Sprache, in der Sie schreiben.

### Antworten {#answers}

Während der Assistent arbeitet, zeigt die Antwort die **Schritte**, die er ausführt, etwa eine Suche im Katalog oder eine Zählung von Features, jeweils mit dem, was er gefunden hat. Danach folgen der Text der Antwort, **Karten** für das, worauf sie verweist, und, wenn er eine Änderung vorschlägt, eine **Vorschlagskarte** (siehe [Was GOAT AI kann](#capabilities)).

Unter der neuesten Antwort, und unter älteren, wenn Sie auf sie zeigen, finden Sie:

- <code>Rückgängig</code>, wenn die Antwort Workflows geändert hat (siehe [Einen Workflow mit dem KI-Assistenten ändern](./workflows/workflow_interface.md#einen-workflow-mit-dem-ki-assistenten-ändern)).
- <code>Antwort kopieren</code>, um den Text der Antwort zu kopieren.
- <code>Details zur Antwort</code>: bei einer Antwort von GOAT AI die verbrauchten KI-Credits (wo die KI-Credits Ihrer Organisation gezählt werden), ihre <code>Schritte</code> und, wo bekannt, wo das Modell läuft, zum Beispiel <code>Läuft auf einem Modell, das in der EU gehostet wird.</code> Bei einer Antwort über die eigene Verbindung Ihrer Organisation das <code>Modell</code>, den <code>Anbieter</code> und die Anzahl der Tokens.
- <code>Gute Antwort</code> und <code>Schlechte Antwort</code>, um die Antwort zu bewerten. Nach <code>Schlechte Antwort</code> können Sie angeben, was besser sein könnte. Ein erneuter Klick auf die gewählte Schaltfläche entfernt Ihre Bewertung.

Schließen Sie den Assistenten oder öffnen Sie eine andere Unterhaltung, während eine Antwort läuft, läuft die Antwort weiter. Eine Meldung sagt Ihnen, wenn sie fertig ist.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/goat_ai/answer_de.webp').default} alt="Eine Antwort von GOAT AI mit Ergebniskarten" style={{ maxWidth: "400px", objectFit: "cover"}}/>
  <p style={{ textAlign: 'center', fontSize: '0.9em' }}>Die Antwort auf <i>Welche Layer enthält dieses Projekt?</i>: eine Karte pro Layer, mit <code>Zoomen</code>, und unter dem Text die Feedback-Schaltflächen.</p>
</div>

## 4. Was GOAT AI kann {#capabilities}

### Ihre Projekte, Datensätze, Workflows und Layouts finden

Fragen Sie nach Inhalten über Name, Thema, Ordner oder Eigentümer, zum Beispiel <code>Welche meiner Projekte nutzen Radverkehrsdaten?</code> Der Assistent durchsucht alles, was Sie öffnen können: Ihre eigenen Inhalte und das, was mit Ihnen, Ihren Teams und Ihrer Organisation geteilt ist, freigegebene Ordner eingeschlossen. Er findet auch die Workflows und Layouts in Projekten, die Layer, die Projekte enthalten, und passende Vorlagen.

Was er empfiehlt, erscheint als Karten mit einer kurzen Notiz, warum es wichtig ist. Jede Karte hat höchstens eine Schaltfläche, die GOAT nach der Art des Elements und der Seite wählt, auf der Sie sind:

- <code>Öffnen</code> öffnet ein Projekt oder einen Workflow oder ein Layout in seinem Projekt. Sind Sie in einem Projekt, öffnet sich ein anderes Projekt in einem neuen Tab, sodass das geöffnete offen bleibt.
- <code>Zoomen</code> wählt einen Layer des geöffneten Projekts aus und zoomt die Karte auf ihn, in der Ansicht `Karte`.
- <code>Hinzufügen</code> fügt einen Datensatz dem geöffneten Projekt hinzu, wenn Sie es bearbeiten dürfen. Eine Meldung bestätigt das, mit <code>Rückgängig</code>, um ihn wieder zu entfernen. Außerhalb eines solchen Projekts fragt <code>Hinzufügen…</code> zuerst, zu welchem Projekt er hinzugefügt werden soll.
- Das Augen-Symbol zeigt eine <code>Vorschau</code> eines Datensatzes; <code>Alle Details</code> öffnet seine vollständigen Informationen.

Fragen Sie nach Daten zu einem Thema oder Ort, sucht der Assistent gleichzeitig in den Datensätzen Ihrer Organisation und im Katalog und zeigt die Datensätze Ihrer Organisation zuerst.

### Den Daten-Katalog durchsuchen

Fragen Sie, welche Daten es gibt, zum Beispiel <code>Welche Datensätze gibt es zur Bevölkerung?</code> oder <code>Welche dieser Datensätze dürfen kommerziell genutzt werden?</code> Der Assistent durchsucht den [GOAT-Daten-Katalog](./workspace/catalog.md), grenzt einen Ort auf seine Region ein und liest den vollständigen Eintrag eines Datensatzes: Beschreibung, Lizenz, Herausgeber, Jahre, Ausdehnung und bei einem Bundle dessen Layer und Felder. Die Datensätze, die er empfiehlt, erscheinen als Karten mit der Markierung <code>Aus dem GOAT-Katalog</code>, mit <code>Hinzufügen</code> und einer Vorschau.

Möchten Sie die Ergebnisse auf der Seite Katalog selbst sehen, bitten Sie darum: Der Assistent schlägt Suche und Filter in einer Karte vor (siehe [Vorschläge anwenden](#suggestions)).

### Erklären, wie GOAT funktioniert {#how-to}

Fragen Sie, wie etwas in GOAT geht, wo Sie es finden oder ob GOAT es kann, zum Beispiel <code>Wo ändere ich die Farben eines Layers?</code> Der Assistent liest die passende Seite dieser Dokumentation in der Sprache Ihrer Oberfläche und antwortet mit den Namen der Schaltflächen und Menüs, wie GOAT sie anzeigt. Wenn die Dokumentation eine Frage nicht abdeckt, sagt er das, statt zu raten.

### Fragen zu den Daten eines Projekts beantworten

In einem Projekt liest der Assistent die Layer des Projekts und beantwortet Fragen dazu, zum Beispiel <code>Welche Felder hat „Schulen“?</code> oder <code>Wie viele Bushaltestellen liegen im Stadtbezirk Pasing?</code> Er kann:

- die Layer und Gruppen des Projekts auflisten, mit ihren Typen, Filtern, Ausdehnungen und dem ausgewählten Layer;
- die Felder eines Layers und ihre Typen auflisten;
- Features zählen, alle oder nur die, die zu einem Filter passen;
- ein Feld beschreiben: Minimum, Maximum, Mittelwert, Standardabweichung und Klassengrenzen bei Zahlen, die häufigsten Werte bei Text;
- Flächen von Polygonen berechnen, auch je Gruppe;
- eine Statistik je Gruppe berechnen, etwa Summe, Mittelwert oder Anzahl der Features je Stadtbezirk, und Anteile an einem anderen Layer, zum Beispiel die erreichbaren Einwohner als Anteil aller Einwohner je Stadtbezirk;
- einige Features eines Layers ansehen, um zu sehen, wie die Daten aussehen;
- die Workflows und Layouts des Projekts auflisten und erklären, was sie tun.

Die Zahlen stammen aus GOAT, nicht vom Modell: Statistiken, Anteile und Summen berechnet GOAT, bevor der Assistent darüber schreibt. Die Daten eines gesperrten Layers kann der Assistent nicht lesen.

Außerhalb eines Projekts können Sie nach jedem Projekt fragen, das Sie öffnen können, oder es mit <code>@ Quelle hinzufügen</code> als Quelle hinzufügen.

### Vorschläge anwenden {#suggestions}

Manche Antworten schlagen in einer **Vorschlagskarte** eine Änderung an der Seite vor. Nichts ändert sich, bis Sie den Vorschlag anwenden.

- **Kartenansicht**: In der Ansicht `Karte` kann der Assistent eine Ansicht vorschlagen, etwa die Ausdehnung eines Layers oder der gefundenen Features. <code>Auf Karte anwenden</code> bewegt die Karte dorthin.
- **Katalog-Filter**: Der Assistent kann eine Suche und Filter für den Katalog vorschlagen. Auf der Seite Katalog setzt <code>Auf Seite anwenden</code> sie; an anderer Stelle öffnet <code>Im Katalog öffnen</code> den Katalog damit.

Nachdem Sie einen Vorschlag angewendet haben, nimmt <code>Rückgängig</code> auf der Karte ihn zurück. <code>Verwerfen</code> blendet ihn aus. Ein Vorschlag für ein anderes Projekt bietet stattdessen <code>Im Projekt öffnen und prüfen</code>.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/goat_ai/suggestion_de.webp').default} alt="Eine Vorschlagskarte für eine Kartenansicht" style={{ maxWidth: "400px", objectFit: "cover"}}/>
  <p style={{ textAlign: 'center', fontSize: '0.9em' }}>Eine Vorschlagskarte für eine Kartenansicht: <code>Auf Karte anwenden</code> bewegt die Karte dorthin, <code>Verwerfen</code> verwirft den Vorschlag.</p>
</div>

### Workflows erstellen, ändern und ausführen

In den Ansichten `Karte` und `Workflows` eines Projekts, das Sie bearbeiten dürfen, erstellt der Assistent Analysen als [Workflows](./category/workflows):

- **Erstellen**: Beschreiben Sie die Analyse, und der Assistent nutzt eine passende Workflow-Vorlage oder erstellt den Workflow aus den Werkzeugen Ihrer Toolbox, prüft ihn wie der Editor und legt ihn im Projekt an.
- **Ändern**: Bitten Sie ihn, einen Workflow zu ändern, etwa eine Einstellung, einen Schritt oder eine Notiz. Er ändert nur, worum Sie gebeten haben, und jede Antwort, die etwas geändert hat, lässt sich rückgängig machen.
- **Ausführen**: Fragen Sie nach einem Ergebnis, und der Assistent führt den Workflow aus, wartet auf ihn und berichtet das Ergebnis mit den Layern, die der Lauf gespeichert hat. Einen Workflow, den er nicht in dieser Unterhaltung erstellt hat, führt er erst aus, wenn Sie zustimmen.

Die Workflow-Seiten beschreiben all das im Detail: [Einen Workflow mit dem KI-Assistenten erstellen](./workflows/workflow_interface.md#einen-workflow-mit-dem-ki-assistenten-erstellen), [Einen Workflow mit dem KI-Assistenten ändern](./workflows/workflow_interface.md#einen-workflow-mit-dem-ki-assistenten-ändern) und [Einen Workflow mit dem KI-Assistenten ausführen](./workflows/workflow_interface.md#einen-workflow-mit-dem-ki-assistenten-ausführen).

### Sie fragen, wenn es eine Wahl gibt

Wenn nur Sie entscheiden können, etwa welcher von mehreren Datensätzen genutzt werden soll, fragt der Assistent Sie in einer Karte mit bis zu vier Fragen mit jeweils einigen Optionen. Die Option, die er vorschlägt, ist mit <code>Empfohlen</code> markiert. Wählen Sie eine Option oder <code>Eigene Antwort eingeben</code> und dann <code>Antwort senden</code>; bei mehreren Fragen führen <code>Weiter</code> und <code>Überprüfen</code> Sie durch die Fragen. Um stattdessen im Eingabefeld zu antworten, klicken Sie auf <code>Stattdessen als Text antworten</code>.

Der Assistent fügt Ihrem Projekt einen Datensatz nur hinzu, wenn Sie ihn in einer solchen Karte wählen, nie, weil er irgendwo davon gelesen hat.

## 5. Unterhaltungen {#conversations}

Jede Unterhaltung wird gespeichert, und nur Sie sehen Ihre Unterhaltungen. Klicken Sie auf den Titel in der Kopfzeile des Assistenten (im Vollbild stehen sie neben der Unterhaltung), um sie zu sehen, gruppiert nach <code>Heute</code> und <code>Früher</code>:

- <code>Unterhaltungen durchsuchen</code> findet eine Unterhaltung über ihren Titel oder ihre erste Nachricht.
- In einem Projekt zeigt <code>Dieses Projekt</code> die Unterhaltungen dieses Projekts und <code>Alle</code> alle Unterhaltungen.
- Über das Menü hinter den drei Punkten einer Unterhaltung können Sie sie <code>Umbenennen</code> oder <code>Löschen</code>. Löschen entfernt auch ihre Antworten und kann nicht rückgängig gemacht werden.

Eine Unterhaltung, die in einem Projekt begonnen wurde, gehört zu diesem Projekt und kann nur dort fortgesetzt werden. An anderer Stelle geöffnet, weist sie darauf hin, mit <code>Im Projekt öffnen</code>, um dorthin zu wechseln, oder <code>Neue Unterhaltung hier</code>, um eine neue zu beginnen.

## 6. Berechtigungen und Daten

- **Ihre Berechtigungen.** Der Assistent nutzt für jeden Schritt Ihre Anmeldung. Er findet nur Inhalte, die Sie öffnen können, liest nie einen gesperrten Layer und erstellt oder ändert Workflows und fügt Datensätze nur in einem Projekt hinzu, das Sie bearbeiten dürfen. Er löscht nie ein Projekt, einen Datensatz oder einen Workflow.
- **Was das Modell erreicht.** Ihre Nachrichten und die Daten, die der Assistent für die Antwort liest, werden an das KI-Modell übermittelt, das Ihre Organisation nutzt: alles, was Sie in GOAT sehen können, einschließlich Beispielzeilen und Abfrageergebnissen. Eine Organisation, deren Daten nicht an das Modell von GOAT AI gehen sollen, schaltet KI aus oder nutzt eine eigene Verbindung ohne Ausweichen auf GOAT AI, in den [KI-Einstellungen](./workspace/settings.md#ki).
- **Welches Modell.** <code>GOAT AI (inklusive)</code> ist GOATs eigene Modellverbindung. Eine Organisation kann stattdessen eine eigene Verbindung mit eigenem Anbieter und Schlüssel nutzen; Anfragen daran unterliegen der Vereinbarung der Organisation mit diesem Anbieter. Fällt dieser Anbieter aus und lässt die Organisation es zu, kann eine Antwort auf GOAT AI ausweichen, und die Antwort weist dann darauf hin.

## 7. KI-Credits {#ai-credits}

Antworten von GOAT AI werden aus dem Kontingent an **KI-Credits** Ihrer Organisation bezahlt. KI-Credits sind getrennt von den Credits, die Werkzeug- und Workflow-Läufe, Downloads und Exporte verbrauchen.

**Was eine Antwort kostet.** Eine Antwort kostet KI-Credits nach der Zahl ihrer **Schritte**, also der Werkzeugaufrufe, die der Assistent dafür gemacht hat, nie nach dem Modell dahinter. Mit den Standardkonditionen von GOAT:

| Schritte der Antwort | KI-Credits |
|---|---|
| bis 10 | 1 |
| 11 bis 20 | 2 |
| mehr als 20 | 3 |

Das Fenster zu den KI-Credits im Assistenten (siehe unten) zeigt die Regel, die für Ihre Organisation gilt.

**Was gezählt wird.** Eine Antwort wird gezählt, wenn sie vollständig ist, wenn sie die Grenze des Assistenten für eine Antwort erreicht und wenn ihre Zeit abläuft oder Sie sie stoppen, nachdem sie mindestens einen Schritt ausgeführt hat. Sie ist kostenlos, wenn der Anbieter des Modells oder GOAT ausfällt, wenn die Antwort unterbrochen wird und wenn sie vor ihrem ersten Schritt endet. Jede Antwort wird einmal gezählt.

**Wie viele KI-Credits es gibt.** Mit den Standardkonditionen von GOAT erhält ein Abonnement jeden Monat 200 KI-Credits je Bearbeiter-Platz und ein Testzeitraum 100 KI-Credits für den ganzen Testzeitraum. Das Kontingent eines Abonnements wird jeden Monat zusammen mit den Credits neu aufgefüllt; das eines Testzeitraums gilt bis zu dessen Ende.

**Wo Sie sie sehen.** Neben <code>Senden</code> zeigt ein kleiner Ring, wie viel des Kontingents genutzt ist. Er wird orange und zeigt, wie viele übrig sind, wenn weniger als ein Zehntel übrig ist, und rot, wenn sie aufgebraucht sind. Ein Klick darauf zeigt <code>KI-Credits · Ihre Organisation</code>: den in diesem Monat (oder in Ihrem Testzeitraum) genutzten Anteil, das Datum, an dem das Kontingent neu aufgefüllt wird, wie viele KI-Credits übrig sind und wie eine Antwort gezählt wird. Eigentümer und Administratoren finden dort <code>Nutzung ansehen →</code>, das die Seite [Nutzung](./workspace/settings.md#nutzung) mit den KI-Credits jedes Mitglieds öffnet.

**Wenn sie aufgebraucht sind**, ersetzt eine Zeile wie <code>Die KI-Credits dieses Monats sind aufgebraucht. Neu ab …</code> das Eingabefeld. Die Unterhaltungen bleiben lesbar. Ein Administrator Ihrer Organisation kann weitere KI-Credits anfragen.

:::info
KI-Credits zählen nur, wo GOAT AI antwortet und GOAT mit Abrechnung läuft. Antworten über die eigene Verbindung Ihrer Organisation verbrauchen nie KI-Credits, und ein selbst gehostetes GOAT hat kein Limit (siehe [KI-Assistent](./self_hosting/docker_compose/configuration.md#assistant) in der Dokumentation zum Selbst-Hosting).
:::

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
  <img src={require('/img/goat_ai/credits_de.webp').default} alt="Das KI-Credits-Fenster im Assistenten" style={{ maxWidth: "380px", objectFit: "cover"}}/>
  <p style={{ textAlign: 'center', fontSize: '0.9em' }}>Das KI-Credits-Fenster, geöffnet über den Ring neben <code>Senden</code>: der Anteil, der diesen Monat genutzt ist, die verbleibenden KI-Credits und wie eine Antwort gezählt wird.</p>
</div>

## 8. GOAT aus Ihren eigenen KI-Werkzeugen nutzen

Externe KI-Agenten können sich über den **MCP-Endpunkt** (Model Context Protocol) mit GOAT verbinden, den der Assistent bereitstellt. Sie handeln mit den Berechtigungen der Person, die sie verbindet. Derzeit bietet der Endpunkt die Katalog-Werkzeuge: den Daten-Katalog durchsuchen, seine Filter auflisten, Regionen nachschlagen und den Eintrag eines Datensatzes lesen. Adresse und Einstellungen des Endpunkts finden Sie in der Dokumentation zum Selbst-Hosting unter [KI-Assistent](./self_hosting/docker_compose/configuration.md#assistant).

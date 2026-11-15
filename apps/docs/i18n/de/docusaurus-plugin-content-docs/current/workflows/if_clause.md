---
description: "Leiten Sie einen Layer mit dem Bedingung-Knoten in den Wahr- oder Falsch-Zweig eines Workflows, anhand logischer oder statistischer Ausdrücke mit UND oder ODER."
---

# Bedingung

Der **Bedingung**-Knoten leitet eine Eingabeebene basierend auf einer definierten Bedingung an den **Wahr**- oder **Falsch**-Zweig weiter. Die Ebene wird unverändert weitergegeben. Eine Bedingung gilt als wahr, wenn mindestens ein Feature sie erfüllt.

## Knotenstruktur

| Verbindung | Position | Beschreibung |
|---|---|---|
| **Eingabe** | Links | Empfängt die Ebene von einem vorgelagerten Knoten |
| **Wahr** | Oben rechts | Ebene fließt hierhin, wenn die Bedingung erfüllt ist |
| **Falsch** | Unten rechts | Ebene fließt hierhin, wenn die Bedingung nicht erfüllt ist |

## Verwendung

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Öffnen Sie im rechten Panel den Tab <strong>Werkzeuge</strong>, suchen Sie den Bereich <strong>Steuerung</strong> und ziehen Sie die Karte <strong>Bedingung</strong> auf die Leinwand.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Verbinden Sie einen vorgelagerten Datensatz- oder Werkzeug-Knoten mit dem Eingabe-Handle des Bedingung-Knotens.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">
  Klicken Sie auf den Bedingung-Knoten, um die Konfiguration zu öffnen. Klicken Sie auf <strong>Ausdruck hinzufügen</strong> und wählen Sie einen Ausdruckstyp:
    <ul>
      <li><strong>Logischer Ausdruck</strong>: Wählen Sie ein Feld aus der vorgelagerten Ebene, einen Operator (z. B. größer als, enthält) und geben Sie einen Wert ein. <strong>Ist wahr</strong> und <strong>Ist falsch</strong> brauchen keinen Wert; <strong>Liegt zwischen</strong> und <strong>Liegt nicht dazwischen</strong> brauchen zwei, <strong>Von</strong> und <strong>Bis</strong>.</li>
      <li><strong>Statistischer Ausdruck</strong>: Wählen Sie eine Aggregationsmethode (<code>count</code>, <code>sum</code>, <code>mean</code>, <code>median</code>, <code>min</code>, <code>max</code>), sowie optional ein numerisches Feld, einen Vergleichsoperator und einen Schwellenwert.</li>
    </ul>
  </div>
</div>

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Wenn zwei oder mehr Ausdrücke vorhanden sind, wählen Sie, ob der Knoten <strong>Passen Sie alle Filter an</strong> (UND) oder <strong>Entspricht mindestens einem Filter</strong> (ODER) erfordert.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Verbinden Sie die Ausgabe-Handles <strong>Wahr</strong> und <strong>Falsch</strong> mit den nächsten Knoten in den jeweiligen Zweigen.</div>
</div>

:::tip Variablenverweise
Klicken Sie auf das <code>{"{}"}</code>-Symbol in einem Wertfeld, um eine Workflow-Variable als dynamischen Schwellenwert einzufügen. Siehe [Variablen](variables.md).
:::

## Ausführungsstatus

Nach der Ausführung zeigt der Bedingung-Knoten einen Statuschip (**Abgeschlossen**, **Fehlgeschlagen** oder **Übersprungen**), der angibt, welcher Zweig genommen wurde. Um alle Bedingungen zu entfernen, klicken Sie auf **Filter löschen**.

# XPlan test data

`bplan_39_6_aenderung_5-3.gml` is a published development plan, unchanged: "Bebauungsplan Nr. 39,
6. Änderung" of the town of Reinfeld (Holstein), XPlanGML 5.3, as its state's plan server hands it
out (a WFS download, the plan's objects inside a `wfs:FeatureCollection`).

- Source: https://ckan.govdata.de/dataset/01062061_bp_bpl-39-6-anderung_01c0fb7
- Publisher: Stadt Reinfeld (Holstein)
- Licence: Datenlizenz Deutschland Namensnennung 2.0 (https://www.govdata.de/dl-de/by-2-0)

The importer's tests read it as a plan from practice beside the hand-written ones: the WFS wrapper,
links between objects, text clauses, a municipality key with a leading zero.

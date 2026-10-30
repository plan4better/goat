---
description: "Classify public transport quality from A to F with station buffers based on GTFS departure frequency and station type, for any day and time window."
sidebar_position: 7
---

# ÖV-Güteklassen

The ÖV-Güteklassen indicator **classifies the quality of public transport services in a given area**, helping planners and stakeholders quickly identify well-served and [underserved locations](https://www.plan4better.de/en/glossary/deficit-area).

<div style={{ display: 'flex', justifyContent: 'center' }}>
<iframe width="674" height="378" src="https://www.youtube.com/embed/7YMhKkg2mtU?si=Wy1-ZjKGeJWt-K-I&amp;start=46" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>

## 1. Explanation

ÖV-Güteklassen (Public Transport Quality Classes) provide a standardized way to **evaluate and visualize the attractiveness of public transport services**. The classes range from **A** (very good) to **F** (very poor), based on service frequency, station type, and spatial coverage.

The ÖV-Güteklassen indicator is decisive and can be used to highlight deficits in the public transport offer and to identify well-serviced locations as attractive areas for development.

:::info

ÖV-Güteklassen computation is available for areas where public transport [GTFS data](https://www.plan4better.de/en/glossary/gtfs) is integrated into GOAT. Currently supported regions include **Germany, Switzerland, and the Haut-Rhin region of France**. If you need analyses beyond these regions, you can [import your own public transport network](../../data/builtin_datasets.md#your-own-public-transport-network) or [contact us](https://plan4better.de/en/contact/) and we will do it for you.

:::

## 2. Example use cases

- How good is public transport supply in different parts of the city?
- How many people are underserved by public transport? Where is the need for further supply?
- How does the quality of public transport services differ at different times of the week and day?

## 3. How to use the indicator?

<div class="step">
  <div class="step-number">1</div>
  <div class="content">Click on <code>Toolbox</code> <img src={require('/img/icons/toolbox.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/>. </div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Under <code>Accessibility Indicators</code>, select <code>ÖV-Güteklassen</code> to open the settings menu.</div>
</div>

### Calculation Time

<div class="step">
  <div class="step-number">3</div>
  <div class="content">Set the <code>Day</code>, <code>Start Time</code>, and <code>End Time</code> for your analysis.</div>
</div>

### Configuration

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Choose the <code>Catchment area type</code>: <b>Buffer</b>.</div>
</div>

:::info

**Buffers** represent areas around public transport stations measured "as the crow flies".

:::

<div class="step">
  <div class="step-number">5</div>
  <div class="content">Select the <code>Reference Area Layer</code>: a polygon layer defining the study area boundary.</div>
</div>

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Optional: Click <code>Station configuration</code> to change how stations are classified. The dialog starts from a ready-made profile and lets you adjust the frequency thresholds, the transport mode groups, the station categories and the quality class each buffer distance gives. Click <code>Apply</code> to keep your changes. See <a href="#station-configuration">Station configuration</a> for what each setting does.</div>
</div>

### Result Layer

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Set the <code>Result layer name</code> for the output ÖV-Güteklassen layer.</div>
</div>

<div class="step">
  <div class="step-number">8</div>
  <div class="content">Set the <code>Station layer name</code> for the output stations layer.</div>
</div>

<div class="step">
  <div class="step-number">9</div>
  <div class="content">Click <code>Run</code> to start the calculation.</div>
</div>

### Results


After calculation, two layers are added to the map:
- **ÖV-Güteklassen**: Shows the quality class for each area.
- **ÖV-Güteklassen Stations**: Shows all stations used in the calculation (grey points = too low frequency, don't contribute to any PT Quality Class).

If you click on a ÖV-Güteklassen result **your will see the further details, such as Public Transport Class and Public Transport Class Number**. Both represent the quality of public transport in that area (see [calculation](#calculation) for more details).

If you click on any station, **you can see details such as the stop name, average frequency, and station category**. 


## 4. Technical details

### Scientific Background

 The approach of Public Transport Quality Classes <i>(German: ÖV-Güteklassen)</i> is **methodologically superior compared to common [catchment areas](https://www.plan4better.de/en/glossary/catchment-area)**. In 2011, the [Swiss Federal Office for Spatial Development (ARE)](https://www.are.admin.ch/are/de/home.html) started to use this indicator to **include the attractiveness of public transport services in the assessment of quality development**; since then, it has been considered an important instrument in formal planning processes in Switzerland. Later on, the Swiss model served as an inspiration for its application in Austria (e.g. Voralberg) and Germany (e.g. by [KCW](https://www.plan4better.de/en/references/calculation-of-public-transport-quality-classes-in-germany) and [Agora Verkehrswende](https://www.plan4better.de/en/references/accessibility-analyses-for-the-mobility-guarantee-and-public-transport-atlas-projects)).  

The institutionalization of the indicator in German-speaking countries, as well as the comprehensible and at the same time differentiated calculation methodology, are important advantages of the <i>ÖV-Güteklassen</i>. 

### Calculation

In the Swiss version of the indicator, the calculation of the quality classes is usually carried out for departures on weekdays between 6 AM and 8 PM. For the use in GOAT, the **calculation period** was made more flexible so that the indicator can be calculated **for any day of the week and time of day**. 

The calculations are carried out based on **GTFS data** (see [Network Datasets](../../data/builtin_datasets)): 
First, the number of departures per public transport mode (train, metro, tram, and bus) is dynamically calculated for each station. The sum of the departures is divided by two to calculate the frequency, to eliminate the outward and return directions. In the next step, the **average frequency** for the selected time interval is calculated. The higher-value service is selected as the **station type** in the case of service by several means of transport. For example, in the case of buses and trains, this is the train. With the help of the table below, as well as the station type and the frequency, the station category can now be determined. 

### Calculation steps

1. **Departures per station**: Calculate the number of departures per mode (train, metro, tram, bus) for each station using **GTFS data** (see [Network Datasets](../../data/builtin_datasets)).
2. **Frequency**: The sum of the departures is divided by two to eliminate the outward and return directions.
3. **Station type**: For each station, determine the highest-ranking mode of transport served (e.g., if both bus and train are available, the station is classified as a train station).
4. **Category assignment**: Use the station type and frequency to determine the category (see table below).
5. **Catchment areas**: Create buffers for each station category.
6. **Merge areas**: Overlapping areas are merged, with the higher-quality class taking precedence.


<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  
  <img src={require('/img/toolbox/accessibility_indicators/gueteklassen/classification_stations_en.webp').default} alt="Classification of transport stops" style={{ maxHeight: "auto", maxWidth: "60%", objectFit: "cover"}}/>

  <p></p>

  <img src={require('/img/toolbox/accessibility_indicators/gueteklassen/determination_oev_gueteklasse_en.webp').default} alt="Determination of Public Transport Quality Classes" style={{ maxHeight: "auto", maxWidth: "60%", objectFit: "cover"}}/>
 
  <p></p>

  <img src={require('/img/toolbox/accessibility_indicators/gueteklassen/oev_figure_en.png').default} alt="ÖV-Güteklassen Calculation" style={{ maxHeight: "400px", maxWidth: "100%", objectFit: "contain", marginTop: "24px"}}/>
</div>

<div></div>

### Station configuration

By default, GOAT classifies stations with the standard scheme from the Swiss ARE model described above. If you need a different scheme, open <code>Station configuration</code> in the tool and adjust it. The dialog has five parts, and they work together in this order: a station's average service interval and its transport mode decide its **category**, and the category and buffer distance then decide the **quality class** that each catchment ring receives.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/toolbox/accessibility_indicators/gueteklassen/station_configuration.webp').default} alt="The Station configuration dialog with its default values" style={{ maxWidth: "100%", objectFit: "contain"}}/>
</div>
<p> </p>

- <code>Configuration profile</code>: a ready-made starting point. Three profiles are available, <code>Frequency up to 60 minutes</code>, <code>Frequency up to 120 minutes</code> (the default) and <code>Frequency up to 210 minutes</code>. They differ in how many frequency tiers they cover, and with that in their station categories and how far each category reaches; <code>Frequency up to 210 minutes</code> adds a <code>1250</code> m ring and a quality class G. When your settings no longer match one of the profiles, the selector shows <code>Custom</code>.

- <code>Frequency thresholds (minutes)</code>: the service intervals used to sort stations, entered as minute values (default <code>5, 10, 20, 40, 60, 120</code>). Each value is the upper bound of an interval, so the tiers read as "up to 5 minutes", "over 5 up to 10 minutes", and so on. A station is placed in a tier by its **average frequency**: the more often it is served, the higher the tier. A station whose average interval is longer than the last threshold gets no category and no catchment, so with a lower last threshold, such as in <code>Frequency up to 60 minutes</code>, rarely served stops drop out of the result.

- <code>Transport mode groups</code>: each transport mode belongs to one of three groups, <code>A</code>, <code>B</code> or <code>C</code>. By default <code>Rail</code> and <code>Subway</code> are in group A, <code>Tram</code> and <code>Funicular</code> in group B, and <code>Bus</code> and <code>Gondola</code> in group C. Ferries and some cable cars have no row of their own: depending on how the timetable data codes them, they are either in group C or left out of the calculation. Group A ranks highest. When a station is served by several modes, the highest group it has decides its type.

- <code>Station categories</code>: a table with one row per frequency tier and one column per mode group (A, B, C). Each cell holds the **category** given to a station in that tier and group. This is the core lookup that turns frequency and mode into a single station category.

- <code>Distance classes</code>: a table with one row per station category and one column per buffer distance in metres (<code>300</code>, <code>500</code>, <code>750</code> and <code>1000</code> m, plus <code>1250</code> m in <code>Frequency up to 210 minutes</code>). The distances come with the profile and can't be changed; you set the class in each cell, as a letter. An empty cell means no ring at that distance. Each cell holds the **quality class** that a buffer ring of that size around a station of that category receives. This is what sets how far each category reaches. Where rings from different stations overlap, the better class wins.

### Visualization

The created buffer catchment areas are visualized around the stations in the corresponding colors to highlight the **quality class** (<span style={{color: "#199741"}}>A</span>-<span style={{color: "#E4696A"}}>F</span>, and G with <code>Frequency up to 210 minutes</code>).

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <img src={require('/img/toolbox/accessibility_indicators/gueteklassen/visualization.webp').default} alt="Visualization of the ÖV-Güteklassen" style={{ maxHeight: "400px", maxWidth: "100%", objectFit: "cover"}}/>
</div>


## 5. Further readings

Sample projects where ÖV-Güteklassen was used:

- [Germany-Wide Assessment of Public Transport Accessibility Through Public Transport Quality Classes white paper](https://www.plan4better.de/en/whitepapers/ov-erschliessung)
- [Accessibility analyses for the "Mobility Guarantee" and "Public Transport Atlas" projects](https://www.plan4better.de/en/references/accessibility-analyses-for-the-mobility-guarantee-and-public-transport-atlas-projects) 
- [Calculation of public transport quality classes in Austria](https://www.plan4better.de/en/references/guteklassen-osterreich)
- [Calculation of public transport quality classes in Germany](https://www.plan4better.de/en/references/calculation-of-public-transport-quality-classes-in-germany)

## 6. References

- Bundesamt für Raumentwicklung ARE, 2022. [ÖV-Güteklassen Berechnungsmethodik ARE (Grundlagenbericht)](https://www.are.admin.ch/dam/de/sd-web/AZsFQRE7tiOY/oev-gueteklassen-berechnungsmethodikare.pdf "Open Reference").

- Hiess, H., 2017. [Entwicklung eines Umsetzungskonzeptes für österreichweite ÖV-Güteklassen](https://web.archive.org/web/20251005162909/https://www.oerok.gv.at/fileadmin/user_upload/Bilder/2.Reiter-Raum_u._Region/1.OEREK/OEREK_2011/PS_RO_Verkehr/OeV-G%C3%BCteklassen_Bericht_Final_2017-04-12.pdf "Open Reference").

- metron, 2017. [Bedienungsqualität und Erschließungsgüte im Öffentlichen Verkehr](https://vorarlberg.at/documents/302033/472144/1-+Schlussbericht.pdf/81c5f0d7-a0f0-54c7-e951-462cd5cf2831?t=1616147848364 "Open Reference").

- Shkurti, Majk, 2022. "Spatio-temporal public transport accessibility analysis and benchmarking in an interactive WebGIS". url: https://www.researchgate.net/publication/365790691_Spatio-temporal_public_transport_accessibility_analysis_and_benchmarking_in_an_interactive_WebGIS 

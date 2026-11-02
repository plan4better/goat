---
description: "Explore a public transport network imported from GTFS: search its lines and stations, read headways, stops and timetables, play its vehicles on the map and estimate its operating cost."
sidebar_position: 6
---

# PT Network Explorer

The **Explorer** opens a public transport network in your project as an interactive view: **search its lines and stations, read headways, stop sequences and timetables, watch its vehicles run through the day on the map and estimate what the network costs to operate.**

## 1. Explanation

A public transport network imported from a [GTFS](https://www.plan4better.de/en/glossary/gtfs) feed arrives in your project as a [bundle](../data/dataset_types.md#datasets-made-of-several-layers): a group of layers (stops, routes, trips, stop times and so on) that belong together. The Explorer reads the whole feed at once and shows it the way riders and planners think of it: **lines** with their directions, **stations** with their platforms, **trips** with their times, and the **calendar** of days on which they run.

While the Explorer is open, it draws the network on the map itself: every line in its own colour, the stops from street level, and, during playback, the vehicles that are out at that moment. The bundle's own layers are switched off meanwhile and come back when you leave the Explorer.

Every figure refers to **one date**, which you set in the bottom bar. The operating cost is an estimate for a year, counted over a **data period** of the feed and based on cost rates you can adjust.

:::info

The Explorer opens **public transport bundles made from a GTFS feed**. To import your own feed, see [Your own public transport network](../data/builtin_datasets.md#your-own-public-transport-network). The Explorer is available in the project's `Map` view.

:::

## 2. Example use cases

- Check how often a line runs in the morning peak compared with the evening.
- Find which lines serve a station and when the next departures leave.
- Follow a single trip stop by stop and step to the trips before and after it.
- Watch the network run through a day to see where and when most vehicles are out.
- Compare the yearly operating cost of one line with that of the whole network.
- Check on which days of the timetable period a line runs, and where its service changes.

## 3. How to use the Explorer

### Open the Explorer

<div class="step">
  <div class="step-number">1</div>
  <div class="content">In your project, open the <code>Layers</code> panel and find the bundle of your public transport network.</div>
</div>

<div class="step">
  <div class="step-number">2</div>
  <div class="content">Click the <img src={require('/img/icons/3dots.png').default} alt="Options" style={{ maxHeight: "20px", maxWidth: "20px", objectFit: "cover"}}/> <code>more options</code> icon next to the bundle and select <code>Explorer</code>.</div>
</div>

<div class="step">
  <div class="step-number">3</div>
  <div class="content">The left panel now has two tabs, <code>Layers</code> and <code>Explorer</code>. While the network loads, the <code>Explorer</code> tab shows <b>Opening the network</b> with two steps: <code>Preparing the data</code> and <code>Loading the data</code>. The first time a version of a bundle is opened, preparing it can take a minute.</div>
</div>

Once the lines can be listed, the map zooms to the network. Timetables keep loading in the background; until they are in, figures that need them say `Loading timetables` with a percentage. In the `Layers` tab, the bundle is marked `In Explorer`, and `Add layer` is switched off until you leave the Explorer.

:::tip

If the network cannot be opened, the tab says why and what to do. Use `Try again` where offered, and open `Details` for the technical message if you need to report the problem.

:::

### Lines and stations

The `Explorer` tab shows the bundle's name, a search field and two sections, `Lines` and `Stations & platforms`, each with its count. One section is open at a time; click a section's header to open or fold it.

<div class="step">
  <div class="step-number">4</div>
  <div class="content">Type in <code>Search lines and stations…</code> to search both lists together. If only one of them has matches, that section opens.</div>
</div>

<div class="step">
  <div class="step-number">5</div>
  <div class="content">To narrow the lists, click the <code>Filter</code> icon at the end of the search field and tick the options you need under <code>Type</code> (<code>Lines</code> or <code>Stations & platforms</code>), <code>Transport mode</code> and <code>Agency</code>. Each option shows how many lines it covers. The filters apply as you tick them; <code>Reset</code> clears them and <code>Done</code> closes the list.</div>
</div>

Active filters show as chips under the search field; click a chip's × to remove it. On the map, lines left out by a transport mode or agency filter are faded.

- **Lines** are listed with their badge in the line's colour, their name and a transport mode icon. A line with no trips on the selected date is dimmed.
- **Stations & platforms** lists stations with their platforms folded under them, and stops that belong to no station. Each row shows the badges of the lines that call there. Click a station or platform to open its timetable in the right panel; click it again to close it.

The lists show at most 200 rows each; narrow the search to find the rest.

### The line panel

<div class="step">
  <div class="step-number">6</div>
  <div class="content">Click a line in the list, or click its line on the map. Where several lines share the track under the pointer, a list of the lines there opens to choose from.</div>
</div>

The `Explorer` tab now shows the line: its badge and name, its transport mode, agency, number of directions and stops, and three tabs: `Overview`, `Stops` and `Schedule`. On the map, the line is highlighted over the faded network, with its stops and the names of its ends, and the map zooms to it. Click `Lines` at the top to go back to the list.

#### Overview

The `Overview` tab describes the line's service on the selected date, per direction. Each section shows the date it refers to.

- `Headways`: how often the line runs in each time period, in minutes. `1 trip` means a single trip in that period.
- `Vehicles in service`: a chart of how many of the line's vehicles are out through the day.
- `Running time`: the approximate end-to-end travel time in each time period (the median).
- `Span of service`: the first and last departure of each direction.

The time periods (`Early`, `AM peak`, `Midday`, `PM peak`, `Evening`, `Night`) can be changed with the `Time periods` icon next to `Headways` and `Running time`; see [Network assumptions](#network-assumptions). If the line does not run on the selected date, pick another day in the bottom bar.

#### Stops

The `Stops` tab shows **one direction at a time**. Choose it under `Direction`: each direction is listed by where it goes, with its number of trips on the selected date, and its variants (`Short turn`, `Express` or `Branch`) indented under it.

Below the choice you see the direction's trips, stops and length, and then the stops as a line diagram: the minutes from the first stop, and the distance and minutes between each pair of stops. Where short turns end, the diagram says how many trips end there. Click a stop to open its timetable in the right panel.

On the map, the chosen direction is highlighted with arrows showing which way it runs. You can also click the selected line on the map to choose a direction; where several directions share the track, they are offered to choose from.

The direction you choose here also applies to the trip strip and to the stop timetables of this line.

#### Schedule

The `Schedule` tab shows on which days the line runs:

- `Service period`: the first and last day with service, and the number of days with service and day types.
- `Day types`: the sets of days that share the same timetable, each with its weekdays and number of trips a day. Rare day types are folded behind a link to show them.
- `Exceptions`: the days on which service is added or removed compared with the usual week, marked in the calendar.
- `Calendar`: the feed's period month by month, each day coloured by its day type. The selected date is outlined; click a day to make it the Explorer's date.

### Stop and trip panels

Stops and trips open in a panel on the right. Click `‹` at its top to go back to the item you opened it from, or `Close` to close it.

**A stop, platform or station** shows its name, its platforms, the number of lines and, where the feed says so, wheelchair boarding. Switch between two views:

- `Timetable`: the departures of one line per direction, as hours and minutes. If several lines leave here, pick one under `Lines`. The next departure after the playback time is highlighted. A departure in a dotted outline is a time window: the feed gives no time for this stop on that trip. Click a direction's heading to open the line.
- `Next`: the next departures of all lines from the playback time on, with how many minutes until each leaves.

Click a departure to open its trip.

**A trip** shows its line badge, its departure time, its first and last stop and the date. Under it you see when it runs, how long it takes and how many stops it has; use the arrows (`Previous trip`, `Next trip`) to step to the trips before and after it in the same direction. Two tabs follow: `Stops`, its stops with their times (click a stop to open its timetable), and `Schedule`, the days on which this trip runs. While playback is within the trip, the stops already passed are dimmed, and its vehicle is ringed on the map.

You can also open these panels from the map: click a vehicle to open its trip, a stop to open its timetable, or, zoomed in, the area of a station to open the timetable of all its stops. A click on an empty part of the map closes the right panel first, then the selected line.

### Playback and the date

The bar at the bottom of the map plays the network through its day:

- **Play and pause** the vehicles on the map. While paused, the map shows the network without vehicles.
- **Speed**: `1×`, `10×` or `60×`.
- **Date**: the date all figures refer to. Use the arrows to go to the day before or after, or click the date to pick one from a calendar. The Explorer opens on today if the feed covers it, otherwise on the nearest day it does. A date outside the data period is shown in grey.
- **Time**: the clock, and a slider to move through the day's service.
- **Vehicles**: how many vehicles are out at that moment, in the whole network or, with a line selected, on that line in the direction shown.

Vehicles are dots in their line's colour; zoomed in, or for the selected line, they carry the line's badge. Click a vehicle to open its trip.

:::info

On a device or browser with too little memory, playback is switched off and the play button says why. Everything else in the Explorer still works.

:::

### The trip strip

With a line selected, the bottom bar grows into the **trip strip**: the line's trips across its whole day. Its header shows the direction (the same choice as in the `Stops` tab) and a button to fold the strip away (`Fold the trips away`); folded, the line's badge in the bar brings it back (`Show the trips`). Drag the strip's top edge to make it taller or shorter.

Switch between two views at the bottom of the strip:

- `Chart`: each trip is a line, with the time of day across and the distance along the direction down; the ends of the direction and of its variants are named on the left. Short turns are dashed. Click a trip's line to open it in the right panel; the map flies to its vehicle if it is out. Click elsewhere on the chart to set the playback time, or drag the vertical time line. Drag a box to zoom into part of the day and route (or pinch, or Ctrl and scroll); `Reset zoom`, Esc or a double-click goes back to the whole day. A strip dragged tall enough also shows the `Vehicles` in service along its bottom.
- `List`: one row per trip with `Departs`, `Arrives`, `Duration`, `Distance`, `Direction` and `Stops`. A dot marks the trips running at the playback time. A distance marked ≈ is an estimate measured in straight lines between stops, because the feed has no shape for that trip.

The number of trips in view is shown next to the switch.

### Operating cost

Below the left panel, the `Operating cost` card estimates what the network costs to run in a year:

- `Whole network`, always;
- the selected line (or the line of the trip open in the right panel), under it;
- the open trip of that line, under the line.

Each step shows its approximate yearly cost. The deepest step also shows its `Vehicle-kilometers` and `Vehicle-hours`. The foot of the card says the figures are `Annualized` and from which months of the data period they are counted. Click the `Cost rates` icon in the card's header to adjust the rates.

### Network assumptions

The `Network assumptions` dialog holds the assumptions behind the figures. It opens from the `Cost rates` icon on the cost card and from the `Time periods` icon in a line's `Overview`, and has three tabs:

- `Operating cost`, with two views:
  - `Cost rates`: choose the `Currency` and the `Agency`, then set a `Rate per km` and, optionally, a `Rate per hour` for each kind of vehicle the agency runs. A field left empty uses the default shown in it. For metro and rail, the rate is `Per trainset`. Agencies with their own rates say `rates set`. A formula under the fields shows how the cost is calculated.
  - `Data period`: the days the yearly figures are counted over. A chart shows the `Daily trips` across the whole feed; drag the two handles (`First day` and `Last day`) to set the period, or choose `Optimum period` (the stretch the timetable fully covers, used by default) or `Entire period`.
- `Time periods`: the end time of each period from `Early` to `Evening`, as HH:MM. Each period starts where the one before ends, and `Night` runs to the end of the service day (48:00).
- `Vehicles`: the `Turnaround time`, the standing time at the end of each trip, in minutes.

Click `Save` to apply the changes. They are kept for this bundle **in this browser** only.

### Exit the Explorer

<div class="step">
  <div class="step-number">7</div>
  <div class="content">Click the × on the <code>Explorer</code> tab (<code>Exit Explorer</code>), or select <code>Exit Explorer</code> in the bundle's <code>more options</code> menu in the <code>Layers</code> tab.</div>
</div>

The bundle's layers are shown on the map again, and you can add layers again.

## 4. Technical details

**Operating cost.** The yearly cost of a network, line or trip is estimated as:

`Annual operating cost ≈ vehicle-km × km rate + vehicle-hours × hour rate`

The vehicle-kilometers and vehicle-hours come from the timetable and its calendar: each service's daily kilometers and hours times the days it runs in the data period, scaled from the period's length to 365 days. Rates are set per agency and kind of vehicle. Where none is set, a default per kilometer applies: 5.5 for buses and other modes, 8 for trams and trolleybuses, and 24 per trainset for metro and rail, in the selected currency (`EUR` by default). The hour rate is optional and empty by default.

**Default time periods.** `Early` until 07:00, `AM peak` 07:00 to 09:00, `Midday` 09:00 to 15:00, `PM peak` 15:00 to 18:00, `Evening` 18:00 to 22:00 and `Night` from 22:00. Times past midnight are written as the timetable writes them (for example 24:30).

**Turnaround time.** The default turnaround time is 6 minutes.

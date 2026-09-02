---
sidebar_position: 3

---

# Public Transport

The **Public Transport Routing** in GOAT is essential for performing analyses that include public transport trips.

## 1. Objectives

Public transport routing facilitates **intermodal analysis** by integrating access and egress modes, such as walking, cycling, or driving to and from the station. This is more complex than the other routing modes as it requires the merging of different datasets (such as sidewalks & bike lanes, public transport stops & schedules, etc.) and calculation approaches.

Public transport routing is used for indicators such as [Catchment Areas](../toolbox/accessibility_indicators/catchments) and [Heatmaps](../toolbox/accessibility_indicators/connectivity) in GOAT.


## 2. Data

### Transit Data

Utilizes data in the **[GTFS](https://gtfs.org/)** (General Transit Feed Specification) format for static public transport network information (stops, routes, schedules, transfers, and more).


### Street Data

Incorporates street-level information from  **[OpenStreetMap](https://wiki.openstreetmap.org/)** to support multi-modal routing and real-world path connections (includes sidewalks, bike lanes, and crosswalks).


## 3. Technical Details

A public transport trip consists of three legs: an **access leg** from the origin to a PT station, the **transit leg** through the PT network, and an **egress leg** from the PT station to the destination. The access and egress modes can be configured independently.

<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '1.5rem' }}>
  <img src={require('/img/routing/pt_trip_structure.png').default} alt="PT trip structure and example combinations" style={{ maxWidth: "100%", objectFit: "contain"}}/>
</div>

Public transport routing is performed by GOAT's own high-performance routing engine, which wraps the open-source **[nigiri](https://github.com/motis-project/nigiri)** library. Nigiri is a C++ library from the **[MOTIS project](https://github.com/motis-project/motis)** that provides one-to-all public transport connection search using the **RAPTOR** algorithm.

The **transit leg** is computed by nigiri, while the **access and egress legs** (first and last mile) use GOAT's own **Dijkstra** implementation — the same routing used for active mobility and car. This keeps street-level routing consistent across all transport modes.


### Routing Options

#### Modes

Analyses for the following modes of public transport are currently supported by GOAT. Choose between one or more, keeping in mind that some modes may not be available in all regions.

`bus` `tram` `rail` `subway` `ferry` `cable_car` `gondola` `funicular`

#### Travel time limit

The maximum journey duration to consider for public transport routing. A maxium of `90 min` is currently supported. This includes the time spent during access and egress from public transport stations.

#### Day

The day of the week to consider for public transport routing. Choose between `Weekday`, `Saturday` and `Sunday`. This is useful for evaluating changes in service between weekdays and weekends.

#### Start and End time

A time window for public transport routing. The engine evaluates **every departure minute** within this window and keeps the **fastest** journey to each reachable location — it is not an average over the window. The result is therefore the best-case, largest possible catchment area from your specified origin point. A journey is considered to fall within the time window solely based on its start time, regardless of its end time or duration.

:::note

Certain indicators may only support a **single departure or arrival time** instead of a time window. In this case, the engine will only evaluate journeys that start at or after a departure time or end at or before an arrival time.

:::

#### Maximum transfers

The maximum number of transfers a PT journey may include. A maximum of `5` transfers is supported.

#### Access and Egress

The **access leg** (origin to public transport stop) and the **egress leg** (public transport stop to destination) can be configured independently. For each, the following options are currently supported.

| Tool | Mode | Calculate by | Limit |
|------|------|--------------|-------|
| Catchment Area | <code>Walk</code>, <code>Bicycle</code>, <code>Pedelec</code>, <code>Car</code> | <code>Time</code> or <code>Distance</code> | Upto overall <code>Limit</code> |
| Heatmaps | <code>Walk</code> | <code>Time</code> | 30 minutes |
| Huff Model | <code>Walk</code> | <code>Time</code> | 30 minutes |
| Travel Cost Matrix | <code>Walk</code>, <code>Bicycle</code>, <code>Pedelec</code>, <code>Car</code> | <code>Time</code> or <code>Distance</code> | Upto overall <code>Limit</code> |

- **Speed** — the travel speed used for the leg (when calculating by `Time`).

By default, both the access and egress legs use `Walk`, a `Time` limit of `15 min`, and a speed of `5 km/h`.
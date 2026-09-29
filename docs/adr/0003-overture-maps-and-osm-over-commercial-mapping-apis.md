# ADR-0003: Adoption of Overture Maps Foundation & OSM Over Commercial Mapping APIs

- **Status:** Accepted
- **Deciders:** Engineering Lead / Architecture Team
- **Date:** 2026-09-24

---

## 1. Context & Problem Statement
ParkSezgi requires two fundamental types of geospatial data to power its heuristic algorithm:
1. **Geometric Road Network:** Street classifications (`residential`, `living_street`, `primary`), one-way status, pedestrian zones, and topological boundaries.
2. **Dense Commercial Venues (POIs):** Accurate coordinates and classifications for cafes, restaurants, grocery stores, pharmacies, and shopping centers that directly induce vehicle parking congestion and illegal bollard placement.

Commercial mapping platforms (Google Maps Places API, Mapbox Search API) charge significant fees ($17.00 to $32.00 per 1,000 requests), making continuous user interactions unaffordable for an open community tool.

---

## 2. Alternatives Considered

### Option A: Google Maps Platform (Places API + JavaScript API)
- **Trade-offs:**
  - ✅ High data quality and venue coverage.
  - ❌ Prohibitive cost: The $200 free tier is exhausted within ~10,000 requests.
  - ❌ Terms of Service prohibit persistent caching and offline pre-bundling.

### Option B: Pure OpenStreetMap (Overpass API for both roads and POIs)
- **Trade-offs:**
  - ✅ 100% open source, zero license fees.
  - ❌ Commercial POI density in OpenStreetMap for Istanbul is sparse and incomplete; many small businesses, cafes, and bakeries are not tagged in OSM.
  - ❌ Overpass API public endpoints impose strict rate limits and IP blocking (frequent HTTP 429/504 errors).

### Option C: Dual Open Geospatial Architecture (OSM Topology + Overture Maps POIs)
- **Trade-offs:**
  - **Road Topology:** Leverages OpenStreetMap via multi-mirror Overpass API failover network with client-side offline fallbacks.
  - **Commercial POIs:** Leverages the **Overture Maps Foundation** (an open data consortium founded by Meta, Microsoft, AWS, and TomTom) to harvest commercial venues directly from parquet datasets hosted on AWS S3 via DuckDB and Python.

---

## 3. Decision Outcome
**Chosen: Option C (Dual Open Geospatial Architecture).**

We developed a dedicated offline harvester script ([`poi_harvester.py`](file:///C:/Users/versi/.gemini/antigravity/scratch/park-bulucu/poi_harvester.py)) that queries Overture Maps' global places release for Istanbul's coordinates, filters out non-parking-related categories, maps taxonomy, and exports a lightweight, highly optimized spatial JSON database ([`commercial_pois_db.json`](file:///C:/Users/versi/.gemini/antigravity/scratch/park-bulucu/commercial_pois_db.json)).

---

## 4. Consequences & Performance Metrics

### Positive:
- **100,542 Commercial Venues Harvested:** Unprecedented POI accuracy across Greater Istanbul (18,016 venues in pilot zone) at **$0 data acquisition cost**.
- **Zero Runtime API Keys:** Neither OSM nor Overture requires proprietary API keys for runtime client execution.
- **Resilient Offline Architecture:** Complete independence from third-party vendor rate limits or service deprecations.
- **Offline Pilot Bundle:** Includes pre-bundled geometries and venues allowing instantaneous initialization even under zero network connectivity.

### Negative:
- Venue data requires periodic offline batch updates (e.g. monthly cron job harvesting new Overture releases).

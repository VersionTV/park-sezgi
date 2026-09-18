#!/usr/bin/env python3
"""
harvester.py
Beylikdüzü ve Büyükçekmece Pilot Bölgeleri için Mekan / POI Toplayıcı (Harvester)

Özellikler:
1. OpenStreetMap Overpass API üzerinden derin POI (kafe, restoran, bar, fırın, AVM) taraması.
2. (Opsiyonel) Google Places API anahtarı verilirse Google'dan yüksek doğruluklu mekanları çekme.
3. Çekilen mekanları 'commercial_pois_db.json' dosyasına birleştirip kaydetme.

Kullanım:
  python harvester.py
  python harvester.py --google-key AIzaSy...
"""

import json
import os
import sys
import urllib.request
import urllib.parse
import time

# Windows terminal UTF-8 desteği
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "commercial_pois_db.json")
STREETS_OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "offline_pilot_streets.json")

# Pilot Bölgeler (Merkez Koordinatları ve Yarıçap)
PILOT_ZONES = [
    {
        "name": "Kameroğlu Metrohome (Beylikdüzü)",
        "lat": 41.0142,
        "lon": 28.6375,
        "radius": 400
    },
    {
        "name": "Beylikdüzü Yaşam Vadisi / Barış Mah.",
        "lat": 41.0020,
        "lon": 28.6410,
        "radius": 450
    },
    {
        "name": "Büyükçekmece Kordonboyu Sahil",
        "lat": 41.0205,
        "lon": 28.5835,
        "radius": 500
    },
    {
        "name": "Büyükçekmece Albatros Sahili",
        "lat": 41.0118,
        "lon": 28.5772,
        "radius": 400
    }
]

# Çevrimdışı Sokak Ağı Pilot Bölgeleri (Yarıçapları ile tüm pilot alanları kapsar)
STREET_PILOT_ZONES = [
    {
        "name": "Kameroğlu Metrohome & Çevresi",
        "lat": 41.0142,
        "lon": 28.6375,
        "radius": 650
    },
    {
        "name": "Bizimkent Sitesi & Emlak Konut",
        "lat": 41.0065,
        "lon": 28.6445,
        "radius": 650
    },
    {
        "name": "Beylikdüzü Yaşam Vadisi & Barış Mah.",
        "lat": 41.0020,
        "lon": 28.6410,
        "radius": 650
    },
    {
        "name": "Büyükçekmece Kordonboyu Sahil",
        "lat": 41.0205,
        "lon": 28.5835,
        "radius": 750
    },
    {
        "name": "Kıyı İstanbul Marina & Liman",
        "lat": 41.0195,
        "lon": 28.5750,
        "radius": 650
    },
    {
        "name": "Büyükçekmece Albatros Sahili",
        "lat": 41.0118,
        "lon": 28.5772,
        "radius": 650
    },
    {
        "name": "Beylikdüzü Cumhuriyet Mah. & Metrobüs Çevresi",
        "lat": 41.0152,
        "lon": 28.6534,
        "radius": 650
    }
]

def fetch_osm_deep_pois(zone):
    """Overpass API ile derin POI taraması yapar."""
    lat, lon, radius = zone["lat"], zone["lon"], zone["radius"]
    query = f"""
    [out:json][timeout:25];
    (
      node["amenity"~"^(cafe|restaurant|fast_food|bar|pub|food_court|pharmacy)$"](around:{radius}, {lat}, {lon});
      node["shop"](around:{radius}, {lat}, {lon});
      way["amenity"~"^(cafe|restaurant|fast_food|bar|pub|food_court)$"](around:{radius}, {lat}, {lon});
      way["shop"](around:{radius}, {lat}, {lon});
    );
    out center tags;
    """
    
    url = "https://overpass.kumi.systems/api/interpreter"
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "ParkSezgiHarvester/1.0"})
    
    pois = []
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            for el in body.get("elements", []):
                tags = el.get("tags", {})
                name = tags.get("name")
                if not name:
                    continue
                
                # Koordinat bul
                p_lat = el.get("lat") or (el.get("center", {}).get("lat"))
                p_lon = el.get("lon") or (el.get("center", {}).get("lon"))
                if not p_lat or not p_lon:
                    continue
                
                poi_type = tags.get("amenity") or tags.get("shop") or "shop"
                pois.append({
                    "name": name,
                    "type": poi_type,
                    "lat": round(p_lat, 5),
                    "lon": round(p_lon, 5),
                    "zone": zone["name"]
                })
    except Exception as e:
        print(f"  [UYARI] {zone['name']} için OSM sorgusu yanıt vermedi: {e}")
    
    return pois

def fetch_google_places(zone, api_key):
    """(Opsiyonel) Google Places Nearby Search ile mekan çeker."""
    lat, lon, radius = zone["lat"], zone["lon"], zone["radius"]
    url = f"https://maps.googleapis.com/maps/api/place/nearbysearch/json?location={lat},{lon}&radius={radius}&type=cafe|restaurant|bar&key={api_key}"
    
    pois = []
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            for item in data.get("results", []):
                name = item.get("name")
                loc = item.get("geometry", {}).get("location", {})
                types = item.get("types", [])
                poi_type = "cafe" if "cafe" in types else ("restaurant" if "restaurant" in types else "shop")
                
                pois.append({
                    "name": name,
                    "type": poi_type,
                    "lat": round(loc.get("lat", 0), 5),
                    "lon": round(loc.get("lon", 0), 5),
                    "zone": zone["name"]
                })
    except Exception as e:
        print(f"  [HATA] Google Places sorgu hatası: {e}")
    
    return pois

def fetch_osm_streets(zone):
    """Overpass API ile gerçek cadde ve sokak ağını çeker (out geom)."""
    lat, lon, radius = zone["lat"], zone["lon"], zone["radius"]
    query = f"""
    [out:json][timeout:25];
    (
      way["highway"~"^(residential|living_street|service|tertiary|secondary|primary)$"](around:{radius}, {lat}, {lon});
    );
    out geom;
    """
    endpoints = [
        "https://lz4.overpass-api.de/api/interpreter",
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter"
    ]
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    for ep in endpoints:
        try:
            req = urllib.request.Request(ep, data=data, headers={"User-Agent": "ParkSezgiHarvester/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                ways = []
                for el in body.get("elements", []):
                    if el.get("type") == "way" and "geometry" in el and el.get("tags", {}).get("highway"):
                        latlngs = [[pt["lat"], pt["lon"]] for pt in el["geometry"]]
                        if len(latlngs) >= 2:
                            ways.append({
                                "id": el["id"],
                                "tags": el["tags"],
                                "latlngs": latlngs
                            })
                return ways
        except Exception as e:
            print(f"  [UYARI] {ep} geçici olarak yanıt vermedi: {e}")
            continue
    return []

def harvest_streets():
    print("==================================================")
    print("🛣️ ParkSezgi Gerçek Sokak Ağı Toplayıcı")
    print("==================================================")
    
    existing_ways = []
    if os.path.exists(STREETS_OUTPUT_FILE):
        try:
            with open(STREETS_OUTPUT_FILE, "r", encoding="utf-8") as f:
                existing_ways = json.load(f)
            print(f"Mevcut çevrimdışı veri tabanında {len(existing_ways)} sokak kayıtlı.")
        except Exception:
            existing_ways = []
            
    way_dict = {w["id"]: w for w in existing_ways}
    
    for zone in STREET_PILOT_ZONES:
        print(f"\n🔍 Sokaklar İndiriliyor: {zone['name']} (r={zone['radius']}m)...")
        ways = fetch_osm_streets(zone)
        new_count = 0
        for w in ways:
            if w["id"] not in way_dict:
                way_dict[w["id"]] = w
                new_count += 1
        print(f"  ✓ {len(ways)} sokak çekildi, {new_count} yeni sokak eklendi (Toplam: {len(way_dict)})")
        time.sleep(1.0) # Nazik bekleme (Overpass rate limit önleyici)
        
    all_ways = list(way_dict.values())
    with open(STREETS_OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(all_ways, f, ensure_ascii=False)
        
    print("\n==================================================")
    print(f"✅ Çevrimdışı sokak paketi hazırlandı: {STREETS_OUTPUT_FILE}")
    print(f"Toplam gerçek sokak sayısı: {len(all_ways)}")
    print("==================================================")

def harvest_pois(google_key=None):
    print("==================================================")
    print("📍 ParkSezgi POI Harvester (Veri Toplayıcı)")
    print("==================================================")
    
    # Mevcut veriyi oku
    existing_pois = []
    if os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
                existing_pois = json.load(f)
            print(f"Mevcut veritabanında {len(existing_pois)} mekan kayıtlı.")
        except Exception:
            existing_pois = []

    all_pois = list(existing_pois)
    existing_names = {p["name"].lower() for p in all_pois if "name" in p}

    for zone in PILOT_ZONES:
        print(f"\n🔍 Taranıyor: {zone['name']} (r={zone['radius']}m)...")
        new_pois = []

        if google_key:
            print("  -> Google Places API kullanılıyor...")
            new_pois = fetch_google_places(zone, google_key)
        else:
            print("  -> Açık kaynak OpenStreetMap derin tarama kullanılıyor...")
            new_pois = fetch_osm_deep_pois(zone)

        added_count = 0
        for p in new_pois:
            if p["name"].lower() not in existing_names:
                all_pois.append(p)
                existing_names.add(p["name"].lower())
                added_count += 1

        print(f"  ✓ {added_count} yeni mekan eklendi (Toplam: {len(all_pois)})")

    # JSON'a kaydet
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(all_pois, f, ensure_ascii=False, indent=2)

    print("\n==================================================")
    print(f"✅ Tamamlandı! Güncel veri kaydedildi: {OUTPUT_FILE}")
    print(f"Toplam mekan sayısı: {len(all_pois)}")
    print("==================================================")

def main():
    google_key = None
    do_streets = False
    do_pois = False

    if "--harvest-streets" in sys.argv:
        do_streets = True
    if "--harvest-pois" in sys.argv or "--google-key" in sys.argv:
        do_pois = True

    for i, arg in enumerate(sys.argv):
        if arg == "--google-key" and i + 1 < len(sys.argv):
            google_key = sys.argv[i + 1]

    # Parametre verilmediyse varsayılan olarak her ikisini de çalıştır
    if not do_streets and not do_pois:
        do_streets = True
        do_pois = True

    if do_streets:
        harvest_streets()
    if do_pois:
        harvest_pois(google_key)

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
poi_harvester.py - Overture Maps (Meta & Microsoft Açık POI Havuzu) Tabanlı İstanbul Mekan Toplayıcı
Google Maps kalitesindeki kafe, restoran, süpermarket ve ticari işletme verilerini %100 ücretsiz çeker.
"""

import os
import sys
import json
import time
import argparse
import overturemaps
import shapely.wkb

# Terminal UTF-8 desteği (Windows için)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(BASE_DIR, "commercial_pois_db.json")

# İstanbul Koordinat Bölgeleri (min_lon, min_lat, max_lon, max_lat)
ZONES = {
    # 1. Pilot Bölge ve Yakın Çevresi (Beylikdüzü, Büyükçekmece, Esenyurt, Avcılar, Küçükçekmece)
    "pilot": {
        "name": "Beylikdüzü & Büyükçekmece Pilot Aksı",
        "bbox": (28.53, 40.96, 28.75, 41.06)
    },
    "avrupa_bati": {
        "name": "Avrupa Batı (Büyükçekmece, Beylikdüzü, Esenyurt, Avcılar)",
        "bbox": (28.48, 40.95, 28.78, 41.08)
    },
    # 2. Avrupa Merkez & Sahil (Bakırköy, Zeytinburnu, Fatih, Beyoğlu, Şişli, Beşiktaş)
    "avrupa_merkez": {
        "name": "Avrupa Merkez (Fatih, Beşiktaş, Şişli, Kadıköy Boğaz Hattı)",
        "bbox": (28.88, 40.98, 29.05, 41.08)
    },
    # 3. Anadolu Merkez (Kadıköy, Üsküdar, Ataşehir, Maltepe)
    "anadolu_merkez": {
        "name": "Anadolu Merkez (Kadıköy, Üsküdar, Ataşehir, Maltepe)",
        "bbox": (29.00, 40.94, 29.18, 41.04)
    }
}

# Otoparkı ve araç sirkülasyonunu doğrudan etkileyen kategori eşleme sözlüğü
CATEGORY_MAP = {
    # Yeme - İçme & Kafe (Müşteri trafiği, kuryeler, valeler, dubalar)
    "restaurant": "restaurant",
    "fast_food_restaurant": "fast_food",
    "casual_eatery": "restaurant",
    "cafe": "cafe",
    "coffee_shop": "cafe",
    "tea_house": "cafe",
    "pizzeria": "restaurant",
    "barbecue_restaurant": "restaurant",
    "seafood_restaurant": "restaurant",
    "diner": "restaurant",
    "bistro": "restaurant",
    "bakery": "bakery",
    "dessert_shop": "bakery",
    "ice_cream_shop": "cafe",
    "bar": "bar",
    "pub": "bar",
    "night_club": "bar",
    "lounge": "bar",
    "gastropub": "bar",

    # Alışveriş & Günlük İhtiyaç (Kısa süreli araç parkı, yük indirme-bindirme)
    "supermarket": "supermarket",
    "grocery_store": "supermarket",
    "convenience_store": "supermarket",
    "food_and_beverage_store": "shop",
    "shopping_mall": "mall",
    "department_store": "shop",
    "fashion_and_apparel_store": "shop",
    "clothing_store": "shop",
    "eyewear_store": "shop",
    "pharmacy": "pharmacy",

    # Araç & Sağlık Servisleri
    "car_repair": "car_repair",
    "auto_service": "car_repair",
    "car_wash": "car_repair",
    "gas_station": "gas_station",
    "bank": "bank",
    "atm": "bank",
    "hospital": "clinic",
    "clinic": "clinic",
    "medical_center": "clinic"
}

def normalize_category(basic_cat, taxonomy):
    """Overture kategorisini ParkSezgi motorunun anladığı türe dönüştürür."""
    tax_primary = (taxonomy or {}).get("primary", "") if isinstance(taxonomy, dict) else ""
    basic = str(basic_cat or "").lower()
    tax = str(tax_primary or "").lower()

    # 1. Öncelikli olarak spesifik taxonomy kontrolü
    for key, mapped in CATEGORY_MAP.items():
        if key in tax:
            return mapped

    # 2. basic_category kontrolü
    for key, mapped in CATEGORY_MAP.items():
        if key in basic:
            return mapped

    # 3. İsim içinde anahtar kelime eşleşmesi
    if "restaurant" in basic or "eat" in basic:
        return "restaurant"
    if "cafe" in basic or "coffee" in basic:
        return "cafe"
    if "store" in basic or "shop" in basic or "market" in basic:
        return "shop"

    return None

def fetch_zone_places(zone_key, zone_info):
    """Overture Maps'ten belirli bir bölgenin mekanlarını akışla çeker."""
    bbox = zone_info["bbox"]
    print(f"\n📡 [{zone_info['name']}] Mekan verileri Overture Maps bulutundan indiriliyor...")
    print(f"   BBox: lon({bbox[0]} -> {bbox[2]}), lat({bbox[1]} -> {bbox[3]})")

    start_time = time.time()
    extracted_pois = []
    total_processed = 0

    try:
        reader = overturemaps.record_batch_reader("place", bbox=bbox)
        if not reader:
            print(f"   ⚠️ Bu koordinat alanı için kayıt okunamadı.")
            return []

        while True:
            try:
                batch = reader.read_next_batch()
            except StopIteration:
                break
            except Exception as e:
                print(f"   [UYARI] Parquet paketi okunurken atlandı: {e}")
                break

            df = batch.to_pydict()
            batch_len = len(df["id"])
            total_processed += batch_len

            for i in range(batch_len):
                names_dict = df["names"][i] or {}
                name = names_dict.get("primary")
                if not name or len(name.strip()) < 2:
                    continue

                geom_raw = df["geometry"][i]
                if not geom_raw:
                    continue

                try:
                    pt = shapely.wkb.loads(geom_raw)
                    lat = round(float(pt.y), 5)
                    lon = round(float(pt.x), 5)
                except Exception:
                    continue

                # Kategori eşleme
                basic_cat = df["basic_category"][i]
                taxonomy = df["taxonomy"][i]
                poi_type = normalize_category(basic_cat, taxonomy)

                if not poi_type:
                    continue

                extracted_pois.append({
                    "name": name.strip(),
                    "type": poi_type,
                    "lat": lat,
                    "lon": lon,
                    "category": str(basic_cat or ""),
                    "zone": zone_info["name"]
                })

        duration = round(time.time() - start_time, 2)
        print(f"   ✓ {total_processed} toplam mekan tarandı -> {len(extracted_pois)} parkı etkileyen işletme ayrıştırıldı ({duration} sn).")

    except Exception as e:
        print(f"   ❌ Hata: {e}")

    return extracted_pois

def deduplicate_pois(poi_list):
    """Birbirine 15 metreden yakın aynı isimli veya mükerrer mekanları teke indirir."""
    print(f"\n🧹 Mükerrer (Duplicate) kayıtlar temizleniyor ({len(poi_list)} aday)...")
    unique_pois = []
    seen = set()

    for p in poi_list:
        # Yaklaşık 15 metre hassasiyetinde ızgara anahtarı (0.00015 derece ~ 15m)
        grid_lat = round(p["lat"] / 0.00015)
        grid_lon = round(p["lon"] / 0.00015)
        name_clean = "".join(filter(str.isalnum, p["name"].lower()))[:12]
        key = (grid_lat, grid_lon, name_clean)

        if key in seen:
            continue
        seen.add(key)
        unique_pois.append(p)

    print(f"   ✓ Temizleme tamamlandı: {len(poi_list)} -> {len(unique_pois)} tekil işletme.")
    return unique_pois

def main():
    parser = argparse.ArgumentParser(description="ParkSezgi Overture Maps POI Harvester")
    parser.add_argument("--zones", choices=["pilot", "avrupa_bati", "all"], default="pilot",
                        help="İndirilecek bölge: 'pilot' (Beylikdüzü/Büyükçekmece), 'avrupa_bati', 'all' (Tüm İstanbul)")
    args = parser.parse_args()

    print("==================================================")
    print("🏢 ParkSezgi Google/Overture Maps Açık POI Toplayıcı")
    print("   Kaynak: Meta (Instagram/FB) & Microsoft Places")
    print("==================================================")

    # Var olan manuel doğrulanmış POI'leri koru (örn. Kameroğlu detayları)
    existing_manual = []
    if os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                # Manuel eklenen veya özel notlu olanları koru
                existing_manual = [p for p in data if p.get("verified") or p.get("zone") == "Kameroğlu Metrohome (Beylikdüzü)"]
            print(f"📌 {len(existing_manual)} adet doğrulanmış yerel POI korundu.")
        except Exception:
            existing_manual = []

    target_zone_keys = list(ZONES.keys()) if args.zones == "all" else [args.zones]

    all_harvested = []
    for zk in target_zone_keys:
        if zk in ZONES:
            zone_pois = fetch_zone_places(zk, ZONES[zk])
            all_harvested.extend(zone_pois)

    # Birleştir ve deduplicate et
    combined = existing_manual + all_harvested
    final_pois = deduplicate_pois(combined)

    # İstatistikler
    type_counts = {}
    for p in final_pois:
        t = p.get("type", "diger")
        type_counts[t] = type_counts.get(t, 0) + 1

    print("\n📊 İndirilen İşletme Dağılımı:")
    for t, cnt in sorted(type_counts.items(), key=lambda x: x[1], reverse=True):
        print(f"   • {t:15}: {cnt} adet")

    # Dosyaya kaydet
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(final_pois, f, ensure_ascii=False, indent=2)

    print(f"\n✅ Başarıyla kaydedildi: {OUTPUT_FILE}")
    print(f"Toplam Aktif Ticari Mekan: {len(final_pois)}")
    print("==================================================")

if __name__ == "__main__":
    main()

/**
 * app.js
 * Harita Katmanları (Sade Gri / Renkli), Overpass API Canlı Veri, Gelişmiş Arama ve #1 #2 #3 Rozetleri
 */

// Global Değişkenler & State
let map;
let currentTileLayerGroup = null;
let targetMarker = null;
let targetRadiusCircle = null;
let radarWaveMarker = null;
let streetPolylinesLayerGroup = null;
let topBadgesLayerGroup = null;
let walkingRouteLayer = null;

let currentTarget = {
    lat: 41.0205,
    lon: 28.5835,
    name: 'Büyükçekmece Kordonboyu'
};

let currentRadius = 500;
let currentTimeMode = 'weekday_day';
let currentLoadedWays = [];
let currentLoadedPOIs = [];
let localCommercialPOIs = [];
let offlinePilotStreets = [];
let selectedStreetData = null;
let searchDebounceTimer = null;
let fetchDebounceTimer = null;
let isOfflineFallbackActive = false;

// 1. Kademe: İstemci Tarafı Mekansal Önbellek (Spatial Street Cache)
const spatialStreetCache = new Map();

// Hazır Pilot Noktalar (Beylikdüzü & Büyükçekmece)
const PRESET_LOCATIONS = {
    'bcekmece_kordon': {
        name: 'Büyükçekmece Kordonboyu (Sahil & Kafeler)',
        lat: 41.0205,
        lon: 28.5835
    },
    'beylikduzu_kameroglu': {
        name: 'Kameroğlu Metrohome (Kafe & Açık Çarşı)',
        lat: 41.0142,
        lon: 28.6375
    },
    'bcekmece_marina': {
        name: 'Kıyı İstanbul Marina (Özel İşletme & Liman)',
        lat: 41.0195,
        lon: 28.5750
    },
    'beylikduzu_yasam_vadisi': {
        name: 'Beylikdüzü Yaşam Vadisi (Barış Mah.)',
        lat: 41.0020,
        lon: 28.6410
    },
    'beylikduzu_bizimkent': {
        name: 'Bizimkent Sitesi (Güvenlikli Site Testi)',
        lat: 41.0065,
        lon: 28.6445
    }
};

// Hızlı Yerel Arama Sözlüğü (Anında yanıt için)
const LOCAL_LANDMARKS = [
    { name: 'Kameroğlu Metrohome', detail: 'Beylikdüzü Kafe & Açık Çarşı Bulvarı', lat: 41.0142, lon: 28.6375 },
    { name: 'Büyükçekmece Kordonboyu', detail: 'Sahil & Kafe Bölgesi', lat: 41.0205, lon: 28.5835 },
    { name: 'Kıyı İstanbul Marina', detail: 'Büyükçekmece Liman & Marina', lat: 41.0195, lon: 28.5750 },
    { name: 'Albatros Sahili', detail: 'Büyükçekmece Sahil Parkı', lat: 41.0118, lon: 28.5772 },
    { name: 'Beylikdüzü Yaşam Vadisi', detail: 'Barış Mahallesi Parkı', lat: 41.0020, lon: 28.6410 },
    { name: 'Bizimkent Sitesi', detail: 'Beylikdüzü Güvenlikli Konut Alanı', lat: 41.0065, lon: 28.6445 },
    { name: 'Beylikdüzü Cumhuriyet Mahallesi', detail: 'Metrobüs & Çarşı Çevresi', lat: 41.0152, lon: 28.6534 },
    { name: 'Beylikdüzü Migros AVM', detail: 'E-5 Yan Yol & AVM Çevresi', lat: 41.0045, lon: 28.6580 },
    { name: 'Gürpınar Sahili', detail: 'Beylikdüzü Sahil Yolu & Park', lat: 40.9715, lon: 28.6185 },
    { name: 'TÜYAP Fuar Merkezi', detail: 'Büyükçekmece / Beylikdüzü Sınırı', lat: 41.0245, lon: 28.6255 }
];

// Uygulama Başlatma
document.addEventListener('DOMContentLoaded', async () => {
    initMap();
    initEventListeners();
    initSearch();
    await Promise.all([
        loadLocalCommercialPOIs(),
        loadOfflinePilotStreets()
    ]);
    setNewTarget(currentTarget.lat, currentTarget.lon, currentTarget.name);
});

// Yerel Yüksek Yoğunluklu POI Veritabanını Yükle
async function loadLocalCommercialPOIs() {
    try {
        const res = await fetch('commercial_pois_db.json');
        if (res.ok) {
            localCommercialPOIs = await res.json();
            console.log(`✓ ${localCommercialPOIs.length} adet yerel ticari mekan (Kameroğlu, Sahil, Vadi) yüklendi.`);
        }
    } catch (e) {
        console.warn("Yerel ticari POI dosyası yüklenemedi:", e);
    }
}

// 3. Kademe: Gerçek Çevrimdışı Pilot Sokak Ağını Yükle (1078 gerçek cadde/sokak)
async function loadOfflinePilotStreets() {
    try {
        const res = await fetch('offline_pilot_streets.json');
        if (res.ok) {
            offlinePilotStreets = await res.json();
            console.log(`✓ ${offlinePilotStreets.length} adet çevrimdışı gerçek pilot sokak geometrisi yüklendi.`);
        }
    } catch (e) {
        console.warn("Çevrimdışı sokak veri tabanı yüklenemedi:", e);
    }
}

// Çevrimdışı Paket Bildirim Rozeti Durumu
function updateOfflineStatusBadge(isActive) {
    const badge = document.getElementById('offline-mode-badge');
    if (badge) {
        if (isActive) {
            badge.classList.remove('hidden');
            badge.classList.add('inline-flex');
        } else {
            badge.classList.add('hidden');
            badge.classList.remove('inline-flex');
        }
    }
}

// Harita Başlatma ve Katman Yönetimi (OSM Tile Usage Policy Uyumlu)
function initMap() {
    map = L.map('map', {
        zoomControl: false,
        attributionControl: true // OSM & Basemap Lisans Kuralı: Atıf zorunludur
    }).setView([currentTarget.lat, currentTarget.lon], 16);

    currentTileLayerGroup = L.layerGroup().addTo(map);
    streetPolylinesLayerGroup = L.layerGroup().addTo(map);
    topBadgesLayerGroup = L.layerGroup().addTo(map);

    // Varsayılan: Minimal Açık Gri (Esri Canvas - Asla API Key istemez, 403 Access Blocked hatası vermez)
    setMapTileStyle('minimal_gray');

    // Zoom kontrolü sağ alt
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Haritaya tıklama ile hedef belirleme
    map.on('click', (e) => {
        setNewTarget(e.latlng.lat, e.latlng.lng, 'Haritadan Seçilen Nokta');
    });
}

// Harita Katman & Renk Paleti Değiştirici (Sıfır API Key, Sıfır 403 Hatası, %100 Kararlı)
function setMapTileStyle(styleKey) {
    currentTileLayerGroup.clearLayers();
    const mapEl = document.getElementById('map');
    if (mapEl) {
        mapEl.classList.remove('tiles-minimal-clean', 'tiles-dark-clean');
    }

    const esriAttr = 'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> &mdash; Esri, DeLorme, NAVTEQ, USGS, Intermap, TomTom, &copy; OpenStreetMap contributors';

    if (styleKey === 'minimal_gray') {
        // Minimal Açık Gri: Esri World Light Gray Canvas (Temiz, sade, park çizgilerini mükemmel gösterir)
        const tile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19,
            attribution: esriAttr
        });
        currentTileLayerGroup.addLayer(tile);
    } else if (styleKey === 'dark_clean') {
        // Koyu Tema: Esri World Dark Gray Canvas (Gece sürüşü ve karanlık arayüz için ideal)
        const tile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19,
            attribution: esriAttr
        });
        currentTileLayerGroup.addLayer(tile);
    } else if (styleKey === 'street_detailed') {
        // Renkli Detaylı Sokak Haritası: Esri World Street Map (Türkçe cadde/sokak tabelaları ve bina blokları)
        const tile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19,
            attribution: 'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> &mdash; Source: Esri, USGS, TomTom, &copy; OpenStreetMap contributors'
        });
        currentTileLayerGroup.addLayer(tile);
    } else if (styleKey === 'satellite') {
        // Gerçek Uydu Görünümü: Esri World Imagery (Kaldırımları, binaları ve gerçek asfaltı net gösterir)
        const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19,
            attribution: 'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> &mdash; Source: Esri, Maxar, Earthstar, GeoEye, &copy; OpenStreetMap contributors'
        });
        currentTileLayerGroup.addLayer(sat);
    } else {
        // Standart Klasik OSM (Kullanıcı açıkça seçerse, referer korumalı)
        const std = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
            referrerPolicy: 'origin'
        });
        std.on('tileerror', function() {
            console.warn('OSM sunucusu 403 veya bağlantı engeli verdi; Esri Canvas katmanına geri dönülüyor.');
            setMapTileStyle('minimal_gray');
        });
        currentTileLayerGroup.addLayer(std);
    }
}

// Gelişmiş Arama Motoru (Yerel Sözlük + Nominatim)
function initSearch() {
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    const searchClearBtn = document.getElementById('search-clear-btn');

    if (!searchInput || !searchResults) return;

    searchInput.addEventListener('input', (e) => {
        const val = e.target.value.trim().toLowerCase();
        if (val.length > 0) {
            searchClearBtn?.classList.remove('hidden');
        } else {
            searchClearBtn?.classList.add('hidden');
            searchResults.classList.add('hidden');
            return;
        }

        clearTimeout(searchDebounceTimer);
        
        // 1. Önce anında yerel eşleşmeleri göster
        const localMatches = LOCAL_LANDMARKS.filter(item => 
            item.name.toLowerCase().includes(val) || item.detail.toLowerCase().includes(val)
        );

        renderSearchResults(localMatches, val, true);

        // 2. Ardından Nominatim ile web araması yap (OSM Nominatim Politikası gereği min 800ms debounce)
        searchDebounceTimer = setTimeout(() => {
            fetchNominatimSearch(val, localMatches);
        }, 800);
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const firstResult = searchResults.querySelector('.search-item');
            if (firstResult) firstResult.click();
        }
    });

    searchClearBtn?.addEventListener('click', () => {
        searchInput.value = '';
        searchClearBtn.classList.add('hidden');
        searchResults.classList.add('hidden');
        searchInput.focus();
    });

    document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
            searchResults.classList.add('hidden');
        }
    });
}

// Arama Sonuçlarını Listele
function renderSearchResults(items, query, isLocalOnly = false) {
    const searchResults = document.getElementById('search-results');
    if (!searchResults) return;

    if (!items || items.length === 0) {
        if (!isLocalOnly) {
            searchResults.innerHTML = '<div class="p-3 text-xs text-slate-400">Sonuç bulunamadı.</div>';
            searchResults.classList.remove('hidden');
        }
        return;
    }

    searchResults.innerHTML = '';
    searchResults.classList.remove('hidden');

    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'search-item p-2.5 cursor-pointer text-left transition flex items-center space-x-2.5';
        div.innerHTML = `
            <div class="w-7 h-7 rounded-lg bg-sky-500/20 text-sky-400 flex items-center justify-center shrink-0">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path></svg>
            </div>
            <div class="overflow-hidden">
                <div class="text-xs font-semibold text-white truncate">${item.name}</div>
                <div class="text-[10px] text-slate-400 truncate">${item.detail || 'İstanbul'}</div>
            </div>
        `;

        div.addEventListener('click', () => {
            setNewTarget(item.lat, item.lon, item.name);
            searchResults.classList.add('hidden');
            document.getElementById('search-input').value = item.name;
        });

        searchResults.appendChild(div);
    });
}

// Nominatim Web Sorgusu (OSM Nominatim Usage Policy Uyumlu)
async function fetchNominatimSearch(val, alreadyShown) {
    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(val + ' İstanbul')}&countrycodes=tr&limit=5&addressdetails=1&email=parksezgi-app@proton.me`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();

        if (data && data.length > 0) {
            const parsed = data.map(d => ({
                name: d.display_name.split(',')[0],
                detail: d.display_name.split(',').slice(1, 3).join(','),
                lat: parseFloat(d.lat),
                lon: parseFloat(d.lon)
            }));

            // Zaten gösterilenlerle birleştir
            const combined = [...alreadyShown];
            parsed.forEach(p => {
                if (!combined.some(c => Math.abs(c.lat - p.lat) < 0.001 && Math.abs(c.lon - p.lon) < 0.001)) {
                    combined.push(p);
                }
            });

            renderSearchResults(combined, val, false);
        }
    } catch (e) {
        console.warn("Nominatim araması gecikti:", e);
    }
}

// UI Event Dinleyicileri
function initEventListeners() {
    // Harita Palet Seçici
    document.getElementById('tile-layer-select')?.addEventListener('change', (e) => {
        setMapTileStyle(e.target.value);
    });

    // Hazır Konum Butonları (Apple Liquid Pills)
    document.querySelectorAll('[data-preset]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const key = e.currentTarget.getAttribute('data-preset');
            const loc = PRESET_LOCATIONS[key];
            if (loc) {
                setNewTarget(loc.lat, loc.lon, loc.name);
                document.querySelectorAll('[data-preset]').forEach(b => {
                    b.classList.remove('active');
                });
                e.currentTarget.classList.add('active');
            }
        });
    });

    // Zaman Filtresi (Apple Segmented Control)
    document.querySelectorAll('[data-time]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            currentTimeMode = e.currentTarget.getAttribute('data-time');
            document.querySelectorAll('[data-time]').forEach(b => {
                b.classList.remove('active');
            });
            e.currentTarget.classList.add('active');
            renderStreets();
        });
    });

    // Yarıçap Slider (iOS Liquid Slider)
    const radiusSlider = document.getElementById('radius-slider');
    const radiusLabel = document.getElementById('radius-value');
    if (radiusSlider) {
        radiusSlider.addEventListener('input', (e) => {
            currentRadius = parseInt(e.target.value);
            const walkMin = Math.round(currentRadius / 80);
            if (radiusLabel) radiusLabel.innerText = `${currentRadius}m (~${walkMin} dk)`;
        });

        radiusSlider.addEventListener('change', () => {
            if (targetRadiusCircle) {
                targetRadiusCircle.setRadius(currentRadius);
            }
            triggerFetch(100);
        });
    }

    // Modal Butonları
    document.getElementById('close-modal-btn')?.addEventListener('click', closeDetailModal);

    document.getElementById('btn-report-duba')?.addEventListener('click', () => {
        if (!selectedStreetData) return;
        saveUserReport(selectedStreetData.way.id, 'duba_yasak');
        showToast('⚠️ Duba / Park Yasağı bildirimi kaydedildi.');
        renderStreets();
        refreshSelectedStreetDetail();
    });

    document.getElementById('btn-report-parked')?.addEventListener('click', () => {
        if (!selectedStreetData) return;
        saveUserReport(selectedStreetData.way.id, 'kolay_park');
        showToast('⭐ Rahat park edildi bildirimi kaydedildi (+25 Puan).');
        renderStreets();
        refreshSelectedStreetDetail();
    });

    document.getElementById('btn-report-clear')?.addEventListener('click', () => {
        if (!selectedStreetData) return;
        saveUserReport(selectedStreetData.way.id, 'clear');
        showToast('İşaretleme temizlendi.');
        renderStreets();
        refreshSelectedStreetDetail();
    });
}

// Yeni Hedef Belirleme
function setNewTarget(lat, lon, name) {
    currentTarget = { lat, lon, name };

    if (targetMarker) {
        targetMarker.setLatLng([lat, lon]);
    } else {
        const customIcon = L.divIcon({
            className: 'custom-pin',
            html: '<div class="target-marker-icon"></div>',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });
        targetMarker = L.marker([lat, lon], { icon: customIcon }).addTo(map);
    }

    if (targetRadiusCircle) {
        targetRadiusCircle.setLatLng([lat, lon]);
        targetRadiusCircle.setRadius(currentRadius);
    } else {
        targetRadiusCircle = L.circle([lat, lon], {
            radius: currentRadius,
            color: '#38bdf8',
            weight: 1.5,
            dashArray: '5, 5',
            fillColor: '#38bdf8',
            fillOpacity: 0.08
        }).addTo(map);
    }

    map.flyTo([lat, lon], 16, { duration: 0.8 });
    document.getElementById('target-name-display').innerText = name;
    
    triggerFetch(150);
}

// İstek Sınırlayıcı (Debounce)
function triggerFetch(delay = 200) {
    clearTimeout(fetchDebounceTimer);
    fetchDebounceTimer = setTimeout(() => {
        fetchAndAnalyzeStreets();
    }, delay);
}

// Hızlı ve Optimize Edilmiş Overpass API Sorgusu + 4 Kademeli Fallback Mimarisi
async function fetchAndAnalyzeStreets(forceBypassCache = false) {
    setLoading(true);
    closeDetailModal();
    if (walkingRouteLayer) {
        map.removeLayer(walkingRouteLayer);
        walkingRouteLayer = null;
    }

    const { lat, lon } = currentTarget;
    const radius = currentRadius;
    const cacheKey = `${lat.toFixed(4)}_${lon.toFixed(4)}_${radius}`;

    // 1. Kademe: İstemci Tarafı Mekansal Önbellek Kontrolü (0 ms)
    if (!forceBypassCache && spatialStreetCache.has(cacheKey)) {
        const cached = spatialStreetCache.get(cacheKey);
        currentLoadedWays = cached.ways;
        currentLoadedPOIs = cached.pois;
        isOfflineFallbackActive = cached.isOffline || false;
        updateOfflineStatusBadge(isOfflineFallbackActive);
        renderStreets();
        showToast(`⚡ Önbellekten yüklendi (0ms): ${currentLoadedWays.length} sokak`);
        setLoading(false);
        return;
    }

    // 2. Kademe: Canlı Overpass Ultra Hızlı Sorgu ('out geom;')
    const query = `
        [out:json][timeout:25];
        (
          way["highway"~"^(residential|living_street|service|tertiary|secondary|primary)$"](around:${radius}, ${lat}, ${lon});
          node["amenity"~"^(cafe|bar|restaurant|fast_food|pub)$"](around:${radius}, ${lat}, ${lon});
          node["shop"~"^(supermarket|convenience|bakery)$"](around:${radius}, ${lat}, ${lon});
        );
        out geom;
    `;

    // Hızlı Failover için sıralı ve dinamik aynalar (3.5s per server)
    const endpoints = [
        'https://lz4.overpass-api.de/api/interpreter',
        'https://overpass-api.de/api/interpreter',
        'https://overpass.osm.ch/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass.private.coffee/api/interpreter'
    ];

    let data = null;
    for (const url of endpoints) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3500); // 3.5s hızlı geçiş

            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'data=' + encodeURIComponent(query),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (res.ok) {
                data = await res.json();
                if (data && data.elements && data.elements.length > 0) {
                    console.log(`✓ Overpass canlı verisi alındı: ${url} (${data.elements.length} eleman)`);
                    break;
                }
            } else if (res.status === 429) {
                console.warn(`Endpoint ${url} hız kısıtı (429) verdi, bir sonraki aynaya geçiliyor.`);
            }
        } catch (err) {
            console.warn(`Endpoint ${url} geçici olarak yanıt vermedi:`, err.message || err);
        }
    }

    if (data && data.elements && data.elements.length > 0) {
        // Canlı veri başarıyla çözümlendi
        parseAndStoreOSMData(data);
        isOfflineFallbackActive = false;
        updateOfflineStatusBadge(false);
        spatialStreetCache.set(cacheKey, { ways: currentLoadedWays, pois: currentLoadedPOIs, isOffline: false });
        renderStreets();
        showToast(`✅ Canlı OSM: ${currentLoadedWays.length} sokak analiz edildi.`);
    } else {
        // 3. Kademe: Canlı sunucu ulaşılamazsa 1078 gerçek sokaklık çevrimdışı paketi filtrele
        console.warn("Canlı Overpass yanıt veremedi, 3. kademe çevrimdışı sokak paketi devrede.");
        const fallbackWays = getOfflinePilotStreetsInRadius(lat, lon, radius);

        if (fallbackWays.length > 0) {
            currentLoadedWays = fallbackWays;
            currentLoadedPOIs = []; // Yerel commercial_pois_db.json otomatik birleştirilir
            isOfflineFallbackActive = true;
            updateOfflineStatusBadge(true);
            spatialStreetCache.set(cacheKey, { ways: currentLoadedWays, pois: [], isOffline: true });
            renderStreets();
            showToast(`⚡ Çevrimdışı Bölge Paketi Devrede (${currentLoadedWays.length} gerçek sokak)`);
        } else {
            // 4. Kademe: Pilot bölge dışındaysa kullanıcıya tekrar dene kartı göster
            isOfflineFallbackActive = false;
            updateOfflineStatusBadge(false);
            currentLoadedWays = [];
            currentLoadedPOIs = [];
            renderStreets();
            showToast("⚠️ Canlı harita sunucusuna geçici olarak ulaşılamadı.");
        }
    }

    setLoading(false);
}

// OSM Yanıtını Ayrıştır (out geom desteği ile doğrudan way.geometry işlenir)
function parseAndStoreOSMData(osmJson) {
    const nodes = {};
    const ways = [];
    const pois = [];

    osmJson.elements.forEach(el => {
        if (el.type === 'node') {
            if (el.lat && el.lon) {
                nodes[el.id] = [el.lat, el.lon];
                if (el.tags && (el.tags.amenity || el.tags.shop)) {
                    pois.push({ lat: el.lat, lon: el.lon, tags: el.tags });
                }
            }
        }
    });

    osmJson.elements.forEach(el => {
        if (el.type === 'way' && el.tags && el.tags.highway) {
            let latlngs = [];
            // 'out geom;' doğrudan geometry dizisinde [ {lat, lon}, ... ] koordinatlarını döner
            if (el.geometry && Array.isArray(el.geometry) && el.geometry.length > 0) {
                latlngs = el.geometry.map(pt => [pt.lat, pt.lon]);
            } else if (el.nodes && Object.keys(nodes).length > 0) {
                el.nodes.forEach(nodeId => {
                    if (nodes[nodeId]) latlngs.push(nodes[nodeId]);
                });
            }

            if (latlngs.length >= 2) {
                ways.push({
                    id: el.id,
                    tags: el.tags,
                    latlngs: latlngs
                });
            }
        }
    });

    currentLoadedWays = ways;
    currentLoadedPOIs = pois;
}

// Sokakları Haritada Göster ve Puanla
function renderStreets() {
    streetPolylinesLayerGroup.clearLayers();
    topBadgesLayerGroup.clearLayers();

    const scoredStreets = [];

    currentLoadedWays.forEach(way => {
        const midPoint = getWayMidpoint(way.latlngs);
        const distanceToTarget = calculateDistanceMeters(
            currentTarget.lat, currentTarget.lon,
            midPoint[0], midPoint[1]
        );

        // Canlı OSM mekanları ile Yerel Yüksek Yoğunluklu Mekan Veritabanı birleştirilir
        const allCandidatePOIs = [...currentLoadedPOIs, ...localCommercialPOIs];
        const nearbyPOIs = allCandidatePOIs.filter(poi => {
            const d = calculateDistanceMeters(midPoint[0], midPoint[1], poi.lat, poi.lon);
            return d <= 85;
        });

        // V3 Skorlama: Koordinat parametresi (midPoint[0], midPoint[1]) ile Marina ve Bizimkent coğrafi kontrolü
        const scoreResult = calculateStreetScore(
            way, 
            nearbyPOIs, 
            currentTimeMode, 
            distanceToTarget, 
            midPoint[0], 
            midPoint[1]
        );

        const streetItem = {
            way,
            midPoint,
            distanceToTarget,
            walkMinutes: Math.max(1, Math.round(distanceToTarget / 75)),
            scoreResult
        };

        scoredStreets.push(streetItem);

        // Çizgi Stili
        const isSelected = selectedStreetData && selectedStreetData.way.id === way.id;
        const polyline = L.polyline(way.latlngs, {
            color: scoreResult.color,
            weight: isSelected ? 8 : (scoreResult.score >= 70 ? 6 : 4),
            opacity: scoreResult.score >= 70 ? 0.95 : (scoreResult.isForbidden ? 0.5 : 0.7),
            lineCap: 'round',
            lineJoin: 'round'
        });

        polyline.on('mouseover', () => {
            polyline.setStyle({ weight: 9, opacity: 1 });
        });
        polyline.on('mouseout', () => {
            polyline.setStyle({
                weight: isSelected ? 8 : (scoreResult.score >= 70 ? 6 : 4),
                opacity: scoreResult.score >= 70 ? 0.95 : (scoreResult.isForbidden ? 0.5 : 0.7)
            });
        });

        polyline.on('click', () => {
            selectStreet(streetItem);
        });

        streetPolylinesLayerGroup.addLayer(polyline);
    });

    // En İyi 3 Öneriyi Panelde Listele ve Haritada Rozetlerle Göster (#1, #2, #3)
    updateTopRecommendationsAndBadges(scoredStreets);
}

// En İyi 3 Öneriyi Listele ve Haritada Rozetlerle Göster (#1, #2, #3)
function updateTopRecommendationsAndBadges(scoredStreets) {
    const listContainer = document.getElementById('recommendations-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';
    topBadgesLayerGroup.clearLayers();

    // Sadece kamuya açık, yasak/site/marina olmayan sokaklar
    const validStreets = scoredStreets
        .filter(s => !s.scoreResult.isForbidden && s.scoreResult.score >= 55)
        .sort((a, b) => b.scoreResult.score - a.scoreResult.score);

    document.getElementById('scanned-streets-count').innerText = `${scoredStreets.length} yol analiz edildi`;

    if (scoredStreets.length === 0) {
        listContainer.innerHTML = `
            <div class="text-xs text-[#FFF1FB]/70 p-4 bg-[#26184A]/80 rounded-[18px] border border-[#B45CFF]/30 text-center space-y-2.5 shadow-sm">
                <div class="text-[#FF4FD8] font-bold flex items-center justify-center gap-1.5 text-xs">
                    <svg class="w-4 h-4 text-[#FF4FD8] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
                    <span>Sunucu Yanıtı Alınamadı</span>
                </div>
                <p class="text-[11px] leading-relaxed text-[#FFF1FB]/60">
                    Canlı sunucu meşgul (hız sınırı) ve bu nokta pilot çevrimdışı alanın dışında.
                </p>
                <button id="btn-retry-fetch" class="px-3.5 py-1.5 bg-[#4BE3FF]/20 hover:bg-[#4BE3FF]/30 text-[#4BE3FF] border border-[#4BE3FF]/40 rounded-xl text-xs font-semibold shadow transition inline-flex items-center gap-1.5 cursor-pointer active:scale-95">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                    <span>Tekrar Dene</span>
                </button>
            </div>
        `;
        document.getElementById('btn-retry-fetch')?.addEventListener('click', () => {
            fetchAndAnalyzeStreets(true);
        });
        return;
    }

    if (validStreets.length === 0) {
        listContainer.innerHTML = `
            <div class="text-xs text-[#FFF1FB]/70 p-3.5 bg-[#26184A]/80 rounded-[18px] border border-[#B45CFF]/30 leading-relaxed">
                Taranan ${scoredStreets.length} yolun tamamı özel mülk, marina, kapalı site veya ana arter olarak tespit edildi. Kamuya açık sakin ara sokak bulunamadı.
            </div>
        `;
        return;
    }

    const topThree = validStreets.slice(0, 3);
    topThree.forEach((item, index) => {
        const rankNum = index + 1;

        // Haritada #1, #2, #3 Rozeti
        const badgeIcon = L.divIcon({
            className: 'custom-rank-div',
            html: `<div class="rank-badge-marker rank-badge-${rankNum}">#${rankNum}</div>`,
            iconSize: [36, 36],
            iconAnchor: [18, 18]
        });

        const badgeMarker = L.marker(item.midPoint, { icon: badgeIcon, zIndexOffset: 500 - index * 10 });
        badgeMarker.on('click', () => {
            selectStreet(item);
            map.flyTo(item.midPoint, 17, { duration: 0.6 });
        });
        badgeMarker.bindTooltip(`<b>#${rankNum} Öneri:</b> ${item.scoreResult.streetName} (%${item.scoreResult.score})`, {
            direction: 'top',
            offset: [0, -16]
        });
        topBadgesLayerGroup.addLayer(badgeMarker);

        // Sol Panel Kartı (Apple Liquid Glass)
        const card = document.createElement('div');
        card.className = 'liquid-glass-card p-3 rounded-[18px] cursor-pointer flex items-center justify-between shadow-md animate-liquid-in border border-white/10 hover:border-[#4BE3FF]/40 active:scale-[0.98] transition-all';
        card.style.animationDelay = `${index * 0.08}s`;
        card.innerHTML = `
            <div class="flex items-center space-x-3.5">
                <div class="w-8 h-8 rounded-full flex items-center justify-center font-black text-xs shadow-sm border border-white/20 ${
                    rankNum === 1 
                        ? 'bg-emerald-600 text-white' 
                        : (rankNum === 2 
                            ? 'bg-sky-600 text-white' 
                            : 'bg-teal-600 text-white')
                }">
                    #${rankNum}
                </div>
                <div>
                    <h4 class="text-xs font-bold text-[#FFF1FB] truncate max-w-[155px] tracking-tight">${item.scoreResult.streetName}</h4>
                    <p class="text-[11px] text-[#FFF1FB]/60 font-medium">${item.walkMinutes} dk yürüme (${Math.round(item.distanceToTarget)}m)</p>
                </div>
            </div>
            <div class="text-right">
                <span class="text-xs font-extrabold px-2.5 py-1 rounded-full text-white shadow-sm border border-white/15 ${
                    rankNum === 1 
                        ? 'bg-emerald-600/90' 
                        : 'bg-[#1A1033]/80'
                }">
                    %${item.scoreResult.score}
                </span>
            </div>
        `;

        card.addEventListener('click', () => {
            selectStreet(item);
            map.flyTo(item.midPoint, 17, { duration: 0.6 });
        });

        listContainer.appendChild(card);
    });
}

// Bir Sokağı Seç
function selectStreet(streetItem) {
    selectedStreetData = streetItem;

    if (walkingRouteLayer) {
        map.removeLayer(walkingRouteLayer);
    }

    walkingRouteLayer = L.polyline([
        [currentTarget.lat, currentTarget.lon],
        streetItem.midPoint
    ], {
        color: '#0284c7',
        weight: 3.5,
        opacity: 0.95,
        className: 'animated-walking-route'
    }).addTo(map);

    refreshSelectedStreetDetail();

    const modal = document.getElementById('detail-modal');
    modal.classList.remove('translate-y-full', 'opacity-0', 'pointer-events-none');
    modal.classList.add('translate-y-0', 'opacity-100');
}

// Detay Kartını Doldur
function refreshSelectedStreetDetail() {
    if (!selectedStreetData) return;

    const midPoint = selectedStreetData.midPoint;
    const allCandidatePOIs = [...currentLoadedPOIs, ...localCommercialPOIs];
    const nearbyPOIs = allCandidatePOIs.filter(poi => {
        const d = calculateDistanceMeters(midPoint[0], midPoint[1], poi.lat, poi.lon);
        return d <= 85;
    });
    const scoreResult = calculateStreetScore(
        selectedStreetData.way,
        nearbyPOIs,
        currentTimeMode,
        selectedStreetData.distanceToTarget,
        midPoint[0],
        midPoint[1]
    );
    selectedStreetData.scoreResult = scoreResult;

    document.getElementById('modal-street-name').innerText = scoreResult.streetName;
    document.getElementById('modal-highway-type').innerText = scoreResult.highway.toUpperCase();
    document.getElementById('modal-walk-info').innerText = `${Math.round(selectedStreetData.distanceToTarget)} metre (yaklaşık ${selectedStreetData.walkMinutes} dk yürüme)`;

    const scoreBadge = document.getElementById('modal-score-badge');
    scoreBadge.innerText = `%${scoreResult.score}`;
    scoreBadge.style.backgroundColor = scoreResult.color;
    scoreBadge.style.color = '#ffffff';

    const breakdownList = document.getElementById('modal-factors-list');
    breakdownList.innerHTML = '';

    scoreResult.breakdown.forEach(item => {
        const li = document.createElement('li');
        li.className = 'flex items-center justify-between text-xs py-1.5 border-b border-white/10';
        
        let valColor = 'text-[#FFF1FB]/80';
        if (item.type === 'positive') valColor = 'text-[#4BE3FF] font-bold';
        if (item.type === 'negative') valColor = 'text-[#FF4FD8] font-bold';
        if (item.type === 'warning') valColor = 'text-[#B45CFF] font-bold';

        li.innerHTML = `
            <span class="text-[#FFF1FB]/70">${item.label}</span>
            <span class="${valColor}">${item.value}</span>
        `;
        breakdownList.appendChild(li);
    });

    const reports = getUserReports();
    const currentReport = reports[selectedStreetData.way.id];
    const reportStatusDiv = document.getElementById('modal-report-status');
    const clearBtn = document.getElementById('btn-report-clear');

    if (currentReport) {
        clearBtn.classList.remove('hidden');
        if (currentReport.type === 'duba_yasak') {
            reportStatusDiv.innerHTML = '<span class="text-[#FF4FD8] text-xs font-semibold">⚠️ Duba / park yasağı bildirimi kayıtlı.</span>';
        } else if (currentReport.type === 'kolay_park') {
            reportStatusDiv.innerHTML = '<span class="text-[#4BE3FF] text-xs font-semibold">⭐ Rahat park edildiği onaylandı.</span>';
        }
    } else {
        clearBtn.classList.add('hidden');
        reportStatusDiv.innerHTML = '<span class="text-[#FFF1FB]/50 text-xs">Henüz bir bildirim yok.</span>';
    }
}

function closeDetailModal() {
    const modal = document.getElementById('detail-modal');
    modal.classList.add('translate-y-full', 'opacity-0', 'pointer-events-none');
    modal.classList.remove('translate-y-0', 'opacity-100');
    if (walkingRouteLayer) {
        map.removeLayer(walkingRouteLayer);
        walkingRouteLayer = null;
    }
    selectedStreetData = null;
}

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

function getWayMidpoint(latlngs) {
    if (!latlngs || latlngs.length === 0) return [0, 0];
    const midIndex = Math.floor(latlngs.length / 2);
    return latlngs[midIndex];
}

function setLoading(isLoading) {
    const spinner = document.getElementById('loading-spinner');
    if (spinner) {
        if (isLoading) spinner.classList.remove('hidden');
        else spinner.classList.add('hidden');
    }

    // Harita Üzerindeki Canlı Radar ve Bilgi Banner'ı
    const mapIndicator = document.getElementById('map-radar-indicator');
    if (mapIndicator) {
        if (isLoading) {
            mapIndicator.classList.remove('opacity-0', '-translate-y-4', 'pointer-events-none');
            mapIndicator.classList.add('opacity-100', 'translate-y-0');
        } else {
            mapIndicator.classList.add('opacity-0', '-translate-y-4', 'pointer-events-none');
            mapIndicator.classList.remove('opacity-100', 'translate-y-0');
        }
    }

    // Harita Hedef Noktası Üzerinde Genişleyen Radar Dalgası Animasyonu
    if (isLoading && map) {
        if (!radarWaveMarker) {
            const radarIcon = L.divIcon({
                className: 'radar-scanner-container',
                html: '<div class="radar-wave"></div><div class="radar-wave radar-wave-2"></div><div class="radar-wave radar-wave-3"></div>',
                iconSize: [80, 80],
                iconAnchor: [40, 40]
            });
            radarWaveMarker = L.marker([currentTarget.lat, currentTarget.lon], { 
                icon: radarIcon, 
                zIndexOffset: -100,
                interactive: false
            }).addTo(map);
        } else {
            radarWaveMarker.setLatLng([currentTarget.lat, currentTarget.lon]);
        }
    } else {
        if (radarWaveMarker && map) {
            map.removeLayer(radarWaveMarker);
            radarWaveMarker = null;
        }
    }
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.innerText = msg;
    toast.classList.remove('opacity-0', 'translate-y-4', 'pointer-events-none');
    toast.classList.add('opacity-100', 'translate-y-0');
    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-4', 'pointer-events-none');
        toast.classList.remove('opacity-100', 'translate-y-0');
    }, 3200);
}

// 3. Kademe: Gerçek Çevrimdışı Pilot Sokak Ağını Dinamik Filtrele (1078 Gerçek OSM Sokağı)
// Hedef noktanın yarıçapı içindeki tüm gerçek OSM sokaklarını çıkarır (Asla hayali çizgi üretmez).
function getOfflinePilotStreetsInRadius(targetLat, targetLon, radiusMeters) {
    if (!offlinePilotStreets || offlinePilotStreets.length === 0) return [];

    const matchedWays = [];
    const maxDist = radiusMeters + 60; // Yarıçap çevresi esneklik payı

    offlinePilotStreets.forEach(way => {
        if (!way.latlngs || way.latlngs.length < 2) return;
        
        // Sokağın orta noktası yarıçap içinde mi?
        const midPoint = way.latlngs[Math.floor(way.latlngs.length / 2)];
        const dist = calculateDistanceMeters(targetLat, targetLon, midPoint[0], midPoint[1]);
        
        if (dist <= maxDist) {
            matchedWays.push(way);
        }
    });

    return matchedWays;
}

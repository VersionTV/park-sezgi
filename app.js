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
let commercialPOISpatialGrid = new Map();
let offlinePilotStreets = [];
let selectedStreetData = null;
let searchDebounceTimer = null;
let fetchDebounceTimer = null;
let isOfflineFallbackActive = false;
let currentSheetState = 'half'; // Mobil çekmece durumu: 'peek', 'half', 'full'
let communityRatings = {}; // Topluluk değerlendirme verileri (aggregate)
let currentUserRating = 0; // Modal'daki aktif yıldız seçimi

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
    initMobileBottomSheet();

    // 1. Çevrimdışı sokak geometrilerini yükle ve haritayı ANINDA başlat (0ms bekleme)
    try {
        await loadOfflinePilotStreets();
    } catch (e) {
        console.warn("Çevrimdışı sokaklar yüklenemedi:", e);
    }
    setNewTarget(currentTarget.lat, currentTarget.lon, currentTarget.name);
    // 2. Ticari mekan veritabanını ve topluluk verilerini arka planda paralel yükle
    checkAndHandleAuthRedirect();
    loadCommunityRatings();
    loadLocalCommercialPOIs().then(() => {
        if (currentLoadedWays && currentLoadedWays.length > 0) {
            renderStreets();
        }
    }).catch(e => {
        console.warn("Yerel ticari POI yükleme uyarısı:", e);
    });
});

// Mekansal Izgara (Spatial Grid Index) Oluşturucu (O(1) Hızlı Arama)
function buildPOISpatialGrid(pois) {
    const grid = new Map();
    for (let i = 0; i < pois.length; i++) {
        const poi = pois[i];
        if (typeof poi.lat !== 'number' || typeof poi.lon !== 'number') continue;
        const key = `${Math.floor(poi.lat * 100)}_${Math.floor(poi.lon * 100)}`;
        let bucket = grid.get(key);
        if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
        }
        bucket.push(poi);
    }
    return grid;
}

// Mekansal Izgara ile Yakındaki Ticari Mekanları Getir (14.000+ işletmede 0ms gecikme)
function getNearbyCommercialPOIs(lat, lon, maxDistanceMeters = 85) {
    const cLat = Math.floor(lat * 100);
    const cLon = Math.floor(lon * 100);
    const nearby = [];

    // 1. Mekansal ızgaradan sadece 3x3 komşu hücreleri tara (O(1) lookup)
    for (let dLat = -1; dLat <= 1; dLat++) {
        for (let dLon = -1; dLon <= 1; dLon++) {
            const key = `${cLat + dLat}_${cLon + dLon}`;
            const bucket = commercialPOISpatialGrid.get(key);
            if (bucket) {
                for (let i = 0; i < bucket.length; i++) {
                    const poi = bucket[i];
                    if (calculateDistanceMeters(lat, lon, poi.lat, poi.lon) <= maxDistanceMeters) {
                        nearby.push(poi);
                    }
                }
            }
        }
    }

    // 2. Canlı Overpass API'den çekilmiş mevcut POI'leri de ekle
    for (let i = 0; i < currentLoadedPOIs.length; i++) {
        const poi = currentLoadedPOIs[i];
        if (calculateDistanceMeters(lat, lon, poi.lat, poi.lon) <= maxDistanceMeters) {
            nearby.push(poi);
        }
    }

    return nearby;
}

// ========================
// ==========================================================
// AWS Canlı Bulut Konfigürasyonu & Topluluk Değerlendirmesi
// ==========================================================
const AWS_CONFIG = {
    apiUrl: 'https://tpp5klk5fe.execute-api.us-east-1.amazonaws.com/prod',
    cognitoDomain: 'https://parksezgi.auth.us-east-1.amazoncognito.com',
    cognitoClientId: '3qf9fpp3vlnlb13mu578s2k7in',
    cloudfrontUrl: 'https://d1msnatkb8tlnq.cloudfront.net'
};

const IS_LOCAL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const REDIRECT_URI = IS_LOCAL ? 'http://localhost:5500' : AWS_CONFIG.cloudfrontUrl;

// Kimlik Doğrulama (Cognito + Google OAuth)
function checkAndHandleAuthRedirect() {
    if (window.location.hash && window.location.hash.includes('id_token=')) {
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        const idToken = params.get('id_token');
        if (idToken) {
            try {
                const payload = JSON.parse(atob(idToken.split('.')[1]));
                localStorage.setItem('parksezgi_id_token', idToken);
                localStorage.setItem('parksezgi_user', JSON.stringify({
                    email: payload.email,
                    name: payload.name || payload.email?.split('@')[0] || 'Kullanıcı',
                    sub: payload.sub,
                    exp: payload.exp
                }));
                showToast(`👋 Hoş geldin, ${payload.name || payload.email}!`);
            } catch (e) {
                console.error("Token çözümleme hatası:", e);
            }
            window.history.replaceState(null, '', window.location.pathname + window.location.search);
        }
    }
    updateAuthUI();
}

function getCurrentUser() {
    const userJson = localStorage.getItem('parksezgi_user');
    const token = localStorage.getItem('parksezgi_id_token');
    if (!userJson || !token) return null;
    try {
        const user = JSON.parse(userJson);
        if (user.exp && user.exp * 1000 < Date.now()) {
            logoutUser(false);
            return null;
        }
        return user;
    } catch (e) {
        return null;
    }
}

function getAuthToken() {
    const user = getCurrentUser();
    return user ? localStorage.getItem('parksezgi_id_token') : null;
}

function redirectToGoogleLogin() {
    const params = new URLSearchParams({
        client_id: AWS_CONFIG.cognitoClientId,
        response_type: 'token',
        scope: 'email openid profile',
        redirect_uri: REDIRECT_URI,
        identity_provider: 'Google'
    });
    window.location.href = `${AWS_CONFIG.cognitoDomain}/oauth2/authorize?${params.toString()}`;
}

function logoutUser(notify = true) {
    localStorage.removeItem('parksezgi_id_token');
    localStorage.removeItem('parksezgi_user');
    updateAuthUI();
    if (notify) showToast('Çıkış yapıldı.');
}

function updateAuthUI() {
    const user = getCurrentUser();
    const headerProfile = document.getElementById('user-profile-header');
    const modalBadge = document.getElementById('user-auth-badge');
    const authPromptCard = document.getElementById('auth-prompt-card');

    if (headerProfile) {
        if (user) {
            headerProfile.innerHTML = `
                <div class="flex items-center gap-1.5 py-1 px-2.5 rounded-full bg-white/10 border border-white/20 text-xs text-[#FFF1FB] backdrop-blur-md shadow-sm">
                    <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    <span class="max-w-[75px] truncate font-medium text-[11px]">${user.name}</span>
                    <button id="btn-logout-header" title="Çıkış Yap" class="text-[#FFF1FB]/50 hover:text-[#FF4FD8] ml-1 text-xs cursor-pointer font-bold">✕</button>
                </div>
            `;
            document.getElementById('btn-logout-header')?.addEventListener('click', (e) => {
                e.stopPropagation();
                logoutUser();
                refreshSelectedStreetDetail();
            });
        } else {
            headerProfile.innerHTML = `
                <button id="btn-login-header" class="py-1 px-3 rounded-full bg-[#4BE3FF]/15 hover:bg-[#4BE3FF]/25 border border-[#4BE3FF]/40 text-[#4BE3FF] text-[11px] font-bold transition flex items-center gap-1 cursor-pointer shadow-sm active:scale-95">
                    <span>Giriş Yap</span>
                </button>
            `;
            document.getElementById('btn-login-header')?.addEventListener('click', () => {
                redirectToGoogleLogin();
            });
        }
    }

    if (modalBadge) {
        modalBadge.textContent = user ? `👤 ${user.name}` : '🔒 Giriş Gerekli';
    }

    if (authPromptCard) {
        if (user) {
            authPromptCard.classList.add('hidden');
        } else {
            authPromptCard.classList.remove('hidden');
        }
    }
}

// Cihaz kimliği (Yerel geliştirme fallback)
function getOrCreateDeviceId() {
    let id = localStorage.getItem('parksezgi_device_id');
    if (!id) {
        id = 'dev_' + crypto.randomUUID();
        localStorage.setItem('parksezgi_device_id', id);
    }
    return id;
}

// Topluluk aggregate verilerini yükle (CloudFront / S3 statik JSON dosyası)
async function loadCommunityRatings() {
    try {
        const cached = sessionStorage.getItem('parksezgi_ratings_cache');
        if (cached) {
            const { data, timestamp } = JSON.parse(cached);
            if (Date.now() - timestamp < 3 * 60 * 1000) {
                communityRatings = data;
                console.log(`📊 Topluluk verileri önbellekten yüklendi (${Object.keys(data).length} sokak)`);
                return;
            }
        }
        const aggregateUrl = '/ratings_aggregate.json?_t=' + Date.now();
        const res = await fetch(aggregateUrl);
        if (res.ok) {
            communityRatings = await res.json();
            sessionStorage.setItem('parksezgi_ratings_cache', JSON.stringify({
                data: communityRatings,
                timestamp: Date.now()
            }));
            console.log(`📊 Topluluk verileri yüklendi (${Object.keys(communityRatings).length} sokak)`);
        }
    } catch (e) {
        console.warn('Topluluk verileri yüklenemedi:', e);
    }
}

// Oy gönder (AWS API Gateway + DynamoDB)
async function submitRating(wayId, rating, comment, lat, lon) {
    const token = getAuthToken();
    if (!token) {
        showToast('⭐ Değerlendirme yapabilmek için lütfen Google ile giriş yapın.');
        redirectToGoogleLogin();
        return null;
    }

    try {
        const res = await fetch(`${AWS_CONFIG.apiUrl}/ratings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ wayId: String(wayId), rating, comment: comment || '', lat, lon })
        });
        if (res.ok) {
            const data = await res.json();
            communityRatings[String(wayId)] = data.aggregated;
            sessionStorage.setItem('parksezgi_ratings_cache', JSON.stringify({
                data: communityRatings,
                timestamp: Date.now()
            }));
            return data;
        } else if (res.status === 401) {
            showToast('⚠️ Oturum süresi doldu. Lütfen tekrar giriş yapın.');
            logoutUser(false);
            return null;
        } else if (res.status === 429) {
            showToast('⏳ Çok fazla istek gönderildi, lütfen biraz bekleyin.');
            return null;
        } else {
            showToast('❌ Puan kaydedilemedi.');
            return null;
        }
    } catch (e) {
        console.error('Rating gönderme hatası:', e);
        showToast('❌ Sunucuya bağlanılamadı.');
        return null;
    }
}

// Kendi oyunu sil (AWS API Gateway + DynamoDB)
async function deleteRating(wayId) {
    const token = getAuthToken();
    if (!token) return null;

    try {
        const res = await fetch(`${AWS_CONFIG.apiUrl}/ratings`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ wayId: String(wayId) })
        });
        if (res.ok) {
            const data = await res.json();
            if (data.aggregated && data.aggregated.count === 0) {
                delete communityRatings[String(wayId)];
            } else if (data.aggregated) {
                communityRatings[String(wayId)] = data.aggregated;
            }
            sessionStorage.setItem('parksezgi_ratings_cache', JSON.stringify({
                data: communityRatings,
                timestamp: Date.now()
            }));
            return data;
        }
    } catch (e) {
        console.error('Rating silme hatası:', e);
        showToast('❌ Oy silinemedi.');
    }
    return null;
}

// Kendi oyunu getir (AWS API Gateway + DynamoDB)
async function getMyRating(wayId) {
    const token = getAuthToken();
    if (!token) return { exists: false };

    try {
        const res = await fetch(`${AWS_CONFIG.apiUrl}/ratings/my?wayId=` + encodeURIComponent(String(wayId)), {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        if (res.ok) return await res.json();
    } catch (e) {
        console.warn('Kendi oyum getirilemedi:', e);
    }
    return { exists: false };
}

// Modal'daki topluluk verilerini güncelle
function updateCommunityDisplay(wayId) {
    const data = communityRatings[String(wayId)];
    const summaryEl = document.getElementById('community-rating-summary');
    const starsDisplay = document.getElementById('community-stars-display');
    const starsVisual = document.getElementById('community-stars-visual');
    const medianText = document.getElementById('community-median-text');
    const distSection = document.getElementById('community-distribution');

    if (!data || data.count === 0) {
        summaryEl.textContent = 'Henüz oy yok';
        starsDisplay.classList.add('hidden');
        distSection.classList.add('hidden');
        return;
    }

    summaryEl.textContent = `${data.count} oy`;
    starsDisplay.classList.remove('hidden');
    distSection.classList.remove('hidden');

    // Yıldızları göster
    const stars = starsVisual.querySelectorAll('span');
    for (let i = 0; i < 5; i++) {
        if (i < Math.floor(data.median)) {
            stars[i].className = 'text-sm star-filled';
        } else if (i < data.median) {
            stars[i].className = 'text-sm star-half';
        } else {
            stars[i].className = 'text-sm star-empty';
        }
        stars[i].textContent = '★';
    }
    medianText.textContent = `${data.median.toFixed(1)} / 5`;

    // Dağılım çubukları
    const maxCount = Math.max(...data.distribution, 1);
    for (let i = 1; i <= 5; i++) {
        const count = data.distribution[i - 1] || 0;
        const pct = (count / maxCount) * 100;
        const bar = document.getElementById('dist-bar-' + i);
        const countEl = document.getElementById('dist-count-' + i);
        if (bar) bar.style.width = pct + '%';
        if (countEl) countEl.textContent = count;
    }
}

// Yıldız seçici etkileşimi
function initStarRatingUI() {
    const container = document.getElementById('star-rating-input');
    const label = document.getElementById('star-rating-label');
    const commentSection = document.getElementById('rating-comment-section');
    if (!container) return;

    const LABELS = { 1: 'İmkansız', 2: 'Zor', 3: 'Orta', 4: 'Kolay', 5: 'Çok Kolay' };
    const starBtns = container.querySelectorAll('.star-btn');

    // Hover preview
    starBtns.forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            const r = parseInt(btn.dataset.rating);
            starBtns.forEach(b => {
                const br = parseInt(b.dataset.rating);
                b.classList.toggle('hover-preview', br <= r && !b.classList.contains('active'));
            });
            label.textContent = LABELS[r];
        });

        btn.addEventListener('mouseleave', () => {
            starBtns.forEach(b => b.classList.remove('hover-preview'));
            if (currentUserRating > 0) {
                label.textContent = LABELS[currentUserRating];
            } else {
                label.textContent = 'Tıkla ve değerlendir';
            }
        });

        // Click to select
        btn.addEventListener('click', () => {
            const r = parseInt(btn.dataset.rating);
            currentUserRating = r;
            starBtns.forEach(b => {
                const br = parseInt(b.dataset.rating);
                b.classList.toggle('active', br <= r);
                b.classList.remove('hover-preview');
            });
            label.textContent = LABELS[r];
            commentSection.classList.remove('hidden');
        });
    });
}

// Yerel Yüksek Yoğunluklu POI Veritabanını Yükle
async function loadLocalCommercialPOIs() {
    try {
        const res = await fetch('commercial_pois_db.json');
        if (res.ok) {
            localCommercialPOIs = await res.json();
            commercialPOISpatialGrid = buildPOISpatialGrid(localCommercialPOIs);
            console.log(`✓ ${localCommercialPOIs.length} adet yerel ticari mekan yüklendi ve mekansal ızgaraya (Spatial Grid) indekslendi.`);
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

// Harita Canlı OSM / Yerel Bölge Veri Rozeti Durumu
function updateOfflineStatusBadge(isOffline) {
    const badge = document.getElementById('offline-mode-badge');
    if (badge) {
        badge.classList.remove('hidden');
        badge.classList.add('inline-flex');
        if (isOffline) {
            badge.className = 'inline-flex text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#B45CFF]/20 text-[#4BE3FF] border border-[#4BE3FF]/40 items-center gap-1';
            badge.innerHTML = '⚡ Yerel Bölge Paketi';
        } else {
            badge.className = 'inline-flex text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 items-center gap-1';
            badge.innerHTML = '🟢 Canlı OSM';
        }
    }
}

// Harita Başlatma ve Katman Yönetimi (Sıfır API Key, Sıfır Veri Yok Hatası)
function initMap() {
    map = L.map('map', {
        zoomControl: false,
        attributionControl: true, // OSM & Basemap Lisans Kuralı: Atıf zorunludur
        minZoom: 12,
        maxZoom: 17 // Esri Canvas katmanının en kararlı çalıştığı üst zoom sınırı
    }).setView([currentTarget.lat, currentTarget.lon], 16);

    currentTileLayerGroup = L.layerGroup().addTo(map);
    streetPolylinesLayerGroup = L.layerGroup().addTo(map);
    topBadgesLayerGroup = L.layerGroup().addTo(map);

    // Varsayılan: Minimal Açık Gri (Esri Canvas - Asla API Key İstemez, Sıfır Hata)
    setMapTileStyle('minimal_gray');

    // Zoom kontrolü sağ alt
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Haritaya tıklama ile hedef belirleme
    map.on('click', (e) => {
        setNewTarget(e.latlng.lat, e.latlng.lng, 'Haritadan Seçilen Nokta');
        if (window.innerWidth < 768) {
            setSheetState('peek');
        }
    });
}

// Harita Katman & Renk Paleti Değiştirici (Sıfır API Key, Sıfır 403, Kesintisiz Destek)
function setMapTileStyle(styleKey) {
    currentTileLayerGroup.clearLayers();
    const mapEl = document.getElementById('map');
    if (mapEl) {
        mapEl.classList.remove('tiles-minimal-clean', 'tiles-dark-clean');
    }

    const esriAttr = 'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> &mdash; Esri, DeLorme, NAVTEQ, USGS, Intermap, TomTom, &copy; OpenStreetMap contributors';

    if (styleKey === 'minimal_gray') {
        // Minimal Açık Gri: Esri World Light Gray Canvas (%100 Ücretsiz, Asla API Key İstemez)
        // maxNativeZoom: 16 -> 17 zoom seviyesinde Esri'den veri istemez, Leaflet CSS ile ölçekler (Böylece "Map data not yet available" çıkmaz)
        const tile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 17,
            maxNativeZoom: 16,
            attribution: esriAttr
        });
        currentTileLayerGroup.addLayer(tile);
    } else if (styleKey === 'dark_clean') {
        // Koyu Tema: Esri World Dark Gray Canvas (%100 Ücretsiz, Asla API Key İstemez)
        const tile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 17,
            maxNativeZoom: 16,
            attribution: esriAttr
        });
        currentTileLayerGroup.addLayer(tile);
    } else if (styleKey === 'street_detailed') {
        // Renkli Detaylı Sokak Haritası: Esri World Street Map (Türkçe cadde/sokak tabelaları ve bina blokları)
        const tile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 18,
            maxNativeZoom: 18,
            attribution: 'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> &mdash; Source: Esri, USGS, TomTom, &copy; OpenStreetMap contributors'
        });
        currentTileLayerGroup.addLayer(tile);
    } else if (styleKey === 'satellite') {
        // Gerçek Uydu Görünümü: Esri World Imagery (Kaldırımları, binaları ve gerçek asfaltı net gösterir)
        const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 18,
            maxNativeZoom: 18,
            attribution: 'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> &mdash; Source: Esri, Maxar, Earthstar, GeoEye, &copy; OpenStreetMap contributors'
        });
        currentTileLayerGroup.addLayer(sat);
    } else {
        // Standart Klasik OSM (Kullanıcı açıkça seçerse, referer korumalı)
        const std = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 18,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
            referrerPolicy: 'origin'
        });
        std.on('tileerror', function() {
            console.warn('OSM sunucusu bağlantı kısıtı verdi; Esri Canvas katmanına geri dönülüyor.');
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
            if (window.innerWidth < 768) {
                setSheetState('peek');
            }
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
    // Canlı GPS Butonları (Hem Çekmece İçi Hem Harita Üstü FAB)
    document.getElementById('btn-use-my-location')?.addEventListener('click', useCurrentLocation);
    document.getElementById('fab-current-location')?.addEventListener('click', useCurrentLocation);

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
                if (window.innerWidth < 768) {
                    setSheetState('peek');
                }
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

    // Yıldız değerlendirme UI etkileşimi
    initStarRatingUI();

    // Değerlendirme gönder butonu
    document.getElementById('btn-submit-rating')?.addEventListener('click', async () => {
        if (!selectedStreetData || currentUserRating === 0) return;
        const comment = document.getElementById('rating-comment')?.value || '';
        const midPoint = selectedStreetData.midPoint;
        const result = await submitRating(
            selectedStreetData.way.id,
            currentUserRating,
            comment,
            midPoint[0],
            midPoint[1]
        );
        if (result) {
            showToast(`⭐ ${currentUserRating} yıldız değerlendirme kaydedildi!`);
            renderStreets();
            refreshSelectedStreetDetail();
        }
    });

    // Değerlendirme sil butonu
    document.getElementById('btn-delete-rating')?.addEventListener('click', async () => {
        if (!selectedStreetData) return;
        const result = await deleteRating(selectedStreetData.way.id);
        if (result) {
            showToast('🗑️ Değerlendirmen silindi.');
            currentUserRating = 0;
            renderStreets();
            refreshSelectedStreetDetail();
        }
    });

    // Mevcut oyu değiştir butonu
    document.getElementById('btn-change-rating')?.addEventListener('click', () => {
        document.getElementById('user-existing-rating')?.classList.add('hidden');
        document.getElementById('rating-comment-section')?.classList.remove('hidden');
        const starBtns = document.querySelectorAll('#star-rating-input .star-btn');
        starBtns.forEach(b => b.classList.remove('active'));
        currentUserRating = 0;
        document.getElementById('star-rating-label').textContent = 'Tıkla ve değerlendir';
    });

    // Modal Google ile Giriş Yap butonu
    document.getElementById('btn-login-google')?.addEventListener('click', () => {
        redirectToGoogleLogin();
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

    // Hızlı Failover için sıralı ve dinamik aynalar (Yerel Node Proxy + Çalışan Aynalar)
    const endpoints = IS_LOCAL ? [
        '/api/overpass', // 1. Yerel Node.js Canlı Proxy (En hızlı, sıfır CORS, sıfır IP engeli)
        'https://overpass.openstreetmap.fr/api/interpreter', // 2. Çalışan Fransa aynası
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass.private.coffee/api/interpreter',
        'https://lz4.overpass-api.de/api/interpreter'
    ] : [
        'https://overpass.openstreetmap.fr/api/interpreter', // 1. Çalışan Fransa aynası (Doğrudan CORS destekli)
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass.private.coffee/api/interpreter',
        'https://lz4.overpass-api.de/api/interpreter'
    ];

    let data = null;
    for (const url of endpoints) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s gerçekçi zaman aşımı

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

        // Mekansal ızgara (Spatial Hash Map) ile O(1) yakın mekan filtresi (14.000+ işletmede sıfır gecikme)
        const nearbyPOIs = getNearbyCommercialPOIs(midPoint[0], midPoint[1], 85);

        // V3 Skorlama: Koordinat parametresi (midPoint[0], midPoint[1]) ile Marina ve Bizimkent coğrafi kontrolü
        const communityData = communityRatings[String(way.id)] || null;
        const scoreResult = calculateStreetScore(
            way, 
            nearbyPOIs, 
            currentTimeMode, 
            distanceToTarget, 
            midPoint[0], 
            midPoint[1],
            communityData
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

        polyline.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
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

    // Mobil Mini Peek Barı Özeti Güncellemesi
    const miniSummary = document.getElementById('mini-peek-summary');
    if (miniSummary) {
        if (validStreets.length > 0) {
            const topOne = validStreets[0];
            miniSummary.innerHTML = `🎯 <span class="text-emerald-400 font-bold">#1 ${topOne.scoreResult.streetName}</span> (%${topOne.scoreResult.score}) • ${topOne.walkMinutes} dk`;
        } else if (scoredStreets.length > 0) {
            miniSummary.innerText = `🔍 ${scoredStreets.length} yol tarandı • Açık kamu sokağı bulunamadı`;
        } else {
            miniSummary.innerText = `⚠️ Hedef taranıyor veya sunucu meşgul`;
        }
    }

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
        badgeMarker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
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
    // Mekansal ızgara (Spatial Hash Map) ile O(1) yakın mekan filtresi
    const nearbyPOIs = getNearbyCommercialPOIs(midPoint[0], midPoint[1], 85);
    const communityData = communityRatings[String(selectedStreetData.way.id)] || null;
    const scoreResult = calculateStreetScore(
        selectedStreetData.way,
        nearbyPOIs,
        currentTimeMode,
        selectedStreetData.distanceToTarget,
        midPoint[0],
        midPoint[1],
        communityData
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

    // Topluluk verilerini göster
    updateCommunityDisplay(selectedStreetData.way.id);
    updateAuthUI();

    // Yıldız seçiciyi sıfırla
    currentUserRating = 0;
    const starBtns = document.querySelectorAll('#star-rating-input .star-btn');
    starBtns.forEach(b => { b.classList.remove('active'); b.classList.remove('hover-preview'); });
    document.getElementById('star-rating-label').textContent = 'Tıkla ve değerlendir';
    document.getElementById('rating-comment-section')?.classList.add('hidden');
    document.getElementById('rating-comment').value = '';
    document.getElementById('user-existing-rating')?.classList.add('hidden');
    document.getElementById('btn-delete-rating')?.classList.add('hidden');

    // Kullanıcının mevcut oyunu kontrol et
    getMyRating(selectedStreetData.way.id).then(myRating => {
        if (myRating.exists) {
            currentUserRating = myRating.rating;
            // Yıldızları işaretle
            starBtns.forEach(b => {
                b.classList.toggle('active', parseInt(b.dataset.rating) <= myRating.rating);
            });
            const LABELS = { 1: 'İmkansız', 2: 'Zor', 3: 'Orta', 4: 'Kolay', 5: 'Çok Kolay' };
            document.getElementById('star-rating-label').textContent = LABELS[myRating.rating];
            document.getElementById('rating-comment-section')?.classList.remove('hidden');
            document.getElementById('btn-delete-rating')?.classList.remove('hidden');
            if (myRating.comment) {
                document.getElementById('rating-comment').value = myRating.comment;
            }
        }
    });
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

// ==========================================================================
// Mobil 3-Kademeli Alt Çekmece (Bottom Sheet) & Canlı GPS Konum Yönetimi
// ==========================================================================

// Çekmece Durumunu Ayarla ('peek', 'half', 'full')
function setSheetState(state) {
    const sidebar = document.getElementById('sidebar');
    const chevron = document.getElementById('sheet-chevron-icon');
    const label = document.getElementById('mini-peek-action-label');
    if (!sidebar) return;

    sidebar.classList.remove('sheet-peek', 'sheet-half', 'sheet-full');
    sidebar.classList.add(`sheet-${state}`);
    currentSheetState = state;

    if (chevron) {
        if (state === 'full') {
            chevron.style.transform = 'rotate(180deg)';
            if (label) label.innerText = 'Küçült';
        } else if (state === 'peek') {
            chevron.style.transform = 'rotate(0deg)';
            if (label) label.innerText = 'Aç';
        } else {
            chevron.style.transform = 'rotate(0deg)';
            if (label) label.innerText = 'Detaylar';
        }
    }
}

// Mobil Alt Çekmece Etkileşimlerini Başlat
function initMobileBottomSheet() {
    const handleBar = document.getElementById('sheet-header-handle');
    if (!handleBar) return;

    // Tıklama ile kademe geçişi: peek -> half -> full -> peek
    handleBar.addEventListener('click', () => {
        if (currentSheetState === 'peek') {
            setSheetState('half');
        } else if (currentSheetState === 'half') {
            setSheetState('full');
        } else {
            setSheetState('peek');
        }
    });

    // Dokunmatik Kaydırma (Touch Drag / Swipe) Desteği
    let touchStartY = 0;
    handleBar.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
    }, { passive: true });

    handleBar.addEventListener('touchend', (e) => {
        const touchEndY = e.changedTouches[0].clientY;
        const deltaY = touchEndY - touchStartY;

        if (deltaY < -35) {
            // Yukarı kaydırma
            if (currentSheetState === 'peek') setSheetState('half');
            else if (currentSheetState === 'half') setSheetState('full');
        } else if (deltaY > 35) {
            // Aşağı kaydırma
            if (currentSheetState === 'full') setSheetState('half');
            else if (currentSheetState === 'half') setSheetState('peek');
        }
    }, { passive: true });
}

// HTML5 Canlı GPS ile Cihazın Anlık Konumunu Kullan
function useCurrentLocation() {
    if (!navigator.geolocation) {
        showToast("⚠️ Tarayıcınız konum servisini desteklemiyor.");
        return;
    }

    showToast("📍 Konumunuz alınıyor...");
    setLoading(true);

    navigator.geolocation.getCurrentPosition(
        (position) => {
            setLoading(false);
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;
            
            setNewTarget(lat, lon, '📍 Mevcut Konumum');
            showToast("✅ Konumunuz alındı, yakındaki sokaklar taranıyor!");

            // Mobilde haritayı öne çıkarmak için çekmeceyi peek moduna al
            if (window.innerWidth < 768) {
                setSheetState('peek');
            }
        },
        (error) => {
            setLoading(false);
            let msg = "Konum alınamadı.";
            if (error.code === error.PERMISSION_DENIED) {
                msg = "Konum erişim izni verilmedi. Lütfen tarayıcı ayarlarından konuma izin verin.";
            } else if (error.code === error.POSITION_UNAVAILABLE) {
                msg = "Konum bilgisine ulaşılamıyor.";
            } else if (error.code === error.TIMEOUT) {
                msg = "Konum alma zaman aşımına uğradı.";
            }
            showToast(`⚠️ ${msg}`);
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 30000
        }
    );
}

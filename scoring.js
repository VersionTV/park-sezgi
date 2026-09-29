/**
 * scoring.js
 * Park Bulma İhtimali Skorlama Motoru (Heuristic Engine) - Gelişmiş V3 Sürümü
 * 
 * Kapsamlı Kontroller:
 * 1. Marina & Liman Alanları (Kıyı İstanbul, Marina vb.)
 * 2. Güvenlikli Siteler & Site İçi Yollar (Bizimkent, Emlak Konut, bariyerli alanlar)
 * 3. Otopark Koridorları & Servis Yolları (parking_aisle, driveway)
 * 4. Resmi Kamu Sokağı Doğrulaması (İsimsiz veya bina arası servis yolları elenir)
 * 5. Zemin Kat Esnaf & POI Yoğunluğu (Kafe, dükkan, duba cezası)
 * 6. Dinamik Zaman Modeli (Gündüz vs Akşam)
 * 7. Topluluk İstisnaları (Local Storage)
 */

const LOCAL_STORAGE_REPORTS_KEY = 'parksezgi_user_reports_v1';
const LEGACY_STORAGE_KEY = 'park_bulucu_user_reports_v1';

// Kullanıcı bildirimlerini al
function getUserReports() {
    try {
        if (typeof localStorage === 'undefined') return {};
        const data = localStorage.getItem(LOCAL_STORAGE_REPORTS_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
        return data ? JSON.parse(data) : {};
    } catch (e) {
        console.error("Local storage okuma hatası:", e);
        return {};
    }
}

// Kullanıcı bildirimi kaydet
function saveUserReport(wayId, reportType) {
    const reports = getUserReports();
    if (reportType === 'clear') {
        delete reports[wayId];
    } else {
        reports[wayId] = {
            type: reportType,
            timestamp: Date.now()
        };
    }
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LOCAL_STORAGE_REPORTS_KEY, JSON.stringify(reports));
    }
}

/**
 * Bir sokağın marina, liman, mendirek veya kıyı işletmesine ait olup olmadığını kontrol eder.
 */
function isMarinaOrPortArea(way, lat, lon) {
    const tags = way.tags || {};
    const name = (tags.name || '').toLowerCase();

    // 1. İsim veya etiket eşleşmesi
    if (
        name.includes('marina') ||
        name.includes('kıyı istanbul') ||
        name.includes('kıyıistanbul') ||
        name.includes('liman') ||
        name.includes('iskele') ||
        name.includes('balıkçı barınağı') ||
        name.includes('dalyan') ||
        name.includes('mendirek')
    ) {
        return true;
    }

    if (
        tags.leisure === 'marina' ||
        tags.harbour ||
        tags.waterway === 'dock' ||
        tags.seamark ||
        tags['seamark:type']
    ) {
        return true;
    }

    // 2. Kıyı İstanbul Marina Coğrafi Alanı (Büyükçekmece Marina Bölgesi)
    // 41.0175 - 41.0230 Kuzey, 28.5720 - 28.5810 Doğu arası mendirek ve marina içi
    if (lat && lon) {
        if (lat >= 41.0170 && lat <= 41.0225 && lon >= 28.5710 && lon <= 28.5805) {
            // Eğer doğrudan sahil/kordon yolu değil de marina mendirek veya tesis içiyse
            if (!name.includes('kordonboyu') && !name.includes('caddesi')) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Bir sokağın güvenlikli site içine veya bariyerli alana ait olup olmadığını kontrol eder.
 * Bizimkent, Adatepe, Hilal, Emlak Konutları gibi büyük sitelerin iç yollarını eler.
 */
function isGatedCommunityOrPrivateRoad(way, lat, lon) {
    const tags = way.tags || {};
    const name = (tags.name || '').toLowerCase();

    // 1. Doğrudan erişim kısıtlamaları
    if (['private', 'no', 'destination', 'customers', 'permissive', 'delivery', 'emergency'].includes(tags.access)) {
        return { isGated: true, reason: 'Özel Erişim / Kamuya Kapalı Alan (access=' + tags.access + ')' };
    }

    // 2. Bariyer etiketleri
    if (tags.barrier === 'lift_gate' || tags.barrier === 'gate' || tags.barrier === 'barrier' || tags.barrier === 'bollard') {
        return { isGated: true, reason: 'Kollu Bariyer / Güvenlik Kontrolü' };
    }

    // 3. Otopark içi koridoru veya özel garaj/driveway
    if (tags.service === 'parking_aisle' || tags.service === 'driveway' || tags.layer === '-1') {
        return { isGated: true, reason: 'Site / Otopark İçi Geçiş Yolu (parking_aisle/driveway)' };
    }

    // 4. Belirgin Site İsimleri
    const gatedKeywords = [
        'sitesi içi', 'site içi', 'sitesi icı', 'site ici', 'sitesi yolu', 'site yolu',
        'bizimkent', 'ihlas marmara', 'estus', 'regnum', 'innova', 'akros',
        'sembol istanbul', 'demir romance', 'gül park', 'adatepe', 'hilal konut',
        'emlak konut', 'kollu bariyer', 'güvenlik girişi', 'kapalı site'
    ];

    for (const kw of gatedKeywords) {
        if (name.includes(kw)) {
            return { isGated: true, reason: `Güvenlikli Site Alanı (${tags.name || 'Site İçi Yol'})` };
        }
    }

    // 5. Bizimkent Sitesi Coğrafi Alanı (Beylikdüzü)
    // 41.0025 - 41.0115 Kuzey, 28.6380 - 28.6510 Doğu arası
    if (lat && lon) {
        if (lat >= 41.0030 && lat <= 41.0110 && lon >= 28.6390 && lon <= 28.6500) {
            // Çevresindeki ana caddeler hariç iç kısımdaki site yolları
            const isBorderAvenue = name.includes('cumhuriyet') || name.includes('atatürk') || name.includes('barış') || name.includes('ali talip');
            if (!isBorderAvenue) {
                return { isGated: true, reason: 'Bizimkent Güvenlikli Site Alanı (Site Sakini Harici Giriş Yasak)' };
            }
        }
    }

    // 6. Genel Site / Konut / Rezidans İsimleri ve Servis Yolu Uyumu
    if (name.includes('sitesi') || name.includes('konutları') || name.includes('rezidans') || name.includes('evleri')) {
        return { isGated: true, reason: `Site / Rezidans Özel Yolu (${tags.name})` };
    }

    // 7. İsimsiz Yol ve Servis Yolu Kontrolü:
    // Türkiye'de kamuya açık sokaklar belediyece adlandırılır ("... Sokağı", "... Caddesi").
    // İsimsiz service veya residential yollar genellikle site içi otopark veya garaj girişleridir.
    if (!tags.name && (tags.highway === 'service' || tags.highway === 'residential')) {
        return { isGated: true, reason: 'İsimsiz İç Servis / Bina Arası Yol (Kamusal Cadde Değil)' };
    }

    return { isGated: false, reason: null };
}

/**
 * Bir sokak için puan ve açıklama faktörlerini hesaplar.
 */
function calculateStreetScore(way, nearbyPOIs = [], timeMode = 'current', distanceMeters = 0, lat = null, lon = null, communityData = null) {
    const tags = way.tags || {};
    const highway = tags.highway || 'unknown';
    const streetName = tags.name || 'İsimsiz Ara Yol';
    const breakdown = [];
    let score = 0;
    let isForbidden = false;

    // ÖNCELİKLİ KONTROL 1: Marina / Liman / Kıyı İstanbul
    if (isMarinaOrPortArea(way, lat, lon)) {
        return {
            score: 0,
            category: 'forbidden',
            breakdown: [
                { label: '⛔ Marina / Liman Bölgesi (Özel İşletme / Kamuya Açık Ücretsiz Park Yok)', value: '0', type: 'negative' }
            ],
            isForbidden: true,
            color: '#ef4444',
            streetName,
            highway
        };
    }

    // ÖNCELİKLİ KONTROL 2: Güvenlikli Siteler & Özel Site Yolları (Bizimkent vb.)
    const gatedCheck = isGatedCommunityOrPrivateRoad(way, lat, lon);
    if (gatedCheck.isGated) {
        return {
            score: 5,
            category: 'forbidden',
            breakdown: [
                { label: `⛔ ${gatedCheck.reason}`, value: 'Giriş Kısıtlı (5)', type: 'negative' },
                { label: 'Yalnızca Site Sakinleri & Bariyer / Güvenlik Kontrolü', value: '-95', type: 'negative' }
            ],
            isForbidden: true,
            color: '#ef4444',
            streetName,
            highway
        };
    }

    // 1. ADIM: Sokak Türü Taban Puanı
    let baseScore = 0;
    if (highway === 'residential') {
        baseScore = 80;
        breakdown.push({ label: 'Konut / Mahalle Arası Sokak', value: '+80', type: 'positive' });
    } else if (highway === 'living_street') {
        baseScore = 85;
        breakdown.push({ label: 'Sakin Yaşam Sokağı (Living Street)', value: '+85', type: 'positive' });
    } else if (highway === 'service') {
        baseScore = 30;
        breakdown.push({ label: 'Ara Bağlantı / Servis Yolu', value: '+30', type: 'warning' });
    } else if (highway === 'tertiary') {
        baseScore = 35;
        breakdown.push({ label: 'Ara Ana Yol / Toplayıcı Yol (Yoğun Trafik)', value: '+35', type: 'warning' });
    } else if (['primary', 'secondary', 'trunk'].includes(highway)) {
        baseScore = 10;
        isForbidden = true;
        breakdown.push({ label: 'Ana Arter / Cadde (Park Yasağı / Çekilme Riski)', value: '-70', type: 'negative' });
    } else if (['pedestrian', 'footway', 'cycleway', 'path'].includes(highway)) {
        return {
            score: 0,
            category: 'forbidden',
            breakdown: [{ label: 'Yaya / Bisiklet Yolu (Araç Girişi Yok)', value: '0', type: 'negative' }],
            isForbidden: true,
            color: '#9ca3af',
            streetName,
            highway
        };
    } else {
        baseScore = 45;
        breakdown.push({ label: 'Standart Yol', value: '+45', type: 'neutral' });
    }
    score = baseScore;

    // 2. ADIM: Esnaf, Dükkan & POI Yoğunluğu (Duba & Sirkülasyon Faktörü)
    // Hem OSM nesneleri (tags.amenity) hem de yerel veri tabanı (poi.type) desteklenir
    const commercialPOIs = nearbyPOIs.filter(poi => {
        const t = poi.tags || {};
        const amenity = t.amenity || poi.type;
        const shop = t.shop || (poi.type === 'shop' || poi.type === 'supermarket' || poi.type === 'bakery' ? poi.type : undefined);
        return (
            ['cafe', 'bar', 'restaurant', 'fast_food', 'pub', 'food_court'].includes(amenity) ||
            ['supermarket', 'convenience', 'bakery', 'clothes', 'car_repair', 'mall', 'shop'].includes(shop) ||
            ['bank', 'pharmacy', 'hospital', 'clinic'].includes(amenity)
        );
    });

    const poiCount = commercialPOIs.length;
    if (poiCount > 0) {
        let penalty = 0;
        if (poiCount >= 8) {
            penalty = 45;
            breakdown.push({ label: `Aşırı Yoğun Kafe/Restoran Bulvarı (${poiCount}+ mekan, vale, duba ve müşteri trafiği)`, value: `-${penalty}`, type: 'negative' });
        } else if (poiCount >= 4) {
            penalty = 30;
            breakdown.push({ label: `Yoğun Esnaf/Kafe Bölgesi (${poiCount} mekan, duba/araç sirkülasyonu)`, value: `-${penalty}`, type: 'negative' });
        } else if (poiCount >= 2) {
            penalty = 20;
            breakdown.push({ label: `Dükkan / Market Bulunuyor (${poiCount} mekan)`, value: `-${penalty}`, type: 'negative' });
        } else {
            penalty = 10;
            breakdown.push({ label: `1 Dükkan / İş Yeri Mevcut`, value: `-${penalty}`, type: 'warning' });
        }
        score -= penalty;
    } else {
        score += 10;
        breakdown.push({ label: 'Dükkansız, Tamamen Konut Sokak (Duba ihtimali düşük)', value: '+10', type: 'positive' });
    }

    // Kameroğlu Metrohome / Cumhuriyet Çarşısı / Açık AVM Promenadı Coğrafi Kontrolü
    const isKamerogluPromenade = (
        lat && lon &&
        lat >= 41.0125 && lat <= 41.0155 &&
        lon >= 28.6360 && lon <= 28.6390
    );

    if (isKamerogluPromenade) {
        score -= 20;
        breakdown.push({
            label: '🏬 Kameroğlu Metrohome Açık Çarşı / Kafe Aksı (Dükkan önleri, valeler ve müşteri sirkülasyonu)',
            value: '-20',
            type: 'negative'
        });
    }

    // 3. ADIM: Zaman Faktörü (Gündüz vs Akşam)
    let isDaytime = false;
    let isWeekend = false;

    if (timeMode === 'current') {
        const now = new Date();
        const hour = now.getHours();
        const day = now.getDay();
        isDaytime = (hour >= 9 && hour < 18);
        isWeekend = (day === 0 || day === 6);
    } else if (timeMode === 'weekday_day') {
        isDaytime = true;
        isWeekend = false;
    } else if (timeMode === 'weekday_night') {
        isDaytime = false;
        isWeekend = false;
    } else if (timeMode === 'weekend') {
        isWeekend = true;
        isDaytime = false;
    }

    if (highway === 'residential' || highway === 'living_street') {
        if (isDaytime && !isWeekend) {
            score += 15;
            breakdown.push({ label: 'Gündüz Mesai Saatleri (Sakinlerin çoğu işte, yer bulma şansı yüksek)', value: '+15', type: 'positive' });
        } else if (!isDaytime && !isWeekend) {
            score -= 20;
            breakdown.push({ label: 'Akşam Saatleri (Bina sakinleri eve döndü, park yerleri dolu olabilir)', value: '-20', type: 'negative' });
        } else {
            score -= 10;
            breakdown.push({ label: 'Hafta Sonu (Evde olan sakin sayısı yüksek)', value: '-10', type: 'warning' });
        }
    }

    // 4. ADIM: Sokak Geometrisi & Tek Yön
    if (tags.oneway === 'yes') {
        breakdown.push({ label: 'Tek Yönlü Sokak (Düzenli araç akışı)', value: '+5', type: 'neutral' });
        score += 5;
    }

    // 5. ADIM: Topluluk Değerlendirmesi (Community Ratings)
    if (communityData && communityData.count >= 3) {
        // Medyan 3 = nötr, 5 = +40, 1 = -40
        const communityAdjustment = (communityData.median - 3) * 20;
        const confidence = Math.min(communityData.count / 20, 1.0);
        const adjustment = Math.round(communityAdjustment * confidence);
        score += adjustment;
        const arrow = adjustment >= 0 ? '+' : '';
        breakdown.push({
            label: `👥 Topluluk Değerlendirmesi (${communityData.count} oy, medyan: ${communityData.median.toFixed(1)})`,
            value: `${arrow}${adjustment}`,
            type: adjustment >= 0 ? 'positive' : 'negative'
        });
    }

    // Eski localStorage fallback (sunucu yokken)
    const reports = getUserReports();
    if (reports[way.id] && (!communityData || communityData.count < 3)) {
        const rep = reports[way.id];
        if (rep.type === 'duba_yasak') {
            score = 10;
            isForbidden = true;
            breakdown.push({ label: '⚠️ Kullanıcı Bildirimi: Duba / Park Yasağı / Tıkalı Sokak', value: 'Geçersiz Kılındı (10)', type: 'negative' });
        } else if (rep.type === 'kolay_park') {
            score = Math.min(100, score + 25);
            breakdown.push({ label: '⭐ Kullanıcı Bildirimi: Rahat Park Edildi Doğrulaması', value: '+25', type: 'positive' });
        }
    }

    score = Math.max(0, Math.min(100, Math.round(score)));

    let category = 'low';
    let color = '#ef4444';

    if (isForbidden || score < 35) {
        category = 'forbidden';
        color = '#ef4444';
    } else if (score >= 70) {
        category = 'high';
        color = '#10b981';
    } else {
        category = 'medium';
        color = '#f59e0b';
    }

    return {
        score,
        category,
        color,
        breakdown,
        isForbidden,
        poiCount,
        streetName,
        highway
    };
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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        calculateStreetScore,
        isMarinaOrPortArea,
        isGatedCommunityOrPrivateRoad,
        calculateDistanceMeters,
        getUserReports,
        saveUserReport
    };
}


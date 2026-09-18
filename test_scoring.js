const { calculateStreetScore, isMarinaOrPortArea, isGatedCommunityOrPrivateRoad } = require('./scoring.js');

console.log("=== V3 KRİTER TESTLERİ ===");

// 1. Kıyı İstanbul koordinatındaki isimsiz servis yolu
const marinaInsideWay = {
    id: 301,
    tags: { highway: 'service', service: 'parking_aisle' }
};
const mScore = calculateStreetScore(marinaInsideWay, [], 'weekday_day', 50, 41.0195, 28.5770);
console.log(`1. Kıyı İstanbul Marina İçi Otopark Yolu: Skor=${mScore.score}, Yasak=${mScore.isForbidden}, Renk=${mScore.color}`);
console.assert(mScore.isForbidden === true, "Marina içi yol kırmızı olmalı");

// 2. Bizimkent koordinatlarındaki iç yol
const bizimkentInnerWay = {
    id: 302,
    tags: { highway: 'residential', name: 'Bizimkent 2. Kısım Blok Yolu' }
};
const bScore = calculateStreetScore(bizimkentInnerWay, [], 'weekday_day', 150, 41.0060, 28.6440);
console.log(`2. Bizimkent Site Yolu: Skor=${bScore.score}, Yasak=${bScore.isForbidden}, Sebep=${bScore.breakdown[0].label}`);
console.assert(bScore.isForbidden === true, "Bizimkent site içi yol kırmızı olmalı");

// 3. İsimsiz residential yol (bina arası / kapalı geçit)
const namelessWay = {
    id: 303,
    tags: { highway: 'residential' } // Adı yok
};
const nScore = calculateStreetScore(namelessWay, [], 'weekday_day', 200, 41.0250, 28.5900);
console.log(`3. İsimsiz Konut Yolu: Skor=${nScore.score}, Yasak=${nScore.isForbidden}, Sebep=${nScore.breakdown[0].label}`);
console.assert(nScore.isForbidden === true, "İsimsiz yol kamusal sokak sayılmamalı");

// 4. Gerçek Resmi Konut Sokağı (Filiz 2 Sokağı)
const officialWay = {
    id: 304,
    tags: { highway: 'residential', name: 'Filiz 2 Sokağı' }
};
const oScore = calculateStreetScore(officialWay, [], 'weekday_day', 250, 41.0220, 28.5860);
console.log(`4. Resmi Filiz 2 Sokağı: Skor=${oScore.score}, Renk=${oScore.color}`);
console.assert(oScore.score >= 80, "Resmi konut sokağı yeşil olmalı");

// 5. Kameroğlu Metrohome Açık Çarşı / Kafe Bulvarı (Nadir Sokak)
const localPOIs = require('./commercial_pois_db.json');
const kamerogluWay = {
    id: 305,
    tags: { highway: 'residential', name: 'Nadir Sokak' }
};
const kScore = calculateStreetScore(kamerogluWay, localPOIs, 'weekday_day', 60, 41.0140, 28.6375);
console.log(`5. Kameroğlu Nadir Sokak (Gündüz): Skor=${kScore.score}, Kategori=${kScore.category}, Renk=${kScore.color}`);
console.log(`   Uygulanan Cezalar:`, kScore.breakdown.filter(b => b.type === 'negative').map(b => b.label));
console.assert(kScore.score < 60, "Kameroğlu sokakları yoğun kafe ve açık çarşı nedeniyle asla yeşil olmamalı (<60 olmalı)");
console.assert(kScore.color !== '#10b981', "Kameroğlu sokakları yeşil olmamalıdır");

console.log("✅ V3 ve Kameroğlu POI testleri başarıyla geçti!");

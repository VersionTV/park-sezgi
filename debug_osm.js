const https = require('https');

const query = `[out:json][timeout:15];
way["highway"~"^(residential|living_street|service|tertiary|secondary|primary)$"](around:400, 41.0060, 28.6440);
out tags;`;

const postData = 'data=' + encodeURIComponent(query);

const req = https.request({
    hostname: 'overpass.kumi.systems',
    port: 443,
    path: '/api/interpreter',
    method: 'POST',
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'ParkBulucuDebugger/2.0'
    }
}, res => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
        try {
            const data = JSON.parse(body);
            console.log("SUCCESS! Ways in Bizimkent:", data.elements.length);
            data.elements.forEach(e => console.log(e.id, JSON.stringify(e.tags)));
        } catch(e) {
            console.log("Body:", body.substring(0, 300));
        }
    });
});
req.write(postData);
req.end();

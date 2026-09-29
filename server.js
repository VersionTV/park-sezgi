const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5500;
const BASE_DIR = __dirname;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const DATA_DIR = path.join(__dirname, 'data');
const VOTES_FILE = path.join(DATA_DIR, 'ratings_votes.json');
const AGGREGATE_FILE = path.join(__dirname, 'ratings_aggregate.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(filePath, defaultVal) {
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return defaultVal;
    }
}

function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function regenerateAggregate() {
    const votes = readJSON(VOTES_FILE, {});
    const grouped = {};
    for (const key in votes) {
        const vote = votes[key];
        if (!grouped[vote.wayId]) {
            grouped[vote.wayId] = { ratings: [], count: 0, distribution: [0, 0, 0, 0, 0] };
        }
        grouped[vote.wayId].ratings.push(vote.rating);
        grouped[vote.wayId].count++;
        if (vote.rating >= 1 && vote.rating <= 5) {
            grouped[vote.wayId].distribution[vote.rating - 1]++;
        }
    }
    const aggregate = {};
    for (const wayId in grouped) {
        const data = grouped[wayId];
        data.ratings.sort((a, b) => a - b);
        const mid = Math.floor(data.ratings.length / 2);
        const median = data.ratings.length % 2 !== 0 ? data.ratings[mid] : (data.ratings[mid - 1] + data.ratings[mid]) / 2;
        aggregate[wayId] = {
            median,
            count: data.count,
            distribution: data.distribution
        };
    }
    writeJSON(AGGREGATE_FILE, aggregate);
    return aggregate;
}

const rateLimitMap = new Map();
function checkRateLimit(userId) {
    const now = Date.now();
    const limit = rateLimitMap.get(userId);
    if (!limit || limit.resetTime < now) {
        rateLimitMap.set(userId, { count: 1, resetTime: now + 60000 });
        return true;
    }
    if (limit.count >= 10) {
        return false;
    }
    limit.count++;
    return true;
}

function extractUserId(req) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
        return auth.slice(7);
    }
    return null;
}

function parseJSONBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(e);
            }
        });
    });
}

const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Canlı OSM Overpass Proxy (CORS & IP Ban bypass, 0ms yerel köprü)
    if (req.url.startsWith('/api/overpass')) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            let queryData = '';
            if (req.method === 'POST') {
                if (body.startsWith('data=')) {
                    queryData = decodeURIComponent(body.slice(5));
                } else {
                    queryData = body;
                }
            } else {
                const u = new URL(req.url, `http://${req.headers.host}`);
                queryData = u.searchParams.get('data') || '';
            }

            if (!queryData) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'data query parameter required' }));
                return;
            }

            const mirrors = [
                'https://overpass.openstreetmap.fr/api/interpreter',
                'https://overpass.kumi.systems/api/interpreter',
                'https://overpass.private.coffee/api/interpreter'
            ];

            let success = false;
            for (const mirror of mirrors) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 6000);
                    const upstreamRes = await fetch(mirror, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'User-Agent': 'ParkSezgi/1.0 (contact@parksezgi.app)'
                        },
                        body: 'data=' + encodeURIComponent(queryData),
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    if (upstreamRes.ok) {
                        const json = await upstreamRes.text();
                        res.writeHead(200, {
                            'Content-Type': 'application/json; charset=utf-8',
                            'Cache-Control': 'no-cache'
                        });
                        res.end(json);
                        success = true;
                        break;
                    }
                } catch (e) {
                    console.warn(`Mirror ${mirror} başarısız:`, e.message);
                }
            }

            if (!success) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Tüm canlı Overpass aynaları zaman aşımına uğradı' }));
            }
        });
        return;
    }

    if (req.url.startsWith('/api/ratings')) {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const pathname = parsedUrl.pathname;

        if (pathname === '/api/ratings/my' && req.method === 'GET') {
            const userId = extractUserId(req);
            if (!userId) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            const wayId = parsedUrl.searchParams.get('wayId');
            if (!wayId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'wayId required' }));
                return;
            }
            const votes = readJSON(VOTES_FILE, {});
            const vote = votes[wayId + ':' + userId];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (vote) {
                res.end(JSON.stringify({ exists: true, rating: vote.rating, comment: vote.comment, timestamp: vote.timestamp }));
            } else {
                res.end(JSON.stringify({ exists: false }));
            }
            return;
        }

        if (pathname === '/api/ratings' && req.method === 'POST') {
            const userId = extractUserId(req);
            if (!userId) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            if (!checkRateLimit(userId)) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
                return;
            }
            parseJSONBody(req).then(body => {
                if (!body.wayId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'wayId required' }));
                }
                if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Invalid rating, must be integer 1-5' }));
                }
                const votes = readJSON(VOTES_FILE, {});
                votes[body.wayId + ':' + userId] = {
                    wayId: body.wayId,
                    userId,
                    rating: body.rating,
                    comment: body.comment,
                    timestamp: Date.now(),
                    lat: body.lat,
                    lon: body.lon
                };
                writeJSON(VOTES_FILE, votes);
                const aggregate = regenerateAggregate();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, aggregated: aggregate[body.wayId] }));
            }).catch(e => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            });
            return;
        }

        if (pathname === '/api/ratings' && req.method === 'DELETE') {
            const userId = extractUserId(req);
            if (!userId) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            parseJSONBody(req).then(body => {
                if (!body.wayId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'wayId required' }));
                }
                const votes = readJSON(VOTES_FILE, {});
                const key = body.wayId + ':' + userId;
                if (votes[key]) {
                    delete votes[key];
                    writeJSON(VOTES_FILE, votes);
                }
                const aggregate = regenerateAggregate();
                const agg = aggregate[body.wayId] || { median: 0, count: 0, distribution: [0,0,0,0,0] };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, aggregated: agg }));
            }).catch(e => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
    }

    let reqPath = decodeURI(req.url.split('?')[0]);
    if (reqPath === '/' || reqPath === '') {
        reqPath = '/index.html';
    }

    const filePath = path.join(BASE_DIR, reqPath);

    // Güvenlik kontrolü (Path Traversal engeli)
    if (!filePath.startsWith(BASE_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('403 Forbidden');
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Dosya Bulunamadı: ' + reqPath);
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stats.size,
            'Cache-Control': 'no-cache'
        });

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 ParkSezgi Canlı Sunucusu Aktif!`);
    console.log(`👉 http://localhost:${PORT}`);
    console.log(`👉 http://127.0.0.1:${PORT}\n`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.warn(`Port ${PORT} kullanımda, alternatif port deneniyor...`);
        server.listen(8080, '0.0.0.0');
    } else {
        console.error('Sunucu hatası:', err);
    }
});

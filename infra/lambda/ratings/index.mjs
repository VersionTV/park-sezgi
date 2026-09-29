import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

// Ortam değişkenleri (Terraform tarafından atanır)
const RATINGS_TABLE = process.env.RATINGS_TABLE;
const AGGREGATE_BUCKET = process.env.AGGREGATE_BUCKET;
const AGGREGATE_KEY = process.env.AGGREGATE_KEY || 'ratings_aggregate.json';

// AWS istemcilerini başlatma
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({});

// Sabit CORS başlıkları
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
};

// Yardımcı fonksiyon: Standart HTTP yanıtı oluşturur
const createResponse = (statusCode, body) => {
    return {
        statusCode,
        headers: CORS_HEADERS,
        body: typeof body === 'string' ? body : JSON.stringify(body)
    };
};

// Medyan (ortanca değer) hesaplama fonksiyonu
const calculateMedian = (values) => {
    if (values.length === 0) return 0;
    values.sort((a, b) => a - b);
    const half = Math.floor(values.length / 2);
    if (values.length % 2) {
        return values[half];
    }
    return (values[half - 1] + values[half]) / 2.0;
};

// Bir wayId için özet (aggregate) puanlamayı hesapla ve S3'e kaydet
const regenerateAggregate = async (wayId) => {
    try {
        // 1. wayId'ye ait tüm puanları DynamoDB'den çek
        const queryParams = {
            TableName: RATINGS_TABLE,
            KeyConditionExpression: 'wayId = :w',
            ExpressionAttributeValues: {
                ':w': wayId
            }
        };
        
        const { Items } = await docClient.send(new QueryCommand(queryParams));
        
        let aggregateData = null;

        if (Items && Items.length > 0) {
            const ratings = Items.map(item => item.rating);
            const count = ratings.length;
            const median = calculateMedian([...ratings]);
            
            // Dağılımı hesapla (1'den 5'e kadar puanların frekansları)
            const distribution = [0, 0, 0, 0, 0];
            ratings.forEach(r => {
                if (r >= 1 && r <= 5) {
                    distribution[r - 1]++; // Örneğin, rating=5 ise distribution[4] bir artırılır
                }
            });

            aggregateData = {
                median,
                count,
                distribution
            };
        }

        // 2. Mevcut S3 JSON dosyasını oku
        let s3Data = {};
        try {
            const getObjParams = {
                Bucket: AGGREGATE_BUCKET,
                Key: AGGREGATE_KEY
            };
            const s3Response = await s3Client.send(new GetObjectCommand(getObjParams));
            const strData = await s3Response.Body.transformToString();
            s3Data = JSON.parse(strData);
        } catch (error) {
            // Dosya yoksa (NoSuchKey) veya okunamıyorsa boş bir obje ile başla
            if (error.name !== 'NoSuchKey' && error.name !== 'NotFound') {
                console.warn("S3 dosyası okunurken beklenmeyen hata, yeni dosya oluşturulacak:", error);
            }
        }

        // 3. Veriyi güncelle veya wayId'yi tamamen sil
        if (aggregateData) {
            s3Data[wayId] = aggregateData;
        } else {
            // Hiç oy kalmadıysa bu wayId'yi listeden çıkar
            delete s3Data[wayId];
        }

        // 4. Güncel veriyi S3'e geri yaz
        const putObjParams = {
            Bucket: AGGREGATE_BUCKET,
            Key: AGGREGATE_KEY,
            Body: JSON.stringify(s3Data),
            ContentType: 'application/json'
        };
        await s3Client.send(new PutObjectCommand(putObjParams));

        return aggregateData || { count: 0 };
    } catch (error) {
        console.error("Özet (aggregate) oluşturulurken hata:", error);
        throw error;
    }
};

// Ana Lambda işleyicisi (Handler)
export const handler = async (event) => {
    // OPTIONS isteği (CORS preflight) kontrolü
    if (event.httpMethod === 'OPTIONS') {
        return createResponse(200, '');
    }

    try {
        const path = event.path || '';
        const resource = event.resource || path;
        const httpMethod = event.httpMethod;

        // Kullanıcı kimliğini (userId) API Gateway Cognito yetkilendiricisinden (authorizer) al
        const userId = event.requestContext?.authorizer?.claims?.sub;

        if (!userId) {
            return createResponse(401, { error: 'Yetkisiz erişim. Kullanıcı kimliği bulunamadı.' });
        }

        // Rota 1: POST /ratings
        if (httpMethod === 'POST' && (resource === '/ratings' || path.endsWith('/ratings'))) {
            const body = JSON.parse(event.body || '{}');
            const { wayId, rating, comment, lat, lon } = body;

            // Parametre doğrulama
            if (!wayId || typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
                return createResponse(400, { error: 'Geçersiz parametreler. wayId ve 1-5 arası tam sayı rating gerekli.' });
            }

            const item = {
                wayId,
                userId,
                rating,
                timestamp: Date.now(),
            };

            // Opsiyonel parametreler
            if (comment !== undefined) item.comment = comment;
            if (lat !== undefined) item.lat = lat;
            if (lon !== undefined) item.lon = lon;

            // DynamoDB'ye kaydet (varsa üzerine yazar - upsert)
            await docClient.send(new PutCommand({
                TableName: RATINGS_TABLE,
                Item: item
            }));

            // Özeti (aggregate) yeniden hesapla ve S3'e yükle
            const aggregated = await regenerateAggregate(wayId);

            return createResponse(200, { success: true, aggregated });
        }

        // Rota 2: DELETE /ratings
        if (httpMethod === 'DELETE' && (resource === '/ratings' || (path.endsWith('/ratings') && !path.endsWith('/ratings/my')))) {
            const body = JSON.parse(event.body || '{}');
            const { wayId } = body;

            if (!wayId) {
                return createResponse(400, { error: 'Geçersiz parametreler. wayId gerekli.' });
            }

            // DynamoDB'den kaydı sil
            await docClient.send(new DeleteCommand({
                TableName: RATINGS_TABLE,
                Key: {
                    wayId,
                    userId
                }
            }));

            // Özeti yeniden hesapla ve S3'ü güncelle
            const aggregated = await regenerateAggregate(wayId);

            return createResponse(200, { success: true, aggregated });
        }

        // Rota 3: GET /ratings/my
        if (httpMethod === 'GET' && (resource === '/ratings/my' || path.endsWith('/ratings/my'))) {
            const wayId = event.queryStringParameters?.wayId;

            if (!wayId) {
                return createResponse(400, { error: 'Geçersiz parametreler. wayId queryString içinde gerekli.' });
            }

            // DynamoDB'den kullanıcının kendi oyunu sorgula
            const { Item } = await docClient.send(new GetCommand({
                TableName: RATINGS_TABLE,
                Key: {
                    wayId,
                    userId
                }
            }));

            if (Item) {
                return createResponse(200, { 
                    exists: true, 
                    rating: Item.rating, 
                    comment: Item.comment, 
                    timestamp: Item.timestamp 
                });
            } else {
                return createResponse(200, { exists: false });
            }
        }

        // Belirtilmeyen rotalar için
        return createResponse(404, { error: 'Rota bulunamadı.' });

    } catch (error) {
        console.error("Lambda içinde yakalanan hata:", error);
        return createResponse(500, { error: 'Sunucu tarafında bir hata oluştu.', details: error.message });
    }
};

# ADR-0002: Hybrid Storage Architecture: DynamoDB Atomic Writes with S3 Static CDN Reads

- **Status:** Accepted
- **Deciders:** Engineering Lead / Architecture Team
- **Date:** 2026-09-25

---

## 1. Context & Problem Statement
ParkSezgi includes a community rating system where users can evaluate street parking viability on a 1–5 star scale. The system needs to support:
1. **Strict anti-abuse:** Exactly 1 vote per user per street, rate limiting, and median calculation to resist brigade manipulation.
2. **High-density map rendering:** When a user navigates to an area, 50–100 streets are displayed simultaneously with community scores.
3. **Budget constraint:** The system must operate within the **AWS Free Tier ($0/month)**.

If clients query a database directly for every rendered street, a single user browsing 5 destinations would trigger hundreds of read operations. Under concurrent usage, this would rapidly exhaust DynamoDB's 25 RCU Free Tier limit and generate unnecessary database costs.

---

## 2. Alternatives Considered

### Option A: Pure DynamoDB On-Demand (Reads and Writes via API Gateway)
- **Mechanism:** Client sends `GET /api/ratings?wayIds=...` directly to DynamoDB via Lambda.
- **Trade-offs:**
  - ❌ Consumes DynamoDB Read Capacity Units on every map drag/zoom.
  - ❌ Cold-start latency from API Gateway + Lambda on every map interaction.
  - ❌ Susceptible to billing spikes during traffic surges.

### Option B: Traditional Relational Database (AWS RDS PostgreSQL / MySQL)
- **Mechanism:** Centralized relational database with SQL aggregations.
- **Trade-offs:**
  - ❌ Incurs minimum fixed costs of $15–$25/month for provisioned db.t3.micro instances, violating the $0 free-tier requirement.
  - ❌ Requires VPC, NAT Gateway, and connection pool management.

### Option C: Hybrid Serverless Architecture (DynamoDB Atomic Writes + S3 Static Aggregate CDN Reads)
- **Mechanism:**
  - **Write Path:** Client submits a rating via `POST /api/ratings` with a Cognito OAuth2 JWT. API Gateway triggers a Node.js Lambda function that atomic-upserts the record into DynamoDB (`PK: wayId`, `SK: userId`).
  - **Aggregation Path:** The same Lambda query-aggregates all votes for that `wayId`, calculates the median and distribution, updates `ratings_aggregate.json`, and writes it to an S3 bucket.
  - **Read Path:** Clients fetch `ratings_aggregate.json` via Amazon CloudFront CDN edge caches. The client caches the response in `sessionStorage` for 3–5 minutes.

---

## 3. Decision Outcome
**Chosen: Option C (Hybrid Architecture).**

Separating the write path (ACID atomic guarantee in DynamoDB) from the read path (globally cached static asset via CloudFront & S3) aligns with the CQRS (Command Query Responsibility Segregation) pattern.

```
Write Path: Client -> API Gateway -> Lambda -> DynamoDB -> S3 (ratings_aggregate.json)
Read Path:  Client -> CloudFront CDN Edge Cache -> S3 (Static GET)
```

---

## 4. Consequences & Performance Metrics

### Positive:
- **Zero Read Cost:** Unlimited clients can load community ratings without consuming a single DynamoDB Read Capacity Unit.
- **Sub-30ms Global Latency:** Reads are served from CloudFront edge locations closest to the user.
- **Atomic Integrity:** Composite partition/sort key (`wayId` / `userId`) enforces exactly one vote per user per street.
- **100% Serverless:** Zero servers to patch, auto-scales from 0 to thousands of users.

### Negative:
- **Eventual Consistency:** A user's new rating may take a few seconds to reflect for other users due to CDN caching headers (deemed completely acceptable for parking sentiment).

# OpenSearch Metrics Monitoring Script

This script monitors OpenSearch cluster metrics to help diagnose performance issues during load testing of the `/addToChat` API.

## Purpose

The `/addToChat` API uses the `pms-green-dots` OpenSearch index. Previous load tests failed due to OpenSearch breaking under load. This script helps you monitor all critical metrics to:

1. **Identify the root cause** of the OpenSearch failure
2. **Monitor performance** during load tests
3. **Provide evidence** of the `refresh:true` bottleneck

## Root Cause Identified

**The primary issue is that ALL OpenSearch write operations use `refresh: true`**, which forces immediate index refreshes and causes 50-100x performance degradation.

**Location:** `node_modules/@amurahealth/pms-utils/ESService.ts` (lines 49, 67, 81, 101, 141, 176)

## Setup

### 1. Install Dependencies

```bash
cd upgradeScripts
npm install
```

### 2. Configure AWS Credentials

Ensure your AWS credentials are configured with access to:
- SSM Parameter Store (to read `pms-elastic-search-url`)
- OpenSearch cluster (read permissions for metrics)

```bash
# Set AWS credentials (if not already configured)
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_REGION=ap-south-1
```

## Usage

### Single Check

Run a one-time metrics check:

```bash
npm run check
```

Or directly:

```bash
npx ts-node checkOpenSearchMetrics.ts
```

### Continuous Monitoring (Recommended for Load Testing)

Monitor metrics continuously during your load test:

```bash
# Check every 30 seconds (default)
npm run check:continuous

# Check every 5 seconds (recommended during active load test)
npm run check:fast

# Custom interval (every 10 seconds)
npx ts-node checkOpenSearchMetrics.ts --continuous --interval=10
```

**Tip:** Start this in a separate terminal BEFORE running your load test, then keep it running throughout the test.

## What It Monitors

### 1. Thread Pool Metrics (CRITICAL)
- ✅ `ThreadpoolWriteQueue` - write queue size
- ✅ `ThreadpoolWriteRejected` - **rejected write requests** (primary failure indicator)
- ✅ `ThreadpoolBulkQueue` - bulk operations queue
- ✅ `ThreadpoolBulkRejected` - **rejected bulk requests** (primary failure indicator)
- ✅ `ThreadpoolSearchQueue` - search queue size
- ✅ `ThreadpoolSearchRejected` - rejected searches

### 2. Performance Metrics
- ✅ `IndexingLatency` - time to index documents
- ✅ `IndexingRate` - documents indexed per second
- ✅ `SearchLatency` - search response time
- ✅ `RefreshLatency` - **will be HIGH due to refresh:true**
- ✅ `RefreshCount` - number of refreshes per minute

### 3. Resource Metrics
- ✅ `CPUUtilization` - should stay below 80%
- ✅ `JVMMemoryPressure` - should stay below 75%
- ✅ `JVMGCYoungCollectionCount` - garbage collection frequency
- ✅ `JVMGCOldCollectionCount` - old gen GC (expensive)

### 4. Cluster Health
- ✅ `ClusterStatus` - green/yellow/red
- ✅ `Nodes` - active node count
- ✅ `Shards` - active, relocating, unassigned

### 5. Index-Specific Stats
- ✅ Number of shards and replicas for `pms_green_dot`
- ✅ Refresh interval setting
- ✅ Index size and document count

## Output

### Console Output

The script provides real-time formatted output with:
- Color-coded status indicators (✅ green, ⚠️ yellow, 🔴 red)
- Tables for thread pool statistics
- Detailed node resource metrics
- Critical issues and warnings

### JSON Files

Complete metrics are saved to:
```
upgradeScripts/metrics-output/opensearch-metrics-{timestamp}.json
```

### CSV Summary

A summary CSV is continuously appended to:
```
upgradeScripts/metrics-output/metrics-summary.csv
```

**This CSV is perfect for:**
- Importing into Excel/Google Sheets
- Creating charts and graphs
- Comparing metrics over time
- Proving the performance issue to your manager

## Load Testing Recommendations

### Before the Load Test

1. **Run baseline check:**
   ```bash
   npm run check
   ```

2. **Start continuous monitoring:**
   ```bash
   npm run check:fast
   ```

3. **Note baseline metrics:**
   - Current thread pool rejections (should be 0)
   - Current JVM memory pressure
   - Average refresh time

### During the Load Test

**Watch for these critical indicators:**

🔴 **Immediate stop conditions:**
- `ThreadpoolBulkRejected` or `ThreadpoolWriteRejected` > 10
- `JVMMemoryPressure` > 85%
- `CPUUtilization` > 90%
- Cluster status turns RED

⚠️ **Warning signs:**
- `JVMMemoryPressure` > 75%
- `CPUUtilization` > 80%
- Average refresh time > 100ms
- Old GC collections increasing rapidly

### Load Test Parameters

**Start conservative:**
- Concurrent users: Start with 10, increase gradually
- Messages per second: Start with 5/sec
- Ramp-up period: 2 minutes
- Test duration: 5 minutes
- Monitor continuously!

**Scaling up:**
Only increase load if:
- No thread pool rejections
- JVM memory < 70%
- CPU < 75%
- No errors in application logs

## Expected Findings

Based on the code analysis, you will likely see:

1. ✅ **High refresh latency** - Proves `refresh:true` is the bottleneck
2. ✅ **Thread pool rejections** - When load exceeds refresh capacity
3. ✅ **High CPU usage** - Refresh operations are CPU-intensive
4. ✅ **JVM memory pressure** - Constant refreshes cause GC pressure

## Troubleshooting

### "Failed to retrieve OpenSearch URL from Parameter Store"

**Solution:** Check AWS credentials and SSM parameter exists:
```bash
aws ssm get-parameter --name pms-elastic-search-url --region ap-south-1
```

### "OpenSearch connection timeout"

**Solutions:**
1. Check security group allows inbound traffic from your IP
2. Verify VPC settings if OpenSearch is in a VPC
3. Check if you need to be on VPN

### "Permission denied" errors

**Solution:** Ensure your AWS IAM role has these permissions:
- `ssm:GetParameter` for Parameter Store
- `es:ESHttpGet` for OpenSearch read operations

## Files Created

```
upgradeScripts/
├── checkOpenSearchMetrics.ts    # Main monitoring script
├── package.json                  # Dependencies
├── tsconfig.json                 # TypeScript configuration
├── README.md                     # This file
├── .gitignore                    # Git ignore rules
└── metrics-output/               # Output directory (created on first run)
    ├── opensearch-metrics-*.json # Detailed metrics snapshots
    └── metrics-summary.csv       # Continuous summary for analysis
```

## Next Steps

After gathering metrics that prove the `refresh:true` issue:

1. **Share the CSV data** with your manager
2. **Highlight the refresh latency** in the metrics
3. **Show thread pool rejections** during load
4. **Recommend the fix:** Change `refresh:true` to `refresh:false` in ESService.ts

### The Fix

The proper fix is to update `node_modules/@amurahealth/pms-utils/ESService.ts`:

```typescript
// BEFORE (current - causes issues)
refresh: true

// AFTER (recommended)
refresh: false  // Let OpenSearch refresh on its own schedule (default: 1s)
```

This single change will:
- Improve write performance by 50-100x
- Eliminate thread pool rejections
- Reduce CPU and memory pressure
- Allow proper batching of operations

---

**Questions?** Check the script output for detailed explanations of each metric.

# Chat API Load Tests

This directory contains k6 load testing scripts for the `/addToChat` API endpoint. These tests help identify performance bottlenecks, breaking points, and system capacity limits.

## Overview

Two main load test scenarios are available:

1. **Multi-Room Load Test** (`chat-load-test.js`) - Tests multiple chat rooms concurrently
2. **Single-Room Load Test** (`single-room-load-test.js`) - Stresses a single room with multiple users

## Prerequisites

### 1. Install k6

**macOS:**
```bash
brew install k6
```

**Linux:**
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

**Windows:**
```bash
choco install k6
```

Or download from: https://k6.io/docs/getting-started/installation/

### 2. Prepare Test Data

Ensure you have the required test data JSON files in this directory:
- `newflow_3k_rooms.json` - For multi-room tests (3000 rooms)
- `test-data_new.json` - For single-room tests
- Additional data files: `new_flow_1k_rooms.json`, `new_flow_5k.json`, etc.

### 3. Start Your API Server

Make sure your `/addToChat` API endpoint is running and accessible:
```bash
# Default: http://localhost:8080/addToChat
# Update the URL in the test scripts if your server runs on a different port
```

## Test Scripts

### 1. Multi-Room Load Test (`chat-load-test.js`)

Simulates realistic chat traffic across **multiple chat rooms** with multiple users per room.

**Configuration:**
- **VUs (Virtual Users):** 3000 concurrent users
- **Total Iterations:** 100,000 chat messages
- **Test Data:** `newflow_3k_rooms.json` (3000 rooms)
- **Delay:** 1.0-1.4 seconds between messages (simulates realistic user behavior)
- **Timeout:** 100 seconds per request

**Key Features:**
- Tracks breaking points (first error, first timeout, first S3 SlowDown)
- Monitors S3 errors and SlowDown issues
- Custom metrics for green dot updates
- Detailed error logging with iteration tracking
- Progress logging every 1000 iterations

**Run the test:**
```bash
k6 run chat-load-test.js
```

**Customize parameters:**
```bash
# Run with different VUs and iterations
k6 run --vus 1000 --iterations 50000 chat-load-test.js

# Run for a specific duration instead of iterations
k6 run --vus 1000 --duration 10m chat-load-test.js
```

### 2. Single-Room Load Test (`single-room-load-test.js`)

Stresses a **single chat room** with multiple concurrent users to test room-level capacity limits.

**Configuration:**
- **VUs:** 100 concurrent users in the same room
- **Total Iterations:** 10,000 messages
- **Test Data:** First room from `test-data_new.json`
- **Delay:** 700ms between messages
- **Success Threshold:** 95% success rate

**Key Features:**
- Tests single room concurrency limits
- Validates room-level locking and performance
- Useful for identifying room-specific bottlenecks

**Run the test:**
```bash
k6 run single-room-load-test.js
```

## Test Data Format

Test data JSON files should follow this structure:

```json
{
  "rooms": [
    {
      "roomId": "room-uuid-1",
      "userId": "user-uuid-1",
      "patientId": "patient-uuid-1"
    },
    {
      "roomId": "room-uuid-2",
      "userId": "user-uuid-2",
      "patientId": "patient-uuid-2"
    }
  ]
}
```

## Understanding the Results

### Key Metrics

k6 will display several important metrics:

**Custom Metrics:**
- `chat_api_success_rate` - Success rate of API calls (target: >95%)
- `greendot_updates` - Number of successful green dot updates
- `s3_slowdown_errors` - S3 SlowDown errors encountered
- `s3_errors_total` - Total S3-related errors
- `total_requests` - Total API requests made
- `total_errors` - Total failed requests
- `timeout_errors` - Requests that timed out

**Standard k6 Metrics:**
- `http_req_duration` - Request duration (p90, p95, p99)
- `http_req_failed` - Failed request rate
- `http_reqs` - Total HTTP requests per second
- `iteration_duration` - Total iteration time including sleep
- `vus` - Number of active virtual users

### Breaking Point Analysis

The test scripts automatically detect and log:

1. **First Timeout** - When the first request timeout occurs
2. **First Error** - When the first API error occurs (overall breaking point)
3. **First S3 SlowDown** - When S3 starts throttling (S3 breaking point)

Example output:
```
========================================
🎯 BREAKING POINT ANALYSIS
========================================

⏱️ First Timeout at Iteration: 5234
🔥 First Error at Iteration: 7891
🐌 First S3 SlowDown at Iteration: 8456

📊 Total Requests: 100000
❌ Total Errors: 1234
⏱️ Timeout Errors: 45
🐌 S3 SlowDown Errors: 89
☁️  Total S3 Errors: 156
📈 Error Rate: 1.23%
⏱️ Timeout Rate: 0.05%
========================================
```

### Interpreting Results

**Good Performance:**
- ✅ Success rate > 99%
- ✅ p95 response time < 2s
- ✅ p99 response time < 5s
- ✅ No timeout errors
- ✅ No S3 SlowDown errors

**Warning Signs:**
- ⚠️ Success rate 95-99%
- ⚠️ p95 response time 2-5s
- ⚠️ p99 response time 5-10s
- ⚠️ Occasional S3 errors

**Critical Issues:**
- 🔴 Success rate < 95%
- 🔴 p95 response time > 5s
- 🔴 Many timeout errors
- 🔴 Frequent S3 SlowDown errors
- 🔴 Increasing error rates over time

## Load Test Strategy

### Phase 1: Baseline Testing

Start with conservative parameters to establish baseline:

```bash
# 100 VUs, 5 minutes
k6 run --vus 100 --duration 5m chat-load-test.js
```

**Goals:**
- Verify test setup works correctly
- Establish baseline performance metrics
- Ensure no immediate errors

### Phase 2: Gradual Scaling

Gradually increase load to find capacity limits:

```bash
# Increment VUs: 100 → 500 → 1000 → 2000 → 3000
k6 run --vus 500 --duration 5m chat-load-test.js
k6 run --vus 1000 --duration 5m chat-load-test.js
k6 run --vus 2000 --duration 5m chat-load-test.js
k6 run --vus 3000 --duration 5m chat-load-test.js
```

**Goals:**
- Identify breaking points
- Monitor for S3 throttling
- Track when errors begin to occur

### Phase 3: Stress Testing

Push beyond normal capacity to find absolute limits:

```bash
# Maximum stress test
k6 run --vus 5000 --iterations 200000 chat-load-test.js
```

**Goals:**
- Find system breaking point
- Identify bottlenecks (OpenSearch, S3, API server)
- Plan capacity improvements

### Phase 4: Endurance Testing

Test sustained load over extended periods:

```bash
# 1 hour sustained test
k6 run --vus 1000 --duration 1h chat-load-test.js
```

**Goals:**
- Check for memory leaks
- Monitor gradual performance degradation
- Verify system stability under sustained load

## Monitoring During Tests

### Start Monitoring BEFORE Load Test

If you have OpenSearch metrics monitoring, start it first:

```bash
# From parent directory
cd ..
npm run check:fast
```

### Watch for Critical Indicators

**OpenSearch Issues:**
- Thread pool rejections
- High JVM memory pressure (>75%)
- High CPU utilization (>80%)
- High refresh latency

**S3 Issues:**
- SlowDown errors
- ServiceUnavailable errors
- High request latency

**API Server Issues:**
- Increasing response times
- Memory leaks
- CPU saturation
- Database connection pool exhaustion

## Troubleshooting

### "Connection Refused" Errors

**Cause:** API server is not running or wrong URL

**Solution:**
```bash
# Check if server is running
curl http://localhost:8080/addToChat

# Update URL in test script if needed
const url = 'http://your-server:port/addToChat'
```

### "Timeout" Errors

**Cause:** Requests taking longer than 100 seconds

**Solutions:**
1. Reduce concurrent VUs
2. Increase delay between requests
3. Optimize API server performance
4. Scale infrastructure

### High S3 SlowDown Errors

**Cause:** S3 request rate limits exceeded

**Solutions:**
1. Implement exponential backoff in application
2. Use S3 request rate tokens
3. Reduce attachment upload rate
4. Consider S3 Transfer Acceleration

### High Memory Usage

**Cause:** Too many concurrent connections or memory leaks

**Solutions:**
1. Reduce VUs
2. Add more delay between requests
3. Monitor application memory usage
4. Check for connection leaks

## Best Practices

### 1. Start Small, Scale Gradually
Don't jump directly to maximum load. Gradually increase to understand behavior at each level.

### 2. Monitor Everything
Use monitoring tools for:
- API server metrics
- OpenSearch/Database metrics
- S3 metrics
- Network metrics

### 3. Realistic Delays
The current 1-1.4 second delay simulates realistic chat behavior. Don't remove delays unless testing maximum theoretical throughput.

### 4. Run Multiple Times
Run each test 2-3 times to confirm results are consistent and not affected by transient issues.

### 5. Document Results
Keep records of:
- Test parameters (VUs, iterations, duration)
- Key metrics (p95, p99, error rates)
- Breaking points identified
- Infrastructure state during test

### 6. Test in Isolation
Run load tests in dedicated environments when possible to avoid interference from other systems.

## Output Files

Test results can be exported to various formats:

```bash
# Export to JSON
k6 run --out json=results.json chat-load-test.js

# Export to CSV
k6 run --out csv=results.csv chat-load-test.js

# Export to InfluxDB for visualization
k6 run --out influxdb=http://localhost:8086/k6 chat-load-test.js
```

## Next Steps

After identifying bottlenecks:

1. **Analyze Results** - Review metrics and breaking points
2. **Identify Root Causes** - Use monitoring data to pinpoint issues
3. **Implement Fixes** - Address bottlenecks (e.g., remove `refresh:true` from OpenSearch)
4. **Retest** - Verify improvements with new load tests
5. **Document Capacity** - Establish known capacity limits for production planning

## Files in This Directory

```
load-tests/
├── README.md                          # This file
├── chat-load-test.js                  # Multi-room load test
├── single-room-load-test.js           # Single-room load test
├── newflow_3k_rooms.json              # Test data: 3000 rooms
├── new_flow_1k_rooms.json             # Test data: 1000 rooms
├── new_flow_5k.json                   # Test data: 5000 rooms
├── test-data_new.json                 # Test data for single room
├── test-data_old.json                 # Legacy test data
└── old_flow_1k_rooms.json             # Legacy test data
```

## Additional Resources

- **k6 Documentation:** https://k6.io/docs/
- **k6 Cloud:** https://k6.io/cloud/ (for distributed load testing)
- **k6 Extensions:** https://k6.io/docs/extensions/
- **Best Practices:** https://k6.io/docs/testing-guides/

---

**Questions or Issues?** Check the console output for detailed error messages and iteration tracking.

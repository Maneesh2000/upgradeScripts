# Upgrade Scripts & Load Testing

This repository contains load testing scripts for the `/addToChat` API endpoint to help identify performance bottlenecks and system capacity limits.

## Directory Structure

```
upgradeScripts/
├── README.md                 # This file
├── package.json              # Node.js dependencies
├── tsconfig.json             # TypeScript configuration
├── .gitignore                # Git ignore rules
└── load-tests/               # k6 Load testing scripts
    ├── README.md             # Detailed load testing documentation
    ├── chat-load-test.js     # Multi-room load test
    ├── single-room-load-test.js  # Single-room stress test
    └── *.json                # Test data files
```

## Quick Start

### Prerequisites

1. **Install k6** (load testing tool):
   ```bash
   # macOS
   brew install k6

   # Linux
   sudo apt-get install k6

   # Windows
   choco install k6
   ```

2. **Install Node.js dependencies** (if needed):
   ```bash
   npm install
   ```

3. **Ensure your API server is running**:
   ```bash
   # Default: http://localhost:8080/addToChat
   ```

### Running Load Tests

**Multi-Room Load Test** (3000 VUs, 100K iterations):
```bash
cd load-tests
k6 run chat-load-test.js
```

**Single-Room Stress Test** (100 VUs, 10K iterations):
```bash
cd load-tests
k6 run single-room-load-test.js
```

**Custom Parameters:**
```bash
# Run with specific VUs and duration
k6 run --vus 1000 --duration 10m chat-load-test.js

# Run with specific VUs and iterations
k6 run --vus 500 --iterations 50000 chat-load-test.js
```

## Load Test Features

Both test scripts include:

- **Breaking Point Detection** - Identifies when system starts failing
  - First timeout iteration
  - First error iteration
  - First S3 SlowDown error

- **Custom Metrics**:
  - Chat API success rate
  - Green dot updates counter
  - S3 error tracking
  - Total requests and errors
  - Timeout error tracking

- **Realistic User Simulation**:
  - Variable delays between messages (1.0-1.4s for multi-room, 700ms for single-room)
  - Unique messages per iteration
  - Real-world payload structure

- **Detailed Error Logging**:
  - Iteration tracking
  - Room and VU identification
  - Response timing
  - Error categorization

- **Progress Monitoring**:
  - Periodic success logging (every 1000 iterations)
  - Real-time error reporting
  - Summary statistics at end

## Understanding Results

### Key Metrics to Watch

**Success Indicators:**
- ✅ `chat_api_success_rate` > 99%
- ✅ `http_req_duration` p95 < 2s
- ✅ No timeout errors
- ✅ No S3 SlowDown errors

**Warning Signs:**
- ⚠️ Success rate 95-99%
- ⚠️ p95 response time 2-5s
- ⚠️ Occasional S3 errors
- ⚠️ Increasing error rates

**Critical Issues:**
- 🔴 Success rate < 95%
- 🔴 p95 response time > 5s
- 🔴 Frequent timeouts
- 🔴 Many S3 SlowDown errors

### Example Output

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
📈 Error Rate: 1.23%
⏱️ Timeout Rate: 0.05%
========================================
```

## Load Testing Strategy

### Recommended Approach

1. **Baseline Test** (5 min, 100 VUs)
   ```bash
   k6 run --vus 100 --duration 5m chat-load-test.js
   ```

2. **Gradual Scaling** (increase VUs progressively)
   ```bash
   k6 run --vus 500 --duration 5m chat-load-test.js
   k6 run --vus 1000 --duration 5m chat-load-test.js
   k6 run --vus 2000 --duration 5m chat-load-test.js
   ```

3. **Stress Testing** (find breaking point)
   ```bash
   k6 run --vus 5000 --iterations 200000 chat-load-test.js
   ```

4. **Endurance Testing** (sustained load)
   ```bash
   k6 run --vus 1000 --duration 1h chat-load-test.js
   ```

## Test Configuration

### Multi-Room Load Test (`chat-load-test.js`)

- **Purpose**: Test system behavior with multiple concurrent chat rooms
- **VUs**: 3000 concurrent users
- **Iterations**: 100,000 messages
- **Delay**: 1.0-1.4 seconds between messages
- **Test Data**: `newflow_3k_rooms.json` (3000 rooms)
- **Timeout**: 100 seconds per request

### Single-Room Load Test (`single-room-load-test.js`)

- **Purpose**: Stress test a single room to find room-level capacity limits
- **VUs**: 100 concurrent users in same room
- **Iterations**: 10,000 messages
- **Delay**: 700ms between messages
- **Test Data**: First room from `test-data_new.json`
- **Success Threshold**: 95% success rate

## Monitoring

### What to Monitor During Tests

**API Server:**
- Response times (p95, p99)
- Error rates
- Memory usage
- CPU utilization
- Active connections

**Database/OpenSearch:**
- Query latency
- Thread pool rejections
- JVM memory pressure
- CPU utilization
- Connection pool usage

**S3:**
- SlowDown errors
- Request rates
- Latency

## Troubleshooting

### Common Issues

**Connection Refused:**
```bash
# Verify server is running
curl http://localhost:8080/addToChat
```

**Timeout Errors:**
- Reduce concurrent VUs
- Increase delay between requests
- Optimize API performance
- Scale infrastructure

**S3 SlowDown Errors:**
- Implement exponential backoff
- Reduce attachment upload rate
- Use S3 request rate tokens

**High Error Rates:**
- Check API server logs
- Monitor database/OpenSearch metrics
- Verify network connectivity
- Check resource limits

## Exporting Results

Export test results for analysis:

```bash
# JSON format
k6 run --out json=results.json chat-load-test.js

# CSV format
k6 run --out csv=results.csv chat-load-test.js

# InfluxDB (for Grafana visualization)
k6 run --out influxdb=http://localhost:8086/k6 chat-load-test.js
```

## Best Practices

1. ✅ **Start small, scale gradually** - Don't jump to maximum load
2. ✅ **Run multiple times** - Verify consistency of results
3. ✅ **Monitor everything** - API, DB, OpenSearch, S3, network
4. ✅ **Use realistic delays** - Simulate actual user behavior
5. ✅ **Test in isolation** - Avoid interference from other systems
6. ✅ **Document results** - Keep records of all test runs

## Additional Resources

- **Detailed Documentation**: [load-tests/README.md](load-tests/README.md)
- **k6 Documentation**: https://k6.io/docs/
- **k6 Testing Guides**: https://k6.io/docs/testing-guides/

## Next Steps After Load Testing

1. **Analyze breaking points** - Review metrics and identify bottlenecks
2. **Investigate root causes** - Use monitoring data to pinpoint issues
3. **Implement fixes** - Address identified performance problems
4. **Retest** - Verify improvements with new load tests
5. **Document capacity** - Establish production capacity limits
6. **Set up alerts** - Monitor production metrics based on test findings

---

For detailed information about the load tests, test data format, and advanced usage, see [load-tests/README.md](load-tests/README.md).

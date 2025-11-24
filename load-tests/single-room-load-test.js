import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter, Trend, Rate } from 'k6/metrics'
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js'

const chatApiSuccess = new Rate('chat_api_success_rate')
const greendotUpdates = new Counter('greendot_updates')
const s3SlowDownErrors = new Counter('s3_slowdown_errors')
const s3Errors = new Counter('s3_errors_total')
const totalRequests = new Counter('total_requests')
const totalErrors = new Counter('total_errors')
const timeoutErrors = new Counter('timeout_errors')

// Load test data from JSON file
const testData = JSON.parse(open('./test-data_new.json'))
const ROOMS_DATA = testData.rooms

// Use only the FIRST room for this test
const SINGLE_ROOM = ROOMS_DATA[0]

// Global tracking for breaking point detection
let firstErrorIteration = null
let firstS3SlowDownIteration = null
let firstTimeoutIteration = null

export const options = {
  // Single room load test with controlled throughput
  // Multiple VUs sending messages to the SAME room with 700ms delay
  vus: 100, // 100 concurrent users in the same room
  iterations: 10000,
  // Additional output options
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max'],

  // Thresholds to define breaking points
  thresholds: {
    'chat_api_success_rate': ['rate>0.95'], // 95% success rate
  },
}

export default function () {
  const url = 'http://localhost:8080/addToChat'

  // Generate unique message for each iteration
  const timestamp = Date.now()
  const vuId = __VU
  const iterationId = __ITER

  // ALL VUs use the SAME room
  const payload = JSON.stringify({
    payLoad: {
      roomId: SINGLE_ROOM.roomId,
      userId: SINGLE_ROOM.userId,
      patientId: SINGLE_ROOM.patientId,
      EventName: 'chat-categorizer',
      tenantId: 'amura',
      senderId: SINGLE_ROOM.userId,
      message: `k6 Single Room Load Test - VU:${vuId} Iter:${iterationId} Time:${timestamp}`,
      isAttachment: false,
      attachmentFileSize: 0,
      isVoiceNote: false,
      ContextType: '@NOTES',
      loginUserId: SINGLE_ROOM.userId,
      delivered: true,
      isReply: false,
      repliedMessage: {},
      isStar: false,
      Locale: 'en_US',
    },
  })

  const params = {
    headers: {
      'Content-Type': 'application/json',
    },
    tags: {
      name: 'AddToChat_SingleRoom',
      roomId: SINGLE_ROOM.roomId,
    },
    timeout: '100s',
  }

  // Execute request
  const response = http.post(url, payload, params)

  // Track total requests
  totalRequests.add(1)

  // Check for timeout (status code 0 means request timeout in k6)
  const isTimeout = response.status === 0 || response.error_code === 1050

  // Track success rate (use the actual status code check)
  const isSuccess = response.status === 200 || response.status === 201
  chatApiSuccess.add(isSuccess)

  // Track green dot updates (if API returns this info)
  if (response.status === 200 || response.status === 201) {
    greendotUpdates.add(1)
  }

  // Track timeout errors specifically
  if (isTimeout) {
    timeoutErrors.add(1)
    totalErrors.add(1)

    // Capture first timeout iteration
    if (firstTimeoutIteration === null) {
      firstTimeoutIteration = iterationId
      console.error(`⏱️ FIRST TIMEOUT at Iteration: ${iterationId}, VU: ${vuId}, Time: ${new Date().toISOString()}, Error: ${response.error || 'Request timeout'}`)
    } else {
      console.error(`⏱️ Timeout: VU ${vuId}, Iter ${iterationId}, Duration: ${response.timings.duration?.toFixed(2) || 'N/A'}ms`)
    }
  }

  // Track errors and breaking points
  if (!isSuccess && !isTimeout) {
    totalErrors.add(1)

    // Capture first error iteration (breaking point)
    if (firstErrorIteration === null) {
      firstErrorIteration = iterationId
      console.error(`🔥 FIRST ERROR DETECTED at Iteration: ${iterationId}, VU: ${vuId}, Time: ${new Date().toISOString()}`)
    }
  }

  // Track S3 errors
  if (response.body && response.body.includes('SlowDown')) {
    s3SlowDownErrors.add(1)
    s3Errors.add(1)

    // Capture first S3 SlowDown (S3 breaking point)
    if (firstS3SlowDownIteration === null) {
      firstS3SlowDownIteration = iterationId
      console.error(`🐌 FIRST S3 SlowDown at Iteration: ${iterationId}, VU: ${vuId}, Time: ${new Date().toISOString()}`)
    } else {
      console.error(`🐌 S3 SlowDown: VU ${vuId}, Iter ${iterationId}, Status ${response.status}`)
    }
  } else if (response.body && (
    response.body.includes('S3') ||
    response.body.includes('ServiceUnavailable') ||
    response.body.includes('InternalError')
  )) {
    s3Errors.add(1)
    console.error(`☁️ S3 Error: VU ${vuId}, Iter ${iterationId}, Status ${response.status}, Body: ${response.body.substring(0, 200)}`)
  }

  // Log errors for debugging with iteration tracking
  if (response.status >= 400) {
    console.error(`❌ Request failed: VU ${vuId}, Iter ${iterationId}, Status ${response.status}, Duration: ${response.timings.duration.toFixed(2)}ms, Body: ${response.body.substring(0, 200)}`)
  }

  // Log successful requests periodically for monitoring
  if (isSuccess && iterationId % 100 === 0) {
    console.log(`✅ Progress: Iteration ${iterationId}, VU ${vuId}, Duration: ${response.timings.duration.toFixed(2)}ms`)
  }

  // CRITICAL: Sleep for 700 milliseconds between requests
  sleep(0.7) // 700ms = 0.7 seconds
}

// Custom summary handler
export function handleSummary(data) {
  let customSummary = '\n========================================\n'
  customSummary += '🎯 SINGLE ROOM LOAD TEST RESULTS\n'
  customSummary += '========================================\n\n'
  customSummary += `📍 Room ID: ${SINGLE_ROOM.roomId}\n`
  customSummary += `👤 User ID: ${SINGLE_ROOM.userId}\n`
  customSummary += `🏥 Patient ID: ${SINGLE_ROOM.patientId}\n`
  customSummary += `⏱️  Request Delay: 700ms\n\n`

  customSummary += '========================================\n'
  customSummary += '🎯 BREAKING POINT ANALYSIS\n'
  customSummary += '========================================\n\n'

  // Show first timeout iteration
  if (firstTimeoutIteration !== null) {
    customSummary += `⏱️ First Timeout at Iteration: ${firstTimeoutIteration}\n`
  } else {
    customSummary += `✅ No timeouts detected\n`
  }

  // Show first error iteration (overall breaking point)
  if (firstErrorIteration !== null) {
    customSummary += `🔥 First Error at Iteration: ${firstErrorIteration}\n`
  } else {
    customSummary += `✅ No errors detected - System held up!\n`
  }

  // Show first S3 SlowDown iteration (S3 breaking point)
  if (firstS3SlowDownIteration !== null) {
    customSummary += `🐌 First S3 SlowDown at Iteration: ${firstS3SlowDownIteration}\n`
  } else {
    customSummary += `✅ No S3 SlowDown errors\n`
  }

  customSummary += '\n'
  customSummary += `📊 Total Requests: ${data.metrics.total_requests?.values?.count || 0}\n`
  customSummary += `❌ Total Errors: ${data.metrics.total_errors?.values?.count || 0}\n`
  customSummary += `⏱️ Timeout Errors: ${data.metrics.timeout_errors?.values?.count || 0}\n`
  customSummary += `🐌 S3 SlowDown Errors: ${data.metrics.s3_slowdown_errors?.values?.count || 0}\n`
  customSummary += `☁️  Total S3 Errors: ${data.metrics.s3_errors_total?.values?.count || 0}\n`

  const totalReqs = data.metrics.total_requests?.values?.count || 0
  const totalErrs = data.metrics.total_errors?.values?.count || 0
  const timeoutCount = data.metrics.timeout_errors?.values?.count || 0

  const errorRate = totalReqs > 0 ? (totalErrs / totalReqs * 100) : 0
  const timeoutRate = totalReqs > 0 ? (timeoutCount / totalReqs * 100) : 0
  const successRate = data.metrics.chat_api_success_rate?.values?.rate * 100 || 0

  customSummary += `\n📈 Success Rate: ${successRate.toFixed(2)}%\n`
  customSummary += `📈 Error Rate: ${errorRate.toFixed(2)}%\n`
  customSummary += `⏱️ Timeout Rate: ${timeoutRate.toFixed(2)}%\n`

  // Calculate throughput
  const duration = data.state.testRunDurationMs / 1000 // in seconds
  const throughput = totalReqs / duration
  customSummary += `\n🚀 Average Throughput: ${throughput.toFixed(2)} requests/sec\n`
  customSummary += `⏱️  Expected Throughput: ${(10 / 0.7).toFixed(2)} requests/sec (10 VUs × 1/0.7s)\n`

  customSummary += '\n========================================\n\n'

  return {
    'stdout': customSummary + textSummary(data, { indent: ' ', enableColors: true }),
    './single-room-load-test-summary.json': JSON.stringify(data, null, 2),
  }
}

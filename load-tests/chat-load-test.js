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
const testData = JSON.parse(open('./newflow_3k_rooms.json'))
const ROOMS_DATA = testData.rooms

// Global tracking for breaking point detection
let firstErrorIteration = null
let firstS3SlowDownIteration = null
let firstTimeoutIteration = null

export const options = {
  // 100 rooms × 10 VUs per room = 1000 total VUs
  // Each VU sends 10 messages = 10,000 total iterations
  vus: 50000,
  iterations: 50000,

  // Additional output options
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max'],

}

export default function () {
  const url = 'http://localhost:8080/addToChat'

  // Generate unique message for each iteration
  const timestamp = Date.now()
  const vuId = __VU
  const iterationId = __ITER

  // Assign each VU to a specific room (10 VUs per room)
  // VU 1-10 → Room 0, VU 11-20 → Room 1, etc.
  const roomIndex = (vuId - 1) % ROOMS_DATA.length
  const selectedRoom = ROOMS_DATA[roomIndex]

  const payload = JSON.stringify({
    payLoad: {
      roomId: selectedRoom.roomId,
      userId: selectedRoom.userId,
      patientId: selectedRoom.patientId,
      EventName: 'chat-categorizer',
      tenantId: 'amura',
      senderId: selectedRoom.userId,
      message: `k6 Load Test - Room:${roomIndex} VU:${vuId} Iter:${iterationId} Time:${timestamp}`,
      isAttachment: false,
      attachmentFileSize: 0,
      isVoiceNote: false,
      ContextType: '@NOTES',
      loginUserId: selectedRoom.userId,
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
      name: 'AddToChat',
      test_phase: getCurrentPhase(__ITER),
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
      console.error(`⏱️ FIRST TIMEOUT at Iteration: ${iterationId}, VU: ${vuId}, Room: ${roomIndex}, Time: ${new Date().toISOString()}, Error: ${response.error || 'Request timeout'}`)
    } else {
      console.error(`⏱️ Timeout: VU ${vuId}, Room ${roomIndex}, Iter ${iterationId}, Duration: ${response.timings.duration?.toFixed(2) || 'N/A'}ms`)
    }
  }

  // Track errors and breaking points
  if (!isSuccess && !isTimeout) {
    totalErrors.add(1)

    // Capture first error iteration (breaking point)
    if (firstErrorIteration === null) {
      firstErrorIteration = iterationId
      console.error(`🔥 FIRST ERROR DETECTED at Iteration: ${iterationId}, VU: ${vuId}, Room: ${roomIndex}, Time: ${new Date().toISOString()}`)
    }
  }

  // Track S3 errors
  if (response.body && response.body.includes('SlowDown')) {
    s3SlowDownErrors.add(1)
    s3Errors.add(1)

    // Capture first S3 SlowDown (S3 breaking point)
    if (firstS3SlowDownIteration === null) {
      firstS3SlowDownIteration = iterationId
      console.error(`🐌 FIRST S3 SlowDown at Iteration: ${iterationId}, VU: ${vuId}, Room: ${roomIndex}, Time: ${new Date().toISOString()}`)
    } else {
      console.error(`🐌 S3 SlowDown: VU ${vuId}, Room ${roomIndex}, Iter ${iterationId}, Status ${response.status}`)
    }
  } else if (response.body && (
    response.body.includes('S3') ||
    response.body.includes('ServiceUnavailable') ||
    response.body.includes('InternalError')
  )) {
    s3Errors.add(1)
    console.error(`☁️ S3 Error: VU ${vuId}, Room ${roomIndex}, Iter ${iterationId}, Status ${response.status}, Body: ${response.body.substring(0, 200)}`)
  }

  // Log errors for debugging with iteration tracking
  if (response.status >= 400) {
    console.error(`❌ Request failed: VU ${vuId}, Room ${roomIndex}, Iter ${iterationId}, Status ${response.status}, Duration: ${response.timings.duration.toFixed(2)}ms, Body: ${response.body.substring(0, 200)}`)
  }

  // Log successful requests periodically for monitoring
  if (isSuccess && iterationId % 1000 === 0) {
    console.log(`✅ Progress: Iteration ${iterationId}, VU ${vuId}, Room ${roomIndex}, Duration: ${response.timings.duration.toFixed(2)}ms`)
  }

  // Add delay between requests to simulate real user behavior
  sleep(getSleepTime(__ITER))

}

// Helper function to determine current test phase
function getCurrentPhase(iteration) {
  // Simplified - you can make this more sophisticated
  if (iteration < 100) return 'warmup'
  if (iteration < 500) return 'rampup'
  if (iteration < 1000) return 'steady'
  return 'spike'
}

// Helper function to vary sleep time
function getSleepTime(iteration) {
  // Add some randomness to simulate real user behavior
  const baseTime = 1
  const randomness = Math.random() * 0.4 // 0 to 0.4 seconds
  return baseTime + randomness
}

// Custom summary handler
export function handleSummary(data) {
  let customSummary = '\n========================================\n'
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

  const errorRate = data.metrics.total_errors?.values?.count / data.metrics.total_requests?.values?.count * 100 || 0
  const timeoutRate = data.metrics.timeout_errors?.values?.count / data.metrics.total_requests?.values?.count * 100 || 0
  customSummary += `📈 Error Rate: ${errorRate.toFixed(2)}%\n`
  customSummary += `⏱️ Timeout Rate: ${timeoutRate.toFixed(2)}%\n`

  customSummary += '\n========================================\n\n'

  return {
    'stdout': customSummary + textSummary(data, { indent: ' ', enableColors: true }),
  }
}

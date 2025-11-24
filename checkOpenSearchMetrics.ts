// upgradeScripts/checkOpenSearchMetrics.ts

import { Client } from '@opensearch-project/opensearch';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import * as fs from 'fs';
import * as path from 'path';

interface MetricsResult {
  timestamp: string;
  clusterHealth: any;
  threadPoolStats: any;
  nodeStats: any;
  indexStats: any;
  indexStatsUserRooms: any;
  clusterStats: any;
  pendingTasks: any;
  activeTasks: any;
  circuitBreakerStatus: any;
  cacheMetrics: any;
  segmentStats: any;
  segmentStatsUserRooms: any;
  hotThreads: any;
  queueMetrics: any;
  summary: {
    critical_issues: string[];
    warnings: string[];
    health_status: string;
    active_searches: number;
    long_running_queries_5s: number;
    long_running_queries_10s: number;
    long_running_queries_30s: number;
    circuit_breaker_trips: number;
    search_queue_saturation_pct: number;
  };
}

class OpenSearchMetricsChecker {
  private ssmClient: SSMClient;                                                           
  private opensearchClient?: Client;

  constructor() {
    this.ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'ap-south-1' });
  }

  async initializeOpenSearchClient(): Promise<Client> {
    try {
      const getParameterCommand = new GetParameterCommand({
        Name: 'pms-elastic-search-url',
        WithDecryption: true
      });

      const parameterResponse = await this.ssmClient.send(getParameterCommand);
      const host = parameterResponse.Parameter?.Value;

      if (!host) {
        throw new Error('Failed to retrieve OpenSearch URL from Parameter Store');
      }

      const credentialsProvider = fromNodeProviderChain();

      this.opensearchClient = new Client({
        ...AwsSigv4Signer({
          region: process.env.AWS_REGION || 'ap-south-1',
          service: 'es',
          getCredentials: async () => {
            const credentials = await credentialsProvider();
            return credentials;
          }
        }),
        node: host
      });

      console.log('OpenSearch client initialized successfully');
      console.log(`Connected to: ${host}\n`);
      return this.opensearchClient;
    } catch (error) {
      console.error('Error initializing OpenSearch client:', error);
      throw error;
    }
  }

  async checkClusterHealth() {
    console.log('='.repeat(80));
    console.log('CLUSTER HEALTH');
    console.log('='.repeat(80));

    const health = await this.opensearchClient!.cluster.health({
      level: 'indices'
    });

    console.log(`Status: ${health.body.status.toUpperCase()} ${this.getStatusEmoji(health.body.status)}`);
    console.log(`Active Nodes: ${health.body.number_of_nodes}`);
    console.log(`Active Data Nodes: ${health.body.number_of_data_nodes}`);
    console.log(`Active Shards: ${health.body.active_shards}`);
    console.log(`Relocating Shards: ${health.body.relocating_shards}`);
    console.log(`Initializing Shards: ${health.body.initializing_shards}`);
    console.log(`Unassigned Shards: ${health.body.unassigned_shards}`);
    console.log(`Delayed Unassigned Shards: ${health.body.delayed_unassigned_shards}`);
    console.log(`Pending Tasks: ${health.body.number_of_pending_tasks}`);
    console.log(`In Flight Fetch: ${health.body.number_of_in_flight_fetch}`);
    console.log(`Task Max Wait Time: ${health.body.task_max_waiting_in_queue_millis}ms\n`);

    return health.body;
  }

  async checkThreadPools() {
    console.log('='.repeat(80));
    console.log('THREAD POOL METRICS (CRITICAL)');
    console.log('='.repeat(80));

    const stats = await this.opensearchClient!.cat.threadPool({
      format: 'json',
      h: 'node_name,name,active,queue,rejected,largest,completed,size,queue_size',
      v: true
    });

    const pools = ['write', 'bulk', 'search', 'get', 'index', 'refresh'];
    const poolData = stats.body.filter((p: any) => pools.includes(p.name));

    console.log('\nCRITICAL POOLS:');
    console.table(poolData.map((p: any) => ({
      'Pool': p.name,
      'Active': p.active,
      'Queue': p.queue,
      'Rejected': p.rejected + (parseInt(p.rejected) > 0 ? ' ⚠️' : ''),
      'Queue Size': p.queue_size,
      'Completed': p.completed,
      'Largest': p.largest
    })));

    const rejections = poolData.filter((p: any) => parseInt(p.rejected) > 0);
    if (rejections.length > 0) {
      console.log('\n⚠️  REJECTIONS DETECTED:');
      rejections.forEach((p: any) => {
        console.log(`   - ${p.name}: ${p.rejected} rejected operations`);
      });
    }

    return poolData;
  }

  async checkNodeStats() {
    console.log('\n' + '='.repeat(80));
    console.log('NODE RESOURCE METRICS');
    console.log('='.repeat(80));

    const stats = await this.opensearchClient!.nodes.stats({
      metric: ['jvm', 'os', 'indices', 'thread_pool']
    });

    const nodes = Object.values(stats.body.nodes) as any[];

    nodes.forEach((node: any) => {
      console.log(`\nNode: ${node.name}`);
      console.log('-'.repeat(80));

      // JVM Memory
      const heapUsedPercent = node.jvm.mem.heap_used_percent;
      const heapWarning = heapUsedPercent > 75 ? ' ⚠️ HIGH' : heapUsedPercent > 85 ? ' 🔴 CRITICAL' : '';
      console.log(`JVM Memory Pressure: ${heapUsedPercent}%${heapWarning}`);
      console.log(`  Heap Used: ${this.formatBytes(node.jvm.mem.heap_used_in_bytes)} / ${this.formatBytes(node.jvm.mem.heap_max_in_bytes)}`);

      // GC Stats
      const youngGC = node.jvm.gc.collectors.young;
      const oldGC = node.jvm.gc.collectors.old;
      console.log(`\nGarbage Collection:`);
      console.log(`  Young GC Count: ${youngGC.collection_count} (Time: ${youngGC.collection_time_in_millis}ms)`);
      console.log(`  Old GC Count: ${oldGC.collection_count} (Time: ${oldGC.collection_time_in_millis}ms)${oldGC.collection_count > 10 ? ' ⚠️' : ''}`);

      // CPU
      const cpuPercent = node.os.cpu.percent;
      const cpuWarning = cpuPercent > 80 ? ' ⚠️ HIGH' : cpuPercent > 90 ? ' 🔴 CRITICAL' : '';
      console.log(`\nCPU Utilization: ${cpuPercent}%${cpuWarning}`);
      console.log(`  Load Average: ${node.os.cpu.load_average?.['1m']?.toFixed(2) || 'N/A'}`);

      // Thread Pool Rejections (detailed)
      console.log(`\nThread Pool Rejections:`);
      const threadPools = node.thread_pool;
      Object.keys(threadPools).forEach(poolName => {
        const pool = threadPools[poolName];
        if (pool.rejected && pool.rejected > 0) {
          console.log(`  ${poolName}: ${pool.rejected} rejected ⚠️`);
        }
      });

      // Check if no rejections
      const hasRejections = Object.values(threadPools).some((p: any) => p.rejected > 0);
      if (!hasRejections) {
        console.log(`  ✓ No rejections`);
      }
    });

    return nodes;
  }

  async checkIndexStats(indexName: string = 'pms_green_dot') {
    console.log('\n' + '='.repeat(80));
    console.log(`INDEX PERFORMANCE METRICS - ${indexName}`);
    console.log('='.repeat(80));

    try {
      const stats = await this.opensearchClient!.indices.stats({
        index: indexName,
        metric: ['indexing', 'search', 'refresh', 'flush', 'merge']
      });

      const indexData = stats.body.indices[indexName];
      if (!indexData) {
        console.log('Index not found or no data available');
        return null;
      }

      const total = indexData.total;

      // Indexing Performance
      console.log('\nIndexing Metrics:');
      console.log(`  Total Indexed: ${total.indexing.index_total.toLocaleString()} documents`);
      console.log(`  Index Time: ${this.formatMs(total.indexing.index_time_in_millis)}`);
      console.log(`  Indexing Rate: ${(total.indexing.index_total / (total.indexing.index_time_in_millis / 1000)).toFixed(2)} docs/sec`);
      console.log(`  Current Indexing: ${total.indexing.index_current} operations`);
      console.log(`  Failed: ${total.indexing.index_failed}`);

      // Refresh Metrics (CRITICAL FOR YOUR ISSUE)
      console.log('\n🔴 Refresh Metrics (CRITICAL):');
      console.log(`  Total Refreshes: ${total.refresh.total.toLocaleString()}`);
      console.log(`  Refresh Time: ${this.formatMs(total.refresh.total_time_in_millis)}`);
      const avgRefreshTime = total.refresh.total > 0 ? (total.refresh.total_time_in_millis / total.refresh.total).toFixed(2) : '0';
      const refreshWarning = parseFloat(avgRefreshTime) > 100 ? ' ⚠️ HIGH LATENCY' : '';
      console.log(`  Avg Refresh Time: ${avgRefreshTime}ms${refreshWarning}`);

      // Calculate refresh rate
      const refreshRate = total.refresh.total > 0 ? (60000 / (total.refresh.total_time_in_millis / total.refresh.total)).toFixed(2) : 0;
      console.log(`  Estimated Refresh Capacity: ${refreshRate} refreshes/min`);

      // Search Performance
      console.log('\nSearch Metrics:');
      console.log(`  Total Searches: ${total.search.query_total.toLocaleString()}`);
      console.log(`  Search Time: ${this.formatMs(total.search.query_time_in_millis)}`);
      const avgSearchTime = total.search.query_total > 0 ? (total.search.query_time_in_millis / total.search.query_total).toFixed(2) : 0;
      console.log(`  Avg Search Time: ${avgSearchTime}ms`);
      console.log(`  Current Searches: ${total.search.query_current}`);

      // Merge Stats
      console.log('\nMerge Metrics:');
      console.log(`  Total Merges: ${total.merges.total.toLocaleString()}`);
      console.log(`  Merge Time: ${this.formatMs(total.merges.total_time_in_millis)}`);
      console.log(`  Current Merges: ${total.merges.current}`);

      // Store Size
      console.log('\nStorage:');
      if (total.store?.size_in_bytes) {
        console.log(`  Total Size: ${this.formatBytes(total.store.size_in_bytes)}`);
      } else {
        console.log(`  Total Size: N/A`);
      }

      return total;
    } catch (error: any) {
      console.log(`Error fetching index stats for ${indexName}: ${error.message}`);
      return null;
    }
  }

  async checkIndexSettings(indexName: string = 'pms_green_dot') {
    console.log('\n' + '='.repeat(80));
    console.log(`INDEX SETTINGS - ${indexName}`);
    console.log('='.repeat(80));

    try {
      const settings = await this.opensearchClient!.indices.getSettings({
        index: indexName
      });

      const indexSettings = settings.body[indexName]?.settings?.index;

      if (indexSettings) {
        console.log(`\nNumber of Shards: ${indexSettings.number_of_shards}`);
        console.log(`Number of Replicas: ${indexSettings.number_of_replicas}`);
        console.log(`Refresh Interval: ${indexSettings.refresh_interval || 'default (1s)'}`);
        console.log(`Auto Expand Replicas: ${indexSettings.auto_expand_replicas || 'false'}`);

        if (indexSettings.refresh_interval === '-1') {
          console.log('⚠️  Refresh is DISABLED');
        }
      }

      return indexSettings;
    } catch (error: any) {
      console.log(`Error fetching index settings for ${indexName}: ${error.message}`);
      return null;
    }
  }

  async checkClusterSettings() {
    console.log('\n' + '='.repeat(80));
    console.log('CLUSTER SETTINGS');
    console.log('='.repeat(80));

    const settings = await this.opensearchClient!.cluster.getSettings({
      include_defaults: true,
      flat_settings: true
    });

    const persistent = settings.body.persistent;
    const defaults = settings.body.defaults;

    // Circuit Breaker Settings
    console.log('\nCircuit Breaker Limits:');
    const cbSettings = Object.keys(defaults).filter(k => k.startsWith('indices.breaker'));
    cbSettings.forEach(key => {
      const value = persistent[key] || defaults[key];
      console.log(`  ${key}: ${value}`);
    });

    // Thread Pool Settings
    console.log('\nThread Pool Settings:');
    const tpSettings = Object.keys(defaults).filter(k => k.includes('thread_pool'));
    const importantPools = ['write', 'bulk', 'search'];
    importantPools.forEach(pool => {
      const poolSettings = tpSettings.filter(k => k.includes(pool));
      if (poolSettings.length > 0) {
        console.log(`\n  ${pool.toUpperCase()}:`);
        poolSettings.forEach(key => {
          const value = persistent[key] || defaults[key];
          console.log(`    ${key.split('.').pop()}: ${value}`);
        });
      }
    });

    return settings.body;
  }

  async checkPendingTasks() {
    console.log('\n' + '='.repeat(80));
    console.log('PENDING CLUSTER TASKS');
    console.log('='.repeat(80));

    const tasks = await this.opensearchClient!.cluster.pendingTasks();

    if (tasks.body.tasks.length === 0) {
      console.log('✓ No pending tasks');
    } else {
      console.log(`⚠️  ${tasks.body.tasks.length} pending tasks`);
      console.table(tasks.body.tasks.map((t: any) => ({
        'Priority': t.priority,
        'Source': t.source,
        'Time in Queue': t.time_in_queue_millis + 'ms'
      })));
    }

    return tasks.body.tasks;
  }

  async checkActiveTasks() {
    console.log('\n' + '='.repeat(80));
    console.log('ACTIVE TASKS & LONG-RUNNING QUERIES');
    console.log('='.repeat(80));

    try {
      const tasks = await this.opensearchClient!.tasks.list({
        detailed: true,
        group_by: 'parents'
      });

      const allTasks = tasks.body.tasks || {};
      const taskList = Object.keys(allTasks).map(key => ({
        id: key,
        ...allTasks[key]
      }));

      // Filter search tasks
      const searchTasks = taskList.filter((t: any) => t.action?.includes('search') || t.action?.includes('query'));

      // Categorize by duration
      const longRunning5s = searchTasks.filter((t: any) => t.running_time_in_nanos > 5000000000);
      const longRunning10s = searchTasks.filter((t: any) => t.running_time_in_nanos > 10000000000);
      const longRunning30s = searchTasks.filter((t: any) => t.running_time_in_nanos > 30000000000);

      console.log(`\nActive Search Tasks: ${searchTasks.length}`);
      console.log(`  >5s:  ${longRunning5s.length} ${longRunning5s.length > 0 ? '⚠️' : ''}`);
      console.log(`  >10s: ${longRunning10s.length} ${longRunning10s.length > 0 ? '⚠️' : ''}`);
      console.log(`  >30s: ${longRunning30s.length} ${longRunning30s.length > 0 ? '🔴' : ''}`);

      if (longRunning5s.length > 0) {
        console.log('\n🔴 LONG-RUNNING QUERIES DETECTED:');
        longRunning5s.slice(0, 10).forEach((t: any) => {
          const durationSec = (t.running_time_in_nanos / 1000000000).toFixed(2);
          console.log(`  - ${t.action} (${durationSec}s) on node ${t.node}`);
          if (t.description) {
            console.log(`    Description: ${t.description.substring(0, 100)}`);
          }
        });
        if (longRunning5s.length > 10) {
          console.log(`  ... and ${longRunning5s.length - 10} more`);
        }
      } else {
        console.log('\n✓ No long-running queries detected');
      }

      return {
        total: taskList.length,
        searchTasks: searchTasks.length,
        longRunning5s: longRunning5s.length,
        longRunning10s: longRunning10s.length,
        longRunning30s: longRunning30s.length,
        tasks: searchTasks.slice(0, 20) // Store top 20 for JSON output
      };
    } catch (error: any) {
      console.log(`Error fetching active tasks: ${error.message}`);
      return { total: 0, searchTasks: 0, longRunning5s: 0, longRunning10s: 0, longRunning30s: 0, tasks: [] };
    }
  }

  async checkCircuitBreakerStatus() {
    console.log('\n' + '='.repeat(80));
    console.log('CIRCUIT BREAKER STATUS (Real-time)');
    console.log('='.repeat(80));

    try {
      const stats = await this.opensearchClient!.nodes.stats({
        metric: ['breaker']
      });

      const nodes = Object.values(stats.body.nodes) as any[];
      let totalTrips = 0;

      nodes.forEach((node: any) => {
        console.log(`\nNode: ${node.name}`);
        console.log('-'.repeat(80));

        const breakers = node.breakers;
        Object.keys(breakers).forEach(breakerName => {
          const breaker = breakers[breakerName];
          const usagePercent = ((breaker.estimated_size_in_bytes / breaker.limit_size_in_bytes) * 100).toFixed(2);
          const warning = parseFloat(usagePercent) > 80 ? ' ⚠️ HIGH' : parseFloat(usagePercent) > 90 ? ' 🔴 CRITICAL' : '';

          if (breakerName === 'parent' || breakerName === 'request' || breakerName === 'fielddata') {
            console.log(`  ${breakerName.toUpperCase()}:`);
            console.log(`    Usage: ${this.formatBytes(breaker.estimated_size_in_bytes)} / ${this.formatBytes(breaker.limit_size_in_bytes)} (${usagePercent}%)${warning}`);
            console.log(`    Tripped: ${breaker.tripped} times`);
            totalTrips += breaker.tripped;
          }
        });
      });

      console.log(`\n${totalTrips > 0 ? '🔴' : '✓'} Total Circuit Breaker Trips: ${totalTrips}`);
      if (totalTrips > 0) {
        console.log('   ⚠️  Circuit breakers have tripped - queries were killed due to memory pressure');
      }

      return {
        nodes: nodes.map(n => ({
          name: n.name,
          breakers: n.breakers
        })),
        totalTrips
      };
    } catch (error: any) {
      console.log(`Error fetching circuit breaker status: ${error.message}`);
      return { nodes: [], totalTrips: 0 };
    }
  }

  async checkCacheMetrics() {
    console.log('\n' + '='.repeat(80));
    console.log('CACHE METRICS (Query Cache, Field Data, Request Cache)');
    console.log('='.repeat(80));

    try {
      const stats = await this.opensearchClient!.nodes.stats({
        metric: ['indices']
      });

      const nodes = Object.values(stats.body.nodes) as any[];
      let totalQueryCacheEvictions = 0;
      let totalFieldDataEvictions = 0;

      nodes.forEach((node: any) => {
        console.log(`\nNode: ${node.name}`);
        console.log('-'.repeat(80));

        const indices = node.indices;

        // Query Cache
        if (indices.query_cache) {
          const qc = indices.query_cache;
          const hitRate = qc.total_count > 0 ? ((qc.hit_count / qc.total_count) * 100).toFixed(2) : '0';
          console.log(`  Query Cache:`);
          console.log(`    Size: ${this.formatBytes(qc.memory_size_in_bytes)}`);
          console.log(`    Hit Rate: ${hitRate}%`);
          console.log(`    Evictions: ${qc.evictions.toLocaleString()}${qc.evictions > 1000 ? ' ⚠️' : ''}`);
          totalQueryCacheEvictions += qc.evictions;
        }

        // Field Data Cache
        if (indices.fielddata) {
          const fd = indices.fielddata;
          console.log(`  Field Data Cache:`);
          console.log(`    Size: ${this.formatBytes(fd.memory_size_in_bytes)}`);
          console.log(`    Evictions: ${fd.evictions.toLocaleString()}${fd.evictions > 100 ? ' ⚠️' : ''}`);
          totalFieldDataEvictions += fd.evictions;
        }

        // Request Cache
        if (indices.request_cache) {
          const rc = indices.request_cache;
          const hitRate = rc.hit_count + rc.miss_count > 0
            ? ((rc.hit_count / (rc.hit_count + rc.miss_count)) * 100).toFixed(2)
            : '0';
          console.log(`  Request Cache:`);
          console.log(`    Size: ${this.formatBytes(rc.memory_size_in_bytes)}`);
          console.log(`    Hit Rate: ${hitRate}%`);
          console.log(`    Evictions: ${rc.evictions.toLocaleString()}`);
        }
      });

      if (totalQueryCacheEvictions > 5000 || totalFieldDataEvictions > 500) {
        console.log('\n⚠️  HIGH CACHE EVICTION RATE - Indicates memory pressure');
      }

      return {
        queryCacheEvictions: totalQueryCacheEvictions,
        fieldDataEvictions: totalFieldDataEvictions,
        nodes: nodes.map(n => ({
          name: n.name,
          caches: {
            queryCache: n.indices.query_cache,
            fieldData: n.indices.fielddata,
            requestCache: n.indices.request_cache
          }
        }))
      };
    } catch (error: any) {
      console.log(`Error fetching cache metrics: ${error.message}`);
      return { queryCacheEvictions: 0, fieldDataEvictions: 0, nodes: [] };
    }
  }

  async checkSegmentStats(indexName: string) {
    console.log('\n' + '='.repeat(80));
    console.log(`SEGMENT STATISTICS - ${indexName}`);
    console.log('='.repeat(80));

    try {
      const stats = await this.opensearchClient!.indices.stats({
        index: indexName,
        metric: ['segments']
      });

      const indexData = stats.body.indices[indexName];
      if (!indexData) {
        console.log(`Index ${indexName} not found`);
        return null;
      }

      const segments = indexData.total.segments;
      const segmentCount = segments.count;
      const segmentMemory = segments.memory_in_bytes;

      console.log(`\nSegment Count: ${segmentCount}${segmentCount > 500 ? ' ⚠️ HIGH' : ''}`);
      console.log(`Segment Memory: ${this.formatBytes(segmentMemory)}`);
      console.log(`Fixed Bit Set Memory: ${this.formatBytes(segments.fixed_bit_set_memory_in_bytes || 0)}`);

      if (segmentCount > 500) {
        console.log('\n⚠️  HIGH SEGMENT COUNT');
        console.log('   Too many segments slow down searches significantly');
        console.log('   Recommendation: Consider force merge or review refresh interval');
      }

      return {
        count: segmentCount,
        memoryInBytes: segmentMemory,
        segments: segments
      };
    } catch (error: any) {
      console.log(`Error fetching segment stats for ${indexName}: ${error.message}`);
      return null;
    }
  }

  async checkQueueMetrics() {
    console.log('\n' + '='.repeat(80));
    console.log('THREAD POOL QUEUE SATURATION ANALYSIS');
    console.log('='.repeat(80));

    try {
      const stats = await this.opensearchClient!.cat.threadPool({
        format: 'json',
        h: 'node_name,name,active,queue,rejected,largest,completed,size,queue_size',
        v: true
      });

      const pools = ['write', 'bulk', 'search', 'get'];
      const poolData = stats.body.filter((p: any) => pools.includes(p.name));

      let maxSaturation = 0;

      console.log('\nQueue Saturation by Pool:');
      pools.forEach(poolName => {
        const poolEntries = poolData.filter((p: any) => p.name === poolName);
        poolEntries.forEach((p: any) => {
          const queueSize = parseInt(p.queue_size);
          const queueDepth = parseInt(p.queue);
          const saturation = queueSize > 0 ? ((queueDepth / queueSize) * 100).toFixed(2) : '0';
          maxSaturation = Math.max(maxSaturation, parseFloat(saturation));

          const warning = parseFloat(saturation) > 80 ? ' 🔴 CRITICAL' : parseFloat(saturation) > 50 ? ' ⚠️ HIGH' : '';
          if (parseFloat(saturation) > 10 || poolName === 'search') {
            console.log(`  ${poolName.toUpperCase()} (${p.node_name}): ${saturation}% full${warning}`);
          }
        });
      });

      if (maxSaturation > 80) {
        console.log('\n🔴 CRITICAL: Queue saturation >80% - queries are likely timing out');
      } else if (maxSaturation > 50) {
        console.log('\n⚠️  WARNING: Queue saturation >50% - performance degradation likely');
      } else {
        console.log('\n✓ Queue saturation healthy');
      }

      return {
        maxSaturation,
        poolData
      };
    } catch (error: any) {
      console.log(`Error checking queue metrics: ${error.message}`);
      return { maxSaturation: 0, poolData: [] };
    }
  }

  async checkHotThreads() {
    console.log('\n' + '='.repeat(80));
    console.log('HOT THREADS ANALYSIS');
    console.log('='.repeat(80));

    try {
      const hotThreads = await this.opensearchClient!.nodes.hotThreads({
        threads: 3,
        type: 'cpu'
      });

      const output = typeof hotThreads.body === 'string' ? hotThreads.body : JSON.stringify(hotThreads.body);
      const lines = output.split('\n').slice(0, 30); // First 30 lines

      console.log('\nTop CPU-consuming threads:');
      lines.forEach(line => {
        if (line.trim()) {
          console.log(`  ${line}`);
        }
      });

      return {
        summary: lines.slice(0, 15).join('\n')
      };
    } catch (error: any) {
      console.log(`Error fetching hot threads: ${error.message}`);
      return { summary: 'Not available' };
    }
  }

  async analyzeCriticalIssues(metrics: MetricsResult): Promise<void> {
    console.log('\n' + '='.repeat(80));
    console.log('CRITICAL ISSUES & RECOMMENDATIONS');
    console.log('='.repeat(80));

    const issues: string[] = [];
    const warnings: string[] = [];

    // Check cluster health
    if (metrics.clusterHealth.status === 'red') {
      issues.push('🔴 CLUSTER STATUS IS RED - Data loss or unavailability');
    } else if (metrics.clusterHealth.status === 'yellow') {
      warnings.push('⚠️  Cluster status is YELLOW - Replica shards not allocated');
    }

    // Check thread pool rejections
    metrics.threadPoolStats.forEach((pool: any) => {
      if (parseInt(pool.rejected) > 0) {
        issues.push(`🔴 ${pool.name.toUpperCase()} thread pool has ${pool.rejected} rejections - System overloaded`);
      }
      const queueSize = parseInt(pool.queue_size);
      const queueDepth = parseInt(pool.queue);
      if (queueSize > 0 && queueDepth > queueSize * 0.8) {
        warnings.push(`⚠️  ${pool.name.toUpperCase()} queue is ${((queueDepth / queueSize) * 100).toFixed(0)}% full`);
      }
    });

    // Check JVM pressure
    metrics.nodeStats.forEach((node: any) => {
      const heapPercent = node.jvm.mem.heap_used_percent;
      if (heapPercent > 85) {
        issues.push(`🔴 Node ${node.name} JVM memory at ${heapPercent}% - Critical memory pressure`);
      } else if (heapPercent > 75) {
        warnings.push(`⚠️  Node ${node.name} JVM memory at ${heapPercent}% - High memory pressure`);
      }

      const cpuPercent = node.os.cpu.percent;
      if (cpuPercent > 90) {
        issues.push(`🔴 Node ${node.name} CPU at ${cpuPercent}% - Critical CPU usage`);
      } else if (cpuPercent > 80) {
        warnings.push(`⚠️  Node ${node.name} CPU at ${cpuPercent}% - High CPU usage`);
      }

      // Old GC collections
      const oldGC = node.jvm.gc.collectors.old.collection_count;
      if (oldGC > 10) {
        warnings.push(`⚠️  Node ${node.name} has ${oldGC} Old Gen GC collections - Memory pressure`);
      }
    });

    // Check refresh latency
    if (metrics.indexStats) {
      const avgRefreshTime = metrics.indexStats.refresh.total > 0
        ? (metrics.indexStats.refresh.total_time_in_millis / metrics.indexStats.refresh.total)
        : 0;

      if (avgRefreshTime > 100) {
        issues.push(`🔴 Average refresh time is ${avgRefreshTime.toFixed(2)}ms - This is HIGH due to refresh:true in code`);
      } else if (avgRefreshTime > 50) {
        warnings.push(`⚠️  Average refresh time is ${avgRefreshTime.toFixed(2)}ms`);
      }
    }

    // Check pending tasks
    if (metrics.pendingTasks.length > 10) {
      warnings.push(`⚠️  ${metrics.pendingTasks.length} pending cluster tasks`);
    }

    // ========== NEW: TIMEOUT-SPECIFIC CHECKS ==========

    // Check active long-running queries
    if (metrics.activeTasks) {
      if (metrics.activeTasks.longRunning30s > 0) {
        issues.push(`🔴 ${metrics.activeTasks.longRunning30s} queries running >30s - LIKELY TIMING OUT NOW`);
      }
      if (metrics.activeTasks.longRunning10s > 0) {
        warnings.push(`⚠️  ${metrics.activeTasks.longRunning10s} queries running >10s - approaching timeout`);
      }
      if (metrics.activeTasks.longRunning5s > 5) {
        warnings.push(`⚠️  ${metrics.activeTasks.longRunning5s} queries running >5s - monitor for timeouts`);
      }

      // Store for summary
      metrics.summary.active_searches = metrics.activeTasks.searchTasks;
      metrics.summary.long_running_queries_5s = metrics.activeTasks.longRunning5s;
      metrics.summary.long_running_queries_10s = metrics.activeTasks.longRunning10s;
      metrics.summary.long_running_queries_30s = metrics.activeTasks.longRunning30s;
    }

    // Check circuit breaker trips
    if (metrics.circuitBreakerStatus && metrics.circuitBreakerStatus.totalTrips > 0) {
      issues.push(`🔴 Circuit breakers tripped ${metrics.circuitBreakerStatus.totalTrips} times - queries killed due to memory`);
      metrics.summary.circuit_breaker_trips = metrics.circuitBreakerStatus.totalTrips;
    }

    // Check queue saturation (causes timeouts)
    if (metrics.queueMetrics && metrics.queueMetrics.maxSaturation > 80) {
      issues.push(`🔴 Search queue saturation at ${metrics.queueMetrics.maxSaturation.toFixed(1)}% - CAUSING TIMEOUTS`);
      metrics.summary.search_queue_saturation_pct = metrics.queueMetrics.maxSaturation;
    } else if (metrics.queueMetrics && metrics.queueMetrics.maxSaturation > 50) {
      warnings.push(`⚠️  Search queue saturation at ${metrics.queueMetrics.maxSaturation.toFixed(1)}% - degraded performance`);
      metrics.summary.search_queue_saturation_pct = metrics.queueMetrics.maxSaturation;
    }

    // Check segment count (slows searches)
    if (metrics.segmentStats && metrics.segmentStats.count > 500) {
      warnings.push(`⚠️  pms_green_dot has ${metrics.segmentStats.count} segments - slowing searches`);
    }
    if (metrics.segmentStatsUserRooms && metrics.segmentStatsUserRooms.count > 500) {
      warnings.push(`⚠️  pms-user-rooms has ${metrics.segmentStatsUserRooms.count} segments - slowing searches`);
    }

    // Check cache evictions (memory pressure indicator)
    if (metrics.cacheMetrics) {
      if (metrics.cacheMetrics.queryCacheEvictions > 10000) {
        warnings.push(`⚠️  High query cache evictions (${metrics.cacheMetrics.queryCacheEvictions.toLocaleString()}) - memory pressure`);
      }
      if (metrics.cacheMetrics.fieldDataEvictions > 1000) {
        warnings.push(`⚠️  High field data evictions (${metrics.cacheMetrics.fieldDataEvictions.toLocaleString()}) - memory pressure`);
      }
    }

    // Display results
    if (issues.length === 0 && warnings.length === 0) {
      console.log('\n✅ No critical issues or warnings detected');
    } else {
      if (issues.length > 0) {
        console.log('\n🔴 CRITICAL ISSUES:');
        issues.forEach(issue => console.log(`   ${issue}`));
      }

      if (warnings.length > 0) {
        console.log('\n⚠️  WARNINGS:');
        warnings.forEach(warning => console.log(`   ${warning}`));
      }
    }

    // Always show the root cause reminder
    console.log('\n💡 ROOT CAUSE OF LOAD TEST FAILURE:');
    console.log('   All ES write operations use refresh:true, forcing immediate index refresh');
    console.log('   This blocks operations and causes 50-100x performance degradation');
    console.log('   Location: node_modules/@amurahealth/pms-utils/ESService.ts');
    console.log('   Fix: Change refresh:true to refresh:false in all operations');

    metrics.summary = {
      critical_issues: issues,
      warnings: warnings,
      health_status: metrics.clusterHealth.status,
      active_searches: metrics.summary.active_searches,
      long_running_queries_5s: metrics.summary.long_running_queries_5s,
      long_running_queries_10s: metrics.summary.long_running_queries_10s,
      long_running_queries_30s: metrics.summary.long_running_queries_30s,
      circuit_breaker_trips: metrics.summary.circuit_breaker_trips,
      search_queue_saturation_pct: metrics.summary.search_queue_saturation_pct
    };
  }

  async runFullCheck(saveToFile: boolean = true): Promise<MetricsResult> {
    const timestamp = new Date().toISOString();
    console.log('\n' + '='.repeat(80));
    console.log(`OPENSEARCH METRICS CHECK - ${timestamp}`);
    console.log('='.repeat(80) + '\n');

    const metrics: MetricsResult = {
      timestamp,
      clusterHealth: null,
      threadPoolStats: null,
      nodeStats: null,
      indexStats: null,
      indexStatsUserRooms: null,
      clusterStats: null,
      pendingTasks: null,
      activeTasks: null,
      circuitBreakerStatus: null,
      cacheMetrics: null,
      segmentStats: null,
      segmentStatsUserRooms: null,
      hotThreads: null,
      queueMetrics: null,
      summary: {
        critical_issues: [],
        warnings: [],
        health_status: 'unknown',
        active_searches: 0,
        long_running_queries_5s: 0,
        long_running_queries_10s: 0,
        long_running_queries_30s: 0,
        circuit_breaker_trips: 0,
        search_queue_saturation_pct: 0
      }
    };

    try {
      // Initialize client
      await this.initializeOpenSearchClient();

      // Run all checks
      metrics.clusterHealth = await this.checkClusterHealth();
      metrics.threadPoolStats = await this.checkThreadPools();
      metrics.nodeStats = await this.checkNodeStats();

      // Check both indices
      metrics.indexStats = await this.checkIndexStats('pms_green_dot');
      metrics.indexStatsUserRooms = await this.checkIndexStats('pms-user-rooms');
      await this.checkIndexSettings('pms_green_dot');
      await this.checkIndexSettings('pms-user-rooms');

      metrics.clusterStats = await this.checkClusterSettings();
      metrics.pendingTasks = await this.checkPendingTasks();

      // NEW: Timeout-specific checks
      metrics.activeTasks = await this.checkActiveTasks();
      metrics.circuitBreakerStatus = await this.checkCircuitBreakerStatus();
      metrics.cacheMetrics = await this.checkCacheMetrics();
      metrics.segmentStats = await this.checkSegmentStats('pms_green_dot');
      metrics.segmentStatsUserRooms = await this.checkSegmentStats('pms-user-rooms');
      metrics.queueMetrics = await this.checkQueueMetrics();
      metrics.hotThreads = await this.checkHotThreads();

      // Analyze issues
      await this.analyzeCriticalIssues(metrics);

      // Save to file
      if (saveToFile) {
        const filename = `opensearch-metrics-${Date.now()}.json`;
        const filepath = path.join(process.cwd(), 'metrics-output', filename);

        // Ensure directory exists
        const dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(filepath, JSON.stringify(metrics, null, 2));
        console.log(`\n✅ Metrics saved to: ${filepath}`);

        // Also save a summary CSV for easy analysis
        this.saveSummaryCSV(metrics);
      }

    } catch (error) {
      console.error('\n❌ Error during metrics check:', error);
      throw error;
    }

    return metrics;
  }

  saveSummaryCSV(metrics: MetricsResult): void {
    const csvFile = path.join(process.cwd(), 'metrics-output', 'metrics-summary.csv');

    const headers = [
      'timestamp',
      'cluster_status',
      'active_nodes',
      'pending_tasks',
      'write_rejections',
      'bulk_rejections',
      'search_rejections',
      'jvm_memory_percent',
      'cpu_percent',
      'avg_refresh_time_ms',
      'indexing_rate',
      'critical_issues_count',
      'warnings_count',
      'active_searches',
      'long_running_queries_5s',
      'long_running_queries_10s',
      'long_running_queries_30s',
      'circuit_breaker_trips',
      'search_queue_saturation_pct',
      'segment_count_pms_green_dot',
      'segment_count_pms_user_rooms',
      'query_cache_evictions',
      'field_data_evictions'
    ];

    // Aggregate data
    const writePool = metrics.threadPoolStats?.find((p: any) => p.name === 'write');
    const bulkPool = metrics.threadPoolStats?.find((p: any) => p.name === 'bulk');
    const searchPool = metrics.threadPoolStats?.find((p: any) => p.name === 'search');
    const firstNode = metrics.nodeStats?.[0];

    const avgRefreshTime = metrics.indexStats && metrics.indexStats.refresh?.total > 0
      ? (metrics.indexStats.refresh.total_time_in_millis / metrics.indexStats.refresh.total).toFixed(2)
      : '0';

    const indexingRate = metrics.indexStats && metrics.indexStats.indexing?.index_time_in_millis
      ? (metrics.indexStats.indexing.index_total / (metrics.indexStats.indexing.index_time_in_millis / 1000)).toFixed(2)
      : '0';

    const row = [
      metrics.timestamp,
      metrics.clusterHealth?.status || 'unknown',
      metrics.clusterHealth?.number_of_nodes || 0,
      metrics.pendingTasks?.length || 0,
      writePool?.rejected || 0,
      bulkPool?.rejected || 0,
      searchPool?.rejected || 0,
      firstNode?.jvm?.mem?.heap_used_percent || 0,
      firstNode?.os?.cpu?.percent || 0,
      avgRefreshTime,
      indexingRate,
      metrics.summary.critical_issues.length,
      metrics.summary.warnings.length,
      metrics.summary.active_searches,
      metrics.summary.long_running_queries_5s,
      metrics.summary.long_running_queries_10s,
      metrics.summary.long_running_queries_30s,
      metrics.summary.circuit_breaker_trips,
      metrics.summary.search_queue_saturation_pct.toFixed(2),
      metrics.segmentStats?.count || 0,
      metrics.segmentStatsUserRooms?.count || 0,
      metrics.cacheMetrics?.queryCacheEvictions || 0,
      metrics.cacheMetrics?.fieldDataEvictions || 0
    ];

    // Check if file exists
    const fileExists = fs.existsSync(csvFile);

    if (!fileExists) {
      fs.writeFileSync(csvFile, headers.join(',') + '\n');
    }

    fs.appendFileSync(csvFile, row.join(',') + '\n');
    console.log(`✅ Summary appended to: ${csvFile}`);
  }

  // Helper methods
  private getStatusEmoji(status: string): string {
    switch (status) {
      case 'green': return '✅';
      case 'yellow': return '⚠️';
      case 'red': return '🔴';
      default: return '❓';
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(2)}m`;
  }
}

// Main execution
async function main() {
  const checker = new OpenSearchMetricsChecker();

  // Check if running in continuous mode
  const continuousMode = process.argv.includes('--continuous');
  const interval = parseInt(process.argv.find(arg => arg.startsWith('--interval='))?.split('=')[1] || '30');

  if (continuousMode) {
    console.log(`🔄 Running in continuous mode, checking every ${interval} seconds...`);
    console.log('Press Ctrl+C to stop\n');

    while (true) {
      try {
        await checker.runFullCheck(true);
        console.log(`\n⏳ Waiting ${interval} seconds before next check...\n`);
        await new Promise(resolve => setTimeout(resolve, interval * 1000));
      } catch (error) {
        console.error('Error in continuous mode:', error);
        await new Promise(resolve => setTimeout(resolve, interval * 1000));
      }
    }
  } else {
    // Single run
    await checker.runFullCheck(true);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { OpenSearchMetricsChecker, MetricsResult };

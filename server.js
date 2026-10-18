#!/usr/bin/env node
/**
 * Antigravity Quota MCP Server (v1.1.0)
 * Connects directly to local Antigravity 2.0 language server via ConnectRPC
 * to query 5-hour and 7-day (weekly) quotas, per-model quotas, user status,
 * and provides a self-learning quota estimation & calibration engine with
 * automatic parallel-chat noise detection.
 */

const { execSync } = require('child_process');
const https = require('https');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Server Metadata
const SERVER_INFO = {
  name: "antigravity-quota",
  version: "1.1.0"
};

const MCP_INSTRUCTIONS = `
# Antigravity Quota & Self-Learning Protocol (antigravity-quota)

1. PASSIVE vs. LARGE TASK CHECKS (Anti-Spam):
   - Small / everyday tasks: Do NOT query quota on simple questions, minor edits, or quick fixes.
   - 20-30 Prompt Cache: Once quota is checked and remaining limits are healthy (>70%), treat it as sufficient for the next 20-30 prompts without re-polling.
   - Heavy workloads: Before starting massive tasks (multi-agent workflows, deep refactors, or full repo generation), call get_antigravity_quota_summary once and give a very brief 1-2 line assessment of current limits vs. expected consumption. Warn if remaining quota is <15%.

2. ACTIVE /quota COMMAND & SELF-LEARNING CALIBRATION:
   - Whenever the user uses '/quota' or asks how much quota a plan/task will consume (e.g. "How much /quota will this plan use?"):
     a) Deep Inspection: Call get_quota_learnings() and get_antigravity_quota_summary() to inspect historical benchmarks and calibration multipliers in quota_learnings.json.
     b) Pre-Task Snapshot: Call start_quota_tracking(task_description, task_category, model_name, estimated_5h_percent, estimated_weekly_percent, planned_scope, conversation_id) to store your estimate and current quota snapshot in quota_learnings.json.
     c) Post-Task Measurement: Once the tracked task finishes, you MUST call finish_quota_tracking(tracking_id, conversation_id, actual_scope_summary) to record actual consumption.
     d) Parallel-Chat Warning: Always check parallelActivity.parallelChatsDetected in the finish_quota_tracking output and explicitly inform the user if parallel chats were active at the same time (showing both raw total drop and isolated task consumption).
`.trim();

const LEARNINGS_FILE = path.join(__dirname, 'quota_learnings.json');
const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

// Available MCP Tools
const TOOLS = [
  {
    name: "get_antigravity_quota_summary",
    description: "Returns the live 5-hour and 7-day (weekly) quota status for Gemini and Claude/GPT models in Antigravity 2.0, including remaining percentages, reset timestamps, human-readable countdowns, and historical calibration stats.",
    inputSchema: {
      type: "object",
      properties: {
        include_learnings: {
          type: "boolean",
          description: "Optional. Whether to include historical learning & calibration statistics in the response (default: true)."
        }
      },
      required: []
    }
  },
  {
    name: "get_antigravity_model_quotas",
    description: "Returns detailed live quota information for each individual AI model available in Antigravity 2.0 (Gemini 4 Argon, Gemini 3.8 Flash/Pro, Claude 3.7 Sonnet, etc.).",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "get_antigravity_user_status",
    description: "Returns Antigravity user plan status, user tier, and language server connectivity health.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "start_quota_tracking",
    description: "Starts tracking a task or plan for self-learning quota calibration. Snapshots current live 5h & weekly quotas before execution and records the AI's estimated consumption.",
    inputSchema: {
      type: "object",
      properties: {
        task_description: {
          type: "string",
          description: "Short description of the planned task or feature."
        },
        task_category: {
          type: "string",
          enum: ["small_fix", "feature_implementation", "large_refactor", "architecture_audit", "multi_agent_swarm", "other"],
          description: "Category of the task for grouped learning statistics."
        },
        model_name: {
          type: "string",
          description: "Name of the active model (e.g. 'Gemini 4 Argon (Medium)', 'Gemini 3.8 Flash')."
        },
        estimated_5h_percent: {
          type: "number",
          description: "AI's estimated 5-hour quota consumption in percent (e.g. 4.5 for 4.5%)."
        },
        estimated_weekly_percent: {
          type: "number",
          description: "Optional. AI's estimated weekly quota consumption in percent (e.g. 1.0 for 1.0%)."
        },
        planned_scope: {
          type: "string",
          description: "Optional metrics about planned scope (e.g. '4 files, ~10 tool calls, 1 subagent')."
        },
        conversation_id: {
          type: "string",
          description: "Optional but recommended: Current Conversation ID so the server can isolate this chat's token usage from parallel chats."
        }
      },
      required: ["task_description", "model_name", "estimated_5h_percent"]
    }
  },
  {
    name: "finish_quota_tracking",
    description: "Completes an active quota tracking session after a task finishes. Measures real 5h & weekly quota delta, scans Antigravity transcript logs to detect parallel chats that ran simultaneously, calculates isolated consumption, and updates the persistent learning file (quota_learnings.json).",
    inputSchema: {
      type: "object",
      properties: {
        tracking_id: {
          type: "string",
          description: "Optional. The tracking_id returned by start_quota_tracking. If omitted, finishes the latest active session."
        },
        conversation_id: {
          type: "string",
          description: "Optional. Conversation ID of the current chat for parallel-chat isolation."
        },
        actual_scope_summary: {
          type: "string",
          description: "Optional summary of work actually performed (e.g. 'Modified 5 files, 14 tool calls')."
        }
      },
      required: []
    }
  },
  {
    name: "get_quota_learnings",
    description: "Retrieves historical quota consumption learnings, accuracy calibration factors, and past task benchmarks from quota_learnings.json. Use this when the user asks '/quota' about how much a plan or task will consume.",
    inputSchema: {
      type: "object",
      properties: {
        model_name: {
          type: "string",
          description: "Optional filter by model name."
        },
        task_category: {
          type: "string",
          description: "Optional filter by task category."
        },
        limit: {
          type: "number",
          description: "Maximum number of recent history entries to return (default: 15)."
        }
      },
      required: []
    }
  }
];

// --- Persistent Learning Store Helpers ---

function loadLearningsStore() {
  try {
    if (fs.existsSync(LEARNINGS_FILE)) {
      const content = fs.readFileSync(LEARNINGS_FILE, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    // Fallback to default structure if corrupted
  }
  return {
    schemaVersion: "1.1.0",
    updatedAt: new Date().toISOString(),
    activeTrackings: {},
    calibrationStats: {
      totalCompletedTasks: 0,
      cleanIsolatedTasks: 0,
      parallelAdjustedTasks: 0,
      globalCalibrationMultiplier: 1.0,
      byModel: {},
      byCategory: {}
    },
    history: []
  };
}

function saveLearningsStore(store) {
  store.updatedAt = new Date().toISOString();
  fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function recomputeCalibrationStats(store) {
  const history = store.history || [];
  const stats = {
    totalCompletedTasks: history.length,
    cleanIsolatedTasks: 0,
    parallelAdjustedTasks: 0,
    globalCalibrationMultiplier: 1.0,
    byModel: {},
    byCategory: {}
  };

  let weightedRatioSum = 0;
  let weightTotal = 0;

  for (const item of history) {
    const isClean = item.parallelActivity && !item.parallelActivity.parallelChatsDetected;
    if (isClean) {
      stats.cleanIsolatedTasks++;
    } else {
      stats.parallelAdjustedTasks++;
    }

    const weight = isClean ? 1.0 : 0.4;
    const est = item.estimated5hPercent || 0;
    const actual = item.attributed5hUsedPercent !== undefined ? item.attributed5hUsedPercent : item.raw5hUsedPercent;

    if (est > 0 && actual >= 0) {
      const ratio = actual / est;
      // Clamp extreme outliers between 0.1x and 10x
      const clampedRatio = Math.max(0.1, Math.min(10.0, ratio));
      weightedRatioSum += clampedRatio * weight;
      weightTotal += weight;
    }

    // Group by Model
    const mKey = item.modelName || "Unknown";
    if (!stats.byModel[mKey]) {
      stats.byModel[mKey] = {
        taskCount: 0,
        cleanCount: 0,
        avgEstimated5hPercent: 0,
        avgActualAttributed5hPercent: 0,
        avgRaw5hPercent: 0,
        calibrationMultiplier: 1.0,
        _estSum: 0,
        _actSum: 0,
        _rawSum: 0
      };
    }
    const mGroup = stats.byModel[mKey];
    mGroup.taskCount++;
    if (isClean) mGroup.cleanCount++;
    mGroup._estSum += est;
    mGroup._actSum += (actual || 0);
    mGroup._rawSum += (item.raw5hUsedPercent || 0);

    // Group by Category
    const cKey = item.taskCategory || "other";
    if (!stats.byCategory[cKey]) {
      stats.byCategory[cKey] = {
        taskCount: 0,
        avgActualAttributed5hPercent: 0,
        min5hPercent: null,
        max5hPercent: null,
        _actSum: 0
      };
    }
    const cGroup = stats.byCategory[cKey];
    cGroup.taskCount++;
    cGroup._actSum += (actual || 0);
    if (cGroup.min5hPercent === null || actual < cGroup.min5hPercent) cGroup.min5hPercent = Number((actual || 0).toFixed(2));
    if (cGroup.max5hPercent === null || actual > cGroup.max5hPercent) cGroup.max5hPercent = Number((actual || 0).toFixed(2));
  }

  if (weightTotal > 0) {
    stats.globalCalibrationMultiplier = Number((weightedRatioSum / weightTotal).toFixed(2));
  }

  for (const mKey of Object.keys(stats.byModel)) {
    const g = stats.byModel[mKey];
    g.avgEstimated5hPercent = Number((g._estSum / g.taskCount).toFixed(2));
    g.avgActualAttributed5hPercent = Number((g._actSum / g.taskCount).toFixed(2));
    g.avgRaw5hPercent = Number((g._rawSum / g.taskCount).toFixed(2));
    if (g._estSum > 0) {
      g.calibrationMultiplier = Number((g._actSum / g._estSum).toFixed(2));
    }
    delete g._estSum;
    delete g._actSum;
    delete g._rawSum;
  }

  for (const cKey of Object.keys(stats.byCategory)) {
    const g = stats.byCategory[cKey];
    g.avgActualAttributed5hPercent = Number((g._actSum / g.taskCount).toFixed(2));
    delete g._actSum;
  }

  store.calibrationStats = stats;
}

// --- Parallel Chat Activity Scanner ---

function scanParallelActivity(startTimeIso, endTimeIso, trackedConversationId) {
  const startMs = new Date(startTimeIso).getTime();
  const endMs = new Date(endTimeIso).getTime();

  const result = {
    parallelChatsDetected: false,
    parallelChatsCount: 0,
    trackedConversationId: trackedConversationId || null,
    thisChatTokenShare: 1.0,
    warningNote: "No parallel chat activity detected. Quota measurement is clean and isolated.",
    activeConversations: []
  };

  try {
    if (!fs.existsSync(BRAIN_DIR)) return result;
    const convDirs = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });

    for (const dirent of convDirs) {
      if (!dirent.isDirectory()) continue;
      const convId = dirent.name;
      const transcriptPath = path.join(BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript.jsonl');

      let stat;
      try {
        stat = fs.statSync(transcriptPath);
      } catch {
        continue;
      }

      // Skip transcripts not modified since startMs (with 5s buffer)
      if (stat.mtimeMs < startMs - 5000) continue;

      const content = fs.readFileSync(transcriptPath, 'utf8');
      const lines = content.split(/\r?\n/);

      let stepsInWindow = 0;
      let plannerResponsesInWindow = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const step = JSON.parse(line);
          if (!step.created_at) continue;
          const stepMs = new Date(step.created_at).getTime();
          if (stepMs >= startMs - 2000 && stepMs <= endMs + 2000) {
            stepsInWindow++;
            if (step.type === 'PLANNER_RESPONSE') {
              plannerResponsesInWindow++;
              inputTokens += (Number(step.input_tokens) || 0);
              outputTokens += (Number(step.output_tokens) || 0);
              cacheReadTokens += (Number(step.cache_read_tokens) || 0);
            }
          }
        } catch {
          // Ignore malformed jsonl line
        }
      }

      if (stepsInWindow > 0) {
        // Weighted cost approximation: output tokens ~4x input, cache_read ~0.1x input
        const weightedTokenLoad = Math.round(inputTokens + (outputTokens * 4) + (cacheReadTokens * 0.1));
        result.activeConversations.push({
          conversationId: convId,
          isTrackedChat: trackedConversationId ? (convId === trackedConversationId) : null,
          stepsInWindow,
          plannerResponsesInWindow,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          weightedTokenLoad
        });
      }
    }

    // Determine parallel activity
    if (result.activeConversations.length > 0) {
      // If trackedConversationId wasn't passed, assume the one with highest activity or sole active is the tracked chat
      let targetConv = null;
      if (trackedConversationId) {
        targetConv = result.activeConversations.find(c => c.conversationId === trackedConversationId);
      }
      if (!targetConv && result.activeConversations.length === 1) {
        targetConv = result.activeConversations[0];
        targetConv.isTrackedChat = true;
        result.trackedConversationId = targetConv.conversationId;
      }

      const otherChats = result.activeConversations.filter(c => targetConv ? c.conversationId !== targetConv.conversationId : true);

      if (targetConv && otherChats.length > 0) {
        result.parallelChatsDetected = true;
        result.parallelChatsCount = otherChats.length;

        const totalWeighted = result.activeConversations.reduce((acc, c) => acc + c.weightedTokenLoad, 0);
        const totalSteps = result.activeConversations.reduce((acc, c) => acc + c.stepsInWindow, 0);

        if (totalWeighted > 0 && targetConv.weightedTokenLoad > 0) {
          result.thisChatTokenShare = Number((targetConv.weightedTokenLoad / totalWeighted).toFixed(3));
        } else if (totalSteps > 0) {
          result.thisChatTokenShare = Number((targetConv.stepsInWindow / totalSteps).toFixed(3));
        }

        const otherSharePct = ((1 - result.thisChatTokenShare) * 100).toFixed(1);
        result.warningNote = `⚠️ PARALLEL CHAT ACTIVITY DETECTED: ${otherChats.length} other chat(s) ran simultaneously during this task window and accounted for ~${otherSharePct}% of the token load. Raw quota drop includes their consumption!`;
      } else if (!targetConv && result.activeConversations.length > 1) {
        result.parallelChatsDetected = true;
        result.parallelChatsCount = result.activeConversations.length - 1;
        result.thisChatTokenShare = Number((1 / result.activeConversations.length).toFixed(3));
        result.warningNote = `⚠️ PARALLEL CHAT ACTIVITY DETECTED: ${result.activeConversations.length} chats were active simultaneously (no specific conversation_id was passed to isolate exact share).`;
      }
    }
  } catch (err) {
    result.scanError = err.message;
  }

  return result;
}

// --- ConnectRPC Language Server Discovery ---

function discoverLanguageServer() {
  try {
    const psCmd = "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'language_server*' } | Select-Object ProcessId, CommandLine | ConvertTo-Json";
    const psOut = execSync(`powershell -NoProfile -Command "${psCmd}"`, { encoding: 'utf8', timeout: 5000 });
    let procs;
    try {
      procs = JSON.parse(psOut);
    } catch {
      return null;
    }
    if (!Array.isArray(procs)) procs = [procs];

    for (const p of procs) {
      if (!p || !p.CommandLine) continue;
      const csrfMatch = p.CommandLine.match(/--csrf_token\s+([^\s"]+)/);
      if (!csrfMatch) continue;
      const csrf = csrfMatch[1];

      const netCmd = `Get-NetTCPConnection -OwningProcess ${p.ProcessId} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort`;
      const netOut = execSync(`powershell -NoProfile -Command "${netCmd}"`, { encoding: 'utf8', timeout: 5000 });
      const ports = netOut.split(/\r?\n/).map(x => parseInt(x.trim(), 10)).filter(Boolean);

      if (ports.length > 0) {
        return { pid: p.ProcessId, csrf, ports };
      }
    }
  } catch (err) {
    // Process discovery failed
  }
  return null;
}

function postRpc(port, csrf, methodPath) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: methodPath,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf
      },
      timeout: 3000
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'de' } }));
    req.end();
  });
}

async function getConnectedSession() {
  const info = discoverLanguageServer();
  if (!info) {
    throw new Error("Antigravity 2.0 language server process (language_server.exe) not found. Is Antigravity running?");
  }

  for (const port of info.ports) {
    const u = await postRpc(port, info.csrf, '/exa.language_server_pb.LanguageServerService/GetUserStatus');
    if (u.status === 200) {
      return { port, csrf: info.csrf, pid: info.pid };
    }
  }

  throw new Error(`Found Antigravity process (PID ${info.pid}), but could not connect to HTTPS ConnectRPC on listening ports [${info.ports.join(', ')}].`);
}

function formatPercent(fraction) {
  if (fraction === undefined || fraction === null) return "N/A";
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatTimeRemaining(isoDate) {
  if (!isoDate) return "N/A";
  const target = new Date(isoDate).getTime();
  const now = Date.now();
  const diffMs = target - now;
  if (diffMs <= 0) return "Jetzt fällig (Verfügbar)";

  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const days = Math.floor(diffMinutes / (60 * 24));
  const hours = Math.floor((diffMinutes % (60 * 24)) / 60);
  const mins = diffMinutes % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

function extractFlatBuckets(groups) {
  const map = {};
  for (const g of groups || []) {
    for (const b of g.buckets || []) {
      if (b.bucketId) {
        map[b.bucketId] = {
          remainingFraction: b.remainingFraction ?? 0,
          remainingPercent: Number(((b.remainingFraction ?? 0) * 100).toFixed(2)),
          resetTime: b.resetTime || null,
          disabled: b.disabled || false
        };
      }
    }
  }
  return map;
}

// --- Tool Implementations ---

async function toolGetQuotaSummary(args = {}) {
  const session = await getConnectedSession();
  const res = await postRpc(session.port, session.csrf, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary');
  if (res.status !== 200) {
    throw new Error(`RPC RetrieveUserQuotaSummary failed with HTTP ${res.status}: ${res.body}`);
  }

  const raw = JSON.parse(res.body);
  const groups = raw?.response?.groups || [];

  const summary = groups.map(g => {
    const buckets = (g.buckets || []).map(b => ({
      bucketId: b.bucketId,
      window: b.window,
      displayName: b.displayName,
      remainingPercent: formatPercent(b.remainingFraction),
      remainingFraction: b.remainingFraction,
      resetTime: b.resetTime,
      timeRemaining: formatTimeRemaining(b.resetTime),
      disabled: b.disabled || false,
      description: b.description || ""
    }));

    return {
      groupName: g.displayName,
      description: g.description,
      buckets
    };
  });

  const result = {
    success: true,
    serverPid: session.pid,
    groups: summary
  };

  if (args.include_learnings !== false) {
    const store = loadLearningsStore();
    result.calibrationStats = store.calibrationStats;
    result.activeTrackingsCount = Object.keys(store.activeTrackings || {}).length;
  }

  return result;
}

async function toolGetModelQuotas() {
  const session = await getConnectedSession();
  const res = await postRpc(session.port, session.csrf, '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData');
  if (res.status !== 200) {
    throw new Error(`RPC GetCascadeModelConfigData failed with HTTP ${res.status}: ${res.body}`);
  }

  const raw = JSON.parse(res.body);
  const models = (raw?.clientModelConfigs || []).map(m => ({
    modelId: m.modelId,
    label: m.label,
    isRecommended: m.isRecommended || false,
    tagTitle: m.tagTitle || null,
    quota: m.quotaInfo ? {
      remainingPercent: formatPercent(m.quotaInfo.remainingFraction),
      remainingFraction: m.quotaInfo.remainingFraction,
      resetTime: m.quotaInfo.resetTime,
      timeRemaining: formatTimeRemaining(m.quotaInfo.resetTime)
    } : null,
    allowedTiers: m.allowedTiers || []
  }));

  return {
    success: true,
    serverPid: session.pid,
    modelCount: models.length,
    models
  };
}

async function toolGetUserStatus() {
  const session = await getConnectedSession();
  const res = await postRpc(session.port, session.csrf, '/exa.language_server_pb.LanguageServerService/GetUserStatus');
  if (res.status !== 200) {
    throw new Error(`RPC GetUserStatus failed with HTTP ${res.status}: ${res.body}`);
  }

  const raw = JSON.parse(res.body);
  return {
    success: true,
    serverPid: session.pid,
    userStatus: raw?.userStatus || {},
    userTier: raw?.userTier || "UNKNOWN",
    planStatus: raw?.planStatus || {}
  };
}

async function toolStartQuotaTracking(args) {
  const session = await getConnectedSession();
  const res = await postRpc(session.port, session.csrf, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary');
  if (res.status !== 200) {
    throw new Error(`RPC RetrieveUserQuotaSummary failed with HTTP ${res.status}`);
  }

  const raw = JSON.parse(res.body);
  const buckets = extractFlatBuckets(raw?.response?.groups || []);
  const store = loadLearningsStore();

  const trackingId = `trk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const startTime = new Date().toISOString();

  const isClaudeOrGpt = /claude|sonnet|opus|gpt/i.test(args.model_name || "");
  const primary5hBucketId = isClaudeOrGpt ? "3p-5h" : "gemini-5h";
  const primaryWeeklyBucketId = isClaudeOrGpt ? "3p-weekly" : "gemini-weekly";

  const trackingRecord = {
    trackingId,
    startTime,
    conversationId: args.conversation_id || null,
    taskDescription: args.task_description,
    taskCategory: args.task_category || "other",
    modelName: args.model_name,
    plannedScope: args.planned_scope || null,
    estimated5hPercent: Number(args.estimated_5h_percent),
    estimatedWeeklyPercent: args.estimated_weekly_percent !== undefined ? Number(args.estimated_weekly_percent) : null,
    primary5hBucketId,
    primaryWeeklyBucketId,
    startSnapshots: buckets
  };

  store.activeTrackings[trackingId] = trackingRecord;
  saveLearningsStore(store);

  const modelStats = store.calibrationStats?.byModel?.[args.model_name] || null;
  const categoryStats = store.calibrationStats?.byCategory?.[trackingRecord.taskCategory] || null;

  return {
    success: true,
    message: "Quota tracking started. Call finish_quota_tracking once the task is completed to record real consumption.",
    trackingId,
    startTime,
    currentQuotaSnapshot: {
      bucket5h: buckets[primary5hBucketId] || null,
      bucketWeekly: buckets[primaryWeeklyBucketId] || null
    },
    aiEstimate: {
      estimated5hPercent: trackingRecord.estimated5hPercent,
      estimatedWeeklyPercent: trackingRecord.estimatedWeeklyPercent
    },
    historicalCalibrationHint: {
      globalCalibrationMultiplier: store.calibrationStats?.globalCalibrationMultiplier || 1.0,
      modelHistoricalStats: modelStats,
      categoryHistoricalStats: categoryStats
    }
  };
}

async function toolFinishQuotaTracking(args = {}) {
  const store = loadLearningsStore();
  const activeIds = Object.keys(store.activeTrackings || {});
  if (activeIds.length === 0) {
    throw new Error("No active quota tracking session found. Call start_quota_tracking before starting a task.");
  }

  let targetId = args.tracking_id;
  if (!targetId || !store.activeTrackings[targetId]) {
    if (args.conversation_id) {
      const matching = activeIds.filter(id => store.activeTrackings[id].conversationId === args.conversation_id);
      if (matching.length > 0) targetId = matching[matching.length - 1];
    }
    if (!targetId) {
      targetId = activeIds[activeIds.length - 1];
    }
  }

  const tracking = store.activeTrackings[targetId];
  const endTime = new Date().toISOString();

  const session = await getConnectedSession();
  const res = await postRpc(session.port, session.csrf, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary');
  if (res.status !== 200) {
    throw new Error(`RPC RetrieveUserQuotaSummary failed with HTTP ${res.status}`);
  }

  const raw = JSON.parse(res.body);
  const endBuckets = extractFlatBuckets(raw?.response?.groups || []);

  const b5hStart = tracking.startSnapshots?.[tracking.primary5hBucketId];
  const b5hEnd = endBuckets?.[tracking.primary5hBucketId];
  const bWeeklyStart = tracking.startSnapshots?.[tracking.primaryWeeklyBucketId];
  const bWeeklyEnd = endBuckets?.[tracking.primaryWeeklyBucketId];

  let raw5hUsedPercent = 0;
  let windowResetOccurred = false;
  if (b5hStart && b5hEnd) {
    if (b5hEnd.remainingPercent > b5hStart.remainingPercent + 0.5) {
      // Quota window reset occurred during execution
      windowResetOccurred = true;
      raw5hUsedPercent = Number((100 - b5hEnd.remainingPercent).toFixed(2));
    } else {
      raw5hUsedPercent = Number(Math.max(0, b5hStart.remainingPercent - b5hEnd.remainingPercent).toFixed(2));
    }
  }

  let rawWeeklyUsedPercent = 0;
  if (bWeeklyStart && bWeeklyEnd) {
    if (bWeeklyEnd.remainingPercent <= bWeeklyStart.remainingPercent) {
      rawWeeklyUsedPercent = Number(Math.max(0, bWeeklyStart.remainingPercent - bWeeklyEnd.remainingPercent).toFixed(2));
    }
  }

  const convId = args.conversation_id || tracking.conversationId || null;
  const parallelActivity = scanParallelActivity(tracking.startTime, endTime, convId);

  const attributed5hUsedPercent = Number((raw5hUsedPercent * parallelActivity.thisChatTokenShare).toFixed(2));
  const parallelNoise5hPercent = Number(Math.max(0, raw5hUsedPercent - attributed5hUsedPercent).toFixed(2));
  const estimationError5hPercent = Number((attributed5hUsedPercent - tracking.estimated5hPercent).toFixed(2));

  const durationSeconds = Math.round((new Date(endTime).getTime() - new Date(tracking.startTime).getTime()) / 1000);

  const completedEntry = {
    trackingId: targetId,
    startTime: tracking.startTime,
    endTime,
    durationSeconds,
    conversationId: convId,
    taskDescription: tracking.taskDescription,
    taskCategory: tracking.taskCategory,
    modelName: tracking.modelName,
    plannedScope: tracking.plannedScope,
    actualScopeSummary: args.actual_scope_summary || null,
    estimated5hPercent: tracking.estimated5hPercent,
    estimatedWeeklyPercent: tracking.estimatedWeeklyPercent,
    raw5hUsedPercent,
    attributed5hUsedPercent,
    parallelNoise5hPercent,
    rawWeeklyUsedPercent,
    estimationError5hPercent,
    windowResetOccurred,
    dataQuality: parallelActivity.parallelChatsDetected ? "parallel_adjusted" : "clean_isolated",
    parallelActivity: {
      parallelChatsDetected: parallelActivity.parallelChatsDetected,
      parallelChatsCount: parallelActivity.parallelChatsCount,
      thisChatTokenShare: parallelActivity.thisChatTokenShare,
      warningNote: parallelActivity.warningNote,
      activeConversations: parallelActivity.activeConversations
    },
    endQuotaRemaining: {
      remaining5hPercent: b5hEnd ? b5hEnd.remainingPercent : null,
      remainingWeeklyPercent: bWeeklyEnd ? bWeeklyEnd.remainingPercent : null
    }
  };

  delete store.activeTrackings[targetId];
  store.history.push(completedEntry);
  recomputeCalibrationStats(store);
  saveLearningsStore(store);

  return {
    success: true,
    learningRecorded: true,
    learningsFilePath: LEARNINGS_FILE,
    result: completedEntry,
    updatedCalibrationStats: store.calibrationStats
  };
}

async function toolGetQuotaLearnings(args = {}) {
  const store = loadLearningsStore();
  let history = [...(store.history || [])].reverse();

  if (args.model_name) {
    const q = args.model_name.toLowerCase();
    history = history.filter(h => (h.modelName || "").toLowerCase().includes(q));
  }
  if (args.task_category) {
    history = history.filter(h => h.taskCategory === args.task_category);
  }

  const limit = args.limit || 15;
  return {
    success: true,
    learningsFilePath: LEARNINGS_FILE,
    calibrationStats: store.calibrationStats,
    activeTrackings: store.activeTrackings,
    recentEntries: history.slice(0, limit)
  };
}

// Dispatch MCP tool calls
async function handleToolCall(name, args) {
  if (name === "get_antigravity_quota_summary") {
    return await toolGetQuotaSummary(args);
  }
  if (name === "get_antigravity_model_quotas") {
    return await toolGetModelQuotas();
  }
  if (name === "get_antigravity_user_status") {
    return await toolGetUserStatus();
  }
  if (name === "start_quota_tracking") {
    return await toolStartQuotaTracking(args);
  }
  if (name === "finish_quota_tracking") {
    return await toolFinishQuotaTracking(args);
  }
  if (name === "get_quota_learnings") {
    return await toolGetQuotaLearnings(args);
  }
  throw new Error(`Unknown tool: ${name}`);
}

// Handle incoming JSON-RPC 2.0 messages
async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: SERVER_INFO,
        instructions: MCP_INSTRUCTIONS
      }
    };
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS
      }
    };
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    try {
      const data = await handleToolCall(name, args || {});
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(data, null, 2)
            }
          ]
        }
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: err.message }, null, 2)
            }
          ],
          isError: true
        }
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method '${method}' not found.`
    }
  };
}

// Main stdio loop
function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      const response = await handleMessage(parsed);
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    } catch (err) {
      const errorResponse = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${err.message}`
        }
      };
      process.stdout.write(JSON.stringify(errorResponse) + "\n");
    }
  });
}

main();

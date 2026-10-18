#!/usr/bin/env node
/**
 * Antigravity Quota MCP Server
 * Connects directly to local Antigravity 2.0 language server via ConnectRPC
 * to query 5-hour and 7-day (weekly) quotas, per-model quotas, and user status.
 */

const { execSync } = require('child_process');
const https = require('https');
const readline = require('readline');

// Server Metadata
const SERVER_INFO = {
  name: "antigravity-quota",
  version: "1.0.0"
};

// Available MCP Tools
const TOOLS = [
  {
    name: "get_antigravity_quota_summary",
    description: "Returns the live 5-hour and 7-day (weekly) quota status for Gemini and Claude/GPT models in Antigravity 2.0, including remaining percentages, reset timestamps, and human-readable time remaining.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "get_antigravity_model_quotas",
    description: "Returns detailed live quota information for each individual AI model available in Antigravity 2.0 (Gemini 3.8 Flash/Pro, Claude 3.7 Sonnet, etc.).",
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
  }
];

// Discover Language Server Process & Ports
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

// Make ConnectRPC POST request over HTTPS to localhost
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

// Find working ConnectRPC HTTPS port
async function getConnectedSession() {
  const info = discoverLanguageServer();
  if (!info) {
    throw new Error("Antigravity 2.0 language server process (language_server_windows_x64.exe) not found. Is Antigravity running?");
  }

  for (const port of info.ports) {
    const u = await postRpc(port, info.csrf, '/exa.language_server_pb.LanguageServerService/GetUserStatus');
    if (u.status === 200) {
      return { port, csrf: info.csrf, pid: info.pid };
    }
  }

  throw new Error(`Found Antigravity process (PID ${info.pid}), but could not connect to HTTPS ConnectRPC on listening ports [${info.ports.join(', ')}].`);
}

// Helper: Format percentage
function formatPercent(fraction) {
  if (fraction === undefined || fraction === null) return "N/A";
  return `${(fraction * 100).toFixed(1)}%`;
}

// Helper: Format remaining time until reset
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

// Tool Implementation: get_antigravity_quota_summary
async function toolGetQuotaSummary() {
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

  return {
    success: true,
    serverPid: session.pid,
    groups: summary,
    rawResponse: raw
  };
}

// Tool Implementation: get_antigravity_model_quotas
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

// Tool Implementation: get_antigravity_user_status
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

// Dispatch MCP tool calls
async function handleToolCall(name, args) {
  if (name === "get_antigravity_quota_summary") {
    return await toolGetQuotaSummary();
  }
  if (name === "get_antigravity_model_quotas") {
    return await toolGetModelQuotas();
  }
  if (name === "get_antigravity_user_status") {
    return await toolGetUserStatus();
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
        serverInfo: SERVER_INFO
      }
    };
  }

  if (method === "notifications/initialized") {
    return null; // Notifications do not have responses
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

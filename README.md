# ⚡ Antigravity Quota MCP Server (`antigravity-quota`)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=18](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![Protocol: MCP](https://img.shields.io/badge/MCP-Protocol-purple.svg)](https://modelcontextprotocol.io/)

A zero-dependency Model Context Protocol (MCP) server that connects directly to the local **Google Antigravity 2.0** Language Server via ConnectRPC/gRPC-Web over HTTPS.

Enables AI agents to query live **5-hour (`5h`)** and **7-day (`weekly`)** quota limits, model-level allowances, and user plan tiers in real time.

---

## 🎯 Key Features

- **⚡ Zero External Dependencies:** Built with pure Node.js standard libraries (`https`, `child_process`, `readline`). No bulky `node_modules` required!
- **🔍 Autonomous Discovery:** Automatically locates running Antigravity `language_server.exe` processes, dynamically extracts the `--csrf_token`, and negotiates the active ConnectRPC HTTPS listening port.
- **⏱️ Live Quota Tracking:** Surfaces 5-hour rolling limits and 7-day tier quotas for both **Gemini Models** and **Claude / GPT Models**.
- **📊 Human-Readable Timers:** Calculates remaining percentage and exact countdown until limits reset (e.g. `5d 8h` or `31m`).
- **🛡️ Quota-Aware Orchestration:** Allows AI coding assistants to evaluate capacity *before* starting heavy refactorings, multi-agent swarms, or batch operations.

---

## 🛠️ Available MCP Tools

### 1. `get_antigravity_quota_summary`
Returns the primary 5-hour and 7-day quota status:
```json
{
  "groups": [
    {
      "groupName": "Gemini Models",
      "buckets": [
        {
          "displayName": "Weekly Limit Remaining",
          "remainingPercent": "26.6%",
          "timeRemaining": "5d 8h",
          "resetTime": "2026-10-23T22:22:02Z"
        },
        {
          "displayName": "Five Hour Limit Remaining",
          "remainingPercent": "47.9%",
          "timeRemaining": "31m",
          "resetTime": "2026-10-18T14:05:09Z"
        }
      ]
    },
    {
      "groupName": "Claude and GPT models",
      "buckets": [
        {
          "displayName": "Weekly Limit Remaining",
          "remainingPercent": "0.0%",
          "timeRemaining": "1d 16h",
          "description": "Weekly limit hit, refreshes in 1 day, 16 hours."
        }
      ]
    }
  ]
}
```

### 2. `get_antigravity_model_quotas`
Returns per-model quota info, capabilities, and availability across all active models (Gemini 3.8 Flash, Gemini Pro, Claude 3.7 Sonnet, etc.).

### 3. `get_antigravity_user_status`
Returns user account tier (`TEAMS_TIER_PRO`, `TEAMS_TIER_TEAMS`, etc.), plan state, and language server connectivity health.

---

## 🚀 Setup & Installation

### Option A: Direct Local Integration (Antigravity 2.0)

Add the server to your Antigravity MCP configuration (`~/.gemini/config/mcp_config.json`):

```json
{
  "mcpServers": {
    "antigravity-quota": {
      "command": "node",
      "args": [
        "D:/Projekte/AGY-MCP/antigravity-quota/server.js"
      ]
    }
  }
}
```

Restart Antigravity 2.0 once to register the new server.

---

### Option B: Claude Desktop / Cursor

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "antigravity-quota": {
      "command": "node",
      "args": [
        "/path/to/antigravity-quota/server.js"
      ]
    }
  }
}
```

---

## 🔬 How it Works (Under the Hood)

1. **WMI Process Inspection:** The server runs `Get-CimInstance Win32_Process` to locate active `language_server` instances.
2. **CSRF Extraction:** Pulls the ephemeral `--csrf_token <UUID>` parameter passed to the language server.
3. **Port Scanning:** Resolves TCP listening ports bound to the language server PID via `Get-NetTCPConnection`.
4. **ConnectRPC Querying:** Dispatches POST requests to the internal gRPC-Web endpoints:
   - `/exa.language_server_pb.LanguageServerService/GetUserStatus`
   - `/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`
   - `/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData`
5. **Stdio JSON-RPC:** Formats the returned data and speaks the standard Model Context Protocol over stdin/stdout.

---

## 📜 License

[MIT](LICENSE) © 2026 [NyboTV](https://github.com/NyboTV)

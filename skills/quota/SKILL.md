---
name: quota
description: Live Antigravity 2.0 Quota Inspection, Deep Plan Consumption Forecasting, and Self-Learning Calibration via the antigravity-quota MCP server. Triggered by the /quota slash command or when the user asks how much quota a plan, feature, or task will consume.
---

# 📊 Antigravity Quota & Self-Learning Estimator (`/quota`)

This skill manages live quota checks (`5h` and `weekly` limits) as well as **deep consumption forecasting and self-learning calibration** using the **`antigravity-quota`** MCP server.

---

## 🎯 When to Activate This Skill
1. The user invokes the **`/quota`** slash command (standalone or with arguments).
2. The user asks how much quota a plan, task, or prompt will consume (e.g., *"Wie viel `/quota` würde der Plan verbrauchen?"*, *"Reicht mein Limit für diesen Refactor?"*, *"Schätze den Quota-Verbrauch"*).
3. Before starting massive tasks (multi-agent workflows, deep refactors, or full repository generation) when quota has not been checked in the last 20–30 prompts.
4. A tracked task finishes and requires closing the learning loop via `finish_quota_tracking`.

---

## ⚖️ General Quota Discipline (Anti-Spam & 20–30 Prompt Interval)
- **Small / Everyday Tasks:** Stay relaxed. Do **NOT** query quota on simple questions, minor edits, or routine single-file tasks.
- **20–30 Prompt Cache:** If quota was already checked and remaining limits are healthy (>70–100%), do **NOT** check again on the next request. Wait **20 to 30 prompts** (or until an unusually heavy task arrives) before re-checking.
- **Large Tasks (Passive Check):** When a large task arrives and a check is due, call `get_antigravity_quota_summary` once and provide a **very brief, gentle 1–2 line estimate** of how much will be used and whether the limit is sufficient.

---

## 🛠️ Available MCP Tools (`antigravity-quota`)

| Tool | Purpose |
| :--- | :--- |
| `get_antigravity_quota_summary` | Returns live 5-hour & 7-day (weekly) remaining percentages, reset countdowns, and historical calibration stats. |
| `get_antigravity_model_quotas` | Returns detailed per-model quota fractions for all 13+ models (Gemini 4 Argon, Gemini 3.8 Flash/Pro, Claude, GPT). |
| `get_antigravity_user_status` | Returns account tier (`TEAMS_TIER_PRO`, etc.) and language server connection health. |
| `get_quota_learnings` | Reads historical task benchmarks and calibration multipliers from `quota_learnings.json`. |
| `start_quota_tracking` | Snapshots live quota before a task begins and stores the AI's consumption estimate in `quota_learnings.json`. |
| `finish_quota_tracking` | Measures the real post-task quota drop, detects parallel chat activity via `transcript.jsonl`, isolates true task consumption, and updates `quota_learnings.json`. |

---

## 📋 Execution Modes for `/quota`

### Mode 1: Quick Status Check (`/quota` without a task/plan)
1. Call `get_antigravity_quota_summary(include_learnings=true)`.
2. Present a clean, concise overview of:
   - **Gemini Models:** 5-Hour Limit (`remainingPercent` + reset timer) & Weekly Limit (`remainingPercent` + reset timer).
   - **Claude & GPT Models:** 5-Hour Limit & Weekly Limit.
   - If historical learnings exist (`totalCompletedTasks > 0`), briefly mention the current calibration accuracy (`globalCalibrationMultiplier`).

---

### Mode 2: Deep Plan & Task Consumption Forecast (*"Wie viel `/quota` würde der Plan verbrauchen?"*)
When the user asks how much `/quota` a specific plan, feature, or task will consume, you are explicitly authorized to perform a **thorough consumption analysis**:

#### Step 1: Gather Live Quotas & Historical Benchmarks
1. Call `get_antigravity_quota_summary(include_learnings=true)` and `get_quota_learnings()`.
2. Inspect the scope of the planned task:
   - Number of files to read/create/modify
   - Estimated number of tool calls & terminal executions
   - Whether subagents (`/boost`, `/teamwork-preview`, `invoke_subagent`) are involved
   - The active model's cost weight (e.g., *Flash* = low, *Pro / Argon Medium-High* = moderate-high, *Claude Opus/Sonnet* = 3P bucket).

#### Step 2: Calculate Calibrated Estimate
- Base your estimate on `calibrationStats.byModel` and `calibrationStats.byCategory` if past data exists in `quota_learnings.json`.
- Multiply your raw heuristic by `calibrationMultiplier` (so if the AI historically underestimated by `1.3x`, self-correct automatically).
- Classify the task into one of:
  - `small_fix` (~0.3% – 1.5% of 5h limit)
  - `feature_implementation` (~1.5% – 5.0% of 5h limit)
  - `large_refactor` (~4.0% – 12.0% of 5h limit)
  - `architecture_audit` (~2.0% – 6.0% of 5h limit)
  - `multi_agent_swarm` (~10.0% – 30.0%+ of 5h limit)

#### Step 3: Register Prediction in the Learning Engine (`start_quota_tracking`)
Immediately call `start_quota_tracking`:
- `task_description`: Brief summary of the plan/task
- `task_category`: Matching category enum
- `model_name`: Your current model name
- `estimated_5h_percent`: Your predicted 5h % consumption
- `estimated_weekly_percent`: Your predicted weekly % consumption
- `planned_scope`: e.g. `"5 Dateien, ~12 Tool-Calls, 0 Subagenten"`
- `conversation_id`: Always pass your current `Conversation ID` from `<user_information>`!

#### Step 4: Present the Forecast to the User
Output a clear, structured forecast:
- **Aktuelles Kontingent:** (5h & Weekly Restwert)
- **Geschätzter Verbrauch für diesen Plan:** `~X.X %` (5h-Limit) / `~Y.Y %` (Wochen-Limit)
- **Basis der Schätzung:** (Geplanter Umfang + Info, ob historische Lerndaten aus `quota_learnings.json` eingeflossen sind)
- **Machbarkeit / Empfehlung:** Grünes Licht oder Warnung bei knappem Puffer (inkl. `trackingId` für die spätere Nachmessung).

---

### Mode 3: Post-Task Learning & Parallel-Chat Verification (`finish_quota_tracking`)
Whenever a task or plan that was tracked via `start_quota_tracking` is finished:

1. **MANDATORY:** Call `finish_quota_tracking(tracking_id=..., conversation_id=..., actual_scope_summary=...)` as your final tool call before reporting completion.
2. Present a compact **🧠 Quota-Lern-Bilanz** at the end of your response:
   - **Geschätzt vs. Real (Rohwert):** `X.X %` geschätzt vs. `Y.Y %` gemessener Gesamt-Abzug am 5h-Balken.
   - **⚠️ Parallel-Chat-Prüfung (WICHTIG!):**
     - Prüfe `parallelActivity.parallelChatsDetected` im Tool-Ergebnis!
     - **Falls `false` (`clean_isolated`):** Bestätige kurz: *„Keine parallelen Chats aktiv – 100 % saubere Referenzmessung in `quota_learnings.json` gespeichert.“*
     - **Falls `true` (`parallel_adjusted`):** Weise **explizit** darauf hin:
       > *„⚠️ Hinweis: Während der Ausführung liefen **N andere Chats parallel** (Fremdanteil ca. Z % der Token-Last = ~P % Quota). Der bereinigte Eigenverbrauch dieses Tasks lag bei **~A.A %** (Gesamtabzug inkl. Nachbar-Chats: **Y.Y %**). Die Lern-Datei wurde entsprechend bereinigt aktualisiert.“*

# 📊 Antigravity Quota — Self-Learning & Estimation Protocol

> This rule is automatically applied while the `antigravity-quota` plugin/MCP is enabled.

---

## 1. ⚡ Passive Background Checks vs. Active `/quota` Forecasting

1. **Everyday Tasks (No Spam):**
   - Do **NOT** call quota tools on small questions, minor edits, or routine single-file tasks.
   - If you already checked quota within the last **20–30 prompts** and remaining limits were healthy (>70%), rely on that cached knowledge.

2. **Proactive Check Before Heavy Workloads:**
   - Before starting massive tasks (`/teamwork-preview`, `/boost`, multi-file architecture refactors, or full repository generation), call `get_antigravity_quota_summary` once and output a concise 1–2 line status note.

3. **Active `/quota` Command & Plan Consumption Questions (Self-Learning Mode):**
   - Whenever the user uses **`/quota`** or asks **how much quota a plan, feature, or task will consume** (e.g., *"Wie viel `/quota` würde der Plan verbrauchen?"*):
     1. **Deep Inspection Allowed:** You are explicitly authorized to inspect the plan/files, query `get_quota_learnings()`, and calculate a detailed, calibrated forecast based on historical data in `quota_learnings.json`.
     2. **Start Tracking (`start_quota_tracking`):** Always record your estimate and the pre-task quota snapshot by calling `start_quota_tracking(..., conversation_id="<current-chat-id>")`.
     3. **Finish Tracking (`finish_quota_tracking`):** Once the tracked plan/task is executed and completed, you **MUST** call `finish_quota_tracking(conversation_id="<current-chat-id>")` to measure the real consumption delta and update `quota_learnings.json`.
     4. **Mandatory Parallel-Chat Disclosure:** Always report whether parallel chats were active during the task (`parallelActivity.parallelChatsDetected`). Explicitly state that parallel chats running at the same time also consume shared account quota, and show both the **raw total drop** (`raw5hUsedPercent`) and the **isolated task consumption** (`attributed5hUsedPercent`).

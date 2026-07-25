// scripts/locomo-ingest.js
//
// LoCoMo ingestion harness — reads a locomo10.json file and feeds every
// conversation into the ACB memory system session-by-session, preserving:
//   • speaker names via message_turns (C2 multi-party path)
//   • real timestamps parsed from the session_N_date_time strings
//   • session boundaries → thread switches (rebalancer fires between sessions)
//
// USAGE:
//   node scripts/locomo-ingest.js /absolute/path/to/locomo/data/locomo10.json
//   node scripts/locomo-ingest.js /path/to/locomo10.json --conversation 0   (single conversation pilot)
//   node scripts/locomo-ingest.js /path/to/locomo10.json --dry-run           (parse only, no DB writes)
//
// This script talks directly to the DB via the same helpers the app uses. It
// does NOT go through HTTP — that would be 10x slower and this is a benchmark.

const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

// Resolve DB paths the same way the app does — cwd() must be the acb root.
// Locate acb.db — the app uses DATA_DIR = join(process.cwd(), 'data'), so
// prefer data/acb.db. Fall back to a root-level acb.db only if that's all
// that exists.
const CANDIDATE_DB_PATHS = [
  path.join(process.cwd(), 'data', 'acb.db'),
  path.join(process.cwd(), 'acb.db'),
];
const dbPath = CANDIDATE_DB_PATHS.find((p) => fs.existsSync(p));
if (!dbPath) {
  console.error('[locomo-ingest] Could not find acb.db. Start the app once (npm run dev) so migrations create data/acb.db, then run this from the acb project root.');
  console.error('  Looked in: ' + CANDIDATE_DB_PATHS.join(', '));
  process.exit(1);
}
console.log(`[locomo-ingest] Using database: ${dbPath}`);

const Database = require('better-sqlite3');
const coreDb = new Database(dbPath);
coreDb.pragma('journal_mode = WAL');
coreDb.pragma('foreign_keys = ON');

// ── Parse args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/locomo-ingest.js <path-to-locomo10.json> [--conversation N] [--dry-run]');
  process.exit(1);
}
const inputPath = args[0];
const conversationOnlyIdx = (() => {
  const i = args.indexOf('--conversation');
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : null;
})();
const dryRun = args.includes('--dry-run');
const noSummaries = args.includes('--no-summaries');

if (!fs.existsSync(inputPath)) {
  console.error(`[locomo-ingest] File not found: ${inputPath}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
if (!Array.isArray(raw)) {
  console.error('[locomo-ingest] Expected top-level list of conversations.');
  process.exit(1);
}

const conversations = conversationOnlyIdx !== null ? [raw[conversationOnlyIdx]] : raw;
console.log(`[locomo-ingest] Loaded ${raw.length} conversation(s) from ${inputPath}; ingesting ${conversations.length}${conversationOnlyIdx !== null ? ` (index ${conversationOnlyIdx})` : ''}${dryRun ? ' — DRY RUN, no DB writes' : ''}`);

// ── Parse "1:56 pm on 8 May, 2023" → epoch ms + ISO ─────────────────────────
function parseLoCoMoDateTime(s) {
  if (!s || typeof s !== 'string') return { ms: Date.now(), iso: new Date().toISOString() };
  // Format: "1:56 pm on 8 May, 2023"
  const m = s.match(/(\d+):(\d+)\s*(am|pm)\s+on\s+(\d+)\s+(\w+),\s*(\d{4})/i);
  if (!m) {
    console.warn(`[locomo-ingest] Could not parse date-time "${s}"; using current time.`);
    return { ms: Date.now(), iso: new Date().toISOString() };
  }
  let [_, hh, mm, ampm, dd, monName, yyyy] = m;
  hh = Number(hh); mm = Number(mm); dd = Number(dd); yyyy = Number(yyyy);
  if (ampm.toLowerCase() === 'pm' && hh < 12) hh += 12;
  if (ampm.toLowerCase() === 'am' && hh === 12) hh = 0;
  const monthIdx = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(monName.slice(0, 3).toLowerCase());
  const d = new Date(Date.UTC(yyyy, monthIdx, dd, hh, mm));
  return { ms: d.getTime(), iso: d.toISOString() };
}

// ── Prepared statements ────────────────────────────────────────────────────
const insertBranch = coreDb.prepare(`
  INSERT INTO branches (id, conversation_id, parent_branch_id, divergence_message_id, status, created_at, closed_at)
  VALUES (?, ?, NULL, '', 'active', ?, NULL)
`);
const closeBranch = coreDb.prepare(`UPDATE branches SET status = 'closed', closed_at = ? WHERE id = ?`);
const insertMessage = coreDb.prepare(`
  INSERT INTO messages (id, conversation_id, branch_id, sequence_number, user_content, assistant_content, timestamp, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertTurn = coreDb.prepare(`
  INSERT OR REPLACE INTO message_turns (id, message_id, conversation_id, branch_id, sequence_in_message, speaker, content, timestamp, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertBranchMessage = coreDb.prepare(`
  INSERT OR IGNORE INTO branch_messages (branch_id, message_id, created_at) VALUES (?, ?, ?)
`);
const insertTrajectory = coreDb.prepare(`
  INSERT OR REPLACE INTO trajectory_state (
    id, conversation_id, branch_id, parent_trajectory_id, status,
    label, active_goal, summary, state_json,
    stability, drift_pressure, continuity_score, last_message_id, created_at, updated_at, closed_at
  ) VALUES (?, ?, ?, NULL, 'closed', ?, ?, ?, '{}', 0.5, 0.0, 1.0, NULL, ?, ?, ?)
`);

// ── Model-call summary generator ─────────────────────────────────────────────
// Produces a trajectory summary for one session-branch from its turns — the
// same kind of summary the live topology evaluator writes, so the clusterer
// can group LoCoMo branches exactly as it groups live branches.
const MODEL_KEY = (process.env.OPENAI_API_KEY || process.env.MODEL_API_KEY || '').trim();
const MODEL_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim();
const SUMMARY_MODEL = (process.env.LOCOMO_SUMMARY_MODEL || 'gpt-4o-mini').trim();

async function summarizeBranch(turnsText) {
  if (!MODEL_KEY) throw new Error('No OPENAI_API_KEY / MODEL_API_KEY set — cannot generate summaries. Set the key or run with --no-summaries.');
  const system = 'You summarise one session of a conversation for a memory index. Return ONLY a compact JSON object: {"label": "<3-6 word topic label>", "active_goal": "<one sentence: what the speakers were doing/discussing>", "summary": "<2-3 sentence factual summary of what was said, names and specifics preserved>"}. No prose, no markdown.';
  const res = await fetch(`${MODEL_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MODEL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: turnsText.slice(0, 12000) }],
      temperature: 0.2,
      max_tokens: 400,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`summary HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '{}';
  let parsed = {};
  try { parsed = JSON.parse(content); } catch { /* leave empty */ }
  return {
    label: String(parsed.label ?? '').slice(0, 200),
    active_goal: String(parsed.active_goal ?? '').slice(0, 500),
    summary: String(parsed.summary ?? '').slice(0, 1500),
  };
}

// ── Ingest one conversation ────────────────────────────────────────────────
async function ingestConversation(sample, idx) {
  const conversationId = `locomo_${String(sample.sample_id ?? idx).replace(/[^a-z0-9_-]/gi, '-')}`;
  const conv = sample.conversation;
  if (!conv) { console.warn(`[locomo-ingest] Conversation ${idx} has no 'conversation' block; skipping.`); return 0; }

  const sessionKeys = Object.keys(conv).filter((k) => k.startsWith('session_') && !k.endsWith('_date_time')).sort((a, b) => {
    const na = Number(a.replace('session_', ''));
    const nb = Number(b.replace('session_', ''));
    return na - nb;
  });

  let totalTurns = 0;
  let globalSeq = 0;
  // Collect per-branch turn text (for summary generation after the write tx).
  const branchInfo = []; // { branchId, dt, turnsText }

  const tx = coreDb.transaction(() => {
    for (const sk of sessionKeys) {
      const turns = conv[sk];
      const dt = parseLoCoMoDateTime(conv[`${sk}_date_time`]);
      const branchId = `${conversationId}__${sk}`;
      insertBranch.run(branchId, conversationId, dt.iso);

      const lines = [];
      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        const speaker = String(turn.speaker ?? 'unknown');
        const text = String(turn.text ?? '');
        if (!text.trim()) continue;

        const messageId = `${branchId}__${String(turn.dia_id ?? `t${i}`).replace(/:/g, '-')}`;
        insertMessage.run(messageId, conversationId, branchId, globalSeq, '', '', dt.ms, dt.iso);
        insertTurn.run(`${messageId}:t0`, messageId, conversationId, branchId, 0, speaker, text, dt.ms, dt.iso);
        insertBranchMessage.run(branchId, messageId, dt.iso);
        lines.push(`${speaker}: ${text}`);
        globalSeq += 1;
        totalTurns += 1;
      }

      closeBranch.run(new Date(dt.ms + 1000).toISOString(), branchId);
      branchInfo.push({ branchId, dt, turnsText: lines.join('\n') });
    }
  });

  if (dryRun) {
    console.log(`[locomo-ingest] Conversation ${idx} (${conversationId}) → ${sessionKeys.length} sessions, ${totalTurns} turns (DRY RUN, not written).`);
    return totalTurns;
  }
  tx();

  // ── Trajectory summaries (unless --no-summaries) ──────────────────────────
  // One model call per branch, in parallel batches, writing a trajectory_state
  // row so the clusterer sees real branch summaries — exactly like live data.
  if (!noSummaries) {
    console.log(`[locomo-ingest] Conversation ${idx}: generating ${branchInfo.length} branch summaries (model=${SUMMARY_MODEL})…`);
    const BATCH = 5;
    let done = 0;
    for (let b = 0; b < branchInfo.length; b += BATCH) {
      const slice = branchInfo.slice(b, b + BATCH);
      await Promise.all(slice.map(async (bi) => {
        try {
          const s = await summarizeBranch(bi.turnsText);
          insertTrajectory.run(
            `${bi.branchId}__traj`, conversationId, bi.branchId,
            s.label, s.active_goal, s.summary, bi.dt.iso, bi.dt.iso, new Date(bi.dt.ms + 1000).toISOString(),
          );
        } catch (e) {
          console.warn(`[locomo-ingest]   summary failed for ${bi.branchId}: ${e.message}`);
        }
      }));
      done += slice.length;
      console.log(`[locomo-ingest]   summaries ${done}/${branchInfo.length}`);
    }
  }

  console.log(`[locomo-ingest] Conversation ${idx} (${conversationId}) → ${sessionKeys.length} sessions, ${totalTurns} turns ingested${noSummaries ? ' (no summaries)' : ' + trajectory summaries'}.`);
  return totalTurns;
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
  let grandTotal = 0;
  for (let i = 0; i < conversations.length; i++) {
    grandTotal += await ingestConversation(conversations[i], conversationOnlyIdx !== null ? conversationOnlyIdx : i);
  }
  console.log(`[locomo-ingest] DONE — ${grandTotal} turns total across ${conversations.length} conversation(s).`);
  console.log(`[locomo-ingest] Next: POST /api/locomo-rebuild to cluster + shard, then run scripts/locomo-eval.js`);
})();

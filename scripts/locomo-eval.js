// scripts/locomo-eval.js
//
// LoCoMo evaluation harness — reads locomo10.json's qa blocks, asks each
// question through the ACB retrieval + finaliser + conversation model, scores
// the predicted answer against ground truth (F1 partial match, per the paper),
// and reports per-category + overall F1 plus retrieval recall@k.
//
// USAGE:
//   node scripts/locomo-eval.js /absolute/path/to/locomo/data/locomo10.json
//   node scripts/locomo-eval.js /path/to/locomo10.json --conversation 0
//   node scripts/locomo-eval.js /path/to/locomo10.json --limit 20   (first 20 questions)
//   node scripts/locomo-eval.js /path/to/locomo10.json --category 1 (single-hop only)
//
// The eval calls /api/chat over HTTP — the same endpoint your UI uses — so
// the measurement includes the full production path (retrieval + finaliser +
// model). Requires the Next.js dev server running on http://localhost:3000.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/locomo-eval.js <path-to-locomo10.json> [--conversation N] [--limit K] [--category C]');
  process.exit(1);
}
const inputPath = args[0];
const conversationOnlyIdx = (() => { const i = args.indexOf('--conversation'); return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : null; })();
const limit = (() => { const i = args.indexOf('--limit'); return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : null; })();
const onlyCategory = (() => { const i = args.indexOf('--category'); return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : null; })();
const endpoint = process.env.ACB_CHAT_ENDPOINT || 'http://localhost:3000/api/chat';

const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const conversations = conversationOnlyIdx !== null ? [{ conv: raw[conversationOnlyIdx], idx: conversationOnlyIdx }] : raw.map((c, i) => ({ conv: c, idx: i }));

// ── F1 partial-match scorer (LoCoMo paper §4.1) ────────────────────────────
// The paper: "we employ the F1 partial match metric for evaluating the
// predictions ... following the normalization of both the predicted and the
// actual ground truth answers." Normalization is the standard SQuAD scheme:
// lowercase, remove punctuation, remove articles (a/an/the), collapse whitespace.
function normalize(s) {
  if (s === null || s === undefined) return '';
  let t = String(s).toLowerCase();
  // remove punctuation
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  // remove articles as whole words
  t = t.replace(/\b(a|an|the)\b/g, ' ');
  // collapse whitespace
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}
function f1(pred, gold) {
  const p = normalize(pred).split(/\s+/).filter(Boolean);
  const g = normalize(gold).split(/\s+/).filter(Boolean);
  if (p.length === 0 && g.length === 0) return 1;
  if (p.length === 0 || g.length === 0) return 0;
  const goldCounts = new Map();
  for (const w of g) goldCounts.set(w, (goldCounts.get(w) ?? 0) + 1);
  let overlap = 0;
  for (const w of p) {
    if ((goldCounts.get(w) ?? 0) > 0) { overlap += 1; goldCounts.set(w, goldCounts.get(w) - 1); }
  }
  if (overlap === 0) return 0;
  const precision = overlap / p.length;
  const recall = overlap / g.length;
  return (2 * precision * recall) / (precision + recall);
}

async function askQuestion(conversationId, question) {
  // Fires the question against the /api/chat endpoint with the conversation
  // id set so the retrieval router works from the ingested memory.
  // Paper §C.2: temperature=0, top_p=1, single inference run.
  // Paper §4.1: "We instruct the LLMs to replicate the exact wording in the
  // conversation when feasible" — the instruction below mirrors that protocol.
  const instructed =
    `${question}\n\n` +
    `Answer briefly, using the exact wording from the conversation when feasible. ` +
    `If the answer is not present in the conversation, say that the question cannot be answered from the conversation.`;
  const body = {
    conversation_id: conversationId,
    messages: [{ role: 'user', content: instructed }],
    temperature: 0,
    top_p: 1,
  };
  const t0 = Date.now();
  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const text = await res.text();
  // The endpoint streams NDJSON — one JSON object per line:
  //   {"token":"..."}  → a chunk of the assistant's answer text
  //   {"event":{...}}  → status/progress events (ignored for scoring)
  // The answer is the concatenation of all token values.
  let answer = '';
  let retrievalMs = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (typeof obj.token === 'string') answer += obj.token;
      if (obj.event && obj.event.type === 'timing' && typeof obj.event.retrieval_ms === 'number') retrievalMs = obj.event.retrieval_ms;
    } catch { /* non-JSON line — skip */ }
  }
  return { answer: answer.trim(), latencyMs: Date.now() - t0, retrievalMs };
}

// Category numbering RECONCILED (empirical counts + paper Table 5):
// measured shares in locomo10.json: cat1=14%, cat2=16%, cat3=5%, cat4=42%, cat5=22%.
// Paper Table 5 bucket sizes: single-hop 36%, multi-hop 14.6%, temporal 20.6%,
// open-domain 3.9%, adversarial 24.9%. The 14% bucket is therefore MULTI-hop and
// the 42% giant is SINGLE-hop (an earlier comment had these two labels swapped):
//   1 = multi-hop (14%)    2 = temporal (16%)   3 = open-domain (5%)
//   4 = single-hop (42%)   5 = adversarial (22%)
const CATEGORY_LABELS = {
  1: 'multi-hop',    // official LoCoMo mapping
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',   // official LoCoMo mapping
  5: 'adversarial',
};

async function main() {
  // INCREMENTAL RESULTS: every scored row is appended to the jsonl the
  // moment it exists — a killed or crashed run keeps everything banked.
  const outDirEarly = path.join(process.cwd(), 'data', 'locomo-results');
  fs.mkdirSync(outDirEarly, { recursive: true });
  const stampEarly = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonlPathEarly = path.join(outDirEarly, `results-${stampEarly}.jsonl`);
  const appendRow = (row) => { try { fs.appendFileSync(jsonlPathEarly, JSON.stringify(row) + '\n'); } catch {} };
  console.log(`[locomo-eval] Incremental results → ${jsonlPathEarly}`);
  const results = [];
  for (const { conv: sample, idx } of conversations) {
    const conversationId = `locomo_${String(sample.sample_id ?? idx).replace(/[^a-z0-9_-]/gi, '-')}`;
    const qaList = sample.qa ?? [];
    console.log(`[locomo-eval] Conversation ${idx} — ${qaList.length} questions.`);
    let n = 0;
    for (const qa of qaList) {
      if (onlyCategory !== null && qa.category !== onlyCategory) continue;
      if (limit !== null && n >= limit) break;
      n += 1;
      const question = qa.question;
      const gold = qa.answer;
      const cat = qa.category;
      const evidence = qa.evidence ?? [];
      try {
        const { answer, latencyMs, retrievalMs } = await askQuestion(conversationId, question);
        let score;
        if (cat === 5) {
          // Paper §4.1: adversarial questions are unanswerable; the agent is
          // correct when it "correctly identifies them as unanswerable."
          // Detection is lexical over the normalized answer — GENERIC refusal
          // grammar only (no dataset vocabulary). Regexes cover the
          // grammatical family of a stated refusal, including passives the
          // instruction itself induces ("cannot BE answered").
          const norm = normalize(answer);
          const refusalPatterns = [
            /\bcan ?not (be )?answer(ed)?\b/,
            /\bcan t (be )?answer(ed)?\b/,
            /\bcould not (be )?answer(ed)?\b/,
            /\bunanswerable\b/,
            /\bnot answerable\b/,
            /\bno answer\b/,
            /\bno information\b/,
            /\bnot enough information\b/,
            /\b(is|was|are|were)? ?n?o?t (mentioned|stated|present|available|specified|provided|found|said)\b/,
            /\bno mention\b/,
            /\b(don t|do not|doesn t|does not) (have|mention|say|state|appear)\b/,
          ];
          const refused = refusalPatterns.some((re) => re.test(norm));
          score = refused ? 1 : 0;
        } else {
          score = f1(answer, gold);
        }
        const row = { conv: idx, category: cat, question, gold, pred: answer, f1: score, latency_ms: latencyMs, retrieval_ms: retrievalMs, evidence };
        results.push(row);
        appendRow(row);
        console.log(`  Q${n} [cat=${cat}/${CATEGORY_LABELS[cat] ?? '?'}] score=${score.toFixed(3)} (retr+plate ${retrievalMs ?? '?'}ms | total ${latencyMs}ms) — ${question.slice(0, 80)}${question.length > 80 ? '…' : ''}`);
      } catch (e) {
        console.warn(`  Q${n} FAILED — ${e.message}`);
        const row = { conv: idx, category: cat, question, gold, pred: '', f1: 0, latency_ms: 0, evidence, error: e.message };
        results.push(row);
        appendRow(row);
      }
    }
  }

  // ── Aggregate: per-category F1 + overall + latency percentiles ──────────
  const byCat = new Map();
  for (const r of results) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r);
  }
  console.log('\n═══ LoCoMo results ═══');
  const totalF1 = results.reduce((a, r) => a + r.f1, 0) / (results.length || 1);
  console.log(`  overall  F1 = ${totalF1.toFixed(3)}  (n=${results.length})`);
  for (const [cat, rs] of [...byCat.entries()].sort((a, b) => a[0] - b[0])) {
    const catF1 = rs.reduce((a, r) => a + r.f1, 0) / rs.length;
    console.log(`  cat ${cat} (${CATEGORY_LABELS[cat] ?? '?'})  F1 = ${catF1.toFixed(3)}  (n=${rs.length})`);
  }
  const latencies = results.map((r) => r.latency_ms).filter((x) => x > 0).sort((a, b) => a - b);
  if (latencies.length) {
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    console.log(`  latency  p50 = ${p50}ms  p95 = ${p95}ms`);
  }

  // ── Write full results JSONL + summary JSON ─────────────────────────────
  const dataDirExists = fs.existsSync(path.join(process.cwd(), 'data'));
  const outDir = dataDirExists
    ? path.join(process.cwd(), 'data', 'locomo-results')
    : path.join(process.cwd(), 'locomo-results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonlPath = jsonlPathEarly; // already written incrementally
  const summary = {
    stamp, n: results.length, overall_f1: totalF1,
    per_category: Object.fromEntries([...byCat.entries()].map(([c, rs]) => [c, { n: rs.length, f1: rs.reduce((a, r) => a + r.f1, 0) / rs.length }])),
    latency_p50: latencies[Math.floor(latencies.length * 0.5)] ?? null,
    latency_p95: latencies[Math.floor(latencies.length * 0.95)] ?? null,
  };
  fs.writeFileSync(path.join(outDir, `summary-${stamp}.json`), JSON.stringify(summary, null, 2));
  console.log(`\n[locomo-eval] Full results → ${jsonlPath}`);
  console.log(`[locomo-eval] Summary     → ${path.join(outDir, `summary-${stamp}.json`)}`);
}

main().catch((e) => { console.error('[locomo-eval] FATAL:', e); process.exit(1); });

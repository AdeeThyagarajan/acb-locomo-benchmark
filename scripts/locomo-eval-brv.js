// scripts/locomo-eval-brv.js
// ByteRover level-evaluation parity harness. Copy of locomo-eval.js with 3 changes:
//   1. constant conversation_id ('brv_global') so no active-card hint leaks
//   2. raw question only (no Mem0 "answer briefly / cannot be answered" suffix)
//   3. posts to /api/chat-brv with model = BRV_MOUTH (default gemini-3-pro)
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/locomo-eval-brv.js <path-to-locomo10.json> [--limit K] [--category C]');
  process.exit(1);
}
const inputPath = args[0];
const limit = (() => { const i = args.indexOf('--limit'); return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : null; })();
const onlyCategory = (() => { const i = args.indexOf('--category'); return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : null; })();
const endpoint = process.env.ACB_CHAT_ENDPOINT || 'http://localhost:3000/api/chat-brv';
const MOUTH = process.env.BRV_MOUTH || 'gemini-3-pro';

const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const conversations = raw.map((c, i) => ({ conv: c, idx: i }));

async function askQuestion(question) {
  const body = {
    conversation_id: 'brv_global',
    messages: [{ role: 'user', content: question }],
    model: MOUTH,
    temperature: 0,
    top_p: 1,
  };
  const t0 = Date.now();
  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const text = await res.text();
  let answer = '';
  let retrievalMs = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (typeof obj.token === 'string') answer += obj.token;
      if (obj.event && obj.event.type === 'timing' && typeof obj.event.retrieval_ms === 'number') retrievalMs = obj.event.retrieval_ms;
    } catch { /* skip */ }
  }
  return { answer: answer.trim(), latencyMs: Date.now() - t0, retrievalMs };
}

const CATEGORY_LABELS = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' };

async function main() {
  const outDir = path.join(process.cwd(), 'data', 'locomo-results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonlPath = path.join(outDir, `results-brv-${stamp}.jsonl`);
  const appendRow = (row) => { try { fs.appendFileSync(jsonlPath, JSON.stringify(row) + '\n'); } catch {} };
  console.log(`[locomo-eval-brv] mouth=${MOUTH} endpoint=${endpoint}`);
  console.log(`[locomo-eval-brv] Incremental results → ${jsonlPath}`);
  const results = [];
  for (const { conv: sample, idx } of conversations) {
    const qaList = sample.qa ?? [];
    console.log(`[locomo-eval-brv] Conversation ${idx} — ${qaList.length} questions.`);
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
        const { answer, latencyMs, retrievalMs } = await askQuestion(question);
        const row = { conv: idx, category: cat, question, gold, pred: answer, latency_ms: latencyMs, retrieval_ms: retrievalMs, evidence };
        results.push(row);
        appendRow(row);
        console.log(`  Q${n} [cat=${cat}/${CATEGORY_LABELS[cat] ?? '?'}] (${retrievalMs ?? '?'}ms | total ${latencyMs}ms) — ${question.slice(0, 80)}${question.length > 80 ? '…' : ''}`);
      } catch (e) {
        console.warn(`  Q${n} FAILED — ${e.message}`);
        const row = { conv: idx, category: cat, question, gold, pred: '', latency_ms: 0, evidence, error: e.message };
        results.push(row);
        appendRow(row);
      }
    }
  }
  console.log(`\n[locomo-eval-brv] Done. ${results.length} rows → ${jsonlPath}`);
  console.log(`[locomo-eval-brv] Judge it:`);
  console.log(`  node scripts/locomo-judge.js "${jsonlPath}"`);
  console.log(`  node scripts/locomo-judge.js "${jsonlPath}" --provider gemini --model gemini-3-flash`);
}

main().catch((e) => { console.error('[locomo-eval-brv] FATAL:', e); process.exit(1); });

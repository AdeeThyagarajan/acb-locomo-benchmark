// scripts/locomo-judge-brv.js
//
// BYTEROVER-PARITY JUDGE PASS. Prompt reproduced WORD FOR WORD from
// brv-bench/brv_bench/metrics/_judge/prompts.py (_DEFAULT_PREAMBLE +
// _JUDGE_SUFFIX — the LoCoMo-style default their harness applies when a
// question has no LongMemEval category). Settings per their constants.py /
// client.py: model gpt-4o-2024-08-06 (OPENAI_DEFAULT_MODEL), temperature 0.0.
//
// Scope note: run over cat 1-4 by default for comparability with the
// Mem0-protocol row. Their edge-case clause ("gold says not mentioned" →
// refusal counts CORRECT) is dormant on cats 1-4. Pass --include-adversarial
// to also judge cat 5 under that clause (their harness's wider scope) — that
// number is NOT comparable to the 1540-row cat 1-4 rows.
//
// USAGE:
//   node scripts/locomo-judge-brv.js <results-*.jsonl> [--model gpt-4o-2024-08-06] [--include-adversarial]

const fs = require('fs');

const args = process.argv.slice(2);
const jsonlPath = args.find((a) => !a.startsWith('--'));
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const JUDGE_MODEL = flag('--model', 'gemini-2.5-flash');
const PROVIDER = flag('--provider', /^gemini/i.test(JUDGE_MODEL) ? 'gemini' : 'openai');
const INCLUDE_ADV = args.includes('--include-adversarial');
const CONCURRENCY = Math.max(1, Number(process.env.JUDGE_CONCURRENCY) || 8);

if (!jsonlPath || !fs.existsSync(jsonlPath)) {
  console.error('Usage: node scripts/locomo-judge-brv.js <results-*.jsonl> [--model <id>] [--include-adversarial]');
  process.exit(1);
}

// ─── VERBATIM brv-bench default judge prompt (prompts.py) ───────────────────
// _DEFAULT_PREAMBLE + _JUDGE_SUFFIX, with {question}/{expected_answer}/
// {predicted_answer} substituted. The doubled braces in their suffix are
// Python .format() escapes — rendered here as literal single braces.
const JUDGE_PROMPT = ({ question, gold, pred }) => `Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data:
(1) a question (posed by one user to another user),
(2) a 'gold' (ground truth) answer,
(3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.
There's an edge case where the actual answer can't be found in the data and in that case the gold answer will say so (e.g. 'You did not mention this information.'); if the generated answer says that it cannot be answered or it doesn't know all the details, it should be counted as CORRECT.

Question: ${question}
Gold answer: ${gold}
Generated answer: ${pred}
First, provide a short (one sentence) explanation of your reasoning. Short reasoning is preferred.

Respond with EXACTLY this JSON format, nothing else:
{"reasoning": "<one sentence>", "verdict": "correct"}
or
{"reasoning": "<one sentence>", "verdict": "incorrect"}`;

async function callJudge(prompt) {
  if (PROVIDER === 'gemini') {
    const gkey = process.env.GEMINI_API_KEY?.trim();
    if (!gkey) { console.error('Set GEMINI_API_KEY.'); process.exit(1); }
    const base = process.env.GEMINI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta';
    const res = await fetch(`${base}/models/${encodeURIComponent(JUDGE_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': gkey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        // Their client: thinking disabled entirely (GEMINI_THINKING_BUDGET_DISABLED=0),
        // temperature 0.0, generous output cap (JUDGE_MAX_TOKENS).
        generationConfig: { temperature: 0.0, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    if (!res.ok) throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  }
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) { console.error('Set OPENAI_API_KEY.'); process.exit(1); }
  const res = await fetch((process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1') + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: JUDGE_MODEL, temperature: 0.0, max_tokens: 8192, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function parseVerdict(text) {
  // Their client strips markdown fences before JSON-parsing; mirror that.
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      const obj = JSON.parse(m[0]);
      const v = String(obj.verdict ?? '').toLowerCase();
      if (v === 'correct') return 1;
      if (v === 'incorrect') return 0;
    }
  } catch { /* fall through */ }
  const low = cleaned.toLowerCase();
  const hasC = /\bcorrect\b/.test(low) && !/\bincorrect\b/.test(low);
  if (hasC) return 1;
  if (/\bincorrect\b/.test(low)) return 0;
  return null; // ambiguous → retry
}

const CATEGORY_LABELS = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' };

(async () => {
  const rows = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const scorable = rows.filter((r) => !r.error && r.pred !== '' && (INCLUDE_ADV || r.category !== 5));
  const skipped = rows.length - scorable.length;
  console.log(`[locomo-judge-brv] ${rows.length} rows → ${scorable.length} scorable (${INCLUDE_ADV ? 'cat 1-5' : 'cat 1-4'}; ${skipped} excluded), judge=${JUDGE_MODEL} (${PROVIDER}), temp=0.0, prompt=brv-bench default (verbatim)`);

  const outPath = jsonlPath.replace(/\.jsonl$/, '.judged-brv-gemini.jsonl');
  fs.writeFileSync(outPath, '');
  const judged = [];
  let done = 0;
  const queue = [...scorable];

  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      let verdict = null;
      let reasoningText = '';
      for (let attempt = 0; attempt < 4 && verdict === null; attempt++) {
        try {
          const text = await callJudge(JUDGE_PROMPT({ question: row.question, gold: row.gold ?? '', pred: row.pred ?? '' }));
          reasoningText = text.slice(0, 300);
          verdict = parseVerdict(text);
        } catch (e) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
      }
      const out = { ...row, judge: verdict ?? 0, judge_raw: reasoningText, judge_error: verdict === null ? true : undefined };
      judged.push(out);
      fs.appendFileSync(outPath, JSON.stringify(out) + '\n');
      done += 1;
      if (done % 50 === 0) console.log(`[locomo-judge-brv] ${done}/${scorable.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const by = {};
  for (const r of judged) (by[r.category] = by[r.category] || []).push(r.judge);
  console.log('\n═══ LoCoMo LLM-judge results (ByteRover/brv-bench judge, verbatim) ═══');
  console.log(`  overall  accuracy = ${(mean(judged.map((r) => r.judge)) * 100).toFixed(1)}%  (n=${judged.length}, ${INCLUDE_ADV ? 'cat 1-5' : 'cat 1-4'})`);
  for (const c of Object.keys(by).sort()) {
    console.log(`  cat ${c} (${CATEGORY_LABELS[c] ?? '?'})  accuracy = ${(mean(by[c]) * 100).toFixed(1)}%  (n=${by[c].length})`);
  }
  console.log(`\n[locomo-judge-brv] Judged rows → ${outPath}`);
})();

// scripts/locomo-judge.js
//
// LLM-JUDGE PASS — CONTROLLED HARNESS. The judge prompt below is reproduced
// WORD FOR WORD from the public Mem0-protocol LoCoMo judge (as published in
// Backboard's open benchmark repo, which the leaderboard numbers use):
// prompt verbatim, temperature=0.1, JSON {reasoning,label} response, and the
// protocol's category scope: categories 1-4 only (adversarial is excluded
// from the judge protocol; its gold answers are empty and the leaderboard
// tables carry no adversarial column).
//
// Judge model: the reference harness uses OpenAI GPT-4.1. Default here is
// gpt-4.1 for a fully controlled comparison (needs OPENAI_API_KEY, ~$2-3 for
// the full set). --model / --provider let you substitute (e.g. Sonnet on
// Anthropic) — that keeps the prompt controlled but the judge MODEL becomes a
// documented deviation.
//
// USAGE:
//   node scripts/locomo-judge.js <results-*.jsonl> [--model gpt-4.1] [--provider openai|anthropic]

const fs = require('fs');

const args = process.argv.slice(2);
const jsonlPath = args.find((a) => !a.startsWith('--'));
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const JUDGE_MODEL = flag('--model', 'gpt-4.1');
const STRICT = args.includes('--strict');
const PROVIDER = flag('--provider', /^claude/i.test(JUDGE_MODEL) ? 'anthropic' : 'openai');
const CONCURRENCY = Math.max(1, Number(process.env.JUDGE_CONCURRENCY) || 8);

if (!jsonlPath || !fs.existsSync(jsonlPath)) {
  console.error('Usage: node scripts/locomo-judge.js <results-*.jsonl> [--model <id>] [--provider openai|anthropic]');
  process.exit(1);
}

// ─── VERBATIM JUDGE PROMPT (Mem0-protocol; Backboard public harness) ────────
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

Now it's time for the real question:
Question: ${question}
Gold answer: ${gold}
Generated answer: ${pred}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.
Return your response in JSON format with two keys: "reasoning" for your explanation and "label" for CORRECT or WRONG.`;

// ─── STRICT JUDGE (secondary, robustness row — NOT the comparable number) ───
// Fact-decomposition chain-of-thought: decompose the gold into required facts,
// verify each against the prediction, verdict follows the facts. Stricter than
// the Mem0-protocol judge by design; run with --strict for the second row.
const STRICT_PROMPT = ({ question, gold, pred }) => `You are a strict factual grader for a memory system. Label the generated answer CORRECT or WRONG.

Question: ${question}
Gold (ground truth) answer: ${gold}
Generated answer: ${pred}

Grade by this exact procedure:
1. FACTS: Break the gold answer down into its required fact(s) — the specific entities, dates, quantities, or claims that constitute a correct answer.
2. VERIFY: For each required fact, check whether the generated answer states it correctly. Equivalent phrasings and date formats count (e.g. "7 May 2023" = "May 7th, 2023"); missing facts, wrong values, or contradictions do not. Extra correct context is not penalized; extra WRONG claims are.
3. VERDICT: CORRECT only if every required fact is present and accurate. Otherwise WRONG.

Return your response in JSON format with two keys: "reasoning" for your fact-by-fact verification (brief), and "label" for CORRECT or WRONG. Do NOT include both CORRECT and WRONG in the label.`;

async function callJudge(prompt) {
  if (PROVIDER === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key) { console.error('Set ANTHROPIC_API_KEY.'); process.exit(1); }
    const res = await fetch((process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com/v1') + '/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': process.env.ANTHROPIC_VERSION?.trim() || '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 200, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  if (PROVIDER === 'gemini') {
    const gkey = process.env.GEMINI_API_KEY?.trim();
    if (!gkey) { console.error('Set GEMINI_API_KEY.'); process.exit(1); }
    const base = process.env.GEMINI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta';
    const res = await fetch(`${base}/models/${encodeURIComponent(JUDGE_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': gkey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
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
    body: JSON.stringify({ model: JUDGE_MODEL, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function parseLabel(text) {
  // Protocol response: JSON with keys "reasoning" and "label".
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const obj = JSON.parse(m[0]);
      const label = String(obj.label ?? '').toUpperCase();
      if (label.includes('CORRECT') && !label.includes('WRONG')) return 1;
      if (label.includes('WRONG')) return 0;
    }
  } catch { /* fall through */ }
  const up = text.toUpperCase();
  const hasC = up.includes('CORRECT'); const hasW = up.includes('WRONG');
  if (hasC && !hasW) return 1;
  if (hasW && !hasC) return 0;
  return null; // ambiguous → retry
}

const CATEGORY_LABELS = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' };   // official LoCoMo mapping

(async () => {
  const rows = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // Protocol scope: categories 1-4; adversarial excluded (empty golds, no
  // adversarial column in judge-scored tables). Quota-failed rows excluded.
  const scorable = rows.filter((r) => !r.error && r.pred !== '' && r.category !== 5);
  const skippedAdv = rows.filter((r) => r.category === 5).length;
  console.log(`[locomo-judge] ${rows.length} rows → ${scorable.length} scorable (cat 1-4; ${skippedAdv} adversarial excluded per protocol), judge=${JUDGE_MODEL} (${PROVIDER}), temp=0.1, mode=${STRICT ? 'STRICT' : 'verbatim-mem0'}`);

  const outPath = jsonlPath.replace(/\.jsonl$/, STRICT ? '.judged-strict.jsonl' : '.judged.jsonl');
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
          const mk = STRICT ? STRICT_PROMPT : JUDGE_PROMPT;
          const text = await callJudge(mk({ question: row.question, gold: row.gold ?? '', pred: row.pred ?? '' }));
          reasoningText = text.slice(0, 300);
          verdict = parseLabel(text);
        } catch (e) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
      }
      const out = { ...row, judge: verdict ?? 0, judge_raw: reasoningText, judge_error: verdict === null ? true : undefined };
      judged.push(out);
      fs.appendFileSync(outPath, JSON.stringify(out) + '\n');
      done += 1;
      if (done % 50 === 0) console.log(`[locomo-judge] ${done}/${scorable.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const by = {};
  for (const r of judged) (by[r.category] = by[r.category] || []).push(r.judge);
  console.log(STRICT ? '\n═══ LoCoMo LLM-judge results (STRICT fact-verification judge) ═══' : '\n═══ LoCoMo LLM-judge results (Mem0-protocol harness) ═══');
  console.log(`  overall  accuracy = ${(mean(judged.map((r) => r.judge)) * 100).toFixed(1)}%  (n=${judged.length}, cat 1-4)`);
  for (const c of Object.keys(by).sort()) {
    console.log(`  cat ${c} (${CATEGORY_LABELS[c] ?? '?'})  accuracy = ${(mean(by[c]) * 100).toFixed(1)}%  (n=${by[c].length})`);
  }
  console.log(`\n[locomo-judge] Judged rows → ${outPath}`);
})();

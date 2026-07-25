# ACB LoCoMo Benchmark (Hindsight/ByteRover Harness)

Evaluation of **ACB**, a conversational memory system, on the LoCoMo (Long Conversation Memory) benchmark, under the Hindsight evaluation methodology as adopted by ByteRover's public benchmark.

Retrieval in ACB makes no LLM calls; implementation details are not disclosed in this repository. The only LLM calls per question are the final answer synthesis (justifier) and, offline, the judge.

## Result

**85.1% overall** on LoCoMo categories 1-4 (n = 1,540, LLM-as-Judge accuracy).

| Category | ACB (%) |
| --- | ---: |
| Single-hop | 87.3 |
| Multi-hop | 83.3 |
| Temporal | 84.1 |
| Open-domain | 75.0 |
| **Overall** | **85.1** |

## Comparison

Reported overall scores on LoCoMo under Hindsight-methodology harnesses. Each row's configuration differs; see the notes.

| System | Overall | Configuration notes |
| --- | ---: | --- |
| ByteRover 2.0 | 92.2% | Gemini 3 Flash curation and retrieval, Gemini 3 Flash/Pro justifier, Gemini 3 Flash judge |
| Hindsight (Gemini 3) | 89.6% | Own harness and backbone |
| Hindsight (OSS-120B) | 85.7% | Own harness, open-weights backbone |
| **ACB** | **85.1%** | **gemini-2.5-flash justifier, Gemini 3 Flash judge, zero-LLM retrieval** |
| Hindsight (OSS-20B) | 83.2% | Own harness, open-weights backbone |

Two notes for honest reading:

1. ACB's justifier (gemini-2.5-flash) is a lighter model than ByteRover's published configuration (Gemini 3 Flash/Pro). The retrieval layer, not the answer model, is what this evaluation is designed to measure; the lighter justifier makes the reported number conservative.
2. ACB is the only system in this table that invokes no LLM during retrieval. Every other listed system calls a language model at query time as part of retrieval or context assembly.

## Protocol

Verified against ByteRover's published methodology ("Benchmarking AI agent memory," byterover.dev) and the brv-bench source:

- **Dataset:** locomo10.json, containing 10 multi-session conversations (~5,882 turns, 272 sessions).
- **Scope:** categories 1-4 (multi-hop, temporal, open-domain, single-hop). Adversarial (category 5) is excluded, "consistent with how all competitors report" (ByteRover).
- **Answer generation (justifier):** each question is asked bare, with no instruction suffix, through a dedicated endpoint that assembles retrieved evidence and synthesizes the answer with Hindsight's justifier prompt. Justifier model: `gemini-2.5-flash`.
- **Judge:** Hindsight's judge prompt, reproduced verbatim from brv-bench (`brv_bench/metrics/_judge/prompts.py`), including the "cannot be answered" edge-case clause and the exact JSON verdict format. Judge model: `gemini-3-flash-preview`, temperature 0.0, thinking disabled, matching ByteRover's published configuration (Gemini 3 Flash judge).
- **Store hygiene:** the memory store is purged of any prior evaluation residue and fully rebalanced before the run.
- **Single continuous run**; results banked incrementally.

## Judge Prompt (verbatim, from brv-bench)

```
Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data:
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

Question: {question}
Gold answer: {gold}
Generated answer: {pred}
First, provide a short (one sentence) explanation of your reasoning. Short reasoning is preferred.

Respond with EXACTLY this JSON format, nothing else:
{"reasoning": "<one sentence>", "verdict": "correct"}
or
{"reasoning": "<one sentence>", "verdict": "incorrect"}
```

## Files

- `scripts/locomo-ingest.js` ingests locomo10.json (branch per session, turn-level speaker attribution, real timestamps)
- `scripts/locomo-eval-brv.js` asks every question bare through the justifier endpoint and writes an incremental, crash-safe results jsonl
- `scripts/locomo-judge-brv.js` runs the judge pass with the verbatim prompt above (Gemini backend, temperature 0.0, thinking disabled)
- `results/results-brv-2026-07-25T01-15-36-054Z.judged-brv-gemini.jsonl` is the judged results file for the reported run

## Reproducing

```bash
# 1. Fresh store: wipe, boot (migrations create the databases), stop
rm -rf data && npm run dev        # wait for "System ready", then Ctrl+C

# 2. Ingest (server stopped; writes directly to the store)
set -a; source .env.local; set +a
node scripts/locomo-ingest.js /path/to/locomo10.json

# 3. Build topology (server running)
npm run dev                        # wait for "System ready"
curl -X POST http://localhost:3000/api/locomo-rebuild

# 4. Run (justifier model via env; results bank incrementally)
BRV_MOUTH=gemini-2.5-flash node scripts/locomo-eval-brv.js /path/to/locomo10.json

# 5. Judge (their judge model)
node scripts/locomo-judge-brv.js data/locomo-results/results-brv-<stamp>.jsonl --model gemini-3-flash-preview
```

Requires `GEMINI_API_KEY` in `.env.local`. Expected judge variance across runs: 2-3%.

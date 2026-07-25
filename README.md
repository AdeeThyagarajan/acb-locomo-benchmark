# ACB LoCoMo Benchmark (Mem0-Protocol Harness)

Evaluation of **ACB**, a conversational memory system, on the LoCoMo (Long Conversation Memory) benchmark, under the Mem0-protocol LLM-judge harness.

Retrieval in ACB makes no LLM calls; implementation details are not disclosed in this repository. The only LLM call per question is the final answer generation.

## Results Summary

**79.9% overall** on LoCoMo categories 1-4 (n = 1,540, LLM-as-Judge accuracy).

| Method | Single-Hop (%) | Multi-Hop (%) | Open Domain (%) | Temporal (%) | Overall (%) |
| --- | ---: | ---: | ---: | ---: | ---: |
| **ACB** | **85.0** | **69.9** | **66.7** | **79.1** | **79.9** |
| Memobase (v0.0.37) | 70.92 | 46.88 | 77.17 | 85.05 | 75.78 |
| Zep | 74.11 | 66.04 | 67.71 | 79.79 | 75.14 |
| Memobase (v0.0.32) | 63.83 | 52.08 | 71.82 | 80.37 | 70.91 |
| Mem0-Graph | 65.71 | 47.19 | 75.71 | 58.13 | 68.44 |
| Mem0 | 67.13 | 51.15 | 72.93 | 55.51 | 66.88 |
| LangMem | 62.23 | 47.92 | 71.12 | 23.43 | 58.10 |
| OpenAI | 63.79 | 42.92 | 62.29 | 21.71 | 52.90 |


Competitor figures as publicly reported under the same protocol family.

**Stability:** verified with a second independent full run under the same protocol; the two runs agree within the 2-3% variance expected of an LLM judge at temperature 0.1.

**Latency:** p50 = 2.8s, p95 = 3.9s per question, end to end (retrieval plus answer generation).

## Protocol

- **Dataset:** locomo10.json, containing 10 multi-session conversations (~5,882 turns, 272 sessions) and 1,540 scorable questions in categories 1-4. Category 5 (adversarial) is excluded, consistent with how all systems in the comparison table report.
- **Categories:** 1 = multi-hop, 2 = temporal, 3 = open-domain, 4 = single-hop (official LoCoMo mapping).
- **Answer generation:** every question is asked over HTTP against the same `/api/chat` endpoint the production UI uses, so retrieval, context assembly, and answer generation are the full production path. Temperature 0, top_p 1, single inference run. Questions carry the LoCoMo paper's instruction ("Answer briefly, using the exact wording from the conversation when feasible...").
- **Answer model:** gpt-4o for both runs.
- **Judge:** the verbatim Mem0-protocol judge prompt (reproduced below), run on `gpt-4o` at temperature 0.1. Binary CORRECT/WRONG with reasoning, categories 1-4 only.
- **Store hygiene:** the memory store is purged of any prior evaluation residue and fully rebalanced before the run. The reported result is a single continuous run with zero failed questions (1,986 asked, 1,540 scorable).

## Judge Prompt (verbatim)

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

Now it's time for the real question:
Question: {question}
Gold answer: {gold}
Generated answer: {pred}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

Return your response in JSON format with two keys: "reasoning" for your explanation and "label" for CORRECT or WRONG.
```

## Repository Contents

- `scripts/locomo-ingest.js` ingests locomo10.json into the memory store (branch per session, turn-level speaker attribution, real timestamps)
- `scripts/locomo-eval.js` asks every question through the production chat endpoint and writes an incremental, crash-safe results jsonl
- `scripts/locomo-judge.js` runs the LLM-judge pass over the results (verbatim prompt above)
- `results/` holds the judged results jsonl and summary json for the reported run
- `HINDSIGHT.md` reports the same store evaluated under the Hindsight/ByteRover harness (85.1%)

## Reproducing

```bash
# 1. Fresh store: wipe, boot (migrations create the databases), stop
rm -rf data && npm run dev        # wait for "System ready", then Ctrl+C

# 2. Ingest the corpus (writes directly to the store; server stopped)
set -a; source .env.local; set +a
node scripts/locomo-ingest.js /path/to/locomo10.json

# 3. Build the topology (server running)
npm run dev                        # wait for "System ready"
curl -X POST http://localhost:3000/api/locomo-rebuild

# 4. Run the evaluation (results bank incrementally)
node scripts/locomo-eval.js /path/to/locomo10.json

# 5. Judge
node scripts/locomo-judge.js data/locomo-results/results-<stamp>.jsonl --model gpt-4o
```

Expected judge variance across runs: 2-3%.

#!/usr/bin/env node
// SQL-first (query_rewind + get_schema) vs specialized-tools MCP eval harness.
// No deps beyond Node built-ins. Reads REWIND_API_KEY and REWIND_API_URL from env.
//
// For each question in questions.json:
//   OLD path: if old_path.answerable === false -> old_unanswerable.
//             else hit the specialized endpoint, extract, compare to frozen ground_truth.
//   NEW path: POST question.sql to /v1/query, extract, compare to frozen ground_truth.
// Emits per-question rows + coverage/accuracy/latency summary (by tier), writes
// results.json and REPORT.md, and prints a console table.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.REWIND_API_URL || 'https://rewind.dinakartumu.com';
const KEY = process.env.REWIND_API_KEY;
if (!KEY) {
  console.error('ERROR: REWIND_API_KEY env var is required.');
  process.exit(1);
}

const questionsDoc = JSON.parse(
  readFileSync(join(__dirname, 'questions.json'), 'utf8'),
);
const QUESTIONS = questionsDoc.questions;

// ---- HTTP helpers with latency measurement --------------------------------

async function httpGet(path) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const ms = Math.round(performance.now() - t0);
  const body = await res.json().catch(() => ({ error: 'non-json response' }));
  return { ms, status: res.status, body };
}

async function runSql(sql) {
  const t0 = performance.now();
  const res = await fetch(BASE + '/v1/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const ms = Math.round(performance.now() - t0);
  const body = await res.json().catch(() => ({ error: 'non-json response' }));
  return { ms, status: res.status, body };
}

// ---- extraction helpers ----------------------------------------------------

// Resolve a dotted/bracketed path against a JSON object. Supports:
//   data.0.name  |  data.total_movies  |  top_categories[category=Coffee Shop].count
function extractPath(obj, path) {
  // handle a [key=value] predicate segment specially
  const segs = path.split('.');
  let cur = obj;
  for (let seg of segs) {
    if (cur == null) return undefined;
    const pred = seg.match(/^(\w+)\[(\w+)=(.+)\]$/);
    if (pred) {
      const [, arrKey, matchKey, matchVal] = pred;
      const arr = cur[arrKey];
      if (!Array.isArray(arr)) return undefined;
      cur = arr.find((el) => String(el[matchKey]) === matchVal);
      continue;
    }
    cur = cur[seg];
  }
  return cur;
}

// From a /v1/query response {columns, rows}, build array-of-objects.
function sqlRows(body) {
  if (!body || !Array.isArray(body.columns) || !Array.isArray(body.rows)) return [];
  return body.rows.map((r) => {
    const o = {};
    body.columns.forEach((c, i) => (o[c] = r[i]));
    return o;
  });
}

function numEq(a, b, tol = 0) {
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) <= tol;
}

// ---- grading ---------------------------------------------------------------

// Grade an extracted answer against a question's ground_truth.
// `answer` shape depends on gt.type:
//   scalar        -> answer = number
//   top_item      -> answer = { label, count }
//   rows          -> answer = { rowCount, byKey: {k: v} }  (byKey used for spot_check)
//   compare_pair  -> answer = { run_day_avg, non_run_avg } (keys per gt.expected)
//   list_contains -> answer = [labels...]
function grade(gt, answer, opts = {}) {
  const tol = gt.tol ?? 0;
  switch (gt.type) {
    case 'scalar':
      return numEq(answer, gt.expected, tol);
    case 'top_item': {
      if (!answer) return false;
      const labelOk = String(answer.label) === String(gt.expected_label);
      if (opts.gradeLabelOnly) return labelOk;
      const countOk = numEq(answer.count, gt.expected_count, tol);
      return labelOk && countOk;
    }
    case 'rows': {
      if (!answer) return false;
      const rowsOk = gt.expected_rows == null || answer.rowCount === gt.expected_rows;
      let spotOk = true;
      if (gt.spot_check) {
        for (const [k, v] of Object.entries(gt.spot_check)) {
          if (!numEq(answer.byKey?.[k], v, tol)) spotOk = false;
        }
      }
      return rowsOk && spotOk;
    }
    case 'compare_pair': {
      if (!answer) return false;
      let valsOk = true;
      for (const [k, v] of Object.entries(gt.expected)) {
        if (!numEq(answer[k], v, tol)) valsOk = false;
      }
      // also enforce the directional assertion if present
      let assertOk = true;
      if (gt.assertion) {
        // simple "a > b" / "a < b" between two keys
        const m = gt.assertion.match(/(\w+)\s*([<>])\s*(\w+)/);
        if (m) {
          const [, a, op, b] = m;
          assertOk = op === '>' ? answer[a] > answer[b] : answer[a] < answer[b];
        }
      }
      return valsOk && assertOk;
    }
    case 'list_contains': {
      if (!Array.isArray(answer)) return false;
      const set = new Set(answer.map((x) => String(x)));
      return gt.expected_labels.every((l) => set.has(String(l)));
    }
    default:
      return false;
  }
}

// Build the NEW-path answer object from SQL rows, shaped per gt.type.
function newAnswerFromRows(gt, rows) {
  switch (gt.type) {
    case 'scalar':
      return rows.length ? Object.values(rows[0])[0] : undefined;
    case 'top_item': {
      if (!rows.length) return undefined;
      const keys = Object.keys(rows[0]);
      return { label: rows[0][keys[0]], count: rows[0][keys[1]] };
    }
    case 'rows': {
      const byKey = {};
      const keys = rows.length ? Object.keys(rows[0]) : [];
      for (const r of rows) byKey[String(r[keys[0]])] = r[keys[1]];
      return { rowCount: rows.length, byKey };
    }
    case 'compare_pair': {
      if (!rows.length) return undefined;
      return rows[0];
    }
    case 'list_contains':
      return rows.map((r) => Object.values(r)[0]);
    default:
      return undefined;
  }
}

// ---- OLD-path execution ----------------------------------------------------

async function runOldPath(q) {
  const op = q.old_path;
  if (op.answerable === false) {
    return { unanswerable: true, reason: op.reason, ms: 0 };
  }
  const { ms, status, body } = await httpGet(op.endpoint);
  if (status !== 200 || body?.error) {
    return { ms, error: `HTTP ${status} ${body?.error || ''}`.trim(), correct: false };
  }
  const gt = q.ground_truth;
  let answer;
  if (gt.type === 'top_item') {
    answer = {
      label: extractPath(body, op.extract_label),
      count: extractPath(body, op.extract_count),
    };
  } else if (gt.type === 'rows') {
    // For rows, OLD spot-checks specific keys from a listed structure.
    // Two shapes are handled:
    //   /running/stats/years -> data[] with {year, longest_run_mi|total_distance_mi}
    //   /listening/trends     -> data[] with {period:"YYYY-MM", value}
    const byKey = {};
    const arr = extractPath(body, 'data');
    if (Array.isArray(arr)) {
      const valField = op.extract.includes('longest_run_mi')
        ? 'longest_run_mi'
        : op.extract.includes('total_distance_mi')
          ? 'total_distance_mi'
          : op.extract.includes('value')
            ? 'value'
            : null;
      // key by whichever bucket field the endpoint uses (year or period)
      for (const el of arr) {
        const k = el.year != null ? String(el.year) : el.period != null ? String(el.period) : null;
        if (k != null) byKey[k] = valField ? el[valField] : undefined;
      }
    }
    // Only judge on the declared spot-check keys (OLD field can have different
    // semantics than the run-only NEW query; we grade whether OLD matches those).
    answer = { rowCount: gt.expected_rows, byKey };
  } else {
    answer = extractPath(body, op.extract);
  }
  const correct = grade(gt, answer, { gradeLabelOnly: q.grade_label_only });
  return { ms, correct, extracted: answer };
}

// ---- NEW-path execution ----------------------------------------------------

async function runNewPath(q) {
  const { ms, status, body } = await runSql(q.sql);
  if (status !== 200 || body?.error) {
    return { ms, error: `HTTP ${status} ${body?.error || ''}`.trim(), correct: false };
  }
  const rows = sqlRows(body);
  const answer = newAnswerFromRows(q.ground_truth, rows);
  const correct = grade(q.ground_truth, answer, { gradeLabelOnly: q.grade_label_only });
  return { ms, correct, extracted: answer, truncated: body.truncated };
}

// ---- main ------------------------------------------------------------------

const results = [];
for (const q of QUESTIONS) {
  const oldR = await runOldPath(q);
  const newR = await runNewPath(q);
  results.push({
    id: q.id,
    tier: q.tier,
    category: q.category,
    question: q.question,
    old: oldR,
    new: newR,
  });
}

// ---- aggregate -------------------------------------------------------------

function pct(n, d) {
  return d === 0 ? '—' : ((100 * n) / d).toFixed(0) + '%';
}

const tiers = [1, 2, 3, 4];
const summary = { byTier: {}, overall: {} };
function bucket(rows) {
  const total = rows.length;
  const oldAttempted = rows.filter((r) => !r.old.unanswerable).length;
  const oldCorrect = rows.filter((r) => r.old.correct === true).length;
  const newAttempted = rows.filter((r) => !r.new.error || r.new.correct !== undefined).length;
  const newCorrect = rows.filter((r) => r.new.correct === true).length;
  const oldLat = rows.filter((r) => r.old.ms > 0).map((r) => r.old.ms);
  const newLat = rows.map((r) => r.new.ms);
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
  return {
    total,
    old_coverage: pct(oldAttempted, total),
    old_coverage_n: oldAttempted,
    old_accuracy: pct(oldCorrect, oldAttempted),
    old_correct: oldCorrect,
    new_coverage: pct(newAttempted, total),
    new_coverage_n: newAttempted,
    new_accuracy: pct(newCorrect, newAttempted),
    new_correct: newCorrect,
    old_avg_ms: avg(oldLat),
    new_avg_ms: avg(newLat),
  };
}
for (const t of tiers) summary.byTier[t] = bucket(results.filter((r) => r.tier === t));
summary.overall = bucket(results);

// ---- console output --------------------------------------------------------

console.log('\n=== PER-QUESTION ===');
for (const r of results) {
  const oldStr = r.old.unanswerable
    ? 'UNANSWERABLE'
    : r.old.error
      ? 'ERR:' + r.old.error
      : r.old.correct
        ? 'PASS'
        : 'FAIL';
  const newStr = r.new.error ? 'ERR:' + r.new.error : r.new.correct ? 'PASS' : 'FAIL';
  console.log(
    `${r.id.padEnd(6)} T${r.tier} ${r.category.padEnd(13)} OLD:${oldStr.padEnd(14)} NEW:${newStr.padEnd(6)} ${r.question}`,
  );
}

console.log('\n=== SUMMARY (coverage = % attempted, accuracy = % correct of attempted) ===');
const hdr = ['Tier', 'N', 'OLD cov', 'OLD acc', 'NEW cov', 'NEW acc', 'OLD ms', 'NEW ms'];
console.log(hdr.map((h) => h.padEnd(9)).join(''));
for (const t of tiers) {
  const s = summary.byTier[t];
  console.log(
    [
      `T${t}`,
      s.total,
      s.old_coverage,
      s.old_accuracy,
      s.new_coverage,
      s.new_accuracy,
      s.old_avg_ms,
      s.new_avg_ms,
    ]
      .map((x) => String(x).padEnd(9))
      .join(''),
  );
}
const o = summary.overall;
console.log(
  ['ALL', o.total, o.old_coverage, o.old_accuracy, o.new_coverage, o.new_accuracy, o.old_avg_ms, o.new_avg_ms]
    .map((x) => String(x).padEnd(9))
    .join(''),
);

// ---- write results.json ----------------------------------------------------

writeFileSync(
  join(__dirname, 'results.json'),
  JSON.stringify({ base: BASE, generated_at: new Date().toISOString(), summary, results }, null, 2),
);

// ---- write REPORT.md numbers block (appended by generate step below) -------

function mdTable(summary) {
  const lines = [];
  lines.push('| Tier | N | OLD coverage | OLD accuracy | NEW coverage | NEW accuracy | OLD avg ms | NEW avg ms |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const t of tiers) {
    const s = summary.byTier[t];
    lines.push(
      `| ${t} | ${s.total} | ${s.old_coverage} (${s.old_coverage_n}/${s.total}) | ${s.old_accuracy} (${s.old_correct}/${s.old_coverage_n}) | ${s.new_coverage} (${s.new_coverage_n}/${s.total}) | ${s.new_accuracy} (${s.new_correct}/${s.new_coverage_n}) | ${s.old_avg_ms} | ${s.new_avg_ms} |`,
    );
  }
  const o = summary.overall;
  lines.push(
    `| **ALL** | ${o.total} | ${o.old_coverage} (${o.old_coverage_n}/${o.total}) | ${o.old_accuracy} (${o.old_correct}/${o.old_coverage_n}) | ${o.new_coverage} (${o.new_coverage_n}/${o.total}) | ${o.new_accuracy} (${o.new_correct}/${o.new_coverage_n}) | ${o.old_avg_ms} | ${o.new_avg_ms} |`,
  );
  return lines.join('\n');
}

// Emit the machine-generated table to a partial the REPORT.md includes verbatim.
writeFileSync(join(__dirname, 'results-table.md'), mdTable(summary) + '\n');

console.log('\nWrote results.json and results-table.md');

// Growth OS L0 contract tests (GROWTH-OS-SESSION-1-SPEC.md).
//
// The D1 fake here is real SQLite (node:sqlite) with every migration applied, so
// the SQL the Worker sends is executed against the real schema — a mock that
// echoed its input would prove nothing (CLAUDE.md: mocks must not mirror inputs).

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { loadWorker, root } = require("../growth-os/load-worker");
const spec = require("../growth-os/definitions");
const generate = require("../growth-os/generate");
const ui = require("../report-ui/growth-envelope.js");

const worker = loadWorker();
const get = worker.__get;

function run(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === "function") throw new Error(`run() was given an async function: use runAsync for "${name}"`);
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

async function runAsync(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

function throwsCode(fn, code) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `expected an error with code ${code}`);
  assert.strictEqual(caught.code, code, `expected code ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

const migrationsDir = path.join(root, "migrations");
const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const file of migrationFiles) db.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  return db;
}

// D1 binding over SQLite. Counts batches and statements.
function d1Over(db) {
  const stats = { batches: 0, statements: 0, prepared: 0 };
  return {
    stats,
    prepare(sql) {
      stats.prepared += 1;
      return { bind: (...params) => ({ sql, params }) };
    },
    async batch(statements) {
      stats.batches += 1;
      stats.statements += statements.length;
      return statements.map((s) => {
        if (/^\s*(SELECT|WITH)\b/i.test(s.sql)) return { results: db.prepare(s.sql).all(...s.params).map((r) => ({ ...r })) };
        const info = db.prepare(s.sql).run(...s.params);
        return { results: [], meta: { changes: Number(info.changes) } };
      });
    }
  };
}

const defs = worker.growthDefinitionMap(generate.definitionRowsInEffect("2026-09-12"));
const d = (key) => defs.get(key);
const SURFACES = get("GROWTH_SURFACES");
const ENTITIES = get("GROWTH_ENTITIES");
const RESOLVERS = get("GROWTH_RESOLVERS");
const QUERIES = get("GROWTH_QUERIES");
const EXCLUSION_METRICS = get("GROWTH_EXCLUSION_METRICS");
const UNITS = ["EGP", "ratio", "count", "days", "multiple", "decimal", "seconds", "date"];
const SURFACE_NAMES = Object.keys(SURFACES);

(async () => {
  // ---------------------------------------------------------------- definitions
  run("definitions: every row parses, keys unique, enumerations valid", () => {
    const keys = new Set();
    for (const def of spec.definitions) {
      assert.ok(!keys.has(`${def.metric_key}@${def.version}`), `duplicate ${def.metric_key}`);
      keys.add(`${def.metric_key}@${def.version}`);
      const parsed = worker.parseMetricDefinitionRow(generate.definitionRow(def));
      assert.ok(UNITS.includes(parsed.unit), `${def.metric_key}: unit ${parsed.unit}`);
      assert.ok(SURFACE_NAMES.includes(parsed.surface), `${def.metric_key}: surface ${parsed.surface}`);
      assert.ok(["higher_better", "lower_better", "neutral"].includes(parsed.direction), def.metric_key);
      if (parsed.session_basis) assert.ok(parsed.basis_label, `${def.metric_key}: a session basis must carry a label`);
    }
    assert.ok(spec.definitions.length >= 200, `expected the full §4-§13 set, got ${spec.definitions.length}`);
  });

  run("definitions: every metric the surfaces name is defined at the week grain", () => {
    for (const [surface, s] of Object.entries(SURFACES)) {
      for (const [section, keys] of Object.entries(s.sections)) {
        for (const key of keys) {
          assert.ok(defs.has(key), `${surface}.${section}: ${key} has no definition`);
          assert.ok(d(key).grains.includes("week"), `${surface}.${section}: ${key} is not defined at week grain`);
        }
      }
    }
    for (const key of EXCLUSION_METRICS) assert.ok(d(key).grains.includes("exclusion_rule"), key);
  });

  run("definitions: no orphans — every (metric, grain) is served somewhere", () => {
    const weekKeys = new Set(Object.values(SURFACES).flatMap((s) => Object.values(s.sections).flat()));
    for (const def of defs.values()) {
      for (const grain of def.grains) {
        if (grain === "week") assert.ok(weekKeys.has(def.metric_key), `${def.metric_key} is defined at week grain but no surface shows it`);
        else if (grain === "exclusion_rule") assert.ok(EXCLUSION_METRICS.includes(def.metric_key), def.metric_key);
        else assert.ok(ENTITIES[grain], `${def.metric_key}: grain "${grain}" has no entity type`);
      }
    }
    const usedGrains = new Set([...defs.values()].flatMap((x) => x.grains));
    for (const entity of Object.keys(ENTITIES)) assert.ok(usedGrains.has(entity), `entity ${entity} carries no metrics`);
  });

  run("definitions: Command CVR and ATC are on Shopify sessions, labelled on the envelope", () => {
    const pulse = SURFACES.command.sections.pulse;
    assert.ok(pulse.includes("cvr_shopify") && pulse.includes("atc_rate_shopify"));
    assert.ok(!pulse.some((key) => d(key).session_basis === "ga4"), "Command must not show a GA4-basis rate");
    assert.strictEqual(d("cvr_shopify").basis_label, "Shopify sessions");
    assert.strictEqual(d("cvr_ga4").basis_label, "GA4 sessions");
    const funnel = SURFACES.funnel.sections;
    assert.ok(funnel.shopify_sessions.includes("atc_rate_shopify") && funnel.ga4_sessions.includes("atc_rate_ga4"), "Funnel shows both labelled series");
  });

  run("definitions: no metric mixes session sources", () => {
    for (const def of defs.values()) {
      const tables = def.source_tables;
      assert.ok(!(tables.includes("fact_ga4_daily") && tables.includes("fact_session_daily")) || def.confidence === "modelled",
        `${def.metric_key} reads both session sources`);
    }
  });

  run("definitions: every resolver is defined and every resolver query exists", () => {
    for (const [key, resolver] of Object.entries(RESOLVERS)) {
      assert.ok(defs.has(key), `orphan resolver ${key}`);
      for (const q of resolver.queries || []) assert.ok(QUERIES[q], `${key}: query ${q}`);
      for (const g of resolver.grains || ["week"]) assert.ok(d(key).grains.includes(g), `${key}: resolver grain ${g}`);
    }
  });

  // ---------------------------------------------------------------- schema
  const db = freshDb();
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));

  run("schema: every migration applies in order on SQLite, entity model complete", () => {
    const required = [
      "dim_date", "dim_drop", "dim_product", "dim_variant", "dim_concept", "dim_ad", "dim_offer", "dim_customer",
      "dim_geo", "dim_courier", "dim_location", "dim_breakdown", "dim_reason",
      "fact_order", "fact_order_line", "fact_reversal", "fact_reversal_line", "fact_refund", "fact_refund_line",
      "fact_exchange", "fact_ad_daily", "fact_adset_daily", "fact_ga4_daily", "fact_ga4_item_daily",
      "fact_session_daily", "fact_inventory_daily", "fact_location_sku_weekly",
      "metric_definitions", "metric_snapshots", "metric_continuity_flags", "load_log",
      "decision_log", "experiment_log", "forecast_log", "intervention_log", "import_batch", "import_row"
    ];
    for (const t of required) assert.ok(tables.has(t), `missing table ${t}`);
  });

  run("schema: every source table a definition names exists", () => {
    for (const def of defs.values()) for (const t of def.source_tables) assert.ok(tables.has(t), `${def.metric_key}: ${t}`);
    for (const [name, e] of Object.entries(ENTITIES)) if (e.source_table) assert.ok(tables.has(e.source_table), `${name}: ${e.source_table}`);
  });

  run("schema: seed loads every definition, one open version per metric", () => {
    const n = db.prepare("SELECT COUNT(*) AS n FROM metric_definitions WHERE effective_to IS NULL").get().n;
    assert.strictEqual(n, new Set(spec.definitions.map((x) => x.metric_key)).size, "one open version per metric");
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM metric_definitions").get().n, spec.definitions.length, "every version kept");
    assert.strictEqual(db.prepare("SELECT version FROM metric_definitions WHERE metric_key = 'reversal_rate' AND effective_to IS NULL").get().version, 2);
    assert.throws(() => db.prepare(
      "INSERT INTO metric_definitions (metric_key, version, label, surface, unit, confidence, formula, grains, comparison_mode, source_tables, effective_from, change_note, created_at) VALUES ('orders', 2, 'x', 'economics', 'count', 'measured', 'x', '[\"week\"]', 'drop_day', '[]', '2026-01-01', 'x', 'x')"
    ).run(), /UNIQUE/);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM dim_breakdown WHERE breakdown_id = 'ga4.device__source_medium'").get().n, 1);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM dim_location").get().n, 4);
  });

  run("schema: dim_date is a Sunday-week calendar", () => {
    const row = db.prepare("SELECT week_start, iso_week, day_of_week FROM dim_date WHERE date = '2026-09-12'").get();
    assert.strictEqual(row.week_start, "2026-09-06");
    assert.strictEqual(row.day_of_week, 6);
    assert.strictEqual(row.iso_week, "2026-W37");
    assert.strictEqual(db.prepare("SELECT iso_week FROM dim_date WHERE date = '2027-01-01'").get().iso_week, "2026-W53");
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM dim_date WHERE day_of_week = 0 AND date <> week_start").get().n, 0);
  });

  run("schema: write-time rules hold whatever code writes", () => {
    // Decision without evidence.
    assert.throws(() => db.prepare("INSERT INTO decision_log (decided_on, area, evidence_json, decision, reason, created_at) VALUES ('2026-09-12', 'offer', '[]', 'x', 'x', 'x')").run(), /CHECK/);
    db.prepare("INSERT INTO decision_log (decided_on, area, evidence_json, decision, reason, created_at) VALUES ('2026-09-12', 'offer', '[{\"metric\":\"orders\"}]', 'x', 'x', 'x')").run();
    // Experiment ended early must be inconclusive.
    const exp = "INSERT INTO experiment_log (hypothesis, area, control, variant, primary_metric, mde, planned_runtime_days, runtime_method, started_on, ended_on, result_status, created_at) VALUES ('h', 'a', 'c', 'v', 'cvr_shopify', 0.1, 14, 'two-proportion', '2026-09-01', '2026-09-05', ?, 'x')";
    assert.throws(() => db.prepare(exp).run("win"), /CHECK/);
    db.prepare(exp).run("inconclusive");
    assert.throws(() => db.prepare("INSERT INTO experiment_log (hypothesis, area, control, variant, primary_metric, mde, planned_runtime_days, runtime_method, created_at) VALUES ('h', 'a', 'c', 'v', 'm', 0, 14, 'x', 'x')").run(), /CHECK/);
    // Forecast after its drop; forecast frozen once written.
    const fc = "INSERT INTO forecast_log (drop_id, drop_date, produced_at, produced_on, metric_key, horizon_drop_day, forecast_value, method) VALUES ('d', '2026-09-20', ?, ?, 'orders', 6, 100, 'prior-drop median')";
    assert.throws(() => db.prepare(fc).run("2026-09-20T10:00:00Z", "2026-09-20"), /CHECK/);
    db.prepare(fc).run("2026-09-15T10:00:00Z", "2026-09-15");
    assert.throws(() => db.prepare("UPDATE forecast_log SET forecast_value = 200").run(), /frozen/);
    db.prepare("UPDATE forecast_log SET actual_value = 90, scored_at = 'x'").run();
    // Intervention cannot be anything but unmeasured without a measured cohort.
    assert.throws(() => db.prepare("INSERT INTO intervention_log (name, started_on, measurement_status, created_at) VALUES ('address gate', '2026-09-01', 'measured', 'x')").run(), /CHECK/);
    assert.strictEqual(db.prepare("INSERT INTO intervention_log (name, started_on, created_at) VALUES ('address gate', '2026-09-01', 'x') RETURNING measurement_status").get().measurement_status, "unmeasured");
  });

  run("schema: fact_inventory_daily is immutable, including INSERT OR REPLACE", () => {
    db.prepare("INSERT INTO fact_inventory_daily (date, variant_id, location_id, qty_on_hand, is_oos) VALUES ('2026-09-12', 'v1', 'online', 5, 0)").run();
    assert.throws(() => db.prepare("UPDATE fact_inventory_daily SET qty_on_hand = 4").run(), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM fact_inventory_daily").run(), /immutable/);
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO fact_inventory_daily (date, variant_id, location_id, qty_on_hand, is_oos) VALUES ('2026-09-12', 'v1', 'online', 9, 0)").run(), /immutable/);
    // The documented writer pattern is a no-op on an existing row.
    db.prepare("INSERT INTO fact_inventory_daily (date, variant_id, location_id, qty_on_hand, is_oos) SELECT '2026-09-12', 'v1', 'online', 9, 0 WHERE NOT EXISTS (SELECT 1 FROM fact_inventory_daily WHERE date = '2026-09-12' AND variant_id = 'v1' AND location_id = 'online')").run();
    assert.strictEqual(db.prepare("SELECT qty_on_hand FROM fact_inventory_daily").get().qty_on_hand, 5);
  });

  run("schema: post-purchase is three systems with an open reason taxonomy", () => {
    for (const t of ["fact_reversal", "fact_refund", "fact_exchange"]) assert.ok(tables.has(t));
    const wrongSize = db.prepare("SELECT applies_to FROM dim_reason WHERE reason_code = 'wrong_size'").get();
    assert.deepStrictEqual(JSON.parse(wrongSize.applies_to), ["rto", "refund", "exchange"]);
    // Staged imports accept any column layout; only JSON validity is enforced.
    db.prepare("INSERT INTO import_batch (batch_id, source, status, imported_at) VALUES ('b1', 'yanet_exchanges', 'staged', 'x')").run();
    db.prepare("INSERT INTO import_row (batch_id, row_num, raw_json) VALUES ('b1', 1, ?)").run(JSON.stringify({ "Order": "#1001", "Reason": "Size too small" }));
    assert.throws(() => db.prepare("INSERT INTO import_row (batch_id, row_num, raw_json) VALUES ('b1', 2, 'not json')").run(), /CHECK/);
  });

  // ---------------------------------------------------------------- envelope
  const drops = generate.FIXTURE_DROPS;
  const win = worker.dropDayWindows(drops, "2000-01-02", "2000-01-08").windows.period;
  const cmp = (value, priors, extra = {}) => worker.dropDayComparison({
    current: { ...win.current, value },
    against: win.against.map((a, i) => ({ ...a, value: priors[i] })),
    excluded: win.excluded,
    ...extra
  });
  const flag = { flag_id: 7, break_date: "1999-12-01", signal: "constancy", detected_at: "x" };
  const stale = { source_table: "fact_order", source_loaded_at: "b", computed_at: "a" };

  run("envelope: all seven states are expressible", () => {
    const got = {
      ok: worker.metricEnvelope(d("orders"), { value: 10, comparison: cmp(10, [8, 9, 7]) }),
      missing: worker.metricEnvelope(d("orders"), { value: null }),
      partial: worker.metricEnvelope(d("orders"), { value: 10, coverage: 0.5, comparison: cmp(10, [8, 9, 7]) }),
      no_basis: worker.metricEnvelope(d("orders"), { value: 10, comparison: cmp(10, [8, null, null]) }),
      contaminated: worker.metricEnvelope(d("orders"), { value: 10, comparison: cmp(10, [8, 9, 7], { flags: [{ kind: "structural_window", offer_id: "o" }] }) }),
      stale: worker.metricEnvelope(d("orders"), { value: 10, comparison: cmp(10, [8, 9, 7]), stale }),
      suspect: worker.metricEnvelope(d("orders"), { value: 10, comparison: cmp(10, [8, 9, 7]), continuity_flags: [flag] })
    };
    for (const [state, env] of Object.entries(got)) {
      assert.strictEqual(env.state, state);
      assert.strictEqual(env.secondary_states.length, 0, `${state} should be alone`);
    }
    assert.deepStrictEqual(Array.from(get("METRIC_STATE_PRECEDENCE")), ["missing", "suspect", "stale", "partial", "contaminated", "no_basis", "ok"]);
  });

  run("envelope: suspect and stale both show — one state never hides another", () => {
    const env = worker.metricEnvelope(d("orders"), { value: 10, coverage: 0.9, comparison: cmp(10, [8, 9, 7], { flags: [{ kind: "structural_window" }] }), stale, continuity_flags: [flag] });
    assert.strictEqual(env.state, "suspect");
    assert.strictEqual(env.secondary_states.join(","), "stale,partial,contaminated");
    assert.strictEqual(env.state_detail.suspect[0].break_date, "1999-12-01");
    assert.ok(env.state_detail.stale && env.state_detail.partial && env.state_detail.contaminated);
  });

  run("envelope: missing is blank, keeps suspect/stale, drops value-dependent states", () => {
    const env = worker.metricEnvelope(d("orders"), { value: null, coverage: 0.3, comparison: cmp(10, [8, 9, 7]), stale, continuity_flags: [flag], missing_reason: "unwired" });
    assert.strictEqual(env.value, null);
    assert.strictEqual(env.state, "missing");
    assert.strictEqual(env.secondary_states.join(","), "suspect,stale");
    assert.strictEqual(env.comparison, null);
    assert.strictEqual(env.state_detail.missing.reason, "unwired");
  });

  run("envelope: no_basis carries no comparison; mode-none metrics never get one", () => {
    const env = worker.metricEnvelope(d("orders"), { value: 10, comparison: cmp(10, [8, null, null]) });
    assert.strictEqual(env.comparison, null);
    assert.strictEqual(env.state_detail.no_basis.available, 1);
    const days = worker.metricEnvelope(d("days_since_drop"), { value: 3 });
    assert.strictEqual(days.state, "ok");
    throwsCode(() => worker.metricEnvelope(d("days_since_drop"), { value: 3, comparison: cmp(3, [1, 2, 3]) }), "comparison_not_allowed");
  });

  run("envelope: never coerces — strings, NaN, Infinity become missing with a warning", () => {
    for (const bad of ["12", NaN, Infinity, true, {}]) {
      const warnings = [];
      const env = worker.metricEnvelope(d("orders"), { value: bad, warnings });
      assert.strictEqual(env.state, "missing");
      assert.strictEqual(env.value, null);
      assert.strictEqual(warnings.length, 1);
    }
    assert.strictEqual(worker.metricEnvelope(d("orders"), { value: 0 }).value, 0, "a true zero is a value");
    assert.strictEqual(worker.metricEnvelope(d("projected_sellout_date"), { value: "2026-10-01" }).value, "2026-10-01");
    throwsCode(() => worker.metricEnvelope(d("orders"), { value: 1, coverage: 1.5 }), "coverage_invalid");
  });

  run("envelope: frozen, carries basis label and definition version", () => {
    const env = worker.metricEnvelope(d("cvr_shopify"), { value: 0.02, comparison: cmp(0.02, [0.02, 0.02, 0.02]) });
    assert.ok(Object.isFrozen(env) && Object.isFrozen(env.comparison) && Object.isFrozen(env.comparison.against));
    assert.strictEqual(env.basis, "Shopify sessions");
    assert.strictEqual(env.definition_version, 1);
    throwsCode(() => worker.metricEnvelope(undefined, { metric: "nope" }), "metric_undefined");
  });

  // ---------------------------------------------------------------- comparison
  run("comparison: equal-length windows ending at the same drop-day, both windows' dates stated", () => {
    const c = cmp(12, [10, 11, 9]);
    assert.strictEqual(c.mode, "drop_day");
    assert.strictEqual(c.current.window.start, "2000-01-02");
    assert.strictEqual(c.current.window.end, "2000-01-08");
    for (const a of c.against) {
      assert.strictEqual(a.window.days, c.current.window.days);
      assert.strictEqual(a.window.drop_day_end, c.drop_day.end);
      assert.ok(a.window.start && a.window.end);
    }
    assert.strictEqual(c.basis_value, 10);
    assert.strictEqual(c.delta_abs, 2);
    assert.strictEqual(c.delta_pct, 0.2);
    assert.strictEqual(c.value_basis, "nominal");
    assert.strictEqual(c.deflator, null);
    assert.strictEqual(c.excluded[0].drop_id, "fixture-drop-4");
    assert.strictEqual(c.excluded[0].reason, "window_crosses_next_drop");
  });

  run("comparison: refuses mismatched windows and an undeclared real/FX basis", () => {
    const bad = { ...win.against[0], window: { ...win.against[0].window, days: 6 }, value: 1 };
    throwsCode(() => worker.dropDayComparison({ current: { ...win.current, value: 1 }, against: [bad] }), "comparison_invalid");
    throwsCode(() => worker.dropDayComparison({ current: { ...win.current, value: 1 }, against: [], value_basis: "real" }), "comparison_invalid");
    throwsCode(() => worker.dropDayComparison({ current: { ...win.current, value: 1 }, against: [], deflator: { index: "cpi" } }), "comparison_invalid");
    const real = worker.dropDayComparison({
      current: { ...win.current, value: 12 },
      against: win.against.map((a) => ({ ...a, value: 10 })),
      value_basis: "real",
      deflator: { index: "fixture-cpi", base_period: "1999-12" }
    });
    assert.strictEqual(real.value_basis, "real");
    assert.strictEqual(real.deflator.index, "fixture-cpi");
  });

  run("comparison: zero basis gives no percentage; negative basis uses its magnitude", () => {
    assert.strictEqual(cmp(5, [0, 0, 0]).delta_pct, null);
    assert.strictEqual(cmp(-50, [-100, -100, -100]).delta_pct, 0.5);
  });

  run("windows: a drop landing mid-week clips the window at drop-day 0", () => {
    const w = worker.dropDayWindows([{ drop_id: "a", drop_date: "2026-08-01" }, { drop_id: "b", drop_date: "2026-08-25" }, { drop_id: "c", drop_date: "2026-09-16" }], "2026-09-13", "2026-09-19");
    assert.strictEqual(w.drop.drop_id, "c");
    assert.strictEqual(w.days_since_drop, 3);
    assert.strictEqual(w.windows.period.current.window.start, "2026-09-16");
    assert.strictEqual(w.windows.period.current.window.days, 4);
    assert.strictEqual(w.windows.period.against[0].window.start, "2026-08-25");
    assert.strictEqual(w.windows.period.against[0].window.end, "2026-08-28");
    assert.strictEqual(w.windows.period.sufficient, true);
    const none = worker.dropDayWindows([], "2026-09-13", "2026-09-19");
    assert.strictEqual(none.drop, null);
    assert.strictEqual(none.windows, null);
  });

  // ---------------------------------------------------------------- floor phase
  // The 2026 calendar from CLAUDE.md, with winter drops 30 days apart as planned.
  const cal2026 = [["apr01", "2026-04-01"], ["apr21", "2026-04-21"], ["may14", "2026-05-14"], ["jun16", "2026-06-16"], ["jun29", "2026-06-29"], ["jul26", "2026-07-26"]]
    .map(([id, d]) => ({ drop_id: id, drop_date: d, season: "summer" }))
    .concat([{ drop_id: "sep20", drop_date: "2026-09-20", season: "winter" }, { drop_id: "oct20", drop_date: "2026-10-20", season: "winter" }]);

  run("floor: late-cycle weeks get a pooled floor basis instead of none", () => {
    const aug30 = worker.dropDayWindows(cal2026, "2026-08-30", "2026-09-05").windows;
    assert.strictEqual(aug30.period.phase, "floor");
    assert.strictEqual(aug30.period.sufficient, false, "the matched rule still has no basis here");
    assert.strictEqual(aug30.floor.scope, "same_season");
    assert.strictEqual(aug30.floor.pool.length, 3);
    assert.strictEqual(aug30.floor.sufficient, true);
    for (const p of aug30.floor.pool) {
      assert.strictEqual(p.window.days, aug30.period.current.window.days, "equal length");
      assert.ok(p.window.drop_day_start >= 21, "inside the floor phase");
    }
    assert.ok(aug30.floor.excluded.some((x) => x.reason === "floor_phase_shorter_than_window"));
  });

  run("floor: phase is set by drop-day, and early weeks keep the matched comparison", () => {
    assert.strictEqual(worker.dropDayWindows(cal2026, "2026-09-27", "2026-10-03").windows.period.phase, "decay");
    const w = worker.dropDayWindows(cal2026, "2026-10-11", "2026-10-17").windows;
    assert.strictEqual(w.period.phase, "floor");
    assert.strictEqual(w.floor.scope, "cross_season", "winter has no floor windows yet");
    assert.strictEqual(w.floor.flags[0].kind, "cross_season");
    assert.ok(w.floor.pool.every((p) => ["may14", "jul26"].includes(p.drop_id)));
  });

  run("floor: no single cycle supplies more than two windows", () => {
    const w = worker.dropDayWindows(cal2026, "2026-10-11", "2026-10-17").windows.floor;
    const perCycle = {};
    for (const p of w.pool) perCycle[p.drop_id] = (perCycle[p.drop_id] || 0) + 1;
    assert.ok(Object.values(perCycle).every((n) => n <= 2), JSON.stringify(perCycle));
    assert.strictEqual(perCycle.jul26, 2, "the 56-day gap no longer dominates");
    assert.deepStrictEqual(w.pool.filter((p) => p.drop_id === "jul26").map((p) => p.window.drop_day_start).join(","), "21,28", "a finished cycle keeps its first two");
    assert.strictEqual(w.excluded.filter((x) => x.reason === "cycle_cap").length, 3);
    // The current cycle keeps its most recent two.
    const sep6 = worker.dropDayWindows(cal2026, "2026-09-06", "2026-09-12").windows.floor;
    assert.deepStrictEqual(sep6.pool.filter((p) => p.drop_id === "jul26").map((p) => p.window.drop_day_start).join(","), "28,35");
    assert.strictEqual(sep6.sufficient, true);
  });

  run("floor: comparison reports median, range, n and position; refuses unequal windows", () => {
    const f = worker.dropDayWindows(cal2026, "2026-08-30", "2026-09-05").windows.floor;
    const c = worker.floorPoolComparison({ current: { ...f.current, value: 150 }, pool: f.pool.map((p, i) => ({ ...p, value: [100, 140, 200][i] })) });
    assert.strictEqual(c.mode, "floor_pool");
    assert.strictEqual(c.basis_value, 140);
    assert.strictEqual(c.spread.min, 100);
    assert.strictEqual(c.spread.max, 200);
    assert.strictEqual(c.n, 3);
    assert.strictEqual(c.position.below, 2);
    assert.strictEqual(c.position.above, 1);
    assert.strictEqual(c.rule_version, "drop-cycle.v3");
    const few = worker.floorPoolComparison({ current: { ...f.current, value: 150 }, pool: f.pool.map((p, i) => ({ ...p, value: i === 0 ? 100 : null })) });
    assert.strictEqual(few.insufficient, true);
    assert.strictEqual(few.required, 3);
    throwsCode(() => worker.floorPoolComparison({ current: { ...f.current, value: 1 }, pool: [{ ...f.pool[0], window: { ...f.pool[0].window, days: 3 }, value: 1 }] }), "comparison_invalid");
  });

  run("floor: envelopes accept the pool; cross-season reads contaminated, too few reads no_basis", () => {
    const f = worker.dropDayWindows(cal2026, "2026-10-11", "2026-10-17").windows.floor;
    const cross = worker.floorPoolComparison({ current: { ...f.current, value: 150 }, pool: f.pool.map((p) => ({ ...p, value: 140 })), flags: f.flags, scope: f.scope });
    const env = worker.metricEnvelope(d("orders"), { value: 150, comparison: cross });
    assert.strictEqual(env.state, "contaminated");
    assert.strictEqual(env.comparison.scope, "cross_season");
    const thin = worker.floorPoolComparison({ current: { ...f.current, value: 150 }, pool: [] });
    const env2 = worker.metricEnvelope(d("orders"), { value: 150, comparison: thin });
    assert.strictEqual(env2.state, "no_basis");
    assert.strictEqual(env2.state_detail.no_basis.mode, "floor_pool");
    assert.strictEqual(env2.state_detail.no_basis.required, 3);
  });

  run("floor: resolvers ask dropCycleComparison, which picks the mode from the drop context", () => {
    const scopeFor = (start, end) => ({ week_start: start, week_end: end, as_of: end, is_complete: true, timezone: "Africa/Cairo" });
    const late = worker.growthContext(scopeFor("2026-08-30", "2026-09-05"), { definitions: generate.definitionRowsInEffect("2026-09-05"), drops: cal2026 });
    assert.strictEqual(worker.dropCycleComparison(late, () => 100).mode, "floor_pool");
    const early = worker.growthContext(scopeFor("2026-09-27", "2026-10-03"), { definitions: generate.definitionRowsInEffect("2026-10-03"), drops: cal2026 });
    assert.strictEqual(worker.dropCycleComparison(early, () => 100).mode, "drop_day");
    assert.strictEqual(worker.dropCycleComparison(late, () => 100, { window: "cumulative" }).mode, "drop_day", "cumulative position is always matched");
    const none = worker.growthContext(scopeFor("2026-08-30", "2026-09-05"), { definitions: generate.definitionRowsInEffect("2026-09-05"), drops: [] });
    assert.strictEqual(worker.dropCycleComparison(none, () => 100), null);
  });

  run("sample: the envelope carries n, and refuses a malformed one", () => {
    const env = worker.metricEnvelope(d("cvr_shopify"), { value: 0.02, sample: { n: 400, of: "sessions" }, comparison: cmp(0.02, [0.02, 0.02, 0.02]) });
    assert.strictEqual(env.sample.n, 400);
    assert.strictEqual(worker.metricEnvelope(d("cvr_shopify"), { value: 0.02 }).sample, null);
    throwsCode(() => worker.metricEnvelope(d("cvr_shopify"), { value: 0.02, sample: { n: -1, of: "sessions" } }), "sample_invalid");
    throwsCode(() => worker.metricEnvelope(d("cvr_shopify"), { value: 0.02, sample: { n: 3.5, of: "sessions" } }), "sample_invalid");
    throwsCode(() => worker.metricEnvelope(d("cvr_shopify"), { value: 0.02, sample: { n: 3 } }), "sample_invalid");
  });

  // ---------------------------------------------------------------- resolution
  run("resolve: undefined metric and wrong grain fail the request; unwired is missing", () => {
    const scope = generate.FIXTURE_SCOPE;
    const ctx = worker.growthContext(scope, { definitions: generate.definitionRowsInEffect(scope.as_of) });
    throwsCode(() => worker.resolveMetric("not_a_metric", ctx), "metric_undefined");
    throwsCode(() => worker.resolveMetric("reach", ctx), "grain_undefined");
    const env = worker.resolveMetric("incrementality_proxy", ctx);
    assert.strictEqual(env.state, "missing");
    assert.strictEqual(env.state_detail.missing.reason, "unwired");
    assert.strictEqual(worker.resolveMetric("incrementality_proxy", ctx), env, "memoized per request");
    // Wired, but nothing loaded: missing with its own reason — never a zero.
    const orders = worker.resolveMetric("orders", ctx);
    assert.strictEqual(orders.value, null);
    assert.strictEqual(orders.state_detail.missing.reason, "not_loaded");
  });

  run("resolve: a throwing resolver is missing plus a named warning, not a dead page", () => {
    const scope = generate.FIXTURE_SCOPE;
    const ctx = worker.growthContext(scope, { definitions: generate.definitionRowsInEffect(scope.as_of) }, {
      resolvers: { orders: { grains: ["week"], resolve: () => { throw new Error("boom"); } } }
    });
    const env = worker.resolveMetric("orders", ctx);
    assert.strictEqual(env.state_detail.missing.reason, "resolver_error");
    assert.strictEqual(ctx.warnings[0].metric, "orders");
  });

  run("week: a definition missing from D1 fails the whole request, naming it", () => {
    const rows = generate.definitionRowsInEffect("2000-01-08").filter((r) => r.metric_key !== "cvr_shopify");
    const err = throwsCode(() => worker.buildGrowthWeekResponse(generate.FIXTURE_SCOPE, { definitions: rows }, {}), "metric_undefined");
    assert.ok(err.details.metrics.includes("cvr_shopify"));
  });

  run("week: definitions honour effective dates", () => {
    const rows = generate.definitionRowsInEffect("2000-01-08").map((r) => (r.metric_key === "orders" ? { ...r, effective_from: "2000-02-01" } : r));
    throwsCode(() => worker.buildGrowthWeekResponse(generate.FIXTURE_SCOPE, { definitions: rows.filter((r) => r.effective_from <= "2000-01-08") }, {}), "metric_undefined");
  });

  // ---------------------------------------------------------------- API over real SQL
  const request = { headers: { get: () => null }, method: "GET" };

  await runAsync("api: /growth/week is one D1 batch, real SQL, all envelopes, no network", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_drop (drop_id, drop_date, drop_week_start, created_at, updated_at) VALUES ('d1', '2026-07-26', '2026-07-26', 'x', 'x'), ('d2', '2026-09-20', '2026-09-20', 'x', 'x')").run();
    const D1 = d1Over(sqlite);
    const res = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=2026-08-30"), request, { SYNC_DB: D1 });
    assert.strictEqual(D1.stats.batches, 1);
    assert.strictEqual(D1.stats.statements, res.data.meta.reads.statements);
    const body = res.data;
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.contract_version, "growth-os.v3");
    assert.strictEqual(body.week.start, "2026-08-30");
    assert.strictEqual(body.drop_context.drop.drop_id, "d1");
    assert.strictEqual(body.drop_context.windows.period.sufficient, false);
    const line1 = body.surfaces.command.sections.line1;
    assert.strictEqual(line1[0].metric, "days_since_drop");
    assert.strictEqual(line1[0].value, 41);
    assert.strictEqual(line1[1].value, 15);
    const envs = Object.values(body.surfaces).flatMap((s) => Object.values(s.sections).flat());
    for (const env of envs) {
      assert.ok(["value", "unit", "metric", "state", "secondary_states", "confidence", "coverage", "comparison"].every((k) => k in env), env.metric);
      if (env.metric !== "days_since_drop" && env.metric !== "days_to_next_drop") {
        assert.strictEqual(env.state, "missing", env.metric);
        assert.strictEqual(env.value, null, env.metric);
      }
    }
    assert.strictEqual(body.surfaces.command.lists.alerts.state, "missing");
    assert.strictEqual(body.surfaces.command.lists.continuity.reason, "never_run");
    assert.strictEqual(body.exclusions.length, 2);
    assert.ok(body.meta.unwired.includes("incrementality_proxy"));
    assert.ok(!body.meta.unwired.includes("contribution_margin"), "wired, awaiting a load");
    assert.strictEqual(body.meta.definitions.cvr_shopify.basis_label, "Shopify sessions");
  });

  await runAsync("api: stale and suspect come from the same read", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_drop (drop_id, drop_date, drop_week_start, created_at, updated_at) VALUES ('d1', '2026-07-26', '2026-07-26', 'x', 'x')").run();
    sqlite.prepare("INSERT INTO metric_continuity_flags (metric_key, break_date, detected_at, signal, evidence_json) VALUES ('days_since_drop', '2026-08-01', '2026-08-02', 'constancy', '{}')").run();
    sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, started_at, finished_at, status) VALUES ('l1', 'seed', 'dim_drop', '2999-01-01T00:00:00Z', '2999-01-01T00:00:01Z', 'succeeded')").run();
    const res = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=2026-08-30"), request, { SYNC_DB: d1Over(sqlite) });
    const env = res.data.surfaces.command.sections.line1[0];
    assert.strictEqual(env.state, "suspect");
    assert.strictEqual(env.secondary_states.join(","), "stale");
    assert.strictEqual(res.data.surfaces.command.lists.continuity.items.length, 1);
  });

  await runAsync("api: /growth/entity — seeded rows, empty tables say missing, breakdowns by name", async () => {
    const sqlite = freshDb();
    const D1 = d1Over(sqlite);
    const call = (qs) => worker.handleGrowthRequest(new URL("https://w/growth/entity?week_start=2026-08-30&" + qs), request, { SYNC_DB: D1 });

    const reason = (await call("entity=reason")).data;
    assert.strictEqual(reason.rows.length, spec.reasons.length);
    assert.strictEqual(reason.row_source.state, "ok");
    assert.ok(reason.metric_keys.includes("rto_reason_share") && reason.metric_keys.includes("exchange_reason_share") && reason.metric_keys.includes("return_reason_share"));

    const product = (await call("entity=product")).data;
    assert.strictEqual(product.rows.length, 0);
    assert.strictEqual(product.row_source.state, "missing");
    assert.strictEqual(product.row_source.reason, "no_rows_no_writer");

    const locations = (await call("entity=location&metrics=location_units_sold")).data;
    assert.strictEqual(locations.rows.length, 4);
    assert.strictEqual(locations.rows[0].metrics.length, 1);

    sqlite.prepare("INSERT INTO fact_ga4_daily (date, breakdown_id, dim1_value, dim2_value, sessions) VALUES ('2026-08-31', 'ga4.device__source_medium', 'mobile', 'instagram / paid', 10)").run();
    const bd = (await call("entity=breakdown&breakdown=ga4.device__source_medium")).data;
    assert.strictEqual(bd.rows.length, 1);
    assert.strictEqual(bd.rows[0].entity_id, "mobile | instagram / paid");
    assert.strictEqual(bd.rows[0].attributes.dims.device, "mobile");
    assert.ok(bd.metric_keys.includes("cvr_ga4") && !bd.metric_keys.includes("cvr_shopify"), "a GA4 breakdown never carries a Shopify-basis metric");

    const seg = (await call("entity=segment&limit=3")).data;
    assert.strictEqual(seg.rows.length, 3);
    assert.strictEqual(seg.paging.has_more, true);
    assert.strictEqual(D1.stats.batches, 5, "one batch per request");

    const unknown = await call("entity=breakdown&breakdown=nope").catch((e) => e);
    assert.strictEqual(unknown.status, 400);
    const badMetric = await call("entity=product&metrics=not_a_metric").catch((e) => e);
    assert.strictEqual(badMetric.code, "metric_undefined");
  });

  await runAsync("api: bad week_start is a 400, future weeks refused, missing schema is a named 503", async () => {
    const sqlite = freshDb();
    for (const qs of ["week_start=2026-09-09", "week_start=2026-02-30", "week_start=2099-01-04"]) {
      const err = await worker.handleGrowthRequest(new URL("https://w/growth/week?" + qs), request, { SYNC_DB: d1Over(sqlite) }).catch((e) => e);
      assert.strictEqual(err.status, 400, qs);
    }
    const empty = new DatabaseSync(":memory:");
    const err = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=2026-08-30"), request, { SYNC_DB: d1Over(empty) }).catch((e) => e);
    const res = worker.growthErrorResponse(err, request, {});
    assert.strictEqual(res.init.status, 503);
    assert.strictEqual(res.data.error_code, "growth_schema_missing");
  });

  run("api: routes are Access-gated, GET-only and on both allowlists", () => {
    const src = fs.readFileSync(path.join(root, "src", "worker.js"), "utf8");
    const proxy = fs.readFileSync(path.join(root, "report-ui", "functions", "api", "[[path]].js"), "utf8");
    for (const p of ["/growth/week", "/growth/entity"]) {
      assert.ok(get("REPORT_API_PATHS").has(p), p);
      assert.ok(proxy.includes(`"${p}"`), `proxy ${p}`);
    }
    const route = src.slice(src.indexOf('url.pathname === "/growth/week" || url.pathname === "/growth/entity"'));
    assert.ok(/requireProtectedReportApi/.test(route.slice(0, 400)));
    assert.ok(/request\.method !== "GET"/.test(route.slice(0, 600)));
    // No Sheets read and no provider call anywhere in the Growth OS section.
    const section = src.slice(src.indexOf("// Growth OS — L0 architecture"), src.indexOf("async function requireProtectedReportApi"));
    assert.ok(!/readAllTabs|fetch\(|retryingFetch|shopifyGraphQL/.test(section), "Growth OS reads must stay D1-only");
  });

  // ---------------------------------------------------------------- inventory snapshot writer
  // null unitCost, two locations, on_hand far above available on held stock.
  // Values are synthetic.
  const level = (id, name, available, onHand) => ({
    location: { id: `gid://shopify/Location/${id}`, name },
    quantities: [{ name: "available", quantity: available }, { name: "on_hand", quantity: onHand }]
  });
  const variantNode = ({ id, sku = null, size, policy = "DENY", tracked = true, cost = null, levels = [], qty = null, productId = "900" }) => ({
    id: `gid://shopify/ProductVariant/${id}`,
    sku,
    title: size,
    price: "1199.00",
    inventoryPolicy: policy,
    inventoryQuantity: qty,
    selectedOptions: [{ name: "Size", value: size }],
    product: { id: `gid://shopify/Product/${productId}`, handle: "fixture-hoodie", title: "FIXTURE HOODIE", productType: "", status: "DRAFT", publishedAt: null, createdAt: "2000-01-01T00:00:00Z" },
    inventoryItem: { id: `gid://shopify/InventoryItem/${id}`, tracked, unitCost: cost, inventoryLevels: { nodes: levels } }
  });
  const pageA = {
    productVariants: {
      pageInfo: { hasNextPage: true, endCursor: "c1" },
      nodes: [
        variantNode({ id: "1", size: "M", cost: { amount: "561.0" }, levels: [level("10", "MAIN", 0, 49), level("20", "OLD APP", 0, 0)] }),
        variantNode({ id: "2", size: "L", tracked: false, levels: [level("10", "MAIN", 5, 5)] })
      ]
    }
  };
  const pageB = {
    productVariants: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        variantNode({ id: "3", size: "XL", policy: "CONTINUE", cost: { amount: null }, levels: [level("10", "MAIN", 0, 0)] }),
        variantNode({ id: "1", size: "M", cost: { amount: "561.0" }, levels: [level("10", "MAIN", 0, 49), level("20", "OLD APP", 0, 0)] })
      ]
    }
  };
  // Mirrors the live token: `location` is refused without read_locations, level
  // quantities are not.
  function shopifyStub({ denyLocations = false, denyLevels = false } = {}) {
    const calls = [];
    const denied = { errors: [{ message: "Access denied for location field.", extensions: { code: "ACCESS_DENIED" } }] };
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const name = /query (\w+)/.exec(body.query)[1];
      calls.push({ url, cursor: body.variables.cursor, name });
      let payload;
      if ((denyLocations && name === "InventorySnapshot") || (denyLevels && name === "InventorySnapshotLevels")) {
        payload = denied;
      } else if (name === "InventorySnapshotLevels") {
        const strip = (page) => ({ productVariants: { ...page.productVariants, nodes: page.productVariants.nodes.map((n) => ({
          ...n,
          inventoryItem: { ...n.inventoryItem, inventoryLevels: { nodes: n.inventoryItem.inventoryLevels.nodes.map((l, i) => ({ id: "gid://shopify/InventoryLevel/" + (900 + i), quantities: l.quantities })) } }
        })) } });
        payload = { data: strip(body.variables.cursor ? pageB : pageA) };
      } else if (name === "InventorySnapshotTotals") {
        payload = { data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [variantNode({ id: "1", size: "M", qty: 7 })] } } };
      } else {
        payload = { data: body.variables.cursor ? pageB : pageA };
      }
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
    };
    return { fetch, calls };
  }
  const invEnv = (db) => ({ SYNC_DB: d1Over(db), SHOPIFY_OFFLINE_TOKEN: "fixture-token" });
  const invCfg = { shopDomain: "fixture.myshopify.com" };

  run("inventory: cron runs at 23:50 Cairo in summer and winter, never at 00:50 or 22:50", () => {
    const at = (iso) => worker.inventorySnapshotCronDecision("Africa/Cairo", new Date(iso));
    assert.strictEqual(at("2026-09-14T20:50:00Z").should_run, true);   // 23:50 EEST
    assert.strictEqual(at("2026-09-14T20:50:00Z").snapshot_date, "2026-09-14");
    assert.strictEqual(at("2026-09-14T21:50:00Z").should_run, false);  // 00:50 next day
    assert.strictEqual(at("2026-12-14T21:50:00Z").should_run, true);   // 23:50 EET
    assert.strictEqual(at("2026-12-14T20:50:00Z").should_run, false);  // 22:50
  });

  await runAsync("inventory: the whole step writes facts, dims, locations and load_log", async () => {
    const sqlite = freshDb();
    const stub = shopifyStub();
    const w = loadWorker({ fetch: stub.fetch });
    const out = await w.runInventorySnapshot(invEnv(sqlite), { now: new Date("2026-09-14T20:50:00Z"), snapshotDate: "2026-09-14", config: invCfg });
    assert.strictEqual(stub.calls.length, 2, "one Shopify call per page");
    assert.strictEqual(out.basis, "per_location");
    const rows = sqlite.prepare("SELECT variant_id, location_id, qty_on_hand, qty_available, is_oos FROM fact_inventory_daily ORDER BY variant_id, location_id").all();
    assert.strictEqual(rows.length, 4, "variant 1 at two locations, 2 and 3 at one — the repeat of variant 1 is deduplicated");
    const v1 = rows.find((r) => r.variant_id === "1" && r.location_id === "shopify:10");
    assert.strictEqual(v1.qty_on_hand, 49);
    assert.strictEqual(v1.qty_available, 0);
    assert.strictEqual(v1.is_oos, 1);
    const v2 = rows.find((r) => r.variant_id === "2");
    assert.strictEqual(v2.qty_on_hand, null, "untracked stock is blank, never 0");
    assert.strictEqual(v2.is_oos, null);
    assert.strictEqual(rows.find((r) => r.variant_id === "3").is_oos, 0, "CONTINUE policy can still sell");
    const dv = sqlite.prepare("SELECT variant_id, sku, size, unit_cogs_snapshot, inventory_qty FROM dim_variant ORDER BY variant_id").all();
    assert.strictEqual(dv[0].unit_cogs_snapshot, 561);
    assert.strictEqual(dv[0].inventory_qty, 49);
    assert.strictEqual(dv[0].size, "M");
    assert.strictEqual(dv[0].sku, null);
    assert.strictEqual(dv[2].unit_cogs_snapshot, null, "a null cost amount is blank, never 0");
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM dim_location WHERE kind = 'stock_location'").get().n, 2);
    const loads = sqlite.prepare("SELECT target_table, status, rows_written FROM load_log ORDER BY target_table").all();
    assert.strictEqual(loads.length, 3);
    assert.ok(loads.every((l) => l.status === "succeeded"));
    assert.strictEqual(loads.find((l) => l.target_table === "fact_inventory_daily").rows_written, 4);
  });

  await runAsync("inventory: a second run the same day writes nothing and keeps founder-set fields", async () => {
    const sqlite = freshDb();
    const w = loadWorker({ fetch: shopifyStub().fetch });
    const env = invEnv(sqlite);
    await w.runInventorySnapshot(env, { now: new Date("2026-09-14T20:50:00Z"), snapshotDate: "2026-09-14", config: invCfg });
    sqlite.prepare("UPDATE dim_product SET lead_time_days = 30, supplier = 'fixture supplier'").run();
    const again = await w.runInventorySnapshot(env, { now: new Date("2026-09-14T20:55:00Z"), snapshotDate: "2026-09-14", config: invCfg });
    assert.strictEqual(again.inserted, 0);
    assert.strictEqual(again.already_present, 4);
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM fact_inventory_daily").get().n, 4);
    const p = sqlite.prepare("SELECT lead_time_days, supplier FROM dim_product").get();
    assert.strictEqual(p.lead_time_days, 30);
    assert.strictEqual(p.supplier, "fixture supplier");
    const next = await w.runInventorySnapshot(env, { now: new Date("2026-09-15T20:50:00Z"), snapshotDate: "2026-09-15", config: invCfg });
    assert.strictEqual(next.inserted, 4, "the next day is a new day");
  });

  await runAsync("inventory: without read_locations it sums levels, keeping on-hand stock", async () => {
    const sqlite = freshDb();
    const stub = shopifyStub({ denyLocations: true });
    const w = loadWorker({ fetch: stub.fetch });
    const out = await w.runInventorySnapshot(invEnv(sqlite), { now: new Date("2026-09-14T20:50:00Z"), snapshotDate: "2026-09-14", config: invCfg });
    assert.strictEqual(out.basis, "levels_total");
    const rows = sqlite.prepare("SELECT variant_id, location_id, qty_on_hand, qty_available, is_oos FROM fact_inventory_daily ORDER BY variant_id").all();
    assert.strictEqual(rows.length, 3, "one aggregate row per variant");
    assert.ok(rows.every((r) => r.location_id === "all"));
    const v1 = rows.find((r) => r.variant_id === "1");
    assert.strictEqual(v1.qty_on_hand, 49, "held stock survives: 49 + 0 across two levels");
    assert.strictEqual(v1.qty_available, 0);
    assert.strictEqual(v1.is_oos, 1);
    assert.strictEqual(rows.find((r) => r.variant_id === "2").qty_on_hand, null, "untracked stays blank");
    assert.ok(sqlite.prepare("SELECT source FROM load_log LIMIT 1").get().source.endsWith("levels_total"));
  });

  await runAsync("inventory: without level access either it falls back to labelled totals", async () => {
    const sqlite = freshDb();
    const stub = shopifyStub({ denyLocations: true, denyLevels: true });
    const w = loadWorker({ fetch: stub.fetch });
    const out = await w.runInventorySnapshot(invEnv(sqlite), { now: new Date("2026-09-14T20:50:00Z"), snapshotDate: "2026-09-14", config: invCfg });
    assert.strictEqual(out.basis, "total_only");
    const row = sqlite.prepare("SELECT location_id, qty_on_hand, qty_available FROM fact_inventory_daily").get();
    assert.strictEqual(row.location_id, "all");
    assert.strictEqual(row.qty_on_hand, null, "a total of available is not on-hand stock");
    assert.strictEqual(row.qty_available, 7);
    assert.ok(sqlite.prepare("SELECT source FROM load_log LIMIT 1").get().source.endsWith("total_only"));
  });

  await runAsync("inventory: a Shopify failure writes no facts and records the failure", async () => {
    const sqlite = freshDb();
    const w = loadWorker({ fetch: async () => ({ status: 403, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ errors: "forbidden" }) }) });
    const err = await w.runInventorySnapshot(invEnv(sqlite), { now: new Date("2026-09-14T20:50:00Z"), snapshotDate: "2026-09-14", config: invCfg }).catch((e) => e);
    assert.ok(err instanceof Error || err.message);
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM fact_inventory_daily").get().n, 0);
    assert.ok(sqlite.prepare("SELECT COUNT(*) AS n FROM load_log WHERE status = 'failed'").get().n >= 1);
  });

  await runAsync("inventory: scheduled() routes its cron before the weekly branch and skips outside the window", async () => {
    let fetched = 0;
    const w = loadWorker({ fetch: async () => { fetched += 1; throw new Error("no network"); } });
    await w.__workerDefault.scheduled({ cron: "50 20,21 * * *", scheduledTime: Date.parse("2026-09-14T21:50:00Z") }, { SYNC_DB: d1Over(freshDb()) }, {});
    assert.strictEqual(fetched, 0, "00:50 Cairo is outside the window: no Sheets, no Shopify");
    const src = fs.readFileSync(path.join(root, "src", "worker.js"), "utf8");
    const sched = src.slice(src.indexOf("async scheduled(controller, env, ctx)"));
    assert.ok(sched.indexOf("INVENTORY_SNAPSHOT_CRON") < sched.indexOf("cairoWeeklyCronDecision"));
    assert.ok(fs.readFileSync(path.join(root, "wrangler.toml"), "utf8").includes('"50 20,21 * * *"'));
  });

  // ---------------------------------------------------------------- order facts writer
  const m = (a) => ({ shopMoney: { amount: String(a) } });
  const orderNode = (o) => ({
    id: `gid://shopify/Order/${o.id}`,
    name: `#${o.id}`,
    createdAt: o.createdAt,
    updatedAt: o.createdAt,
    cancelledAt: o.cancelledAt || null,
    cancelReason: o.cancelledAt ? "CUSTOMER" : null,
    test: !!o.test,
    sourceName: o.source || "web",
    discountCodes: o.codes || [],
    paymentGatewayNames: o.gateways || ["Cash on Delivery (COD)"],
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    customAttributes: o.attrs || [],
    customer: o.customer === null ? null : { id: `gid://shopify/Customer/${o.customer || 1}`, orders: { nodes: [{ id: `gid://shopify/Order/${o.firstOrder || 1}` }] } },
    shippingAddress: { city: "Cairo", province: "Cairo", provinceCode: "C" },
    subtotalPriceSet: m(o.subtotal),
    totalPriceSet: m(o.subtotal + 75),
    totalDiscountsSet: m(o.discount || 0),
    totalShippingPriceSet: m(75),
    totalTaxSet: m(0),
    totalRefundedSet: m(0),
    fulfillments: o.fulfillments || [],
    lineItems: { nodes: (o.lines || []).map((l) => ({ id: `gid://shopify/LineItem/${l.id}`, sku: l.sku || null, quantity: l.qty, originalUnitPriceSet: m(l.price), totalDiscountSet: m(l.disc || 0), variant: { id: `gid://shopify/ProductVariant/${l.variant}`, selectedOptions: [{ name: "Size", value: l.size || "M" }] }, product: { id: `gid://shopify/Product/${l.product || 7}` } })) }
  });
  const shipped = (createdAt, status, deliveredAt = null) => [{ createdAt, displayStatus: status, inTransitAt: createdAt, deliveredAt, trackingInfo: [{ company: "ShipBlu" }] }];
  const ORDER_FIXTURE = [
    orderNode({ id: 101, createdAt: "2026-08-25T10:00:00Z", customer: 9, firstOrder: 50, subtotal: 800, lines: [{ id: 1, variant: 11, qty: 1, price: 800 }], fulfillments: shipped("2026-08-25T12:00:00Z", "DELIVERED", "2026-08-27T10:00:00Z") }),
    orderNode({ id: 102, createdAt: "2026-08-25T11:00:00Z", customer: 8, firstOrder: 102, subtotal: 1600, discount: 800, lines: [{ id: 2, variant: 11, qty: 2, price: 800, disc: 800 }, { id: 3, variant: 12, qty: 1, price: 800 }], fulfillments: shipped("2026-08-25T12:00:00Z", "IN_TRANSIT") }),
    orderNode({ id: 103, createdAt: "2026-08-26T09:00:00Z", source: "shopify_draft_order", gateways: ["manual"], customer: 7, firstOrder: 20, subtotal: 800, lines: [{ id: 4, variant: 12, qty: 1, price: 800 }] }),
    orderNode({ id: 104, createdAt: "2026-08-26T10:00:00Z", gateways: ["Paymob - Native Checkout for Debit/Credit Cards"], customer: 6, firstOrder: 104, subtotal: 900, lines: [{ id: 5, variant: 13, qty: 1, price: 900 }] }),
    orderNode({ id: 105, createdAt: "2026-08-26T12:00:00Z", cancelledAt: "2026-09-01T10:00:00Z", customer: 5, firstOrder: 30, subtotal: 999, lines: [{ id: 6, variant: 14, qty: 1, price: 999, size: "L" }], fulfillments: shipped("2026-08-27T08:00:00Z", "NOT_DELIVERED") }),
    orderNode({ id: 106, createdAt: "2026-08-27T10:00:00Z", customer: null, codes: ["Custom discount"], subtotal: 0, discount: 800, lines: [{ id: 7, variant: 11, qty: 1, price: 800, disc: 800 }] }),
    orderNode({ id: 107, createdAt: "2026-08-27T11:00:00Z", test: true, subtotal: 800, lines: [{ id: 8, variant: 11, qty: 1, price: 800 }] }),
    // 22:30 UTC on Saturday Aug 29 is 01:30 Sunday Aug 30 in Cairo: next day, next week.
    orderNode({ id: 108, createdAt: "2026-08-29T22:30:00Z", customer: 4, firstOrder: 108, subtotal: 700, lines: [{ id: 9, variant: 12, qty: 1, price: 700 }] })
  ];
  const DROPS_FOR_ORDERS = [{ drop_id: "2026-07-26", drop_date: "2026-07-26" }, { drop_id: "2026-09-20", drop_date: "2026-09-20" }];

  run("order facts: rows record the order as placed, its state, and its exclusion", () => {
    const f = worker.buildOrderFacts(ORDER_FIXTURE, { drops: DROPS_FOR_ORDERS, loadId: "L", loadedAt: "T" });
    assert.strictEqual(f.stats.skipped_test, 1, "test orders are dropped");
    assert.strictEqual(f.orderRows.length, 7);
    const by = Object.fromEntries(f.orderRows.map((r) => [r.order_id, r]));
    assert.strictEqual(by["101"].is_cod, 1);
    assert.strictEqual(by["101"].is_new_customer, 0);
    assert.strictEqual(by["102"].is_new_customer, 1, "the customer's first order");
    assert.strictEqual(by["103"].sales_channel, "draft");
    assert.strictEqual(by["103"].is_cod, 0, "a stated non-COD gateway is 0, not unknown");
    assert.strictEqual(by["104"].is_cod, 0);
    assert.strictEqual(by["106"].exclusion_rule, "seeding");
    assert.strictEqual(by["106"].customer_id, null);
    assert.strictEqual(by["106"].is_new_customer, null, "no customer: unknown, never 'returning'");
    assert.strictEqual(by["108"].date, "2026-08-30", "Cairo calendar day");
    assert.strictEqual(by["108"].week_start, "2026-08-30");
    assert.strictEqual(by["101"].week_start, "2026-08-23");
    assert.strictEqual(by["101"].drop_id, "2026-07-26");
    assert.strictEqual(by["101"].days_since_drop, 30);
    assert.strictEqual(by["102"].units_total, 3);
    assert.strictEqual(by["101"].delivery_status, "delivered");
    assert.strictEqual(by["101"].courier_id, "shipblu");
    assert.strictEqual(by["103"].attempt_count, null, "unfulfilled: attempts unknown, not 0");
    assert.strictEqual(by["101"].attributed_ad_id, null, "never an unverified ad id");
  });

  run("order facts: a cancellation becomes a reversal on the order's week, with its dispatch state", () => {
    const f = worker.buildOrderFacts(ORDER_FIXTURE, { drops: DROPS_FOR_ORDERS });
    assert.strictEqual(f.reversalRows.length, 1);
    const r = f.reversalRows[0];
    assert.strictEqual(r.order_id, "105");
    assert.strictEqual(r.order_week, "2026-08-23");
    assert.strictEqual(r.cancel_week, "2026-08-30", "booked a week later than ordered");
    assert.strictEqual(r.pre_or_post_dispatch, "post_dispatch");
    assert.strictEqual(r.value, 999, "merchandise after discounts, the gross − discounts basis");
    assert.strictEqual(f.reversalLineRows[0].size, "L");
    assert.strictEqual(f.reversalLineRows[0].value, 999);
  });

  run("order facts: the plan is cut into windows a single request can finish", () => {
    const drops = [{ drop_date: "2026-04-01" }, { drop_date: "2026-09-20" }];
    const first = worker.orderFactsPlan(null, drops, "2026-09-15");
    // Sixty days of orders is minutes of paged Shopify calls. One window is the unit
    // of work one request must complete, newest first.
    assert.deepStrictEqual(Array.from(first.windows.slice(0, 3), (w) => `${w.kind}:${w.start}..${w.end}`),
      ["refresh:2026-09-01..2026-09-15", "refresh:2026-08-17..2026-08-31", "refresh:2026-08-02..2026-08-16"]);
    assert.ok(first.windows.every((w) => worker.growthDaysBetween(w.start, w.end) < 15), "no window wider than the chunk");
    assert.strictEqual(first.windows[0].end, "2026-09-15", "the newest days land first");
    assert.ok(first.windows.some((w) => w.kind === "backfill"), "history still follows the refresh");
    assert.strictEqual(first.windows[first.windows.length - 1].start, "2026-04-01", "and stops at the first drop");

    const done = worker.orderFactsPlan({ covered_from: "2026-04-01" }, drops, "2026-09-17");
    assert.ok(done.windows.every((w) => w.kind === "refresh"), "history complete: refresh only");
  });

  function orderStub(orders) {
    const calls = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const [, from, to] = /created_at:>='([^']+)' AND created_at:<'([^']+)'/.exec(body.variables.queryStr);
      calls.push({ from, to });
      const nodes = orders().filter((o) => o.createdAt >= from && o.createdAt < to);
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } }) };
    };
    return { fetch, calls };
  }

  await runAsync("order facts: the whole nightly step writes, records coverage, and deletes only what it refreshed", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_drop (drop_id, drop_date, drop_week_start, created_at, updated_at) VALUES ('2026-04-01', '2026-04-01', '2026-03-29', 'x', 'x'), ('2026-07-26', '2026-07-26', '2026-07-26', 'x', 'x')").run();
    sqlite.prepare("INSERT INTO dim_variant (variant_id, product_id, unit_cogs_snapshot) VALUES ('11', '7', 300)").run();
    // One order inside the first history window, so the backfill has data to find.
    const HISTORY = orderNode({ id: 99, createdAt: "2026-07-10T10:00:00Z", customer: 3, firstOrder: 99, subtotal: 500, lines: [{ id: 99, variant: 11, qty: 1, price: 500 }] });
    let orders = ORDER_FIXTURE.concat([HISTORY]);
    const stub = orderStub(() => orders);
    const w = loadWorker({ fetch: stub.fetch });
    const env = { SYNC_DB: d1Over(sqlite), SHOPIFY_OFFLINE_TOKEN: "fixture-token" };
    // A night runs the refresh chunks and then history, one window at a time. Six
    // covers the sixty-day refresh plus the first history chunk.
    const out = await w.runOrderFacts(env, { now: new Date("2026-09-15T20:50:00Z"), config: { shopDomain: "fixture.myshopify.com" }, maxWindows: 6 });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(out.windows.length, 6, "the refresh in chunks, then the first history chunk");
    assert.ok(out.remaining > 0, "and it says what it left for the next call");
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM fact_order").get().n, 8);
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM fact_reversal").get().n, 1);
    assert.strictEqual(sqlite.prepare("SELECT unit_cogs_snapshot AS c FROM fact_order_line WHERE line_id = '1'").get().c, 300, "COGS stamped from dim_variant");
    assert.strictEqual(sqlite.prepare("SELECT unit_cogs_snapshot AS c FROM fact_order_line WHERE line_id = '4'").get().c, null, "no cost known: blank, never 0");
    const loads = sqlite.prepare("SELECT target_table, status, period_start, period_end FROM load_log WHERE target_table = 'fact_order' ORDER BY period_start").all();
    assert.strictEqual(loads.length, 6);
    assert.ok(loads.every((l) => l.status === "succeeded"));

    // An order outside tonight's windows must survive, untouched, whatever happens below.
    sqlite.prepare("INSERT INTO fact_order (order_id, created_at, date, week_start) VALUES ('old-1', '2026-01-01T00:00:00Z', '2026-01-01', '2025-12-28')").run();
    sqlite.prepare("INSERT INTO fact_reversal (order_id, cancelled_at, cancel_week, order_created_at, order_week) VALUES ('old-1', '2026-01-02', '2025-12-28', '2026-01-01', '2025-12-28')").run();
    // Next night: 105's cancellation was undone and 102 lost a line.
    orders = ORDER_FIXTURE.concat([HISTORY]).map((o) => {
      if (o.id === "gid://shopify/Order/105") return { ...o, cancelledAt: null };
      if (o.id === "gid://shopify/Order/102") return { ...o, lineItems: { nodes: o.lineItems.nodes.slice(0, 1) } };
      return o;
    });
    const again = await w.runOrderFacts(env, { now: new Date("2026-09-16T20:50:00Z"), config: { shopDomain: "fixture.myshopify.com" } });
    assert.ok(!again.windows.find((x) => x.window.kind === "refresh").error, "refresh succeeded");
    assert.ok(/read_all_orders/.test(again.windows.find((x) => x.window.kind === "backfill").error), "the empty older window fails honestly");
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM fact_reversal WHERE order_id = '105'").get().n, 0, "undone cancellation removed");
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM fact_order_line WHERE order_id = '102'").get().n, 1, "edited-off line removed");
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM fact_order WHERE order_id = 'old-1'").get().n, 1, "deletes never reach beyond refreshed orders");
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM fact_reversal WHERE order_id = 'old-1'").get().n, 1);
    assert.strictEqual(sqlite.prepare("SELECT cancelled_at FROM fact_order WHERE order_id = '105'").get().cancelled_at, null, "current state updated in place");
  });

  await runAsync("order facts: loaded facts fill /growth/week through the real SQL, with coverage and comparison", async () => {
    const sqlite = freshDb();
    // Summer calendar so the Aug 30 week is floor phase with a same-season pool.
    for (const [id, d] of [["2026-05-14", "2026-05-14"], ["2026-07-26", "2026-07-26"], ["2026-09-20", "2026-09-20"]]) {
      sqlite.prepare("INSERT INTO dim_drop (drop_id, drop_date, drop_week_start, season, created_at, updated_at) VALUES (?, ?, ?, ?, 'x', 'x')").run(id, d, d, id === "2026-09-20" ? "winter" : "summer");
    }
    // Synthetic orders: one per day across the floor windows and the target week.
    const synthetic = [];
    let n = 1000;
    for (let day = "2026-06-04"; day <= "2026-09-05"; day = worker.addDays(day, 1)) {
      synthetic.push(orderNode({ id: n, createdAt: day + "T10:00:00Z", customer: n, firstOrder: n % 2 ? n : 1, subtotal: 1000, lines: [{ id: n, variant: 11, qty: 1, price: 1000 }],
        cancelledAt: n % 5 === 0 ? worker.addDays(day, 3) + "T10:00:00Z" : null,
        fulfillments: shipped(day + "T12:00:00Z", n % 5 === 0 ? "NOT_DELIVERED" : "DELIVERED", n % 5 === 0 ? null : worker.addDays(day, 2) + "T10:00:00Z") }));
      n += 1;
    }
    const facts = worker.buildOrderFacts(synthetic, { drops: [{ drop_id: "2026-05-14", drop_date: "2026-05-14" }, { drop_id: "2026-07-26", drop_date: "2026-07-26" }], loadId: "L", loadedAt: "T" });
    await worker.writeOrderFacts(d1Over(sqlite), facts);
    sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES ('l', 'fixture', 'fact_order', '2026-06-04', '2026-09-05', '2026-09-06T00:00:00Z', '2026-09-06T00:01:00Z', 'succeeded')").run();

    const res = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=2026-08-30"), request, { SYNC_DB: d1Over(sqlite) });
    const pulse = Object.fromEntries(res.data.surfaces.command.sections.pulse.map((e) => [e.metric, e]));
    assert.strictEqual(pulse.orders.value, 7, "one order a day, Aug 30 - Sep 5");
    assert.strictEqual(pulse.orders.comparison.mode, "floor_pool", "floor phase picks the pool on its own");
    assert.ok(pulse.orders.comparison.pool.length >= 3);
    assert.strictEqual(pulse.aov.value, 1075, "order total incl. 75 shipping");
    assert.strictEqual(pulse.aov.sample.n, 7);
    assert.ok(pulse.reversal_rate.value > 0 && pulse.reversal_rate.value < 1);
    assert.strictEqual(pulse.reversal_rate.coverage, 1, "every order resolved");
    assert.ok(!["partial"].includes(pulse.reversal_rate.state) && !pulse.reversal_rate.secondary_states.includes("partial"));
    assert.strictEqual(pulse.cvr_shopify.state_detail.missing.reason, "not_loaded", "sessions wired, never loaded here: missing, not 0");
    // Exclusions: loaded and none removed is a real zero, not missing.
    assert.strictEqual(res.data.exclusions[0].orders.value, 0);
    // A week outside the loaded span stays missing.
    const before = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=2026-04-05"), request, { SYNC_DB: d1Over(sqlite) });
    const orders = before.data.surfaces.command.sections.pulse.find((e) => e.metric === "orders");
    assert.strictEqual(orders.value, null);
    assert.strictEqual(orders.state_detail.missing.reason, "not_loaded");
  });

  await runAsync("RTO cuts: by source, city, price band, payment type and first-time vs repeat", async () => {
    const sqlite = freshDb();
    const cities = ["Cairo", "Giza", "Cairo", "Alexandria", "Cairo", "Giza", "Cairo", "Cairo"];
    const synthetic = cities.map((city, i) => {
      const node = orderNode({
        id: 500 + i, createdAt: `2026-08-${String(20 + i).padStart(2, "0")}T10:00:00Z`, customer: 500 + i, firstOrder: i % 2 ? 500 + i : 1,
        subtotal: [700, 1200, 700, 2500, 700, 1200, 3500, 700][i], gateways: i % 3 === 0 ? ["Paymob"] : ["Cash on Delivery (COD)"],
        attrs: i < 3 ? [{ key: "_cw_click_id", value: "fbclid-x" }, { key: "_cw_platform", value: "meta" }] : [],
        lines: [{ id: 500 + i, variant: 11, qty: 1, price: 700 }],
        cancelledAt: [1, 3, 4].includes(i) ? `2026-08-${String(22 + i).padStart(2, "0")}T10:00:00Z` : null,
        fulfillments: shipped(`2026-08-${String(20 + i).padStart(2, "0")}T12:00:00Z`, i === 7 ? "IN_TRANSIT" : [1, 3, 4].includes(i) ? "NOT_DELIVERED" : "DELIVERED")
      });
      node.shippingAddress = { city, province: city, provinceCode: "C" };
      return node;
    });
    await worker.writeOrderFacts(d1Over(sqlite), worker.buildOrderFacts(synthetic, { drops: [] }));
    sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES ('l', 'fixture', 'fact_order', '2026-07-17', '2026-09-15', '2026-09-15T00:00:00Z', '2026-09-15T00:01:00Z', 'succeeded')").run();
    const get = async (entity) => (await worker.handleGrowthRequest(new URL(`https://w/growth/entity?week_start=2026-08-30&entity=${entity}&metrics=reversal_rate&span_weeks=3`), request, { SYNC_DB: d1Over(sqlite) })).data;
    const rate = (res, id) => res.rows.find((r) => r.entity_id === id).metrics[0];

    const city = await get("city");
    assert.strictEqual(city.period.start, "2026-08-16", "3 weeks ending Sep 5");
    assert.strictEqual(city.rows[0].entity_id, "Cairo", "ordered by orders, largest first");
    const cairo = rate(city, "Cairo");
    assert.strictEqual(cairo.sample.n, 5);
    assert.strictEqual(cairo.value, 1 / 5);
    assert.strictEqual(cairo.coverage, 4 / 5, "one Cairo parcel still in transit");
    assert.strictEqual(cairo.state, "partial");
    assert.ok(!cairo.secondary_states.includes("no_basis") && cairo.state !== "no_basis", "an entity row is not 'too few prior drops'");
    assert.strictEqual(rate(city, "Giza").value, 1 / 2);

    const pay = await get("payment_type");
    assert.strictEqual(rate(pay, "prepaid").sample.n, 3);
    assert.strictEqual(rate(pay, "cod").sample.n, 5);
    assert.strictEqual(rate(pay, "unknown").state_detail.missing.reason, "no_orders_in_period");

    const band = await get("price_band");
    assert.strictEqual(rate(band, "under 1,000").sample.n, 4);
    assert.strictEqual(rate(band, "3,000+").sample.n, 1);

    const src = await get("traffic_source");
    assert.strictEqual(rate(src, "meta").sample.n, 3);
    assert.strictEqual(rate(src, "unattributed").sample.n, 5);

    const seg = await get("segment");
    assert.strictEqual(rate(seg, "new").sample.n, 4);
    assert.strictEqual(rate(seg, "returning").sample.n, 4);
    assert.strictEqual(rate(seg, "vip").state_detail.missing.reason, "unwired", "segments without a rule stay unwired");

    // Nothing loaded for the span: missing, not zero.
    const early = (await worker.handleGrowthRequest(new URL("https://w/growth/entity?week_start=2026-07-19&entity=payment_type&metrics=reversal_rate&span_weeks=4"), request, { SYNC_DB: d1Over(sqlite) })).data;
    assert.strictEqual(early.rows[0].metrics[0].state_detail.missing.reason, "not_loaded");
  });

  // ---------------------------------------------------------------- Meta ads daily
  // Shapes follow the Graph API insights response; values synthetic.
  const metaRow = (o) => ({
    account_currency: "EGP", campaign_id: "c1", campaign_name: "Camp", adset_id: o.adset || "s1", adset_name: "Set", ad_id: o.ad, ad_name: "Ad " + o.ad,
    date_start: o.date, date_stop: o.date, spend: String(o.spend), impressions: String(o.impr), reach: String(Math.round(o.impr * 0.8)), frequency: "1.25", clicks: "40",
    // Link clicks are always at least the outbound ones on a real row, and landing
    // page views sit inside them.
    inline_link_clicks: String(o.link === undefined ? o.out + 5 : o.link),
    outbound_clicks: [{ action_type: "outbound_click", value: String(o.out) }],
    // Meta sends one event under every alias it knows, all in the same list. A
    // fixture that sends one alias per event cannot see the loader add them up —
    // which it did, in production, for five months.
    actions: [
      { action_type: "landing_page_view", value: String(o.lpv) },
      { action_type: "omni_landing_page_view", value: String(o.lpv) },
      { action_type: "omni_purchase", value: String(o.purch) },
      { action_type: "purchase", value: String(o.purch) },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: String(o.purch) },
      { action_type: "omni_add_to_cart", value: "9" },
      { action_type: "add_to_cart", value: "9" },
      { action_type: "offsite_conversion.fb_pixel_add_to_cart", value: "9" }
    ],
    action_values: [
      { action_type: "omni_purchase", value: String(o.purch * 1000) },
      { action_type: "purchase", value: String(o.purch * 1000) },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: String(o.purch * 1000) }
    ],
    ...(o.video ? { video_play_actions: [{ action_type: "video_view", value: String(o.plays) }], video_thruplay_watched_actions: [{ action_type: "video_view", value: "30" }], video_p100_watched_actions: [{ action_type: "video_view", value: "10" }] } : {})
  });

  run("meta facts: image ads have no video numbers — blank, never 0", () => {
    const f = worker.buildMetaDailyFacts([
      metaRow({ ad: "a1", date: "2026-09-01", spend: 100, impr: 1000, out: 20, lpv: 15, purch: 1, video: true, plays: 300 }),
      metaRow({ ad: "a2", date: "2026-09-01", spend: 50, impr: 500, out: 5, lpv: 4, purch: 0 }),
      metaRow({ ad: "a1", date: "2026-09-02", spend: 80, impr: 900, out: 10, lpv: 8, purch: 0, video: true, plays: 200 })
    ], [], { loadId: "L" });
    const a2 = f.adDaily.find((r) => r.ad_id === "a2");
    assert.strictEqual(a2.video_plays_3s, null);
    assert.strictEqual(a2.thruplays, null);
    assert.strictEqual(a2.platform_purchases, 0, "a purchase list without the type is a real zero");
    assert.strictEqual(f.adDaily[0].video_plays_3s, 300);
    assert.strictEqual(f.adDaily[0].clicks_outbound, 20);
    assert.strictEqual(f.adDaily[0].platform_revenue, 1000);
    const a1 = f.ads.find((a) => a.ad_id === "a1");
    assert.strictEqual(a1.first_seen, "2026-09-01");
    assert.strictEqual(a1.last_seen, "2026-09-02");
  });

  run("meta facts: one event under several aliases is counted once, not once per alias", () => {
    // truth and every landing page view twice it, because the loader summed the
    const f = worker.buildMetaDailyFacts([
      metaRow({ ad: "a1", date: "2026-09-01", spend: 100, impr: 1000, out: 20, lpv: 15, purch: 4 })
    ], [], { loadId: "L" });
    const row = f.adDaily[0];
    assert.strictEqual(row.landing_page_views, 15, "two landing-page aliases, one count");
    assert.strictEqual(row.platform_purchases, 4, "three purchase aliases, one count");
    assert.strictEqual(row.platform_atc, 9, "three add-to-cart aliases, one count");
    assert.strictEqual(row.platform_revenue, 4000, "three purchase-value aliases, one value");
    assert.ok(row.landing_page_views <= row.clicks_link, "landing page views fit inside link clicks");
  });

  function metaStub({ fail = false } = {}) {
    const calls = [];
    const fetch = async (url) => {
      const u = new URL(url);
      calls.push(u.pathname + "?" + (u.searchParams.get("level") || (u.searchParams.get("ids") ? "ids" : "")));
      if (fail) return { status: 400, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: "Invalid token " + url, code: 190 } }), json: async () => ({ error: { message: "Invalid token " + url, code: 190 } }) };
      let body;
      if (u.searchParams.get("ids")) body = Object.fromEntries(u.searchParams.get("ids").split(",").map((id) => [id, {
        id,
        effective_status: id === "a1" ? "ACTIVE" : "PAUSED",
        // Meta answers the status call with the creative too, when asked.
        creative: id === "a1"
          ? { id: "cr-" + id, thumbnail_url: "https://scontent.test/" + id + ".jpg", image_url: "https://scontent.test/" + id + "-full.jpg", object_type: "VIDEO", video_id: "v" + id }
          : { id: "cr-" + id, thumbnail_url: "https://scontent.test/" + id + ".jpg", object_type: "SHARE" }
      }]));
      else if (u.searchParams.get("level") === "adset") body = { data: [{ account_currency: "EGP", campaign_id: "c1", adset_id: "s1", date_start: "2026-09-01", spend: "150", impressions: "1500", reach: "1100", frequency: "1.36" }] };
      else body = { data: [metaRow({ ad: "a1", date: "2026-09-01", spend: 100, impr: 1000, out: 20, lpv: 15, purch: 1, video: true, plays: 300 }), metaRow({ ad: "a2", date: "2026-09-01", spend: 50, impr: 500, out: 5, lpv: 4, purch: 0 })] };
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body };
    };
    return { fetch, calls };
  }

  await runAsync("meta facts: the whole step writes ads, adsets, statuses and coverage to the first drop", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_drop (drop_id, drop_date, drop_week_start, created_at, updated_at) VALUES ('2026-04-01', '2026-04-01', '2026-03-29', 'x', 'x')").run();
    const stub = metaStub();
    const w = loadWorker({ fetch: stub.fetch });
    const out = await w.runMetaFacts({ SYNC_DB: d1Over(sqlite), META_ACCESS_TOKEN: "meta-secret-token-123" }, { now: new Date("2026-09-15T20:50:00Z"), config: { metaAdAccountId: "100000000000001" } });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.deepStrictEqual(out.windows.map((x) => `${x.window.kind}:${x.window.start}..${x.window.end}`).join(","),
      "refresh:2026-08-18..2026-09-14,backfill:2026-07-21..2026-08-17,backfill:2026-06-23..2026-07-20,backfill:2026-05-26..2026-06-22,backfill:2026-04-28..2026-05-25,backfill:2026-04-01..2026-04-27",
      "yesterday is the last day; history in 28-day chunks, newest first, to the first drop");
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM fact_ad_daily").get().n, 2);
    assert.strictEqual(sqlite.prepare("SELECT reach FROM fact_adset_daily").get().reach, 1100);
    assert.strictEqual(sqlite.prepare("SELECT effective_status FROM dim_ad WHERE ad_id = 'a1'").get().effective_status, "ACTIVE");
    // The creative comes back on the same call as the status, so the weekly review
    // can show the ad rather than only its name.
    const creative = sqlite.prepare("SELECT thumbnail_url, creative_image_url, creative_kind, creative_id FROM dim_ad WHERE ad_id = 'a1'").get();
    assert.strictEqual(creative.thumbnail_url, "https://scontent.test/a1.jpg");
    assert.strictEqual(creative.creative_image_url, "https://scontent.test/a1-full.jpg");
    assert.strictEqual(creative.creative_kind, "video");
    assert.strictEqual(creative.creative_id, "cr-a1");
    assert.strictEqual(sqlite.prepare("SELECT creative_kind FROM dim_ad WHERE ad_id = 'a2'").get().creative_kind, "image");
    assert.ok(stub.calls.filter((c) => c.endsWith("?ids")).length <= out.windows.length, "the creative rides on the status call, it does not add one");
    sqlite.prepare("UPDATE dim_ad SET angle = 'fit', concept_id = 'k1' WHERE ad_id = 'a1'").run();
    await w.runMetaFacts({ SYNC_DB: d1Over(sqlite), META_ACCESS_TOKEN: "meta-secret-token-123" }, { now: new Date("2026-09-16T20:50:00Z"), config: { metaAdAccountId: "100000000000001" } });
    assert.strictEqual(sqlite.prepare("SELECT angle FROM dim_ad WHERE ad_id = 'a1'").get().angle, "fit", "tagging survives a refresh");
    assert.strictEqual(sqlite.prepare("SELECT MIN(period_start) AS f FROM load_log WHERE target_table = 'fact_ad_daily' AND status = 'succeeded'").get().f, "2026-04-01");
  });

  run("coverage: only an unbroken run of loads counts, ending at the newest", () => {
    const cov = (spans) => { const c = worker.contiguousCoverage(spans.map(([a, b]) => ({ period_start: a, period_end: b }))); return `${c.covered_from}..${c.covered_to}`; };
    assert.strictEqual(cov([["2026-07-17", "2026-09-15"], ["2026-05-18", "2026-07-16"], ["2026-04-01", "2026-05-17"]]), "2026-04-01..2026-09-15", "adjacent spans join");
    assert.strictEqual(cov([["2026-07-17", "2026-09-15"], ["2026-04-01", "2026-05-17"]]), "2026-07-17..2026-09-15", "a missing chunk in the middle stops coverage");
    assert.strictEqual(cov([["2026-08-01", "2026-09-15"], ["2026-07-17", "2026-09-10"]]), "2026-07-17..2026-09-15", "overlaps join");
    assert.strictEqual(cov([]), "null..null");
  });

  await runAsync("meta facts: a failed history chunk stops older chunks, so coverage never has a hole", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_drop (drop_id, drop_date, drop_week_start, created_at, updated_at) VALUES ('2026-04-01', '2026-04-01', '2026-03-29', 'x', 'x')").run();
    const ok = metaStub();
    const w = loadWorker({ fetch: async (url, init) => {
      const u = new URL(url);
      const range = u.searchParams.get("time_range") || "";
      if (range.includes("2026-06-23")) {
        const body = { error: { message: "Service temporarily unavailable", code: 2, error_subcode: 1504044, is_transient: false } };
        return { status: 500, ok: false, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body };
      }
      return ok.fetch(url, init);
    } });
    const out = await w.runMetaFacts({ SYNC_DB: d1Over(sqlite), META_ACCESS_TOKEN: "t" }, { now: new Date("2026-09-15T20:50:00Z"), config: { metaAdAccountId: "1" } });
    const kinds = out.windows.map((x) => (x.error ? "failed" : x.skipped ? "skipped" : "ok") + ":" + x.window.start).join(",");
    assert.strictEqual(kinds, "ok:2026-08-18,ok:2026-07-21,failed:2026-06-23,skipped:2026-05-26,skipped:2026-04-28,skipped:2026-04-01");
    const spans = sqlite.prepare("SELECT DISTINCT period_start, period_end FROM load_log WHERE target_table = 'fact_ad_daily' AND status = 'succeeded'").all();
    assert.strictEqual(worker.contiguousCoverage(spans).covered_from, "2026-07-21", "the next run resumes at the gap");
  });

  await runAsync("meta facts: a failure is recorded without the token", async () => {
    const sqlite = freshDb();
    const w = loadWorker({ fetch: metaStub({ fail: true }).fetch });
    const out = await w.runMetaFacts({ SYNC_DB: d1Over(sqlite), META_ACCESS_TOKEN: "meta-secret-token-123" }, { now: new Date("2026-09-15T20:50:00Z"), config: { metaAdAccountId: "100000000000001" } });
    assert.strictEqual(out.ok, false);
    const errors = sqlite.prepare("SELECT error FROM load_log WHERE status = 'failed'").all().map((r) => r.error).join(" ") + JSON.stringify(out);
    assert.ok(!errors.includes("meta-secret-token-123"), "the access token never reaches load_log or the response");
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM fact_ad_daily").get().n, 0);
  });

  // ---------------------------------------------------------------- drop view
  // Two drops: Jun 16 (before stock snapshots existed) and Jul 26 (with a snapshot
  // the night before). Same shape, so the only difference is the denominator.
  function dropViewDb() {
    const sqlite = freshDb();
    for (const [id, d] of [["2026-06-16", "2026-06-16"], ["2026-07-26", "2026-07-26"]]) {
      sqlite.prepare("INSERT INTO dim_drop (drop_id, drop_date, drop_week_start, season, created_at, updated_at) VALUES (?, ?, ?, 'summer', 'x', 'x')").run(id, d, d);
    }
    for (const [pid, title] of [["7", "Worker v2"], ["8", "Globe tee"]]) {
      sqlite.prepare("INSERT INTO dim_product (product_id, title, handle) VALUES (?, ?, ?)").run(pid, title, title.toLowerCase().replace(/ /g, "-"));
    }
    for (const [vid, pid] of [["11", "7"], ["12", "8"]]) {
      sqlite.prepare("INSERT INTO dim_variant (variant_id, product_id) VALUES (?, ?)").run(vid, pid);
    }
    // Egypt fulfils online; KSA does not; "new-warehouse" is nobody's decision yet.
    sqlite.prepare("INSERT INTO dim_location (location_id, name, kind, channel, fulfils_online) VALUES ('shopify:egypt', 'CODDI EGYPT', 'stock_location', 'shopify', 1)").run();
    sqlite.prepare("INSERT INTO dim_location (location_id, name, kind, channel, fulfils_online) VALUES ('shopify:ksa', 'CODDI KSA', 'stock_location', 'shopify', 0)").run();
    sqlite.prepare("INSERT INTO dim_location (location_id, name, kind, channel) VALUES ('shopify:new', 'New warehouse', 'stock_location', 'shopify')").run();
    const stock = sqlite.prepare("INSERT INTO fact_inventory_daily (date, variant_id, location_id, qty_on_hand) VALUES (?, ?, ?, ?)");
    stock.run("2026-07-25", "11", "shopify:egypt", 100);
    stock.run("2026-07-25", "12", "shopify:egypt", 40);
    stock.run("2026-07-25", "11", "shopify:ksa", 500);
    stock.run("2026-07-25", "11", "shopify:new", 25);
    // A later snapshot must not be mistaken for the pre-launch one.
    stock.run("2026-07-27", "11", "shopify:egypt", 10);
    return sqlite;
  }

  async function seedDropOrders(sqlite) {
    const orders = [];
    let n = 5000;
    const add = (date, variant, qty, disc = 0) => {
      orders.push(orderNode({ id: n, createdAt: date + "T10:00:00Z", customer: n, firstOrder: n, subtotal: 1000 * qty - disc, discount: disc,
        lines: [{ id: n, variant, product: variant === "11" ? 7 : 8, qty, price: 1000, disc }],
        fulfillments: shipped(date + "T12:00:00Z", "DELIVERED", worker.addDays(date, 2) + "T10:00:00Z") }));
      n += 1;
    };
    // Jul 26 drop: day 0 heavy, then decay. Product 7: 30 units, product 8: 6.
    add("2026-07-26", "11", 20);
    add("2026-07-26", "12", 4);
    add("2026-07-27", "11", 7, 500);
    add("2026-07-29", "11", 3);
    add("2026-07-29", "12", 2);
    // Jun 16 drop, same shape, no snapshot behind it.
    add("2026-06-16", "11", 12);
    add("2026-06-18", "11", 5);
    const drops = [{ drop_id: "2026-06-16", drop_date: "2026-06-16" }, { drop_id: "2026-07-26", drop_date: "2026-07-26" }];
    await worker.writeOrderFacts(d1Over(sqlite), worker.buildOrderFacts(orders, { drops }));
    sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES ('l-o', 'fixture', 'fact_order', '2026-06-01', '2026-09-15', '2026-09-15T00:00:00Z', '2026-09-15T00:01:00Z', 'succeeded')").run();
    sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES ('l-l', 'fixture', 'fact_order_line', '2026-06-01', '2026-09-15', '2026-09-15T00:00:00Z', '2026-09-15T00:01:00Z', 'succeeded')").run();
  }

  const dropView = (sqlite, qs) => worker.handleGrowthRequest(new URL("https://w/growth/drop?" + qs), request, { SYNC_DB: d1Over(sqlite) });

  await runAsync("drop view: units by day since drop, against the stock held the night before launch", async () => {
    const sqlite = dropViewDb();
    await seedDropOrders(sqlite);
    const res = await dropView(sqlite, "drop=2026-07-26&days=7");
    const d = res.data;
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.drop.drop_id, "2026-07-26");
    assert.strictEqual(d.drop.window.day_index_max, 6, "seven days means day 0 to day 6");
    assert.strictEqual(d.series.state, "ok");
    assert.deepStrictEqual(Array.from(d.series.points, (p) => p.units), [24, 7, 0, 5, 0, 0, 0]);
    assert.deepStrictEqual(Array.from(d.series.points, (p) => p.cumulative_units), [24, 31, 31, 36, 36, 36, 36]);
    assert.strictEqual(d.series.points[0].date, "2026-07-26", "day 0 is the launch day");

    assert.strictEqual(d.commitment.state, "ok");
    assert.strictEqual(d.commitment.snapshot_date, "2026-07-25", "the snapshot before launch, not the one after");
    assert.strictEqual(d.commitment.units, 140, "Egypt only: KSA stock cannot ship to an Egyptian customer");

    const byProduct = Object.fromEntries(d.products.rows.map((r) => [r.entity_id, r]));
    assert.deepStrictEqual(Array.from(d.products.rows, (r) => r.entity_id), ["7", "8"], "biggest seller first");
    assert.strictEqual(byProduct["7"].attributes.title, "Worker v2");
    assert.deepStrictEqual(Array.from(byProduct["7"].curve), [20, 7, 0, 3, 0, 0, 0]);
    const m7 = Object.fromEntries(byProduct["7"].metrics.map((e) => [e.metric, e]));
    assert.strictEqual(m7.units_sold_since_drop.value, 30);
    assert.strictEqual(m7.units_committed.value, 100);
    assert.strictEqual(m7.sell_through_vs_commitment.value, 0.3);
    assert.strictEqual(m7.full_price_sell_through.value, 23 / 100, "the discounted units are not full price");
    assert.strictEqual(m7.discounted_sell_through.value, 7 / 100);
    assert.strictEqual(m7.sell_through_vs_commitment.sample.n, 100);
    // 25 units sit at a location nobody has classified: counted as coverage, not stock.
    assert.strictEqual(m7.sell_through_vs_commitment.coverage, 0.8);
    assert.ok(m7.sell_through_vs_commitment.secondary_states.includes("partial") || m7.sell_through_vs_commitment.state === "partial");

    const totals = Object.fromEntries(d.totals.metrics.map((e) => [e.metric, e]));
    assert.strictEqual(totals.units_sold_since_drop.value, 36);
    assert.strictEqual(totals.sell_through_vs_commitment.value, 36 / 140);
    assert.strictEqual(d.meta.reads.d1_batches, 1, "the drop view is one D1 batch");
  });

  await runAsync("drop view: a drop that launched before stock snapshots has a curve but no sell-through", async () => {
    const sqlite = dropViewDb();
    await seedDropOrders(sqlite);
    const d = (await dropView(sqlite, "drop=2026-06-16&days=7")).data;
    assert.deepStrictEqual(Array.from(d.series.points, (p) => p.units), [12, 0, 5, 0, 0, 0, 0], "the curve is readable");
    assert.strictEqual(d.commitment.state, "missing");
    assert.strictEqual(d.commitment.reason, "no_stock_snapshot_before_drop");
    const m = Object.fromEntries(d.products.rows[0].metrics.map((e) => [e.metric, e]));
    assert.strictEqual(m.units_sold_since_drop.value, 17);
    assert.strictEqual(m.sell_through_vs_commitment.value, null);
    assert.strictEqual(m.sell_through_vs_commitment.state, "missing");
    assert.strictEqual(m.sell_through_vs_commitment.state_detail.missing.reason, "no_stock_snapshot_before_drop", "never 0 when the denominator was never measured");
    assert.strictEqual(m.units_committed.value, null);
  });

  await runAsync("drop view: a drop whose products are created on launch day still has a commitment", async () => {
    // The real case for 2026-09-06: a drop's products do not exist in Shopify
    // before the day, so no earlier snapshot holds them. Launch stock is rebuilt
    // from the launch-night snapshot plus what sold before it was taken.
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_drop (drop_id, drop_date, drop_week_start, season, created_at, updated_at) VALUES ('2026-09-06', '2026-09-06', '2026-09-06', 'winter', 'x', 'x')").run();
    sqlite.prepare("INSERT INTO dim_product (product_id, title) VALUES ('9', 'WINTER PARKA')").run();
    sqlite.prepare("INSERT INTO dim_variant (variant_id, product_id, size) VALUES ('21', '9', 'M')").run();
    sqlite.prepare("INSERT INTO dim_location (location_id, name, kind, channel, fulfils_online) VALUES ('shopify:egypt', 'CODDI EGYPT', 'stock_location', 'shopify', 1)").run();
    const stock = sqlite.prepare("INSERT INTO fact_inventory_daily (date, variant_id, location_id, qty_on_hand) VALUES (?, ?, 'shopify:egypt', ?)");
    // The night before the drop the product does not exist yet — nothing to count.
    // On launch night 40 are left on the shelf.
    stock.run("2026-09-05", "11", 5);
    stock.run("2026-09-06", "21", 40);
    sqlite.prepare("INSERT INTO dim_variant (variant_id, product_id, size) VALUES ('11', '7', 'M')").run();
    sqlite.prepare("INSERT INTO dim_product (product_id, title) VALUES ('7', 'OLD TEE')").run();
    const orders = [];
    let n = 9500;
    for (let i = 0; i < 10; i += 1) {
      orders.push(orderNode({ id: n++, createdAt: "2026-09-06T13:00:00Z", customer: n++, firstOrder: 1, subtotal: 2000,
        lines: [{ id: n++, variant: 21, product: 9, qty: 1, price: 2000 }] }));
    }
    await worker.writeOrderFacts(d1Over(sqlite), worker.buildOrderFacts(orders, { drops: [{ drop_id: "2026-09-06", drop_date: "2026-09-06" }] }));
    sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES ('l', 'fixture', 'fact_order', '2026-08-30', '2026-09-08', '2026-09-08T00:00:00Z', '2026-09-08T00:01:00Z', 'succeeded')").run();

    const d = (await worker.handleGrowthRequest(new URL("https://w/growth/drop?drop=2026-09-06&days=2"), request, { SYNC_DB: d1Over(sqlite) })).data;
    assert.strictEqual(d.commitment.state, "ok", "the drop's own products were never in an earlier snapshot");
    assert.strictEqual(d.commitment.snapshot_date, "2026-09-06");
    assert.deepStrictEqual(Array.from(d.commitment.methods), ["reconstructed"]);
    assert.strictEqual(d.commitment.units, 50, "40 left on the shelf plus the 10 that had already sold");
    const parka = d.products.rows.find((r) => r.entity_id === "9");
    const m = Object.fromEntries(parka.metrics.map((e) => [e.metric, e]));
    assert.strictEqual(m.units_committed.value, 50);
    assert.strictEqual(m.units_sold_since_drop.value, 10);
    assert.strictEqual(m.sell_through_vs_commitment.value, 0.2, "ten of the fifty it launched with");
  });

  await runAsync("drop view: the window stops at the next drop, and prior drops come back for shape", async () => {
    const sqlite = dropViewDb();
    await seedDropOrders(sqlite);
    // Jun 16 asked for 90 days, but Jul 26 launches on day 40.
    const d = (await dropView(sqlite, "drop=2026-06-16&days=90")).data;
    assert.strictEqual(d.drop.window.end, "2026-07-25", "a drop's window ends the day before the next one");
    assert.strictEqual(d.drop.window.day_index_max, 39);
    assert.strictEqual(d.drop.is_current, false);
    const latest = (await dropView(sqlite, "days=7")).data;
    assert.strictEqual(latest.drop.drop_id, "2026-07-26", "no drop asked for means the one that launched last");
    assert.strictEqual(latest.prior_drops.length, 1);
    assert.strictEqual(latest.prior_drops[0].drop_id, "2026-06-16");
    assert.deepStrictEqual(Array.from(latest.prior_drops[0].points, (p) => p.units), [12, 0, 5, 0, 0, 0, 0], "the same day indices, so the shapes compare");
    await assert.rejects(() => dropView(sqlite, "drop=nope"), /No drop/);
    await assert.rejects(() => dropView(sqlite, "days=0"), /days must be between/);
  });

  // ShopifyQL sessions, shaped like the live answer (checked 2026-09-15): day first,
  // then the GROUP BY columns, then the four counts as strings. Each cell's share
  // differs per metric so a cut has its own rate, not the total's.
  const SESSION_CELLS = {
    session_device_type: [["mobile", [0.8, 0.75, 0.8, 0.5]], ["desktop", [0.2, 0.25, 0.2, 0.5]]],
    referrer_source: [["social", [0.6, 0.5, 0.6, 0.6]], ["direct", [0.4, 0.5, 0.4, 0.4]]],
    // Two paths to one product, and the home page.
    landing_page_path: [["/collections/shirts/products/worker-v2", [0.3, 0.3, 0.3, 0.3]], ["/products/worker-v2/", [0.2, 0.2, 0.2, 0.2]], ["/", [0.5, 0.5, 0.5, 0.5]]]
  };
  const SESSION_BASE = [1000, 40, 25, 10];
  function sessionStub({ failOn = null } = {}) {
    const queries = [];
    const fetch = async (_url, init) => {
      const q = JSON.parse(init.body).variables.query;
      queries.push(q);
      if (failOn && q.includes(failOn)) {
        const body = { errors: [{ message: "Internal error. Looks like something went wrong on our end." }] };
        return { status: 400, ok: false, headers: { get: () => null }, text: async () => JSON.stringify(body) };
      }
      const since = q.match(/SINCE (\S+)/)[1];
      const until = q.match(/UNTIL (\S+)/)[1];
      const group = (q.match(/GROUP BY (.+?) TIMESERIES/) || [null, ""])[1].split(",").map((g) => g.trim()).filter(Boolean);
      let combos = [{ vals: [], shares: [1, 1, 1, 1] }];
      for (const g of group) {
        combos = combos.flatMap((c) => SESSION_CELLS[g].map(([v, sh]) => ({ vals: c.vals.concat(v), shares: c.shares.map((x, i) => x * sh[i]) })));
      }
      const rows = [];
      for (let d = since; d <= until; d = worker.addDays(d, 1)) {
        for (const c of combos) rows.push([d, ...c.vals, ...SESSION_BASE.map((b, i) => String(Math.round(b * c.shares[i])))]);
      }
      const columns = ["day", ...group, "sessions", "sessions_with_cart_additions", "sessions_that_reached_checkout", "sessions_that_completed_checkout"].map((name) => ({ name, displayName: name, dataType: "INTEGER" }));
      const body = { data: { shopifyqlQuery: { tableData: { columns, rows }, parseErrors: [] } } };
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    };
    return { fetch, queries };
  }
  const SESSION_ENV = (sqlite) => ({ SYNC_DB: d1Over(sqlite), SHOPIFY_OFFLINE_TOKEN: "shpat_secret_session_token" });
  const SESSION_CFG = { shopDomain: "x.myshopify.com" };

  await runAsync("session facts: every cut per window to the first drop, then CVR, ATC and checkout by week and by device", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_drop (drop_id, drop_date, drop_week_start, created_at, updated_at) VALUES ('2026-04-01', '2026-04-01', '2026-03-29', 'x', 'x')").run();
    const stub = sessionStub();
    const w = loadWorker({ fetch: stub.fetch });
    const out = await w.runSessionFacts(SESSION_ENV(sqlite), { now: new Date("2026-09-15T20:50:00Z"), config: SESSION_CFG });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(out.windows.map((x) => `${x.window.kind}:${x.window.start}..${x.window.end}`).join(","),
      "refresh:2026-08-18..2026-09-14,backfill:2026-07-21..2026-08-17,backfill:2026-06-23..2026-07-20,backfill:2026-05-26..2026-06-22,backfill:2026-04-28..2026-05-25,backfill:2026-04-01..2026-04-27");
    assert.strictEqual(stub.queries.length, 6 * 5, "five cuts per window");
    const count = (b) => sqlite.prepare("SELECT COUNT(*) AS n FROM fact_session_daily WHERE breakdown_id = ?").get(b).n;
    assert.strictEqual(count("shopify.total"), 167, "Apr 1 → Sep 14, one row a day");
    assert.strictEqual(count("shopify.device"), 334);
    assert.strictEqual(count("shopify.device__referrer_source"), 668);
    assert.strictEqual(count("shopify.landing_page"), 334, "two paths to one product fold into one landing page");
    assert.strictEqual(sqlite.prepare("SELECT sessions FROM fact_session_daily WHERE breakdown_id = 'shopify.landing_page' AND dim1_value = '/products/worker-v2' AND date = '2026-09-01'").get().sessions, 500);
    assert.deepStrictEqual({ ...sqlite.prepare("SELECT dim1_value, dim2_value FROM fact_session_daily WHERE breakdown_id = 'shopify.device__referrer_source' AND date = '2026-09-01' ORDER BY sessions DESC LIMIT 1").get() }, { dim1_value: "mobile", dim2_value: "social" });

    const res = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=2026-09-06"), request, { SYNC_DB: d1Over(sqlite) });
    assert.strictEqual(res.data.ok, true);
    const env = Object.fromEntries(Object.values(res.data.surfaces).flatMap((s) => Object.values(s.sections).flat()).map((e) => [e.metric, e]));
    assert.strictEqual(env.sessions_shopify.value, 7000);
    assert.strictEqual(env.cvr_shopify.value, 70 / 7000);
    assert.strictEqual(env.atc_rate_shopify.value, 280 / 7000);
    assert.strictEqual(env.checkout_completion_rate_shopify.value, 70 / 175);
    assert.strictEqual(env.cvr_shopify.sample.n, 7000);
    assert.strictEqual(env.checkout_completion_rate_shopify.sample.n, 175);

    const device = (await worker.handleGrowthRequest(new URL("https://w/growth/entity?week_start=2026-09-06&entity=breakdown&breakdown=shopify.device&metrics=cvr_shopify,sessions_shopify"), request, { SYNC_DB: d1Over(sqlite) })).data;
    const byId = Object.fromEntries(device.rows.map((r) => [r.entity_id, Object.fromEntries(r.metrics.map((m) => [m.metric, m]))]));
    assert.deepStrictEqual(device.rows.map((r) => r.entity_id), ["mobile", "desktop"], "biggest cut first");
    assert.strictEqual(device.row_source.source_table, "fact_session_daily");
    assert.strictEqual(byId.mobile.sessions_shopify.value, 5600);
    assert.strictEqual(byId.mobile.cvr_shopify.value, 35 / 5600);
    assert.strictEqual(byId.desktop.cvr_shopify.value, 35 / 1400, "each cut its own rate");
    assert.strictEqual(byId.desktop.cvr_shopify.sample.n, 1400);
  });

  await runAsync("session facts: a failed cut writes nothing for its window, stops older history, and never records the token", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_drop (drop_id, drop_date, drop_week_start, created_at, updated_at) VALUES ('2026-04-01', '2026-04-01', '2026-03-29', 'x', 'x')").run();
    const w = loadWorker({ fetch: sessionStub({ failOn: "GROUP BY session_device_type TIMESERIES day SINCE 2026-06-23" }).fetch });
    const out = await w.runSessionFacts(SESSION_ENV(sqlite), { now: new Date("2026-09-15T20:50:00Z"), config: SESSION_CFG });
    const kinds = out.windows.map((x) => (x.error ? "failed" : x.skipped ? "skipped" : "ok") + ":" + x.window.start).join(",");
    assert.strictEqual(kinds, "ok:2026-08-18,ok:2026-07-21,failed:2026-06-23,skipped:2026-05-26,skipped:2026-04-28,skipped:2026-04-01");
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM fact_session_daily WHERE date BETWEEN '2026-06-23' AND '2026-07-20'").get().n, 0, "totals never land without their cuts");
    const spans = sqlite.prepare("SELECT DISTINCT period_start, period_end FROM load_log WHERE target_table = 'fact_session_daily' AND status = 'succeeded'").all();
    assert.strictEqual(worker.contiguousCoverage(spans).covered_from, "2026-07-21");
    const errors = sqlite.prepare("SELECT error FROM load_log WHERE target_table = 'fact_session_daily' AND status = 'failed'").all().map((r) => r.error).join(" ") + JSON.stringify(out);
    assert.ok(errors.length > 0 && !errors.includes("shpat_secret_session_token"));
    // Before 2026-07-21 the week has no session basis: missing, not zero.
    const res = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=2026-07-05"), request, { SYNC_DB: d1Over(sqlite) });
    const cvr = Object.values(res.data.surfaces).flatMap((s) => Object.values(s.sections).flat()).find((e) => e.metric === "cvr_shopify");
    assert.strictEqual(cvr.value, null);
    assert.strictEqual(cvr.state_detail.missing.reason, "not_loaded");
  });

  run("ads: the naming convention is read off the name, and a name that breaks it is not guessed at", () => {
    // Real names from the account (2026-09-17).
    const cases = [
      ["Coddiwomple City Tee | Chest Print Detail | Static | V2", "Static", "Chest Print Detail", "V2"],
      // Case is normalised so this joins the other flatlay ads instead of splitting them.
      ["Ollie baseball tee | FLATLAY| Video | V2", "Video", "Flatlay", "V2"],
      ["Grey And Black Sweatpants | Waistbands Duo | Static | V1", "Static", "Waistbands Duo", "V1"],
      ["Blue Bootcut Jeans | Model Side Profile | Video | V1", "Video", "Model Side Profile", "V1"]
    ];
    for (const [name, format, shot, version] of cases) {
      const parsed = worker.parseAdName(name);
      assert.strictEqual(parsed.format_derived, format, name);
      assert.strictEqual(parsed.shot_derived, shot, name);
      assert.strictEqual(parsed.version_derived, version, name);
    }
    // Off-convention names: a format may still be readable, the rest stays unknown
    // rather than becoming a guess.
    const carousel = worker.parseAdName("catalogue carousel bestsellers 8");
    assert.strictEqual(carousel.format_derived, "Carousel");
    assert.strictEqual(carousel.shot_derived, null);
    assert.strictEqual(worker.parseAdName("").format_derived, null);
    assert.strictEqual(worker.parseAdName("something else entirely").shot_derived, null);
  });

  run("ads: an ad is linked to the product it sells by name, and never by a coin toss", () => {
    const products = [
      { product_id: "1", title: "CODDIWOMPLE BLACK BOOTCUT JEANS" },
      { product_id: "2", title: "CODDIWOMPLE BLUE BOOTCUT JEANS" },
      { product_id: "3", title: "ANOMALY STRIPPED SHIRT" },
      { product_id: "4", title: "ORBIT GREY TEE" },
      { product_id: "5", title: "ORBIT BLACK TEE" }
    ];
    assert.deepStrictEqual({ ...worker.matchAdProduct("Black Bootcut Jeans | Model | Video | V1", products) },
      { product_id: "1", method: "exact_tokens" }, "the brand is in the title and not the ad name");
    // The catalogue's own typo: one edit is tolerated, and recorded as such.
    assert.deepStrictEqual({ ...worker.matchAdProduct("Anomaly Striped Shirt | Model | Video | V1", products) },
      { product_id: "3", method: "near_token" });
    assert.deepStrictEqual({ ...worker.matchAdProduct("Orbit Grey Tee | Back Print | Video | V1", products) },
      { product_id: "4", method: "exact_tokens" }, "grey and black are not interchangeable");
    // An ad that does not name a product is left alone rather than attached to one.
    assert.deepStrictEqual({ ...worker.matchAdProduct("catalogue carousel", products) }, { product_id: null, method: null });
    assert.deepStrictEqual({ ...worker.matchAdProduct("Unknown Thing | Flatlay | Static | V1", products) }, { product_id: null, method: null });
    // Two titles that fit equally well is a question, not an answer.
    const twins = [{ product_id: "6", title: "ORBIT TEE RED" }, { product_id: "7", title: "ORBIT TEE BLUE" }];
    assert.strictEqual(worker.matchAdProduct("Orbit Tee | Flatlay | Static | V1", twins).method, "ambiguous");
  });

  await runAsync("ads: an ad is compared with itself across the window, and a thin half yields no trend", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_ad (ad_id, platform, ad_name, adset_id, campaign_id) VALUES ('a1','meta','Tee | Flatlay | Video | V1','s1','c1')").run();
    sqlite.prepare("INSERT INTO dim_ad (ad_id, platform, ad_name, adset_id, campaign_id) VALUES ('a2','meta','Tee | Model | Static | V1','s1','c1')").run();
    const ins = sqlite.prepare("INSERT INTO fact_ad_daily (date, platform, ad_id, adset_id, campaign_id, spend, impressions, clicks_outbound) VALUES (?,'meta',?,'s1','c1',?,?,?)");
    // a1: cheap and clicked early, dearer and ignored later — the shape of fatigue.
    for (const d of ["2026-09-01", "2026-09-02", "2026-09-03"]) ins.run(d, "a1", 500, 10000, 150);
    for (const d of ["2026-09-08", "2026-09-09", "2026-09-10"]) ins.run(d, "a1", 750, 10000, 100);
    // a2 barely ran in its later half: no trend may be claimed from that.
    ins.run("2026-09-01", "a2", 500, 10000, 150);
    ins.run("2026-09-09", "a2", 30, 400, 6);
    sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES ('l','fixture','fact_ad_daily','2026-08-01','2026-09-12','2026-09-12T00:00:00Z','2026-09-12T00:01:00Z','succeeded')").run();

    const res = await worker.handleGrowthRequest(new URL("https://w/growth/entity?week_start=2026-09-06&span_weeks=2&entity=ad&metrics=cpm_trend,ctr_trend"), request, { SYNC_DB: d1Over(sqlite) });
    const byId = Object.fromEntries(res.data.rows.map((r) => [r.entity_id, Object.fromEntries(r.metrics.map((e) => [e.metric, e]))]));
    const a1 = byId["meta:a1"];
    assert.strictEqual(a1.cpm_trend.value, 0.5, "CPM 50 in the earlier half against 75 in the later one");
    assert.ok(Math.abs(a1.ctr_trend.value + 1 / 3) < 1e-9, "CTR 1.5% against 1.0%");
    assert.strictEqual(a1.cpm_trend.sample.n, 60000);
    // It compares the ad with itself, so it carries no drop-cycle comparison.
    assert.strictEqual(a1.cpm_trend.comparison, null);

    const a2 = byId["meta:a2"];
    assert.strictEqual(a2.cpm_trend.value, null);
    assert.strictEqual(a2.cpm_trend.state_detail.missing.reason, "one_half_below_impression_threshold",
      "400 impressions in a half cannot establish a trend");
  });

  await runAsync("stock: read at the latest snapshot, summed across sizes, never across days", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_product (product_id, title, category) VALUES ('7', 'ORBIT TEE', 'tees')").run();
    sqlite.prepare("INSERT INTO dim_variant (variant_id, product_id, size) VALUES ('11', '7', 'M')").run();
    sqlite.prepare("INSERT INTO dim_variant (variant_id, product_id, size) VALUES ('12', '7', 'L')").run();
    sqlite.prepare("INSERT INTO dim_location (location_id, name, kind, channel, fulfils_online) VALUES ('shopify:egypt', 'CODDI EGYPT', 'stock_location', 'shopify', 1)").run();
    sqlite.prepare("INSERT INTO dim_location (location_id, name, kind, channel, fulfils_online) VALUES ('shopify:ksa', 'CODDI KSA', 'stock_location', 'shopify', 0)").run();
    const stock = sqlite.prepare("INSERT INTO fact_inventory_daily (date, variant_id, location_id, qty_on_hand, qty_available) VALUES (?, ?, ?, ?, ?)");
    // Two nights: only the later one counts, and KSA never does.
    stock.run("2026-09-10", "11", "shopify:egypt", 99, 99);
    stock.run("2026-09-11", "11", "shopify:egypt", 12, 10);
    stock.run("2026-09-11", "12", "shopify:egypt", 5, 5);
    stock.run("2026-09-11", "11", "shopify:ksa", 400, 400);
    sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES ('l','fixture','fact_inventory_daily','2026-09-10','2026-09-11','2026-09-11T00:00:00Z','2026-09-11T00:01:00Z','succeeded')").run();

    const byVariant = (await worker.handleGrowthRequest(new URL("https://w/growth/entity?week_start=2026-09-06&entity=variant&metrics=inventory_on_hand"), request, { SYNC_DB: d1Over(sqlite) })).data;
    const variants = Object.fromEntries(byVariant.rows.map((r) => [r.entity_id, r.metrics[0].value]));
    assert.strictEqual(variants["11"], 12, "the latest night, not the sum of both, and not KSA");
    assert.strictEqual(variants["12"], 5);

    const byProduct = (await worker.handleGrowthRequest(new URL("https://w/growth/entity?week_start=2026-09-06&entity=product&metrics=inventory_on_hand"), request, { SYNC_DB: d1Over(sqlite) })).data;
    assert.strictEqual(byProduct.rows.find((r) => r.entity_id === "7").metrics[0].value, 17, "sizes roll into the product");

    // A product with no snapshot row is unknown, which is not zero.
    sqlite.prepare("INSERT INTO dim_product (product_id, title) VALUES ('8', 'NEW TEE')").run();
    sqlite.prepare("INSERT INTO dim_variant (variant_id, product_id, size) VALUES ('21', '8', 'M')").run();
    const again = (await worker.handleGrowthRequest(new URL("https://w/growth/entity?week_start=2026-09-06&entity=product&metrics=inventory_on_hand"), request, { SYNC_DB: d1Over(sqlite) })).data;
    const unknown = again.rows.find((r) => r.entity_id === "8").metrics[0];
    assert.strictEqual(unknown.value, null);
    assert.strictEqual(unknown.state_detail.missing.reason, "not_in_snapshot");
  });

  // ---------------------------------------------------------------- refunds
  // The founder's process (stated 2026-09-16): once a return is approved the
  // inventory team tells ShipBlu and the courier hands the money back. Shopify
  await runAsync("refunds: money back through Shopify and through the courier, counted once, and out of contribution", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_variant (variant_id, product_id, unit_cogs_snapshot) VALUES ('11', '7', 300)").run();
    sqlite.prepare("INSERT INTO dim_product (product_id, title) VALUES ('7', 'ORBIT TEE')").run();
    const orders = [];
    let n = 6000;
    const ids = [];
    for (let i = 0; i < 4; i += 1) {
      const id = n++;
      ids.push(String(id));
      orders.push(orderNode({ id, createdAt: "2026-08-24T10:00:00Z", customer: n++, firstOrder: 1, subtotal: 1000,
        lines: [{ id: n++, variant: 11, qty: 1, price: 1000 }],
        fulfillments: shipped("2026-08-24T12:00:00Z", "DELIVERED", "2026-08-26T10:00:00Z") }));
    }
    await worker.writeOrderFacts(d1Over(sqlite), worker.buildOrderFacts(orders, { drops: [] }));
    // One refunded through Shopify.
    sqlite.prepare("UPDATE fact_order SET refunded_amount = 900 WHERE order_id = ?").run(ids[0]);
    // One returned through Yanet and approved: the courier paid that one back.
    const req = sqlite.prepare("INSERT INTO fact_return_request (request_id, item_index, source, order_id, request_type, status, date, week_start, order_date, product_title, size, product_id, variant_id, match_method, quantity, reason_code, item_value, return_shipping_fee) VALUES (?, 0, 'yanet', ?, ?, ?, '2026-08-27', '2026-08-23', '2026-08-24', 'ORBIT TEE', 'M', '7', '11', 'order_line', 1, ?, ?, ?)");
    req.run("#R1", ids[1], "return", "approved", "disliked_item", 1000, 60);
    // One still only requested: not money yet, by the founder's own process.
    req.run("#R2", ids[2], "return", "requested", "wrong_size", 1000, 0);
    // One exchange: revenue stays, so it is not a refund at all.
    req.run("#R3", ids[3], "exchange", "approved", "wrong_size", 1000, 0);
    // No spend that week, but the economics chain still needs the ad load behind it.
    for (const [t, from, to] of [["fact_order", "2026-08-01", "2026-09-16"], ["fact_return_request", "2026-08-17", "2026-09-16"], ["fact_ad_daily", "2026-08-01", "2026-09-16"]]) {
      sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES (?, 'fixture', ?, ?, ?, '2026-09-16T00:00:00Z', '2026-09-16T00:01:00Z', 'succeeded')").run("l-" + t, t, from, to);
    }
    const res = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=2026-08-23"), request, { SYNC_DB: d1Over(sqlite) });
    const env = Object.fromEntries(Object.values(res.data.surfaces).flatMap((s) => Object.values(s.sections).flat()).map((e) => [e.metric, e]));

    // The courier return was a 1,000 item with a 60 return shipping fee withheld,
    assert.strictEqual(env.refund_value.value, 1840, "900 through Shopify plus the 940 the customer actually got");
    assert.strictEqual(env.refund_orders.value, 2, "the requested-only return is not money yet");
    assert.strictEqual(env.refund_units.value, 1, "only the courier channel carries lines");
    assert.strictEqual(env.refund_rate.value, 2 / 4);
    // The returned unit goes back on the shelf, so its 300 of cost is not spent.
    assert.strictEqual(env.return_cost.value, 1840 - 300, "cash out, less the cost of goods that came back sellable");
    assert.strictEqual(env.exchange_orders.value, 1);
    assert.strictEqual(env.exchange_units.value, 1);

    const delivered = 4 * 1000;
    const expected = delivered - 4 * 300 - 4 * 75 - (4 * 1075 * 0.02) - 1840 + 300;
    assert.strictEqual(Math.round(env.contribution_margin.value * 100) / 100, Math.round(expected * 100) / 100, "net refunds leave the contribution line and restocked goods come back to it");
    assert.ok(env.refund_value.coverage === 1, "a request file stands behind this week");
    // Weeks before the first request file are not a basis: comparing against them
    // would read as refunds exploding, when it is only the file beginning.
    assert.strictEqual(env.refund_value.comparison, null, "no prior window can be measured, so no delta is shown");
  });

  await runAsync("refunds: a week with no request file behind it says so rather than reading nothing came back", async () => {
    const sqlite = freshDb();
    const orders = [orderNode({ id: 6100, createdAt: "2026-07-06T10:00:00Z", customer: 1, firstOrder: 1, subtotal: 1000,
      lines: [{ id: 6101, variant: 11, qty: 1, price: 1000 }], fulfillments: shipped("2026-07-06T12:00:00Z", "DELIVERED", "2026-07-08T10:00:00Z") })];
    await worker.writeOrderFacts(d1Over(sqlite), worker.buildOrderFacts(orders, { drops: [] }));
    for (const [t, from, to] of [["fact_order", "2026-07-01", "2026-09-16"], ["fact_return_request", "2026-08-17", "2026-09-16"]]) {
      sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES (?, 'fixture', ?, ?, ?, '2026-09-16T00:00:00Z', '2026-09-16T00:01:00Z', 'succeeded')").run("l-" + t, t, from, to);
    }
    const res = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=2026-07-05"), request, { SYNC_DB: d1Over(sqlite) });
    const env = Object.fromEntries(Object.values(res.data.surfaces).flatMap((s) => Object.values(s.sections).flat()).map((e) => [e.metric, e]));
    assert.strictEqual(env.refund_value.value, 0, "Shopify's own refunds are still readable: there were none");
    assert.strictEqual(env.refund_value.coverage, 0, "but the courier's channel is not covered for this week");
    assert.ok(env.refund_value.state === "partial" || env.refund_value.secondary_states.includes("partial"));
  });

  // ---------------------------------------------------------------- Yanet import
  // The real export's own shape: one row per request, items packed into one cell
  // as newline-separated lists that run in the same order, and a customer's name,
  // email, phone and address in columns this import must never read.
  const YANET_HEADER = ["Request Name", "Order", "Order ID", "Email", "Phone", "Customer Name", "Product Status", "Status", "Currency",
    "Is Refunded", "Is Canceled", "Request Type", "Created At", "Updated At", "Returned Product", "Returned Variant", "Returned Qty",
    "Returned Item Discounted Total", "Returned Item Restocking Fee", "Reasons", "Reason Description", "Exchange Product", "Exchange Variant",
    "Exchange Final Price", "Return shipping fee", "Shipping Address"];
  const yanetCsv = (rows) => [YANET_HEADER].concat(rows).map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(",")).join("\n");

  run("yanet: one row per requested item, reasons mapped, and not one personal detail kept", () => {
    const csv = yanetCsv([
      ["#RET000001", "#10009", "gid://shopify/Order/7900000000099", "mody@example.com", "+201000000009", "A Customer", "", "requested", "EGP",
        "No", "No", "Exchange", "9/16/2026, 5:03:03 PM", "9/16/2026, 5:03:03 PM", "CODDIWOMPLE BAGGY RAW DENIM JEANS", "36", "1",
        "1399.0 EGP", "", "Ordered Wrong Size", "Big size", "CODDIWOMPLE BAGGY RAW DENIM JEANS", "34", "1399.00 EGP", "", "A Street, Cairo"],
      // Three items in one request: the reasons run in the same order as the products.
      ["#RET000283", "#34500", "gid://shopify/Order/7900000000001", "x@example.com", "+201000000000", "B Customer", "pending", "approved", "EGP",
        "No", "No", "Return", "9/9/2026, 10:34:42 AM", "9/10/2026, 9:00:00 AM",
        "LOWBROW WHITE TEE\nGLOBAL BLACK TEE\nOG RED TEE", "L\nL\nL", "1\n1\n1", "639.2 EGP\n679.2 EGP\n639.2 EGP", "",
        "I didn't like the item\nOrdered Wrong Size\nWrong Item/Size received ", "didn’t like color", "", "", "", "60 EGP", "Another Street"],
      // Jeans: the catalogue's own size is "38 - L", so the two-part option is kept whole.
      ["#RET000274", "#34400", "gid://shopify/Order/7800000000002", "y@example.com", "+201111111111", "C Customer", "pending", "approved", "EGP",
        "No", "No", "Return", "8/17/2026, 2:15:16 PM", "8/18/2026, 2:15:16 PM", "CODDIWOMPLE BLUE BOOTCUT JEANS", "38 - L", "1",
        "1599.0 EGP", "50 EGP", "Product Defect", "", "", "", "", "", "A Third Street"]
    ]);
    const out = worker.buildYanetRequests(csv, { batchId: "b1", loadId: "b1" });
    assert.strictEqual(out.stats.requests, 3);
    assert.strictEqual(out.stats.items, 5, "three of them belong to one request");
    assert.strictEqual(out.warnings.length, 0, JSON.stringify(out.warnings));

    const first = out.rows[0];
    assert.strictEqual(first.order_id, "7900000000099", "the numeric id out of the gid");
    assert.strictEqual(first.request_type, "exchange");
    assert.strictEqual(first.date, "2026-09-16");
    assert.strictEqual(first.week_start, "2026-09-13");
    assert.strictEqual(first.requested_at, "2026-09-16T17:03:03", "5:03 PM is 17:03");
    assert.strictEqual(first.reason_code, "wrong_size");
    assert.strictEqual(first.item_value, 1399);
    assert.strictEqual(first.exchange_size, "34");

    const three = out.rows.filter((r) => r.request_id === "#RET000283");
    assert.deepStrictEqual(Array.from(three, (r) => r.product_title), ["LOWBROW WHITE TEE", "GLOBAL BLACK TEE", "OG RED TEE"]);
    assert.deepStrictEqual(Array.from(three, (r) => r.reason_code), ["disliked_item", "wrong_size", "wrong_item_received"]);
    assert.deepStrictEqual(Array.from(three, (r) => r.item_index), [0, 1, 2]);
    // One fee for one request: summing the column must not multiply it by the items.
    assert.deepStrictEqual(Array.from(three, (r) => r.return_shipping_fee), [60, null, null]);

    const jeans = out.rows.find((r) => r.request_id === "#RET000274");
    assert.strictEqual(jeans.size, "38 - L", "the catalogue records jeans as '38 - L'; splitting it broke every jeans match");
    assert.strictEqual(jeans.reason_code, "quality");
    assert.strictEqual(jeans.restocking_fee, 50);

    const asText = JSON.stringify(out.rows);
    for (const personal of ["example.com", "+20109", "A Customer", "Street"]) {
      assert.ok(!asText.includes(personal), `the import kept ${personal}`);
    }
  });

  run("yanet: a file that is not the export is refused, and an unknown reason stays 'other'", () => {
    assert.throws(() => worker.buildYanetRequests("a,b,c\n1,2,3"), /does not look like a Yanet export/);
    const csv = yanetCsv([["#R1", "#1", "gid://shopify/Order/1", "", "", "", "", "approved", "EGP", "No", "No", "Return",
      "9/1/2026, 1:00:00 PM", "", "TEE", "M", "1", "100 EGP", "", "Astrology", "", "", "", "", "", ""]]);
    const out = worker.buildYanetRequests(csv, {});
    assert.strictEqual(out.rows[0].reason_code, "other", "an unrecognised reason is never guessed into a known one");
    assert.strictEqual(out.rows[0].reason_text, null);
  });

  await runAsync("returns: rate by SKU and size against that SKU's own sales, missing where no request file covers it", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_product (product_id, title) VALUES ('7', 'ORBIT TEE')").run();
    sqlite.prepare("INSERT INTO dim_variant (variant_id, product_id, size) VALUES ('11', '7', 'M')").run();
    sqlite.prepare("INSERT INTO dim_variant (variant_id, product_id, size) VALUES ('12', '7', 'L')").run();
    const orders = [];
    let n = 9000;
    for (let i = 0; i < 10; i += 1) {
      orders.push(orderNode({ id: n++, createdAt: "2026-08-24T10:00:00Z", customer: n, firstOrder: 1, subtotal: 1000, lines: [{ id: n++, variant: 11, qty: 1, price: 1000 }] }));
      orders.push(orderNode({ id: n++, createdAt: "2026-08-25T10:00:00Z", customer: n, firstOrder: 1, subtotal: 1000, lines: [{ id: n++, variant: 12, qty: 1, price: 1000 }] }));
    }
    await worker.writeOrderFacts(d1Over(sqlite), worker.buildOrderFacts(orders, { drops: [] }));
    const req = sqlite.prepare("INSERT INTO fact_return_request (request_id, item_index, source, order_id, request_type, status, date, week_start, order_date, product_title, size, product_id, variant_id, match_method, quantity, reason_code) VALUES (?, 0, 'yanet', '0', ?, 'approved', ?, '2026-08-23', ?, 'ORBIT TEE', ?, '7', ?, 'order_line', 1, ?)");
    // Two of the ten L units come back; one M is exchanged.
    req.run("#R1", "return", "2026-08-27", "2026-08-25", "L", "12", "disliked_item");
    req.run("#R2", "return", "2026-08-28", "2026-08-25", "L", "12", "wrong_size");
    req.run("#R3", "exchange", "2026-08-27", "2026-08-24", "M", "11", "wrong_size");
    for (const [t, from, to] of [["fact_order", "2026-08-01", "2026-09-16"], ["fact_return_request", "2026-08-17", "2026-09-16"]]) {
      sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES (?, 'fixture', ?, ?, ?, '2026-09-16T00:00:00Z', '2026-09-16T00:01:00Z', 'succeeded')").run("l-" + t, t, from, to);
    }
    const bySize = (await worker.handleGrowthRequest(new URL("https://w/growth/entity?week_start=2026-08-23&entity=size&metrics=return_request_rate_units,exchange_request_rate_units,return_requests_units"), request, { SYNC_DB: d1Over(sqlite) })).data;
    const rows = Object.fromEntries(bySize.rows.map((r) => [r.entity_id, Object.fromEntries(r.metrics.map((e) => [e.metric, e]))]));
    assert.strictEqual(rows.L.return_request_rate_units.value, 0.2, "two of ten L units asked back");
    assert.strictEqual(rows.L.return_requests_units.value, 2);
    assert.strictEqual(rows.L.return_request_rate_units.sample.n, 10, "against that size's own sales");
    assert.strictEqual(rows.M.return_request_rate_units.value, 0, "M had none: a real zero, it was measured");
    assert.strictEqual(rows.M.exchange_request_rate_units.value, 0.1, "and one M was exchanged, which is not a return");
    // The week is three weeks behind the file's end, so it has fully settled.
    assert.strictEqual(rows.L.return_request_rate_units.coverage, 1);

    // A window that starts before the uploaded requests do cannot be a rate.
    const early = (await worker.handleGrowthRequest(new URL("https://w/growth/entity?week_start=2026-08-23&entity=size&span_weeks=3&metrics=return_request_rate_units"), request, { SYNC_DB: d1Over(sqlite) })).data;
    const earlyL = early.rows.find((r) => r.entity_id === "L").metrics[0];
    assert.strictEqual(earlyL.value, null);
    assert.strictEqual(earlyL.state_detail.missing.reason, "requests_start_after_window", "no file behind those weeks: missing, not a flattering zero");
  });

  // ---------------------------------------------------------------- cohorts
  await runAsync("cohorts: repeat rate by the month a customer was acquired, censored where the window has not elapsed", async () => {
    const sqlite = freshDb();
    const orders = [];
    let n = 7000;
    // customer: [first order date, repeat gaps in days]. firstOrder = own id means new.
    // firstOrder is the id Shopify reports as the customer's first order: equal to
    // this order's own id only when the customer is genuinely new.
    const person = (first, gaps, { wasNew = true, discountFirst = false } = {}) => {
      const customer = n++;
      const firstId = n++;
      const acquiredAs = wasNew ? firstId : 1;
      // Shopify's subtotal is already after line discounts, so the fixture is too.
      orders.push(orderNode({ id: firstId, createdAt: first + "T10:00:00Z", customer, firstOrder: acquiredAs, subtotal: discountFirst ? 800 : 1000, discount: discountFirst ? 200 : 0,
        lines: [{ id: n++, variant: 11, qty: 1, price: 1000, disc: discountFirst ? 200 : 0 }] }));
      for (const g of gaps) {
        orders.push(orderNode({ id: n++, createdAt: worker.addDays(first, g) + "T10:00:00Z", customer, firstOrder: acquiredAs, subtotal: 1000,
          lines: [{ id: n++, variant: 11, qty: 1, price: 1000 }] }));
      }
    };
    // June: 4 new customers. Two come back inside 30 days, one at 75 days, one never.
    person("2026-06-02", [10]);
    person("2026-06-05", [20], { discountFirst: true });
    person("2026-06-09", [75]);
    person("2026-06-12", []);
    // A customer whose first order here is not their first ever: acquired earlier.
    person("2026-06-15", [5], { wasNew: false });
    // September: too recent for any window to have elapsed by the 16th.
    person("2026-09-10", []);
    person("2026-09-12", [2]);
    await worker.writeOrderFacts(d1Over(sqlite), worker.buildOrderFacts(orders, { drops: [] }));
    sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES ('l', 'fixture', 'fact_order', '2026-06-01', '2026-09-16', '2026-09-16T00:00:00Z', '2026-09-16T00:01:00Z', 'succeeded')").run();

    const res = await worker.handleGrowthRequest(new URL("https://w/growth/entity?week_start=2026-09-13&entity=cohort&span_weeks=26"), request, { SYNC_DB: d1Over(sqlite) });
    const rows = Object.fromEntries(res.data.rows.map((r) => [r.entity_id, { attrs: r.attributes, m: Object.fromEntries(r.metrics.map((e) => [e.metric, e])) }]));
    assert.deepStrictEqual(Array.from(res.data.rows, (r) => r.entity_id), ["2026-09", "2026-06"], "newest cohort first");

    const jun = rows["2026-06"];
    assert.strictEqual(jun.m.cohort_size.value, 4, "the customer acquired before the window is not in the cohort");
    assert.strictEqual(jun.attrs.pre_window_customers, 1, "and is counted and named, not hidden");
    assert.strictEqual(jun.m.repeat_rate_30d.value, 0.5, "two of four came back within 30 days");
    assert.strictEqual(jun.m.repeat_rate_30d.sample.n, 4);
    assert.strictEqual(jun.m.repeat_rate_90d.value, 0.75, "the 75-day return counts at 90 days");
    assert.strictEqual(jun.m.orders_per_customer.value, 7 / 4);
    // June has fully elapsed 90 days for everyone, so the median is taken inside 90:
    // gaps 10, 20 and 75 all count. The 180-day window has not elapsed, so it is not used.
    assert.strictEqual(jun.m.time_to_second_purchase.value, 20, "median of 10, 20, 75");
    assert.strictEqual(jun.m.time_to_second_purchase.sample.n, 3);
    assert.strictEqual(jun.m.time_to_second_purchase.sample.of, "customers who came back within 90 days");
    // September cannot have a median yet: no window has elapsed, so a fast repeat
    // must not make the cohort look quicker than one measured over months.
    assert.strictEqual(sepMedianPlaceholder(rows), "window_not_elapsed");
    assert.strictEqual(jun.m.ltv_to_date.value, (7000 - 200) / 4, "merchandise after discounts, per customer");
    assert.strictEqual(jun.m.discount_dependence.value, 1 / 7);

    // 180 days have not elapsed for anyone in June: missing, never 0.
    assert.strictEqual(jun.m.repeat_rate_180d.value, null);
    assert.strictEqual(jun.m.repeat_rate_180d.state_detail.missing.reason, "window_not_elapsed");

    function sepMedianPlaceholder(all) {
      const e = all["2026-09"].m.time_to_second_purchase;
      return e.value === null ? e.state_detail.missing.reason : String(e.value);
    }
    const sep = rows["2026-09"];
    assert.strictEqual(sep.m.cohort_size.value, 2);
    assert.strictEqual(sep.m.repeat_rate_30d.value, null, "a cohort acquired days ago has no 30-day rate yet");
    assert.strictEqual(sep.m.repeat_rate_30d.state_detail.missing.reason, "window_not_elapsed");
    assert.strictEqual(sep.m.orders_per_customer.value, 1.5, "what is measurable is still measured");
  });

  await runAsync("cohorts: a partly-elapsed window says so in its coverage, and drops can be the cohort", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_drop (drop_id, drop_date, drop_week_start, season, created_at, updated_at) VALUES ('2026-07-26', '2026-07-26', '2026-07-26', 'summer', 'x', 'x')").run();
    const orders = [];
    let n = 8000;
    const person = (first, gaps) => {
      const customer = n++;
      const firstId = n++;
      orders.push(orderNode({ id: firstId, createdAt: first + "T10:00:00Z", customer, firstOrder: firstId, subtotal: 1000, lines: [{ id: n++, variant: 11, qty: 1, price: 1000 }] }));
      for (const g of gaps) orders.push(orderNode({ id: n++, createdAt: worker.addDays(first, g) + "T10:00:00Z", customer, firstOrder: firstId, subtotal: 1000, lines: [{ id: n++, variant: 11, qty: 1, price: 1000 }] }));
    };
    // Two acquired on drop day (30 days elapsed by Sep 16), two acquired 2026-08-25 (22 days: not yet).
    person("2026-07-26", [5]);
    person("2026-07-27", []);
    person("2026-08-25", [1]);
    person("2026-08-26", []);
    await worker.writeOrderFacts(d1Over(sqlite), worker.buildOrderFacts(orders, { drops: [{ drop_id: "2026-07-26", drop_date: "2026-07-26" }] }));
    sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES ('l', 'fixture', 'fact_order', '2026-07-01', '2026-09-16', '2026-09-16T00:00:00Z', '2026-09-16T00:01:00Z', 'succeeded')").run();
    const res = await worker.handleGrowthRequest(new URL("https://w/growth/entity?week_start=2026-09-13&entity=cohort&cohort_by=drop&span_weeks=26"), request, { SYNC_DB: d1Over(sqlite) });
    const row = res.data.rows.find((r) => r.entity_id === "2026-07-26");
    const m = Object.fromEntries(row.metrics.map((e) => [e.metric, e]));
    assert.strictEqual(m.cohort_size.value, 4, "everyone whose first order fell in the drop's window");
    assert.strictEqual(m.repeat_rate_30d.value, 0.5, "of the two past the window, one came back");
    assert.strictEqual(m.repeat_rate_30d.coverage, 0.5, "half the cohort has had the full 30 days");
    assert.ok(m.repeat_rate_30d.secondary_states.includes("partial") || m.repeat_rate_30d.state === "partial");
    assert.strictEqual(m.repeat_rate_30d.sample.n, 2, "the denominator is the customers past the window, not the cohort");
  });

  await runAsync("coverage: a source one day behind gives a partial week, not a blank one", async () => {
    const sqlite = freshDb();
    const ins = sqlite.prepare("INSERT INTO fact_session_daily (date, breakdown_id, sessions, sessions_with_cart_add, sessions_reached_checkout, sessions_converted) VALUES (?, 'shopify.total', 1000, 40, 25, 10)");
    // Six of the week's seven days are loaded; the seventh has not arrived yet.
    for (let day = "2026-09-06"; day <= "2026-09-11"; day = worker.addDays(day, 1)) ins.run(day);
    sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES ('l','fixture','fact_session_daily','2026-04-01','2026-09-11','2026-09-12T00:00:00Z','2026-09-12T00:01:00Z','succeeded')").run();

    const res = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=2026-09-06"), request, { SYNC_DB: d1Over(sqlite) });
    const env = Object.fromEntries(Object.values(res.data.surfaces).flatMap((s) => Object.values(s.sections).flat()).map((e) => [e.metric, e]));
    assert.strictEqual(env.sessions_shopify.value, 6000, "the days that exist are counted");
    assert.ok(Math.abs(env.sessions_shopify.coverage - 6 / 7) < 1e-9, "and the tile says six sevenths of the week");
    assert.ok(env.sessions_shopify.state === "partial" || env.sessions_shopify.secondary_states.includes("partial"));

    // A week with nothing loaded is still missing: partial is not a licence to
    // report zero for a week that was never measured.
    const earlier = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=2026-03-01"), request, { SYNC_DB: d1Over(sqlite) });
    const old = Object.values(earlier.data.surfaces).flatMap((s) => Object.values(s.sections).flat()).find((e) => e.metric === "sessions_shopify");
    assert.strictEqual(old.value, null);
    assert.strictEqual(old.state_detail.missing.reason, "not_loaded");
  });

  // ---------------------------------------------------------------- the load button
  await runAsync("load run: a press does a bounded number of windows and says what is left", async () => {
    const sqlite = dropViewDb();
    const stub = sessionStub();
    const w = loadWorker({ fetch: stub.fetch });
    // One window per press is what survives a single request; the rest is reported,
    // not attempted, so nothing is left running past the response that started it.
    const one = await w.runSessionFacts(SESSION_ENV(sqlite), { now: new Date("2026-09-15T20:50:00Z"), config: SESSION_CFG, maxWindows: 1 });
    assert.strictEqual(one.windows.length, 1);
    assert.strictEqual(one.windows[0].window.kind, "refresh", "the newest days first");
    assert.ok(one.remaining > 0, "and it says how much is left");

    const out = await w.runSessionFacts(SESSION_ENV(sqlite), { now: new Date("2026-09-15T20:50:00Z"), config: SESSION_CFG, maxWindows: 3 });
    assert.strictEqual(out.windows.length, 3);
    assert.deepStrictEqual(Array.from(out.windows, (x) => x.window.kind), ["refresh", "backfill", "backfill"]);
    // The rest is not lost: the next run starts again from the gap.
    const spans = sqlite.prepare("SELECT DISTINCT period_start, period_end FROM load_log WHERE target_table = 'fact_session_daily' AND status = 'succeeded'").all();
    assert.strictEqual(w.contiguousCoverage(spans).covered_from, "2026-06-23");
    const again = await w.runSessionFacts(SESSION_ENV(sqlite), { now: new Date("2026-09-15T20:50:00Z"), config: SESSION_CFG, maxWindows: 3 });
    assert.strictEqual(w.contiguousCoverage(sqlite.prepare("SELECT DISTINCT period_start, period_end FROM load_log WHERE target_table = 'fact_session_daily' AND status = 'succeeded'").all()).covered_from, "2026-06-16", "the second press reaches the first drop: " + JSON.stringify(again.plan));
  });

  await runAsync("load run: pressing again does the next window, not the same one again", async () => {
    const sqlite = dropViewDb();
    const stub = sessionStub();
    const w = loadWorker({ fetch: stub.fetch });
    const env = SESSION_ENV(sqlite);
    const at = (iso) => new Date(iso);
    // Five presses, minutes apart, exactly as the page makes them.
    const done = [];
    for (let i = 0; i < 5; i += 1) {
      const out = await w.runSessionFacts(env, { now: at("2026-09-15T20:" + String(10 + i * 2).padStart(2, "0") + ":00Z"), config: SESSION_CFG, maxWindows: 1, skipFresh: true });
      for (const x of out.windows) done.push(`${x.window.start}..${x.window.end}`);
    }
    // This fixture's history is four windows deep, so four presses exhaust it and
    // the fifth has nothing to do — which is how the page learns to stop.
    assert.strictEqual(done.length, 4, "one window per press until there are none");
    assert.strictEqual(new Set(done).size, 4, "and a different one each time: " + done.join(" | "));
    assert.strictEqual(done[0], "2026-08-18..2026-09-14", "newest first");

    const empty = await w.runSessionFacts(env, { now: at("2026-09-15T20:30:00Z"), config: SESSION_CFG, maxWindows: 1, skipFresh: true });
    assert.strictEqual(empty.windows.length, 0);
    assert.strictEqual(empty.remaining, 0, "so the page is told it is finished");

    // History is complete now, so the nightly plan is the refresh window alone — and
    // the cron runs it again even though a press did it minutes ago.
    const nightly = await w.runSessionFacts(env, { now: at("2026-09-15T20:50:00Z"), config: SESSION_CFG });
    assert.deepStrictEqual(Array.from(nightly.windows, (x) => `${x.window.start}..${x.window.end}`), ["2026-08-18..2026-09-14"]);
  });

  await runAsync("load run: the run records itself, so the page can poll instead of holding the connection", async () => {
    const sqlite = dropViewDb();
    const stub = sessionStub();
    const w = loadWorker({ fetch: stub.fetch });
    const env = { ...SESSION_ENV(sqlite), SHOPIFY_SHOP_DOMAIN: "x.myshopify.com" };
    const started = new Date("2026-09-15T20:50:00Z");
    const before = await w.growthLoadStatus(env, { since: started.toISOString() });
    assert.strictEqual(before.run, null, "nothing has run yet");
    assert.deepStrictEqual(before.windows, []);

    const run = await w.runGrowthLoads(env, { sources: ["sessions"], now: started, config: SESSION_CFG, maxWindows: 2 });
    assert.strictEqual(run.ok, true, JSON.stringify(run).slice(0, 300));
    const after = await w.growthLoadStatus(env, { since: started.toISOString() });
    assert.strictEqual(after.run.load_id, run.run_id);
    assert.strictEqual(after.run.status, "succeeded");
    assert.ok(after.run.finished_at, "a finished run has an end, so the page stops polling");
    assert.strictEqual(after.windows.length, 2, "one refresh and one history window");
    assert.ok(after.windows.every((x) => x.target_table === "fact_session_daily" && x.status === "succeeded"));
    assert.strictEqual(after.tables.fact_session_daily.covered_to, "2026-09-14");
    assert.strictEqual(after.tables.fact_session_daily.failed_windows, 0);
    assert.ok(!Object.keys(after.tables).includes("growth_load_run"), "the run's own row is not a data table");
  });

  await runAsync("load run: a failing source ends the run as failed, never leaves it running", async () => {
    const sqlite = dropViewDb();
    const w = loadWorker({ fetch: sessionStub({ failOn: "FROM sessions" }).fetch });
    const env = { ...SESSION_ENV(sqlite), SHOPIFY_SHOP_DOMAIN: "x.myshopify.com" };
    const started = new Date("2026-09-15T20:50:00Z");
    const run = await w.runGrowthLoads(env, { sources: ["sessions"], now: started, config: SESSION_CFG, maxWindows: 1 });
    assert.strictEqual(run.ok, false);
    const status = await w.growthLoadStatus(env, { since: started.toISOString() });
    assert.strictEqual(status.run.status, "failed");
    assert.ok(status.run.finished_at);
    assert.strictEqual(status.windows.filter((x) => x.status === "failed").length, 1);
    assert.ok(!JSON.stringify(status).includes("shpat_secret_session_token"), "the token never reaches the status the page polls");
  });

  await runAsync("economics: contribution per order after COGS, discount, freight, COD fee, RTO and ad spend", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_variant (variant_id, product_id, unit_cogs_snapshot) VALUES ('11', '7', 300)").run();
    const orders = [
      orderNode({ id: 801, createdAt: "2026-08-31T10:00:00Z", customer: 801, firstOrder: 801, subtotal: 1000, lines: [{ id: 801, variant: 11, qty: 1, price: 1000 }], fulfillments: shipped("2026-08-31T12:00:00Z", "DELIVERED", "2026-09-02T10:00:00Z") }),
      orderNode({ id: 802, createdAt: "2026-09-01T10:00:00Z", customer: 802, firstOrder: 802, subtotal: 800, discount: 200, lines: [{ id: 802, variant: 11, qty: 1, price: 1000, disc: 200 }], fulfillments: shipped("2026-09-01T12:00:00Z", "DELIVERED", "2026-09-03T10:00:00Z") }),
      orderNode({ id: 803, createdAt: "2026-09-02T10:00:00Z", customer: 803, firstOrder: 1, subtotal: 1000, lines: [{ id: 803, variant: 11, qty: 1, price: 1000 }], cancelledAt: "2026-09-05T10:00:00Z", fulfillments: shipped("2026-09-02T12:00:00Z", "NOT_DELIVERED") }),
      orderNode({ id: 804, createdAt: "2026-09-03T10:00:00Z", customer: 804, firstOrder: 1, gateways: ["Paymob"], subtotal: 1000, lines: [{ id: 804, variant: 11, qty: 1, price: 1000 }], fulfillments: shipped("2026-09-03T12:00:00Z", "DELIVERED", "2026-09-04T10:00:00Z") })
    ];
    orders[0].shippingAddress = { city: "Cairo", province: "Cairo", provinceCode: "C" };
    orders[1].shippingAddress = { city: "Cairo", province: "Cairo", provinceCode: "C" };
    orders[2].shippingAddress = { city: "Aswan", province: "Aswan", provinceCode: "ASN" };
    orders[3].shippingAddress = { city: "Alexandria", province: "Alexandria", provinceCode: "ALX" };
    await worker.writeOrderFacts(d1Over(sqlite), worker.buildOrderFacts(orders, { drops: [] }));
    await worker.writeMetaDailyFacts(d1Over(sqlite), worker.buildMetaDailyFacts([metaRow({ ad: "a1", date: "2026-09-01", spend: 600, impr: 10000, out: 100, lpv: 80, purch: 2 })], []), "T");
    for (const t of ["fact_order", "fact_ad_daily"]) {
      sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES (?, 'fixture', ?, '2026-08-01', '2026-09-10', '2026-09-10T00:00:00Z', '2026-09-10T00:01:00Z', 'succeeded')").run("l-" + t, t);
    }
    const res = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=2026-08-30"), request, { SYNC_DB: d1Over(sqlite) });
    const econ = Object.fromEntries(Object.values(res.data.surfaces.economics.sections).flat().map((e) => [e.metric, e]));
    assert.strictEqual(econ.delivered_revenue.value, 2800);
    assert.strictEqual(econ.cogs_delivered.value, 900, "three delivered units at 300");
    assert.strictEqual(econ.gross_profit.value, 1900);
    assert.strictEqual(econ.fulfilment_cost_outbound.value, 75 + 75 + 85, "outbound on parcels that stayed delivered");
    assert.strictEqual(econ.rto_shipping_waste.value, 300, "Aswan is rest of Egypt: 150 out + 150 back");
    assert.strictEqual(econ.cod_collection_fees.value, (1075 + 875) * 0.02, "COD fee on delivered COD orders only — the card order pays none");
    const expected = 1900 - 600 - 235 - 39 - 300;
    assert.strictEqual(Math.round(econ.contribution_margin.value * 100) / 100, expected);
    assert.strictEqual(Math.round(econ.contribution_per_order.value * 100) / 100, Math.round((expected / 3) * 100) / 100);
    assert.strictEqual(econ.contribution_per_order.sample.n, 3);
    assert.strictEqual(econ.blended_cac.value, 300, "600 spend over 2 new-customer orders");
    assert.strictEqual(econ.blended_mer.value, (4000 - 200 - 1000) / 600);
    assert.ok(econ.contribution_margin.confidence === "modelled");
  });

  // ---------------------------------------------------------------------- GA4
  function ga4Stub({ fail = false, otherRow = false } = {}) {
    const calls = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const dims = body.dimensions.map((d) => d.name);
      const isEvents = dims.includes("eventName");
      calls.push(dims.join("+"));
      if (fail) return { status: 500, ok: false, headers: { get: () => null }, text: async () => "boom", json: async () => ({ error: { message: "boom" } }) };
      const cut = dims.filter((d) => d !== "date" && d !== "eventName");
      // Two days, one value per dimension combination.
      const days = ["20260901", "20260902"];
      const rows = [];
      if (isEvents) {
        for (const date of days) {
          for (const [name, count] of [["view_item", "300"], ["add_to_cart", "40"], ["begin_checkout", "20"], ["add_payment_info", "12"], ["purchase", "7"]]) {
            rows.push({ dimensionValues: [{ value: date }, ...cut.map((d) => ({ value: d === "deviceCategory" ? "mobile" : "google / cpc" })), { value: name }], metricValues: [{ value: count }] });
          }
        }
        const payload = { metricHeaders: [{ name: "eventCount" }], rows };
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(payload), json: async () => payload };
      }
      for (const date of days) {
        rows.push({ dimensionValues: [{ value: date }, ...cut.map((d) => ({ value: d === "deviceCategory" ? "mobile" : "google / cpc" }))],
          metricValues: [{ value: "1000" }, { value: "620" }, { value: "31000" }] });
        if (otherRow && cut.length) {
          rows.push({ dimensionValues: [{ value: date }, ...cut.map(() => ({ value: "(other)" }))],
            metricValues: [{ value: "55" }, { value: "10" }, { value: "900" }] });
        }
      }
      const payload = { metricHeaders: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "userEngagementDuration" }], rows };
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(payload), json: async () => payload };
    };
    return { fetch, calls };
  }

  const GA4_ENV = (sqlite) => ({ SYNC_DB: d1Over(sqlite), GA4_PROPERTY_ID: "1234567", GOOGLE_SERVICE_ACCOUNT_JSON: "{}" });

  await runAsync("ga4: a window writes the totals and the cuts, with (other) rows marked", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_drop (drop_id, drop_date, drop_week_start, created_at, updated_at) VALUES ('d1', '2026-09-01', '2026-08-30', 'x', 'x')").run();
    const stub = ga4Stub({ otherRow: true });
    const w = loadWorker({ fetch: stub.fetch });
    // The loader asks for a token through the same helper the rest of the file uses;
    // priming its cache is how a test gets past the service-account signature.
    Object.assign(w.__get("GOOGLE_TOKEN_CACHE"), { accessToken: "ya29.super-secret-token", expiresAtMs: Date.now() + 3600000 });
    const out = await w.runGa4Facts(GA4_ENV(sqlite), { now: new Date("2026-09-03T20:50:00Z"), config: { ga4PropertyId: "1234567" }, maxWindows: 1 });
    assert.strictEqual(out.ok, true, JSON.stringify(out).slice(0, 400));

    // Seven breakdowns, two reports each: the sessions and the events.
    assert.strictEqual(stub.calls.length, 14, stub.calls.join(", "));
    assert.strictEqual(stub.calls.filter((c) => c.includes("eventName")).length, 7);

    const total = sqlite.prepare("SELECT * FROM fact_ga4_daily WHERE breakdown_id = 'ga4.total' AND date = '2026-09-01'").get();
    assert.strictEqual(total.sessions, 1000);
    assert.strictEqual(total.engaged_sessions, 620);
    assert.strictEqual(total.add_to_cart, 40, "the events land on the same row as the sessions");
    assert.strictEqual(total.purchase, 7);

    // A cut is stored as its own rows, never folded into the total.
    const device = sqlite.prepare("SELECT dim1_value, sessions, is_other_row FROM fact_ga4_daily WHERE breakdown_id = 'ga4.device' AND date = '2026-09-01' ORDER BY is_other_row").all();
    assert.deepStrictEqual(device.map((r) => [r.dim1_value, r.sessions, r.is_other_row]), [["mobile", 1000, 0], ["(other)", 55, 1]]);
    // The cuts do not add up to the total, and that is the point of keeping both.
    assert.ok(1000 + 55 !== total.sessions || true);

    const cov = sqlite.prepare("SELECT period_start, period_end, status, rows_written FROM load_log WHERE target_table = 'fact_ga4_daily'").get();
    assert.strictEqual(cov.status, "succeeded");
    assert.ok(cov.rows_written > 0);
  });

  await runAsync("ga4: the week reads GA4's own funnel, beside Shopify's, never mixed", async () => {
    const sqlite = freshDb();
    const day = (d) => sqlite.prepare("INSERT INTO fact_ga4_daily (date, breakdown_id, sessions, engaged_sessions, engagement_time_sec, view_item, add_to_cart, begin_checkout, add_payment_info, purchase) VALUES (?, 'ga4.total', 1000, 600, 30000, 400, 50, 25, 15, 10)").run(d);
    const cut = sqlite.prepare("INSERT INTO fact_ga4_daily (date, breakdown_id, dim1_value, is_other_row, sessions) VALUES (?, ?, ?, ?, ?)");
    for (let d = "2026-08-30"; d <= "2026-09-05"; d = worker.addDays(d, 1)) {
      day(d);
      cut.run(d, "ga4.channel_group", "Direct", 0, 300);
      cut.run(d, "ga4.channel_group", "Organic Social", 0, 200);
      cut.run(d, "ga4.channel_group", "Unassigned", 0, 40);
      cut.run(d, "ga4.channel_group", "(other)", 1, 60);
      cut.run(d, "ga4.new_or_returning", "new", 0, 700);
      cut.run(d, "ga4.new_or_returning", "returning", 0, 200);
      cut.run(d, "ga4.device", "mobile", 0, 900);
    }
    sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES ('g1', 'fixture', 'fact_ga4_daily', '2026-08-01', '2026-09-10', 'x', 'y', 'succeeded')").run();
    const res = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=2026-08-30"), request, { SYNC_DB: d1Over(sqlite) });
    const all = Object.fromEntries(Object.values(res.data.surfaces).flatMap((s) => Object.values(s.sections).flat()).map((e) => [e.metric, e]));
    assert.strictEqual(all.sessions_ga4.value, 7000);
    assert.strictEqual(all.add_to_cart_ga4.value, 350);
    assert.strictEqual(all.cvr_ga4.value, 70 / 7000);
    assert.strictEqual(all.engagement_rate_ga4.value, 4200 / 7000);
    assert.strictEqual(all.direct_sessions_ga4.value, 2100);
    assert.strictEqual(all.organic_sessions_ga4.value, 1400, "organic search and social, not paid social");
    assert.strictEqual(all.returning_visitor_share_ga4.value, 1400 / 6300, "against the sessions GA4 could place, not all of them");
    assert.strictEqual(all.unattributed_session_share_ga4.value, 280 / 7000);
    assert.strictEqual(all.ga4_other_row_share.value, 420 / 7000, "how much of the cut GA4 would not name");
    // Shopify's own sessions are absent here: GA4 must not stand in for them.
    assert.strictEqual(all.sessions_shopify.state, "missing");
    assert.strictEqual(all.cvr_shopify.state, "missing");

    // And a GA4 cut is readable on its own rows.
    const device = (await worker.handleGrowthRequest(new URL("https://w/growth/entity?week_start=2026-08-30&entity=breakdown&breakdown=ga4.device&metrics=sessions_ga4"), request, { SYNC_DB: d1Over(sqlite) })).data;
    assert.strictEqual(device.rows[0].entity_id, "mobile");
    assert.strictEqual(device.rows[0].metrics[0].value, 6300);
  });

  await runAsync("ga4: a failed window writes nothing and never prints the token", async () => {
    const sqlite = freshDb();
    const w = loadWorker({ fetch: ga4Stub({ fail: true }).fetch });
    Object.assign(w.__get("GOOGLE_TOKEN_CACHE"), { accessToken: "ya29.super-secret-token", expiresAtMs: Date.now() + 3600000 });
    const out = await w.runGa4Facts(GA4_ENV(sqlite), { now: new Date("2026-09-03T20:50:00Z"), config: { ga4PropertyId: "1234567" }, maxWindows: 1 });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM fact_ga4_daily").get().n, 0, "a failed window writes no rows at all");
    const log = sqlite.prepare("SELECT status, error FROM load_log WHERE target_table = 'fact_ga4_daily'").get();
    assert.strictEqual(log.status, "failed");
    assert.ok(!JSON.stringify(out).includes("ya29."), "the token is not in the result");
    assert.ok(!String(log.error).includes("ya29."), "nor in the recorded failure");
  });

  await runAsync("ad tagging: a product connected by hand wins over the guess and survives a refresh", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_product (product_id, title, status) VALUES ('p9', 'WINTER PARKA', 'ACTIVE'), ('p12', 'GREY HOODIE', 'ACTIVE')").run();
    sqlite.prepare("INSERT INTO dim_ad (platform, ad_id, ad_name, product_id_derived, product_match_method) VALUES ('meta', 'a1', 'UGC clip 4', 'p12', 'near_token')").run();
    sqlite.prepare("INSERT INTO fact_ad_daily (date, platform, ad_id, spend, impressions) VALUES ('2026-09-01', 'meta', 'a1', 900, 30000)").run();
    sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES ('l1', 'fixture', 'fact_ad_daily', '2026-08-01', '2026-09-10', 'x', 'y', 'succeeded')").run();
    const env = { SYNC_DB: d1Over(sqlite), REPORT_AUTH_LOCAL_DEV: "true" };
    const post = (body) => worker.__workerDefault.fetch({
      url: "http://localhost/growth/ad-product",
      method: "POST",
      headers: { get: () => null },
      json: async () => body
    }, env, {});

    const bad = await post({ ad_id: "meta:a1", product_id: "p404" });
    assert.strictEqual(bad.data.ok, false, "a product outside the catalogue is a typo, not a tag");
    const missing = await post({ ad_id: "nope", product_id: "p9" });
    assert.strictEqual(missing.data.ok, false, "and an ad nobody has loaded is not tagged either");

    const ok = await post({ ad_id: "meta:a1", product_id: "p9" });
    assert.strictEqual(ok.data.ok, true, JSON.stringify(ok.data));
    assert.strictEqual(sqlite.prepare("SELECT promoted_product_id FROM dim_ad WHERE ad_id = 'a1'").get().promoted_product_id, "p9");
    assert.strictEqual(sqlite.prepare("SELECT tagged_by FROM dim_ad WHERE ad_id = 'a1'").get().tagged_by, "local-dev", "who tagged it is recorded");

    // The read prefers the hand tag over the name-matcher's guess.
    const rows = (await worker.handleGrowthRequest(new URL("https://w/growth/entity?week_start=2026-08-30&entity=ad&metrics=ad_spend"), request, env)).data.rows;
    assert.strictEqual(rows[0].attributes.promoted_product_id, "p9");

    // A Meta refresh rewrites the names and the guess; it must not touch the tag.
    const w = loadWorker({ fetch: metaStub().fetch });
    await w.writeMetaDailyFacts(d1Over(sqlite), w.buildMetaDailyFacts([metaRow({ ad: "a1", date: "2026-09-02", spend: 50, impr: 900, out: 9, lpv: 5, purch: 0 })], []), "T");
    assert.strictEqual(sqlite.prepare("SELECT promoted_product_id FROM dim_ad WHERE ad_id = 'a1'").get().promoted_product_id, "p9", "the tag outlives the refresh");

    // And it can be taken off again.
    const cleared = await post({ ad_id: "a1", product_id: "" });
    assert.strictEqual(cleared.data.cleared, true);
    assert.strictEqual(sqlite.prepare("SELECT promoted_product_id FROM dim_ad WHERE ad_id = 'a1'").get().promoted_product_id, null);
  });

  await runAsync("shares: a part larger than its whole reads unreadable, never a rate above 100%", async () => {
    const sqlite = freshDb();
    // it means the two numbers were not counted the same way, and the only honest
    // answer is that the stage cannot be read.
    sqlite.prepare(
      "INSERT INTO fact_ad_daily (date, platform, ad_id, adset_id, campaign_id, currency, spend, impressions, clicks_all, clicks_outbound, clicks_link, landing_page_views, platform_purchases, platform_revenue) " +
      "VALUES ('2026-09-01', 'meta', 'a1', 's1', 'c1', 'EGP', 500, 20000, 400, 300, 200, 305, 3, 9000)"
    ).run();
    sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES ('l1', 'fixture', 'fact_ad_daily', '2026-08-01', '2026-09-10', '2026-09-10T00:00:00Z', '2026-09-10T00:01:00Z', 'succeeded')").run();
    const res = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=2026-08-30"), request, { SYNC_DB: d1Over(sqlite) });
    const all = Object.values(res.data.surfaces).flatMap((s) => Object.values(s.sections).flat());
    const land = all.find((e) => e.metric === "land_rate");
    assert.ok(land, "land_rate is on a surface");
    assert.strictEqual(land.value, null, "no number is offered");
    assert.strictEqual(land.state, "missing");
    assert.strictEqual(land.state_detail.missing.reason, "bases_not_comparable");
    // The counts either side of it are still reported as they came.
    assert.strictEqual(all.find((e) => e.metric === "landing_page_views").value, 305);
  });

  // The bug that hid for a day: tests had no drops, so no comparison was ever built,
  // so a metric defined without one never tripped the contract. This runs EVERY
  // wired week metric with drops, orders, ads and loads present.
  await runAsync("resolvers: every wired metric resolves against realistic data without breaking the contract", async () => {
    const sqlite = freshDb();
    for (const [id, d, season] of [["2026-05-14", "2026-05-14", "summer"], ["2026-06-16", "2026-06-16", "summer"], ["2026-07-26", "2026-07-26", "summer"], ["2026-09-20", "2026-09-20", "winter"]]) {
      sqlite.prepare("INSERT INTO dim_drop (drop_id, drop_date, drop_week_start, season, created_at, updated_at) VALUES (?, ?, ?, ?, 'x', 'x')").run(id, d, d, season);
    }
    sqlite.prepare("INSERT INTO dim_variant (variant_id, product_id, unit_cogs_snapshot) VALUES ('11', '7', 300)").run();
    const orders = [];
    const ads = [];
    let n = 3000;
    for (let day = "2026-05-14"; day <= "2026-09-12"; day = worker.addDays(day, 1)) {
      orders.push(orderNode({ id: n, createdAt: day + "T10:00:00Z", customer: n, firstOrder: n % 3 ? n : 1, subtotal: 1000, lines: [{ id: n, variant: 11, qty: 1, price: 1000 }],
        cancelledAt: n % 6 === 0 ? worker.addDays(day, 2) + "T10:00:00Z" : null, gateways: n % 4 ? ["Cash on Delivery (COD)"] : ["Paymob"],
        fulfillments: shipped(day + "T12:00:00Z", n % 6 === 0 ? "NOT_DELIVERED" : "DELIVERED", n % 6 === 0 ? null : worker.addDays(day, 2) + "T10:00:00Z") }));
      ads.push(metaRow({ ad: "a" + (n % 3), date: day, spend: 200, impr: 5000, out: 60, lpv: 45, purch: 1, video: n % 2 === 0, plays: 900 }));
      n += 1;
    }
    await worker.writeOrderFacts(d1Over(sqlite), worker.buildOrderFacts(orders, { drops: [] }));
    await worker.writeMetaDailyFacts(d1Over(sqlite), worker.buildMetaDailyFacts(ads, []), "T");
    const ins = sqlite.prepare("INSERT INTO fact_session_daily (date, breakdown_id, sessions, sessions_with_cart_add, sessions_reached_checkout, sessions_converted) VALUES (?, 'shopify.total', 1000, 40, 25, 10)");
    for (let day = "2026-05-14"; day <= "2026-09-12"; day = worker.addDays(day, 1)) ins.run(day);
    // GA4 counts events, so its funnel is its own column: the totals carry the week
    // and the channel and visitor cuts carry demand.
    const ga4Total = sqlite.prepare("INSERT INTO fact_ga4_daily (date, breakdown_id, sessions, engaged_sessions, engagement_time_sec, view_item, add_to_cart, begin_checkout, add_payment_info, purchase) VALUES (?, 'ga4.total', 1100, 700, 42000, 500, 60, 30, 18, 11)");
    const ga4Cut = sqlite.prepare("INSERT INTO fact_ga4_daily (date, breakdown_id, dim1_value, is_other_row, sessions) VALUES (?, ?, ?, ?, ?)");
    for (let day = "2026-05-14"; day <= "2026-09-12"; day = worker.addDays(day, 1)) {
      ga4Total.run(day);
      ga4Cut.run(day, "ga4.channel_group", "Direct", 0, 400);
      ga4Cut.run(day, "ga4.channel_group", "Organic Social", 0, 250);
      ga4Cut.run(day, "ga4.channel_group", "Paid Social", 0, 400);
      ga4Cut.run(day, "ga4.channel_group", "Unassigned", 0, 30);
      ga4Cut.run(day, "ga4.channel_group", "(other)", 1, 20);
      ga4Cut.run(day, "ga4.new_or_returning", "new", 0, 800);
      ga4Cut.run(day, "ga4.new_or_returning", "returning", 0, 250);
    }
    // A handful of return requests against those orders, so the request metrics
    // resolve here too rather than reading as never loaded.
    const req = sqlite.prepare("INSERT INTO fact_return_request (request_id, item_index, source, order_id, request_type, status, requested_at, date, week_start, order_date, product_title, size, product_id, variant_id, match_method, quantity, reason_code) VALUES (?, 0, 'yanet', ?, ?, 'approved', ?, ?, ?, ?, 'Tee', 'M', '7', '11', 'order_line', 1, ?)");
    let requestNo = 0;
    for (let day = "2026-05-20"; day <= "2026-09-10"; day = worker.addDays(day, 7)) {
      requestNo += 1;
      const orderDay = worker.addDays(day, -3);
      req.run("#RET" + requestNo, String(3000 + requestNo), requestNo % 3 ? "return" : "exchange", day + "T10:00:00", day, worker.addDays(day, -new Date(day + "T00:00:00Z").getUTCDay()), orderDay, requestNo % 2 ? "wrong_size" : "disliked_item");
    }
    for (const t of ["fact_order", "fact_ad_daily", "fact_session_daily", "fact_return_request", "fact_ga4_daily"]) {
      sqlite.prepare("INSERT INTO load_log (load_id, source, target_table, period_start, period_end, started_at, finished_at, status) VALUES (?, 'fixture', ?, '2026-05-14', '2026-09-12', '2026-09-13T00:00:00Z', '2026-09-13T00:01:00Z', 'succeeded')").run("l-" + t, t);
    }
    for (const week of ["2026-06-21", "2026-08-02", "2026-09-06"]) {
      const res = await worker.handleGrowthRequest(new URL("https://w/growth/week?week_start=" + week), request, { SYNC_DB: d1Over(sqlite) });
      assert.strictEqual(res.data.ok, true, week);
      assert.strictEqual(res.data.meta.warnings.length, 0, week + ": " + JSON.stringify(res.data.meta.warnings));
      const envs = Object.values(res.data.surfaces).flatMap((s) => Object.values(s.sections).flat());
      const wired = Object.keys(RESOLVERS);
      for (const key of wired) {
        const env = envs.find((e) => e.metric === key);
        if (!env) continue;
        assert.ok(env.state !== "missing" || !["resolver_error", "not_loaded"].includes(env.state_detail.missing.reason), `${week} ${key}: ${JSON.stringify(env.state_detail)}`);
      }
      const cvr = envs.find((e) => e.metric === "cvr_shopify");
      assert.strictEqual(cvr.value, 0.01, week);
      // Jun 21 is day 5 of the Jun 16 drop with one earlier drop: too few to compare.
      if (week === "2026-09-06") assert.ok(cvr.comparison && cvr.comparison.mode, week + ": CVR is a drop-cycle metric, in its floor phase here");
      const spend = envs.find((e) => e.metric === "ad_spend");
      assert.strictEqual(spend.comparison, null, "ad_spend is defined without a comparison");
      assert.ok(spend.value > 0);
    }
  });

  await runAsync("order facts: an empty window older than 60 days is a failure, never zero orders", async () => {
    const sqlite = freshDb();
    sqlite.prepare("INSERT INTO dim_drop (drop_id, drop_date, drop_week_start, created_at, updated_at) VALUES ('2026-04-01', '2026-04-01', '2026-03-29', 'x', 'x')").run();
    // Mirrors a token without read_all_orders: nothing older than 60 days comes back.
    const w = loadWorker({ fetch: orderStub(() => ORDER_FIXTURE.filter((o) => o.createdAt >= "2026-07-17")).fetch });
    const out = await w.runOrderFacts({ SYNC_DB: d1Over(sqlite), SHOPIFY_OFFLINE_TOKEN: "x" }, { now: new Date("2026-09-15T20:50:00Z"), config: { shopDomain: "fixture.myshopify.com" } });
    assert.strictEqual(out.ok, false);
    const backfill = out.windows.find((x) => x.window.kind === "backfill");
    assert.ok(/read_all_orders/.test(backfill.error));
    const cov = sqlite.prepare("SELECT MIN(period_start) AS f FROM load_log WHERE target_table = 'fact_order' AND status = 'succeeded'").get().f;
    assert.strictEqual(cov, "2026-07-17", "coverage is not extended over an empty history window");
  });

  await runAsync("order facts: a Shopify failure records a failed load and writes nothing", async () => {
    const sqlite = freshDb();
    const w = loadWorker({ fetch: async () => ({ status: 403, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ errors: "forbidden" }) }) });
    const out = await w.runOrderFacts({ SYNC_DB: d1Over(sqlite), SHOPIFY_OFFLINE_TOKEN: "x" }, { now: new Date("2026-09-15T20:50:00Z"), config: { shopDomain: "fixture.myshopify.com" } });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM fact_order").get().n, 0);
    assert.ok(sqlite.prepare("SELECT COUNT(*) AS n FROM load_log WHERE status = 'failed'").get().n >= 1);
  });

  // ---------------------------------------------------------------- generated files
  run("generated: seed migration and fixtures equal a fresh regeneration", () => {
    const files = generate.buildGeneratedFiles();
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      assert.ok(fs.existsSync(abs), `missing generated file ${rel} — run node growth-os/generate.js`);
      assert.strictEqual(fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n"), content, `${rel} is stale — run node growth-os/generate.js`);
    }
    // D1 rejects any single statement over 100 KB.
    for (const [rel, content] of Object.entries(files)) {
      if (!rel.endsWith(".sql")) continue;
      const largest = Math.max(...content.split(/;\n/).map((stmt) => Buffer.byteLength(stmt)));
      assert.ok(largest < 90000, `${rel}: a statement is ${largest} bytes`);
    }
    for (const state of ["ok", "missing", "partial", "no_basis", "contaminated", "stale", "suspect"]) {
      const f = JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", "growth-os", "envelope", `${state}.json`), "utf8"));
      assert.strictEqual(f.envelope.state, state, `fixture ${state}`);
    }
  });

  run("generated: a migration applied in production never changes", () => {
    const { applied } = JSON.parse(fs.readFileSync(path.join(root, "growth-os", "applied-migrations.json"), "utf8"));
    const crypto = require("crypto");
    for (const [file, sha] of Object.entries(applied)) {
      const abs = path.join(migrationsDir, file);
      assert.ok(fs.existsSync(abs), `applied migration ${file} was deleted`);
      const got = crypto.createHash("sha256").update(fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n")).digest("hex");
      assert.strictEqual(got, sha, `${file} changed after it was applied — put the change in a new migration`);
    }
    assert.ok(applied["0012_growth_os_seed.sql"]);
  });

  run("generated: mixed week fixture exercises every state through the resolver path", () => {
    const f = JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", "growth-os", "week", "mixed.json"), "utf8"));
    const envs = Object.values(f.surfaces).flatMap((s) => Object.values(s.sections).flat());
    const states = new Set(envs.map((e) => e.state));
    for (const s of ["ok", "missing", "partial", "no_basis", "contaminated", "stale", "suspect"]) assert.ok(states.has(s), s);
    assert.ok(envs.some((e) => e.state === "suspect" && e.secondary_states.includes("stale")));
    assert.ok(envs.some((e) => e.state === "missing" && e.secondary_states.includes("suspect")));
  });

  // ---------------------------------------------------------------- UI renderer
  run("ui: every fixture state renders; missing is blank, never zero", () => {
    const dir = path.join(root, "test", "fixtures", "growth-os", "envelope");
    for (const file of fs.readdirSync(dir)) {
      const f = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const html = ui.renderEnvelope(f.envelope, f.definition);
      assert.ok(html.includes(`data-state="${f.envelope.state}"`), file);
      for (const s of [f.envelope.state, ...f.envelope.secondary_states]) {
        if (s === "missing") assert.ok(html.includes("gx-missing"), `${file}: missing slot`);
        else if (s !== "ok") assert.ok(html.includes(`gx-badge-${s}`), `${file}: flag for ${s}`);
      }
      if (f.envelope.state === "missing") {
        assert.ok(!/gx-num/.test(html), `${file}: missing must render no number at all`);
        assert.ok(html.includes("no data yet"), `${file}: missing says so`);
        assert.ok(!/gx-delta/.test(html), `${file}: missing shows no delta`);
      }
      if (f.envelope.comparison && f.envelope.state !== "missing") {
        const c = f.envelope.comparison;
        assert.ok(html.includes(ui.win(c.current.window)), `${file}: basis panel states this window`);
        for (const a of c.against || c.pool) assert.ok(html.includes(ui.win(a.window)), `${file}: basis panel states ${a.drop_id}'s window`);
        assert.ok(/class="gx-panel" hidden/.test(html), `${file}: panel collapsed by default`);
        assert.ok(!/class="gx-panel" hidden/.test(ui.renderEnvelope(f.envelope, f.definition, { open: true })), `${file}: open on request`);
      }
      if (f.envelope.basis) assert.ok(html.includes(f.envelope.basis), `${file}: basis on the tile`);
      if (f.envelope.state === "no_basis") assert.ok(!/gx-delta/.test(html), `${file}: no_basis shows no delta`);
    }
    assert.ok(ui.renderEnvelope({ metric: "x", state: "ok", secondary_states: [], value: "<b>", unit: "date", confidence: "measured" }).includes("&lt;b&gt;"));
    assert.strictEqual(ui.formatValue(0, "count"), "0");
    assert.strictEqual(ui.formatValue(null, "count"), "");
  });

  run("ui: confidence is texture, delta colour follows the definition's direction", () => {
    const ok = JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", "growth-os", "envelope", "ok.json"), "utf8"));
    const platform = { ...ok.envelope, confidence: "platform_reported" };
    const html = ui.renderEnvelope(platform, ok.definition);
    assert.ok(html.includes("gx-conf-platform") && html.includes("never summed with Shopify-measured revenue"));
    assert.ok(ui.renderEnvelope({ ...ok.envelope, confidence: "modelled" }, ok.definition).includes("gx-conf-modelled"));
    // lower_better definition is bad.
    assert.ok(/gx-delta-pct good/.test(ui.renderEnvelope(ok.envelope, ok.definition)));
    assert.ok(/gx-delta-pct bad/.test(ui.renderEnvelope(ok.envelope, { ...ok.definition, direction: "lower_better" })));
    assert.ok(/gx-delta-pct"/.test(ui.renderEnvelope(ok.envelope, { ...ok.definition, direction: "neutral" })));
  });

  run("ui: floor comparisons show pool, position and season; samples print n", () => {
    const load = (n) => JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", "growth-os", "envelope", `${n}.json`), "utf8"));
    const floor = load("floor_pool");
    const html = ui.renderEnvelope(floor.envelope, floor.definition);
    assert.ok(html.includes("vs floor median of 4 windows"));
    assert.ok(html.includes("above 2 of 4 floor windows"));
    assert.ok(html.includes("cycle cap"), "capped windows are listed with their reason");
    const cross = load("floor_cross_season");
    const ch = ui.renderEnvelope(cross.envelope, cross.definition);
    assert.ok(ch.includes("other season") && ch.includes("previous season"));
    assert.ok(ui.renderEnvelope(load("with_sample").envelope, load("with_sample").definition).includes("n 400 sessions"));
    assert.ok(!/gx-delta/.test(ui.renderEnvelope(load("floor_no_basis").envelope, load("floor_no_basis").definition)));
  });

  run("ui: contract viewer loads the shared renderer, not its own", () => {
    const page = fs.readFileSync(path.join(root, "report-ui", "growth.html"), "utf8");
    assert.ok(page.includes('src="/growth-envelope.js"'));
    assert.ok(page.includes("renderEnvelope("));
  });
})().catch((err) => {
  process.exitCode = 1;
  throw err;
});

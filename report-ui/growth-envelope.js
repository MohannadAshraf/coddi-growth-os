// Growth OS envelope renderer — the one place the UI turns an envelope into a tile.
// Visual system: Claude Design "Growth OS Visual System" (tile anatomy, state
// colours, confidence textures), ported to plain HTML strings. Styles live in
// growth.css.
//
// The API decides state; this file never infers it. Missing is blank — never zero,
// never an estimate. Secondary states render as extra flags, so a metric that is
// suspect and stale shows both. The basis label prints on the tile, and every
// delta can expand to show both windows' dates.
//
// Browser: window.GrowthEnvelope. Node (tests): module.exports.

(function (root) {
  "use strict";

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Accent rule precedence is visual: the loudest problem owns the edge.
  const ACCENT_ORDER = ["suspect", "contaminated", "stale", "partial", "no_basis", "missing"];
  const ACCENT_VAR = {
    ok: "var(--st-ok)",
    suspect: "var(--st-suspect)",
    contaminated: "var(--st-contaminated)",
    stale: "var(--st-stale)",
    partial: "var(--st-partial)",
    no_basis: "var(--st-no-basis)",
    missing: "var(--st-missing)"
  };

  const MISSING_REASONS = {
    unwired: "not wired up",
    source_absent: "source has no data",
    resolver_error: "computation failed",
    resolver_returned_nothing: "computation returned nothing",
    no_drop_recorded: "no drop recorded",
    no_next_drop_recorded: "no next drop recorded",
    not_loaded: "not loaded for this week yet",
    no_denominator: "nothing to divide by",
    // A part came back larger than the whole it is measured against, so the two were
    // not counted the same way and no rate can be read from them.
    bases_not_comparable: "the two numbers are not counted the same way",
    no_delivery_in_period: "this ad did not deliver in the window",
    below_impression_threshold: "too few impressions to read",
    below_click_threshold: "too few clicks to read",
    below_purchase_threshold: "too few purchases to read",
    ad_links_not_tagged: "too few of its orders carried the ad id",
    no_cogs_for_this_sku: "no cost recorded for what it sold"
  };

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function human(s) {
    return String(s == null ? "" : s).replace(/_/g, " ");
  }

  // "2026-09-02" -> "Sep 2"
  function dt(iso) {
    if (!iso) return "";
    const p = String(iso).slice(0, 10).split("-");
    if (p.length < 3) return String(iso);
    return MONTHS[+p[1] - 1] + " " + +p[2];
  }

  function ts(iso) {
    if (!iso) return "";
    return dt(iso) + " " + String(iso).slice(11, 16);
  }

  // A window: "Sep 2–8", or "Aug 30 – Sep 5" across a month.
  function win(w) {
    if (!w || !w.start || !w.end) return "";
    if (w.start.slice(0, 7) === w.end.slice(0, 7)) return dt(w.start) + "–" + +w.end.slice(8, 10);
    return dt(w.start) + " – " + dt(w.end);
  }

  function formatParts(value, unit) {
    if (value === null || value === undefined) return { num: "", suffix: "" };
    if (unit === "date") return { num: String(value), suffix: "" };
    if (typeof value !== "number" || !isFinite(value)) return { num: "", suffix: "" };
    switch (unit) {
      case "EGP":
        return { num: Math.round(value).toLocaleString("en-US"), suffix: "EGP" };
      case "ratio": {
        const p = value * 100;
        return { num: Math.abs(p) < 10 ? p.toFixed(1) : p.toFixed(0), suffix: "%" };
      }
      case "multiple":
        return { num: value.toFixed(2), suffix: "×" };
      case "count":
        return { num: value.toLocaleString("en-US", { maximumFractionDigits: 0 }), suffix: "" };
      case "days":
        return { num: String(value), suffix: value === 1 ? "day" : "days" };
      case "decimal":
        return { num: value.toFixed(2), suffix: "" };
      case "seconds":
        return { num: String(Math.round(value)), suffix: "s" };
      default:
        return { num: value.toLocaleString("en-US", { maximumFractionDigits: 2 }), suffix: "" };
    }
  }

  function formatValue(value, unit) {
    const f = formatParts(value, unit);
    return f.suffix === "%" || f.suffix === "×" ? f.num + f.suffix : (f.suffix ? f.num + " " + f.suffix : f.num);
  }

  function pctStr(x) {
    const p = x * 100;
    const s = (Math.abs(p) < 10 ? p.toFixed(1) : p.toFixed(0)).replace(/\.0$/, "");
    return (x > 0 ? "+" : "") + s + "%";
  }

  function formatDelta(comparison, unit) {
    if (!comparison) return "";
    if (typeof comparison.delta_pct === "number") return pctStr(comparison.delta_pct);
    if (typeof comparison.delta_abs === "number") {
      const f = formatParts(comparison.delta_abs, unit);
      return (comparison.delta_abs > 0 ? "+" : "") + f.num + (f.suffix ? " " + f.suffix : "");
    }
    return "";
  }

  function statesOf(env) {
    return [env.state].concat(env.secondary_states || []);
  }

  function accentOf(states) {
    for (const s of ACCENT_ORDER) if (states.indexOf(s) >= 0) return ACCENT_VAR[s];
    return ACCENT_VAR.ok;
  }

  function isMissing(env) {
    return env.state === "missing" || env.value === null || env.value === undefined;
  }

  // One flag per applicable state, primary first, each carrying its own evidence.
  function badges(env) {
    const sd = env.state_detail || {};
    const out = [];
    for (const s of statesOf(env)) {
      if (s === "suspect") {
        for (const f of sd.suspect || []) {
          out.push({ cls: "suspect", tag: "investigate", note: "the measurement may be broken · break " + dt(f.break_date) + " · " + human(f.signal) + (f.detected_at ? " · flagged " + ts(f.detected_at) : "") });
        }
      } else if (s === "stale") {
        const x = sd.stale || {};
        out.push({ cls: "stale", tag: "stale", note: "computed " + ts(x.computed_at) + ", after that " + (x.source_table || "source") + " loaded " + ts(x.source_loaded_at) });
      } else if (s === "partial") {
        const cov = sd.partial && sd.partial.coverage != null ? sd.partial.coverage : env.coverage;
        out.push({ cls: "partial", tag: Math.round((cov || 0) * 100) + "% coverage", note: "the window is only part-covered" });
      } else if (s === "contaminated") {
        for (const f of sd.contaminated || []) {
          if (f.kind === "cross_season") {
            out.push({ cls: "contaminated", tag: "other season", note: f.note || "compared against the previous season's floor" });
            continue;
          }
          out.push({ cls: "contaminated", tag: "contaminated", note: human(f.kind) + (f.start ? " " + dt(f.start) + " – " + dt(f.end) : "") + (f.offer_id ? " · offer " + f.offer_id : "") + " sits inside the delta" });
        }
      } else if (s === "no_basis") {
        const x = sd.no_basis || {};
        const noun = x.mode === "floor_pool" ? " floor windows usable" : " prior drops usable";
        out.push({ cls: "no_basis", tag: "no basis", note: (x.available || 0) + " of " + (x.required || 2) + noun + (x.reason ? " · " + human(x.reason) : "") + " — no delta shown" });
      }
    }
    return out;
  }

  // Bars: the windows this number is being compared against, then this one lit.
  // They are not "the last few weeks" — in drop-day mode they are the same stretch
  // of earlier drops, oldest to newest; in floor mode they are the floor windows
  // ordered smallest to largest, which is a distribution and not a timeline. Each
  // bar names its own window on hover, because neither order is guessable.
  function sparkBars(c) {
    const prior = c.mode === "floor_pool"
      ? c.pool.slice().sort((x, y) => x.value - y.value)
      : c.against.slice().reverse();
    return prior.concat([c.current]).filter((x) => x && typeof x.value === "number");
  }

  function sparkLabel(item, index, last, mode, unit) {
    const value = formatParts(item.value, unit);
    const amount = value.num + (value.suffix ? " " + value.suffix : "");
    const where = win(item.window);
    if (index === last) return "this window · " + where + " · " + amount;
    const drop = item.drop_id ? "drop " + item.drop_id : "";
    if (mode === "floor_pool") {
      return "floor window " + (index + 1) + " of " + last + " by size · " + where + (drop ? " · " + drop : "") + " · " + amount;
    }
    return (drop || "earlier drop") + " · same drop-days · " + where + " · " + amount;
  }

  function sparkSvg(c, unit) {
    const items = sparkBars(c);
    if (items.length < 2) return "";
    const max = Math.max.apply(null, items.map((x) => Math.abs(x.value)));
    const n = items.length;
    const bw = (64 - (n - 1) * 3) / n;
    const bars = items.map((item, i) => {
      const h = max > 0 ? Math.max(1.5, (Math.abs(item.value) / max) * 20) : 1.5;
      return '<rect' + (i === n - 1 ? ' class="cur"' : "") + ' x="' + (i * (bw + 3)).toFixed(1) + '" y="' + (20 - h).toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '"><title>' + esc(sparkLabel(item, i, n - 1, c.mode, unit)) + "</title></rect>";
    });
    const label = c.mode === "floor_pool"
      ? "This window against " + (n - 1) + " floor windows, ordered smallest to largest"
      : "This window against " + (n - 1) + " earlier drops at the same drop-days";
    return '<svg class="gx-spark" viewBox="0 0 64 20" width="64" height="20" role="img" aria-label="' + esc(label) + '"><title>' + esc(label) + "</title>" + bars.join("") + "</svg>";
  }

  // "vs median of 3 drops, drop-day 3–9" or "vs floor median of 6 windows".
  function comparisonSummary(c) {
    if (!c) return "";
    if (c.mode === "floor_pool") {
      return "vs floor median of " + c.n + " windows" + (c.scope === "cross_season" ? ", previous season" : "");
    }
    return "vs " + c.basis_method + " of " + c.against.length + " drops, drop-day " + c.drop_day.start + "–" + c.drop_day.end;
  }

  function floorPosition(c) {
    const p = c.position || {};
    if (p.above === 0) return "highest of " + (p.of + 1);
    if (p.below === 0) return "lowest of " + (p.of + 1);
    return "above " + p.below + " of " + p.of + " floor windows";
  }

  function basisSentence(c) {
    if (c.mode === "floor_pool") {
      return pctStr(c.delta_pct == null ? 0 : c.delta_pct) + " vs floor median of " + c.n + " windows · " + win(c.current.window) +
        " (drop-day " + c.current.window.drop_day_start + "–" + c.current.window.drop_day_end + ") · " + floorPosition(c) + " · " +
        human(c.scope) + " · " + human(c.value_basis) + " " + (c.currency || "");
    }
    const priors = c.against.map((a) => win(a.window)).join(", ");
    return pctStr(c.delta_pct == null ? 0 : c.delta_pct) + " vs " + c.basis_method + " of " + c.against.length + " drops · drop-day " +
      c.drop_day.start + "–" + c.drop_day.end + " · " + win(c.current.window) + " vs " + priors + " · " + human(c.value_basis) + " " + (c.currency || "");
  }

  // One plain sentence before the rows: the panel is precise, but precision is not
  // the same as being understood.
  function basisLead(c) {
    if (c.mode === "floor_pool") {
      return "This drop is past its spike, so the comparison is the quiet weeks — the floor. " +
        "Each row below is one floor week; the change is measured from their median, not from last week.";
    }
    return "The drop is still fresh, so the comparison is the same days of earlier drops — day " +
      c.drop_day.start + " to " + c.drop_day.end + " of each. Comparing with last week would only say that a drop happened.";
  }

  function basisPanel(env, c, open) {
    const unit = env.unit;
    const row = (k, cls, text, val) =>
      '<div class="gx-panel-r"><span class="gx-panel-k ' + cls + '">' + esc(k) + '</span><span class="gx-panel-t">' + esc(text) + '</span><span class="gx-panel-v">' + esc(val) + "</span></div>";
    if (c.mode === "floor_pool") {
      let fr = row("this week", "cur", c.current.drop_id + " · " + win(c.current.window) + " · drop-day " + c.current.window.drop_day_start + "–" + c.current.window.drop_day_end, formatParts(c.current.value, unit).num);
      for (const a of c.pool) {
        fr += row("floor", "", a.drop_id + " · " + win(a.window) + " · drop-day " + a.window.drop_day_start + "–" + a.window.drop_day_end, formatParts(a.value, unit).num);
      }
      for (const x of c.excluded || []) fr += row("excluded", "exc", x.drop_id + (x.window ? " · " + win(x.window) : "") + " · " + human(x.reason), "—");
      fr += row("median", "med", "floor median of " + c.n + " windows · " + human(c.scope) + " · " + human(c.value_basis) + " " + (c.currency || ""), formatParts(c.basis_value, unit).num);
      fr += row("range", "med", "lowest to highest floor window · this week is " + floorPosition(c), formatParts(c.spread.min, unit).num + "–" + formatParts(c.spread.max, unit).num);
      for (const f of c.flags || []) fr += row("flag", "flag", f.note || human(f.kind), "⚑");
      return '<div class="gx-panel"' + (open ? "" : " hidden") + '><div class="gx-panel-lead">' + esc(basisLead(c)) + '</div><div class="gx-panel-s">' + esc(basisSentence(c)) + "</div>" + fr + "</div>";
    }
    let rows = row("this drop", "cur", c.current.drop_id + " · " + win(c.current.window) + " · drop-day " + c.current.window.drop_day_start + "–" + c.current.window.drop_day_end, formatParts(c.current.value, unit).num);
    for (const a of c.against) {
      rows += row("prior", "", a.drop_id + " · " + win(a.window) + " · drop-day " + a.window.drop_day_start + "–" + a.window.drop_day_end, formatParts(a.value, unit).num);
    }
    for (const x of c.excluded || []) {
      rows += row("excluded", "exc", x.drop_id + " · " + win(x.window) + " · " + human(x.reason), "—");
    }
    rows += row(c.basis_method, "med", "basis value · " + c.basis_method + " of " + c.against.length + " prior drops · " + human(c.value_basis) + " " + (c.currency || ""), formatParts(c.basis_value, unit).num);
    for (const f of c.flags || []) {
      rows += row("flag", "flag", human(f.kind) + (f.start ? " · " + dt(f.start) + " – " + dt(f.end) : "") + (f.offer_id ? " · offer " + f.offer_id : ""), "⚑");
    }
    return '<div class="gx-panel"' + (open ? "" : " hidden") + '><div class="gx-panel-lead">' + esc(basisLead(c)) + '</div><div class="gx-panel-s">' + esc(basisSentence(c)) + "</div>" + rows + "</div>";
  }

  // envelope: from the API. definition: meta.definitions[metric].
  // opts.open forces the basis panel open (the "always show basis" reading mode);
  // opts.footnote = false drops the platform footnote inside a platform block.
  function renderEnvelope(envelope, definition, opts) {
    const env = envelope || {};
    const def = definition || {};
    const o = opts || {};
    const states = statesOf(env);
    const missing = isMissing(env);
    const f = formatParts(env.value, env.unit);
    const conf = env.confidence || "measured";

    let html = '<div class="gx-tile" data-metric="' + esc(env.metric) + '" data-state="' + esc(env.state) + '" data-conf="' + esc(conf) + '" style="--accent:' + accentOf(states) + '">';
    html += '<div class="gx-head"><div class="gx-label">' + esc(def.label || human(env.metric)) + "</div>";
    if (conf === "modelled") html += '<div class="gx-conf gx-conf-modelled">modelled</div>';
    if (conf === "platform_reported") html += '<div class="gx-conf gx-conf-platform">platform-reported</div>';
    html += "</div>";

    const c = env.comparison;
    const hasDelta = !missing && c && env.state !== "no_basis" && (typeof c.delta_pct === "number" || typeof c.delta_abs === "number");

    if (!missing) {
      html += '<div class="gx-value-row"><div class="gx-value"><span class="gx-num">' + esc(f.num) + '</span><span class="gx-suffix">' + esc(f.suffix) + "</span></div>" + (hasDelta ? sparkSvg(c, env.unit) : "") + "</div>";
    } else {
      const reason = (env.state_detail && env.state_detail.missing && env.state_detail.missing.reason) || "unwired";
      html += '<div class="gx-missing"><span class="gx-slot"></span><span class="gx-missing-t">no data yet · ' + esc(MISSING_REASONS[reason] || human(reason)) + "</span></div>";
    }

    // The bars are a mystery without a caption, and a tooltip nobody hovers is not
    // an explanation. Say it in words under the number.
    if (hasDelta) {
      const bars = sparkBars(c);
      if (bars.length >= 2) {
        html += '<div class="gx-spark-key">' + esc(c.mode === "floor_pool"
          ? (bars.length - 1) + " floor weeks, weakest to strongest, then this one"
          : (bars.length - 1) + " earlier drops at the same drop-days, then this one") + "</div>";
      }
    }

    if (hasDelta) {
      const dir = def.direction || "neutral";
      const good = dir === "neutral" || c.delta_abs === 0 ? null : dir === "higher_better" ? c.delta_abs > 0 : c.delta_abs < 0;
      html += '<div class="gx-delta"><span class="gx-delta-pct' + (good === null ? "" : good ? " good" : " bad") + '">' + esc(formatDelta(c, env.unit)) + "</span>" +
        '<span class="gx-delta-m">' + esc(comparisonSummary(c)) + "</span>" +
        '<button type="button" class="gx-basis-btn" data-basis-toggle aria-expanded="' + (o.open ? "true" : "false") +
        '" title="Show the exact windows this number is compared against">compared to…</button></div>';
    }

    const b = badges(env);
    if (b.length) {
      html += '<div class="gx-badges">' + b.map((x) => '<div class="gx-badge gx-badge-' + x.cls + '"><span class="gx-badge-tag">' + esc(x.tag) + '</span><span class="gx-badge-note">' + esc(x.note) + "</span></div>").join("") + "</div>";
    }
    // Inside a block already headed "platform-reported" the footnote is noise.
    if (conf === "platform_reported" && o.footnote !== false) {
      html += '<div class="gx-footnote">Platform-reported: the network’s own claim. Directional only, never summed with Shopify-measured revenue.</div>';
    }
    const n = env.sample ? "n " + env.sample.n.toLocaleString("en-US") + " " + env.sample.of : "";
    if (env.basis || n) html += '<div class="gx-basis" title="What this number is measured on, and how much of it there was">' +
      esc([env.basis ? "measured on " + env.basis : "", n].filter(Boolean).join(" · ")) + "</div>";
    if (hasDelta) html += basisPanel(env, c, !!o.open);
    return html + "</div>";
  }

  // Delegated handler: one listener on a container toggles any tile's basis panel.
  function bindBasisToggles(container) {
    container.addEventListener("click", (event) => {
      const btn = event.target.closest && event.target.closest("[data-basis-toggle]");
      if (!btn) return;
      const panel = btn.closest(".gx-tile").querySelector(".gx-panel");
      if (!panel) return;
      panel.hidden = !panel.hidden;
      btn.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
    });
  }

  const api = { renderEnvelope, comparisonSummary, formatValue, formatParts, formatDelta, pctStr, badges, accentOf, statesOf, isMissing, esc, human, dt, ts, win, bindBasisToggles, ACCENT_VAR };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GrowthEnvelope = api;
})(typeof window !== "undefined" ? window : globalThis);

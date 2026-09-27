"use strict";

// The weekly report is a page, not a module: it reads the API and writes HTML. Twice
// it lost a whole section in silence — once because a section returned "" when its
// source had no day in the window, once because a missing rate was read as zero. So
// it is executed here against realistic payloads, in a stubbed document, and the
// output is read back.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
let failures = 0;
let passes = 0;

async function run(name, fn) {
  try {
    await fn();
    passes += 1;
    console.log("ok - " + name);
  } catch (err) {
    failures += 1;
    console.log("not ok - " + name);
    console.log(String(err && err.stack ? err.stack : err).split("\n").slice(0, 6).join("\n"));
  }
}

// ---------------------------------------------------------------- the payloads
const envelope = (metric, value, unit, extra) =>
  Object.assign({
    metric, value, unit,
    state: value === null ? "missing" : "ok",
    secondary_states: [],
    confidence: "measured",
    coverage: null,
    comparison: null,
    basis: null,
    sample: null,
    state_detail: value === null ? { missing: { reason: (extra && extra.reason) || "not_loaded" } } : {},
    definition_version: 1
  }, extra && extra.envelope);

function weekPayload({ adsCoveredTo = "2026-09-19", sessionsCoveredTo = "2026-09-19" } = {}) {
  return {
    ok: true,
    contract_version: "growth-os.v3",
    week: { start: "2026-09-20", end: "2026-09-26", as_of: "2026-09-21", is_complete: false, timezone: "Africa/Cairo" },
    drop_context: { drop: { drop_id: "2026-09-20", drop_date: "2026-09-20", label: "Winter W1" } },
    surfaces: {
      command: { title: "Command", sections: { pulse: [
        envelope("orders", 43, "count"),
        envelope("net_sales_attributed", 61000, "EGP"),
        envelope("aov", 1418, "EGP"),
        envelope("sessions_shopify", null, "count"),
        envelope("ad_spend", null, "EGP")
      ] } }
    },
    meta: {
      generated_at: "2026-09-21T09:00:00Z",
      definitions: {},
      sources: {
        fact_order: { covered_from: "2026-04-01", covered_to: "2026-09-20", last_loaded_at: "2026-09-21T06:00:00Z" },
        fact_ad_daily: { covered_from: "2026-04-01", covered_to: adsCoveredTo, last_loaded_at: "2026-09-21T06:00:00Z" },
        fact_session_daily: { covered_from: "2026-04-01", covered_to: sessionsCoveredTo, last_loaded_at: "2026-09-21T06:00:00Z" }
      },
      unwired: [],
      envelopes: { total: 5, by_state: {} },
      warnings: [],
      reads: { d1_batches: 1, statements: 14 }
    }
  };
}

const entityPayload = (rows, baselines) => ({ ok: true, contract_version: "growth-os.v3", rows, baselines: baselines || {}, evidence_gates: { impressions: 1000, clicks: 100, purchases: 5 } });

// ------------------------------------------------------------------ the stubs
function makeDocument() {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id, innerHTML: "", textContent: "", value: "", hidden: false, style: {},
        addEventListener() {}, setAttribute() {}, getAttribute: () => null, closest: () => null, click() {}
      });
    }
    return nodes.get(id);
  };
  return {
    nodes,
    documentElement: { setAttribute() {}, getAttribute: () => null },
    getElementById: (id) => node(id),
    addEventListener() {}
  };
}

async function renderPage(responses) {
  const html = fs.readFileSync(path.join(root, "report-ui", "weekly.html"), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const envelopeSrc = fs.readFileSync(path.join(root, "report-ui", "growth-envelope.js"), "utf8");

  const document = makeDocument();
  const context = {
    console, Math, JSON, Date, URL, URLSearchParams, Map, Set, Object, Array, String, Number, Boolean,
    isNaN, parseFloat, parseInt, RegExp, Error, Intl, Promise, setTimeout,
    document,
    location: { origin: "https://report.test", hash: "" },
    localStorage: { getItem: () => null, setItem() {} },
    window: { addEventListener() {} },
    module: { exports: {} },
    async fetch(url) {
      const target = String(url);
      const body = responses(target);
      return { ok: !!body, status: body ? 200 : 500, json: async () => body };
    }
  };
  context.window.GrowthEnvelope = null;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(envelopeSrc, context);
  context.window.GrowthEnvelope = context.module.exports;
  for (const src of scripts) vm.runInContext(src, context);
  // The page loads on start; give its promise chain a few turns to settle.
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 0));
  return document.getElementById("app").innerHTML;
}

(async () => {
  await run("weekly: the creative section explains itself when Meta has no day in the week", async () => {
    // The drop week: Meta reaches the 19th, the week starts on the 20th.
    const out = await renderPage((url) => {
      if (url.includes("/growth/week")) return weekPayload();
      if (url.includes("entity=ad")) return entityPayload([]);
      return entityPayload([]);
    });
    assert.ok(out.includes("Creative"), "the section is still on the page");
    assert.ok(/Meta ad data is loaded to Sep 19/.test(out), "and says why it is empty: " + out.slice(out.indexOf("Creative"), out.indexOf("Creative") + 400));
    assert.ok(out.includes("Nothing to judge yet"), "rather than disappearing");
  });

  await run("weekly: an ad that spent is judged, with its campaign shown", async () => {
    const ads = [
      { entity_id: "meta:a1", attributes: { ad_name: "Parka | Flatlay | Video | V1", campaign_name: "sales creative testing", promoted_product_id: "9", format_shown: "Video" },
        metrics: [envelope("ad_spend", 4000, "EGP"), envelope("cpm", 70, "EGP"), envelope("outbound_ctr", 0.02, "ratio"),
          envelope("cpc_outbound", 4, "EGP"), envelope("platform_purchases", 12, "count"), envelope("platform_roas", 9, "multiple")] },
      { entity_id: "meta:a2", attributes: { ad_name: "Parka | Model | Static | V1", campaign_name: "always on", promoted_product_id: "9", format_shown: "Static" },
        metrics: [envelope("ad_spend", 3000, "EGP"), envelope("cpm", 190, "EGP"), envelope("outbound_ctr", 0.004, "ratio"),
          envelope("cpc_outbound", 22, "EGP"), envelope("platform_purchases", 6, "count"), envelope("platform_roas", 1.2, "multiple")] }
    ];
    const baselines = {
      cpm: { p25: 80, p50: 120, p75: 160, n: 8, direction: "lower_better" },
      outbound_ctr: { p25: 0.008, p50: 0.012, p75: 0.016, n: 8, direction: "higher_better" },
      cpc_outbound: { p25: 5, p50: 10, p75: 15, n: 8, direction: "lower_better" }
    };
    const out = await renderPage((url) => {
      if (url.includes("/growth/week")) return weekPayload({ adsCoveredTo: "2026-09-26" });
      if (url.includes("entity=ad")) return entityPayload(ads, baselines);
      return entityPayload([]);
    });
    assert.ok(out.includes("sales creative testing"), "the campaign is on the row and in the picker");
    assert.ok(out.includes("Working") && out.includes("Not working") && out.includes("Too early"), "the verdict panels render");
    assert.ok(/cheap to show/.test(out), "the winner says why it is working");
    assert.ok(/dear to show|ignored|dear clicks/.test(out), "and the loser says what is wrong");
  });

  await run("weekly: the creative is shown, with the product it sells and its stock", async () => {
    const ads = [
      { entity_id: "meta:a1", attributes: {
          ad_name: "Parka | Flatlay | Video | V1", campaign_name: "sales creative testing", promoted_product_id: "9",
          format_shown: "Video", creative_kind: "video", thumbnail_url: "https://scontent.test/a1.jpg",
          creative_image_url: "https://scontent.test/a1-full.jpg" },
        metrics: [envelope("ad_spend", 4000, "EGP"), envelope("cpm", 70, "EGP"), envelope("outbound_ctr", 0.02, "ratio"),
          envelope("cpc_outbound", 4, "EGP"), envelope("landing_page_views", 640, "count"),
          envelope("platform_purchases", 12, "count"), envelope("platform_roas", 9, "multiple"),
          envelope("attributed_orders", 7, "count"), envelope("net_roas_attributed", 3.1, "multiple"),
          envelope("delivered_roas_attributed", 2.4, "multiple")] },
      // An ad pointing at a product that has sold out: the thing you must see.
      { entity_id: "meta:a2", attributes: {
          ad_name: "Hoodie | Model | Static | V1", campaign_name: "always on", promoted_product_id: "12",
          format_shown: "Static", thumbnail_url: "https://scontent.test/a2.jpg" },
        metrics: [envelope("ad_spend", 1500, "EGP"), envelope("cpm", 120, "EGP")] }
    ];
    // Product 12 is in the catalogue but sold nothing this week, so it is not in the
    // products table — the gallery must still know what it is and that it is empty.
    const products = [
      { entity_id: "9", attributes: { title: "WINTER PARKA", handle: "parka", status: "ACTIVE" },
        metrics: [envelope("units_total", 12, "count"), envelope("ad_spend", 4000, "EGP")] },
      { entity_id: "12", attributes: { title: "GREY HOODIE", handle: "hoodie", status: "ACTIVE" },
        metrics: [envelope("units_total", 0, "count"), envelope("ad_spend", 1500, "EGP")] }
    ];
    const variants = [
      { entity_id: "v1", attributes: { product_id: "9", size: "L" }, metrics: [envelope("inventory_on_hand", 40, "count"), envelope("units_total", 12, "count")] },
      { entity_id: "v2", attributes: { product_id: "12", size: "L" }, metrics: [envelope("inventory_on_hand", 0, "count"), envelope("units_total", 0, "count")] }
    ];
    const out = await renderPage((url) => {
      if (url.includes("/growth/week")) return weekPayload({ adsCoveredTo: "2026-09-26" });
      if (url.includes("entity=ad")) return entityPayload(ads);
      if (url.includes("entity=product")) return entityPayload(products);
      if (url.includes("entity=variant")) return entityPayload(variants);
      return entityPayload([]);
    });
    assert.ok(out.includes('src="https://scontent.test/a1.jpg"'), "the creative is on the page, not only its name");
    assert.ok(out.includes("WINTER PARKA") && /WINTER PARKA[\s\S]{0,120}40 in stock/.test(out), "the product it sells, and what is left");
    assert.ok(/GREY HOODIE[\s\S]{0,120}out of stock/.test(out), "an ad still running behind an empty product says so");
    assert.ok(out.includes("onerror="), "an expired Meta link does not leave a hole");
    // The attribution is used, not just computed.
    assert.ok(/our orders[\s\S]{0,40}7/.test(out), "our own attributed orders sit beside Meta's count");
    // All three ROAS, side by side: what Meta claims, what was booked, what arrived.
    assert.ok(/ROAS raw[\s\S]{0,40}9\.00/.test(out), "Meta's raw ROAS");
    assert.ok(/ROAS net[\s\S]{0,40}3\.10/.test(out), "booked ROAS");
    assert.ok(/ROAS delivered[\s\S]{0,40}2\.40/.test(out), "delivered ROAS");
    // And the creative can be opened, and the gallery re-sorted.
    assert.ok(out.includes('data-full="https://scontent.test/a1-full.jpg"'), "the full asset is what a click opens");
    assert.ok(out.includes('id="ad-sort"') && out.includes("delivered ROAS</option>"), "the gallery sorts by any metric");
  });

  await run("weekly: an ad whose name names no product can be connected to one", async () => {
    const ads = [
      { entity_id: "meta:a3", attributes: { ad_name: "UGC clip 4", campaign_name: "sales creative testing", thumbnail_url: "https://scontent.test/a3.jpg" },
        metrics: [envelope("ad_spend", 2200, "EGP"), envelope("cpm", 90, "EGP")] }
    ];
    const products = [
      { entity_id: "9", attributes: { title: "WINTER PARKA", handle: "parka", status: "ACTIVE" }, metrics: [envelope("units_total", 12, "count")] },
      // Archived and sold nothing, and still offered: an ad can run behind anything.
      { entity_id: "12", attributes: { title: "GREY HOODIE", handle: "hoodie", status: "ARCHIVED" }, metrics: [envelope("units_total", 0, "count")] }
    ];
    const out = await renderPage((url) => {
      if (url.includes("/growth/week")) return weekPayload({ adsCoveredTo: "2026-09-26" });
      if (url.includes("entity=ad")) return entityPayload(ads);
      if (url.includes("entity=product")) return entityPayload(products);
      return entityPayload([]);
    });
    assert.ok(out.includes("no product read from the name"), "it says the name could not be read");
    assert.ok(/<select data-ad="meta:a3"/.test(out), "and offers the catalogue: " + (out.match(/no product read[\s\S]{0,300}/) || [""])[0]);
    assert.ok(out.includes("WINTER PARKA") && out.includes("GREY HOODIE"), "every product, not only the ones that sold");
  });

  await run("weekly: the four questions are answered by name, with the evidence", async () => {
    const ads = [
      // Best clicked, and it sells nothing: the answer has to say both.
      { entity_id: "meta:hook", attributes: { ad_name: "Hook clip", campaign_name: "testing", thumbnail_url: "t" },
        metrics: [envelope("ad_spend", 1000, "EGP"), envelope("cpm", 60, "EGP"), envelope("outbound_ctr", 0.05, "ratio"),
          envelope("cpc_outbound", 2, "EGP"), envelope("platform_purchases", 0, "count")] },
      // Fewer clicks, but the orders are ours and they are worth money.
      { entity_id: "meta:seller", attributes: { ad_name: "Parka flatlay", campaign_name: "testing", promoted_product_id: "9", thumbnail_url: "t" },
        metrics: [envelope("ad_spend", 2000, "EGP"), envelope("cpm", 100, "EGP"), envelope("outbound_ctr", 0.01, "ratio"),
          envelope("cpc_outbound", 10, "EGP"), envelope("platform_purchases", 9, "count"), envelope("platform_roas", 8, "multiple"),
          envelope("attributed_orders", 6, "count"), envelope("attributed_net_sales", 18000, "EGP"),
          envelope("net_roas_attributed", 9, "multiple"), envelope("delivered_roas_attributed", 5.5, "multiple")] }
    ];
    const products = [
      { entity_id: "9", attributes: { title: "WINTER PARKA", handle: "parka", status: "ACTIVE" },
        metrics: [envelope("units_total", 30, "count"), envelope("orders_containing", 26, "count"),
          envelope("net_sales_attributed", 40000, "EGP"), envelope("ad_spend", 2000, "EGP"),
          envelope("inventory_on_hand", 12, "count")] },
      { entity_id: "12", attributes: { title: "GREY HOODIE", handle: "hoodie", status: "ACTIVE" },
        metrics: [envelope("units_total", 8, "count"), envelope("orders_containing", 8, "count")] }
    ];
    const pages = [
      { entity_id: "/products/parka", attributes: {}, metrics: [
        envelope("sessions_shopify", 900, "count"), envelope("atc_rate_shopify", 0.08, "ratio"),
        envelope("checkout_rate_shopify", 0.05, "ratio"), envelope("cvr_shopify", 0.03, "ratio")] }
    ];
    const out = await renderPage((url) => {
      if (url.includes("/growth/week")) return weekPayload({ adsCoveredTo: "2026-09-26", sessionsCoveredTo: "2026-09-26" });
      if (url.includes("entity=ad")) return entityPayload(ads);
      if (url.includes("entity=product")) return entityPayload(products);
      if (url.includes("breakdown=shopify.landing_page")) return entityPayload(pages);
      return entityPayload([]);
    });

    // 1. best clicked, named, with the comparison that makes it the answer
    assert.ok(/Which creative is best clicked\?[\s\S]{0,200}Hook clip/.test(out), "the best-clicked creative is named");
    assert.ok(/CTR 5\.00% against a median of 3\.00%/.test(out), "against the other ads, not in a vacuum");
    assert.ok(/bought nothing/.test(out), "and says the clicks bought nothing");

    // 2. most money, ours not Meta's
    assert.ok(/Which creative brought the most money\?[\s\S]{0,200}Parka flatlay/.test(out), "the money answer is named");
    assert.ok(/18,000 EGP of our own net sales/.test(out), "stated on our own money");
    assert.ok(/Meta claims 8\.00/.test(out), "with Meta's claim beside it, not instead of it");

    // 3. best ad end to end
    assert.ok(/Which ad is performing best\?[\s\S]{0,200}Parka flatlay/.test(out), "the best ad is named");
    assert.ok(/Its chain: CPM 100, CTR 1\.00%/.test(out), "and the chain that makes it best is shown");

    // 4. best seller, and what did the selling
    assert.ok(/Which product is selling most\?[\s\S]{0,200}WINTER PARKA/.test(out), "the best seller is named");
    assert.ok(/ahead of GREY HOODIE on 8/.test(out), "against the runner-up");
    assert.ok(/2,000 EGP of ad spend sits behind it/.test(out), "and what was spent to get it");
    assert.ok(/Only 12 left against 30 sold/.test(out), "and the stock consequence");
  });

  await run("weekly: an unanswerable question says so instead of picking a winner", async () => {
    // Ads delivered, but not one order carries an ad id.
    const ads = [
      { entity_id: "meta:a1", attributes: { ad_name: "Clip", campaign_name: "testing", thumbnail_url: "t" },
        metrics: [envelope("ad_spend", 1000, "EGP"), envelope("outbound_ctr", 0.01, "ratio"),
          envelope("platform_purchases", 4, "count"), envelope("platform_revenue", 9000, "EGP"), envelope("platform_roas", 9, "multiple")] }
    ];
    const out = await renderPage((url) => {
      if (url.includes("/growth/week")) return weekPayload({ adsCoveredTo: "2026-09-26" });
      if (url.includes("entity=ad")) return entityPayload(ads);
      return entityPayload([]);
    });
    assert.ok(/Which ad is performing best\?[\s\S]{0,240}Not answerable this week/.test(out),
      "no winner is invented from Meta's own count");
    assert.ok(/counts orders which are never delivered/.test(out), "and it says why that would be wrong");
    assert.ok(/No order this week carries an ad id/.test(out), "the money answer falls back to Meta's count, labelled");
  });

  await run("weekly: only active products with activity are listed", async () => {
    const products = [
      { entity_id: "1", attributes: { title: "LIVE SELLER", handle: "live-seller", status: "ACTIVE" },
        metrics: [envelope("units_total", 12, "count"), envelope("ad_spend", 900, "EGP"), envelope("inventory_on_hand", 40, "count")] },
      { entity_id: "2", attributes: { title: "DRAFT WITH STOCK", handle: "draft-stock", status: "DRAFT" },
        metrics: [envelope("units_total", 0, "count"), envelope("ad_spend", null, "EGP"), envelope("inventory_on_hand", 500, "count")] },
      { entity_id: "3", attributes: { title: "LIVE BUT QUIET", handle: "quiet", status: "ACTIVE" },
        metrics: [envelope("units_total", 0, "count"), envelope("ad_spend", null, "EGP"), envelope("inventory_on_hand", 80, "count")] }
    ];
    const out = await renderPage((url) => {
      if (url.includes("/growth/week")) return weekPayload();
      if (url.includes("entity=product")) return entityPayload(products);
      return entityPayload([]);
    });
    assert.ok(out.includes("LIVE SELLER"), "the active product that sold is there");
    assert.ok(!out.includes("DRAFT WITH STOCK"), "a draft sitting on stock is not a line in a weekly review");
    assert.ok(!out.includes("LIVE BUT QUIET"), "nor is an active product that did nothing");
  });

  await run("weekly: a product's rate is never diluted by a page whose rate is unknown", async () => {
    const pages = [
      { entity_id: "/products/live-seller", attributes: {}, metrics: [
        envelope("sessions_shopify", 100, "count"), envelope("atc_rate_shopify", 0.1, "ratio"),
        envelope("checkout_rate_shopify", 0.04, "ratio"), envelope("cvr_shopify", 0.02, "ratio")] },
      { entity_id: "/products/live-seller?variant=2", attributes: {}, metrics: [
        envelope("sessions_shopify", 100, "count"), envelope("atc_rate_shopify", null, "ratio"),
        envelope("checkout_rate_shopify", null, "ratio"), envelope("cvr_shopify", null, "ratio")] }
    ];
    const products = [{ entity_id: "1", attributes: { title: "LIVE SELLER", handle: "live-seller", status: "ACTIVE" },
      metrics: [envelope("units_total", 12, "count"), envelope("ad_spend", 900, "EGP")] }];
    const out = await renderPage((url) => {
      if (url.includes("/growth/week")) return weekPayload({ sessionsCoveredTo: "2026-09-26" });
      if (url.includes("breakdown=shopify.landing_page")) return entityPayload(pages);
      if (url.includes("entity=product")) return entityPayload(products);
      return entityPayload([]);
    });
    // 10 carts over the 100 sessions that could be measured, not over 200.
    assert.ok(out.includes("10.0%"), "the known rate survives the unknown one: " + (out.match(/LIVE SELLER[\s\S]{0,400}/) || [""])[0]);
    // Halving would show ATC 5.0% against the 200 sessions, only 100 of which could
    // be measured at all.
    assert.ok(!out.includes("5.0%"), "and is not halved by counting unmeasured sessions");
  });

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
})();

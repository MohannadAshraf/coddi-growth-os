// Growth OS — metric definitions and structural registries (source of truth).
//
// Meaning lives here; computation lives in src/worker.js (GROWTH_RESOLVERS).
// `node growth-os/generate.js` turns this file into the seed migration and the
// checked-in fixtures. Never hand-edit the generated files; the test suite
// regenerates them and fails on any difference.
//
// Changing a definition = add a row with version + 1, a later effective_from and a
// new `migration` tag. The generator closes the previous version (effective_to), so
// the system can tell its own redefinitions apart from external breaks (§14).
//
// Contains no measurements. Every metric is a definition, not a value.

"use strict";

const SEED_MIGRATION = "0012";
const SEED_CREATED_AT = "2026-09-12T00:00:00Z";
// v1 definitions govern all history: nothing earlier ever defined these metrics.
const V1_EFFECTIVE_FROM = "1970-01-01";

// Source tables — a metric is stale when one of these loads after the value was computed.
const T = {
  order: "fact_order",
  line: "fact_order_line",
  reversal: "fact_reversal",
  reversalLine: "fact_reversal_line",
  refund: "fact_refund",
  refundLine: "fact_refund_line",
  exchange: "fact_exchange",
  ad: "fact_ad_daily",
  adset: "fact_adset_daily",
  ga4: "fact_ga4_daily",
  ga4Item: "fact_ga4_item_daily",
  sessions: "fact_session_daily",
  inventory: "fact_inventory_daily",
  locationSku: "fact_location_sku_weekly",
  returnRequest: "fact_return_request",
  drop: "dim_drop",
  product: "dim_product",
  variant: "dim_variant",
  dimAd: "dim_ad",
  concept: "dim_concept",
  offer: "dim_offer",
  customer: "dim_customer",
  geo: "dim_geo",
  flags: "metric_continuity_flags",
  decisions: "decision_log",
  experiments: "experiment_log",
  forecasts: "forecast_log",
  interventions: "intervention_log"
};

// Grain groups. "week" is served by /growth/week; every other grain is an entity
// type served by /growth/entity.
const G = {
  ads: ["platform", "campaign", "adset", "ad"],
  creativeRollups: ["concept", "angle", "hook_type", "format", "creator"],
  merch: ["product", "variant", "size", "category"]
};

const SHOPIFY_SESSIONS = { session_basis: "shopify", basis_label: "Shopify sessions" };
const GA4_SESSIONS = { session_basis: "ga4", basis_label: "GA4 sessions" };
const GA4_EVENTS = { session_basis: "ga4", basis_label: "GA4 events" };
const GA4_ITEMS = { session_basis: "ga4", basis_label: "GA4 item views" };

const definitions = [];

function m(metric_key, surface, label, unit, formula, opts = {}) {
  definitions.push({
    metric_key,
    version: opts.version || 1,
    label,
    surface,
    unit,
    confidence: opts.confidence || "measured",
    formula,
    session_basis: opts.session_basis || null,
    basis_label: opts.basis_label || null,
    grains: opts.grains || ["week"],
    direction: opts.direction || "neutral",
    comparison_mode: opts.comparison_mode || "drop_day",
    treatment: opts.treatment || null,
    source_tables: opts.sources || [],
    effective_from: opts.effective_from || V1_EFFECTIVE_FROM,
    effective_to: null,
    change_note: opts.change_note || "v1: Growth OS L0 seed (GROWTH-OS-SESSION-1-SPEC.md).",
    created_at: SEED_CREATED_AT,
    migration: opts.migration || SEED_MIGRATION
  });
}

const NONE = { comparison_mode: "none" };
const HIGHER = { direction: "higher_better" };
const LOWER = { direction: "lower_better" };
const MODELLED = { confidence: "modelled" };
const PLATFORM = { confidence: "platform_reported" };
const o = (...parts) => Object.assign({}, ...parts);

// ---------------------------------------------------------------------------
// §3 Command — line 1, exclusions, continuity
// ---------------------------------------------------------------------------
m("days_since_drop", "command", "Days since drop", "days",
  "period end − drop_date of the drop in effect (launch day = 0)",
  o(NONE, { sources: [T.drop], grains: ["week"],
    treatment: "Counts from drop_date. The legacy weekly Sheets field counts from drop_week_start; they are different measures and must not be compared." }));
m("days_to_next_drop", "command", "Days to next drop", "days",
  "next drop_date recorded in dim_drop − period end; missing when no next drop is recorded",
  o(NONE, { sources: [T.drop], grains: ["week"] }));
m("cumulative_orders_since_drop", "command", "Orders since drop", "count",
  "non-excluded orders created from drop_date through period end",
  o(HIGHER, { sources: [T.order, T.drop], grains: ["week", "drop"] }));
m("cumulative_net_sales_since_drop", "command", "Net sales since drop", "EGP",
  "net_sales_attributed from drop_date through period end",
  o(HIGHER, { sources: [T.order, T.line, T.reversal, T.drop], grains: ["week", "drop"] }));
m("alert_egp_at_stake", "command", "EGP at stake in open alerts", "EGP",
  "Σ EGP at stake across open performance alerts; each alert computes its own",
  o(NONE, MODELLED, { sources: [T.order, T.ad, T.ga4, T.sessions] }));
m("continuity_open_flags", "command", "Open continuity flags", "count",
  "open rows in metric_continuity_flags with break_date on or before period end",
  o(NONE, LOWER, { sources: [T.flags] }));
m("exclusion_orders_removed", "command", "Orders excluded", "count",
  "orders created in the period with exclusion_rule set",
  o(NONE, { sources: [T.order], grains: ["exclusion_rule"],
    treatment: "Exclusions apply at the fact level over their full history and report what they removed." }));
m("exclusion_value_removed", "command", "Order value excluded", "EGP",
  "Σ total of orders created in the period with exclusion_rule set",
  o(NONE, { sources: [T.order], grains: ["exclusion_rule"] }));
m("exclusion_units_removed", "command", "Units excluded", "count",
  "Σ units_total of orders created in the period with exclusion_rule set",
  o(NONE, { sources: [T.order], grains: ["exclusion_rule"] }));

// ---------------------------------------------------------------------------
// §4 Economics — the waterfall and its ratios
// ---------------------------------------------------------------------------
const ECON_GRAINS = ["week", "drop", "offer", "location"];
const ECON_MERCH = ["week", "drop", "offer", "location", "product", "variant", "size", "category"];

m("gross_sales", "economics", "Gross sales", "EGP",
  "Σ unit_price × quantity before discounts, non-excluded orders created in the period",
  o(HIGHER, { sources: [T.order, T.line], grains: [...ECON_MERCH, "governorate"] }));
m("discounts", "economics", "Discounts", "EGP",
  "Σ discount_total (line discounts at merchandise grains), non-excluded orders created in the period",
  o(LOWER, { sources: [T.order, T.line], grains: ECON_MERCH }));
m("discount_rate", "economics", "Discount rate", "ratio",
  "discounts ÷ gross_sales",
  o(LOWER, { sources: [T.order, T.line], grains: ECON_MERCH }));
m("reversals_booked", "economics", "Reversals (as booked)", "EGP",
  "Σ fact_reversal.value by cancel_week — cancellations, which are RTO",
  o(LOWER, { sources: [T.reversal], grains: ["week"],
    treatment: "Booked on the cancel date. Shown only beside the attributed figure; weekly economics use reversals_attributed." }));
m("reversals_attributed", "economics", "Reversals (order week)", "EGP",
  "Σ fact_reversal.value by order_week",
  o(LOWER, { sources: [T.reversal, T.reversalLine], grains: [...ECON_MERCH, "governorate", "courier_zone", ...G.ads, "reason"],
    treatment: "Right-censored: recent order weeks gain reversals as late cancellations arrive; coverage states the resolved share." }));
m("net_sales", "economics", "Net sales (as booked)", "EGP",
  "gross_sales − discounts − reversals_booked",
  o(HIGHER, { sources: [T.order, T.line, T.reversal], grains: ["week"] }));
m("net_sales_attributed", "economics", "Net sales", "EGP",
  "gross_sales − discounts − reversals_attributed (reversals attributed to order week)",
  o(HIGHER, { sources: [T.order, T.line, T.reversal], grains: [...ECON_MERCH, "governorate"] }));
m("ordered_revenue", "economics", "Ordered revenue", "EGP",
  "Σ total of non-cancelled, non-excluded orders created in the period",
  o(HIGHER, { sources: [T.order], grains: ECON_GRAINS,
    treatment: "A claim on money, not money: COD orders are uncollected until delivered." }));
m("delivered_revenue", "economics", "Delivered revenue", "EGP",
  "Σ (total − shipping_charged − tax) over delivered orders created in the period",
  o(HIGHER, { sources: [T.order], grains: [...ECON_MERCH, "governorate"],
    treatment: "Right-censored: orders in transit are not delivered yet; coverage states the resolved share." }));
m("net_to_delivered_bridge", "economics", "Not yet delivered, shipping and tax", "EGP",
  "net_sales_attributed − delivered_revenue: undelivered orders plus pass-through shipping and tax",
  o(NONE, { sources: [T.order, T.line, T.reversal],
    treatment: "Bridges the waterfall's net sales to the delivered basis gross profit is computed on." }));
m("orders", "economics", "Orders", "count",
  "non-excluded orders created in the period",
  o(HIGHER, { sources: [T.order], grains: [...ECON_GRAINS, "governorate", "cohort", "segment"] }));
m("delivered_orders", "economics", "Delivered orders", "count",
  "non-excluded orders created in the period whose delivery_status is delivered",
  o(HIGHER, { sources: [T.order], grains: ECON_GRAINS }));
m("units_total", "economics", "Units", "count",
  "Σ units on non-excluded orders created in the period",
  o(HIGHER, { sources: [T.order, T.line], grains: ECON_MERCH }));
m("units_per_order", "economics", "Units per order", "decimal",
  "units_total ÷ orders",
  o(HIGHER, { sources: [T.order, T.line], grains: ECON_GRAINS }));
m("aov", "economics", "AOV", "EGP",
  "Σ order total ÷ orders, non-excluded orders created in the period",
  o(HIGHER, { sources: [T.order], grains: [...ECON_GRAINS, "cohort", "segment"] }));
m("new_customer_orders", "economics", "New-customer orders", "count",
  "orders with is_new_customer = 1",
  o(HIGHER, { sources: [T.order], grains: [...ECON_GRAINS, ...G.ads] }));
m("cogs_delivered", "economics", "COGS on delivered units", "EGP",
  "Σ unit_cogs_snapshot × quantity on lines of delivered orders",
  o(LOWER, { sources: [T.order, T.line, T.variant], grains: ECON_MERCH,
    treatment: "Cancelled units are not charged COGS where the stock is restocked — charging it double-counts. Where stock is not recovered it is charged. Units with no COGS snapshot are left out and reported through cogs_coverage_rate (partial state)." }));
m("cogs_coverage_rate", "economics", "COGS coverage", "ratio",
  "delivered units with a unit_cogs_snapshot ÷ delivered units",
  o(NONE, HIGHER, { sources: [T.line, T.variant], grains: ["week", "product"] }));
m("gross_profit", "economics", "Gross profit", "EGP",
  "delivered_revenue − cogs_delivered",
  o(HIGHER, { sources: [T.order, T.line, T.variant], grains: ECON_MERCH }));
m("gross_margin_rate", "economics", "Gross margin", "ratio",
  "gross_profit ÷ delivered_revenue",
  o(HIGHER, { sources: [T.order, T.line, T.variant], grains: ECON_MERCH }));
m("ad_spend", "economics", "Ad spend", "EGP",
  "Σ fact_ad_daily.spend, all platforms",
  o(NONE, { sources: [T.ad], grains: ["week", "drop", "offer", ...G.ads, ...G.creativeRollups, "product"],
    treatment: "Billed spend. The one platform figure allowed into Shopify-denominated ratios, because it is money paid, not a platform claim. At product grain: spend on ads promoting the product." }));
m("fulfilment_cost_outbound", "economics", "Fulfilment (outbound)", "EGP",
  "courier rate by zone × shipped orders created in the period",
  o(LOWER, MODELLED, { sources: [T.order, T.geo], grains: ["week", "drop", "governorate", "courier_zone"],
    treatment: "Modelled from the rate card until courier invoices are loaded; that change is a new definition version." }));
m("cod_collection_fees", "economics", "COD collection fees", "EGP",
  "COD fee rate × collected value on delivered COD orders",
  o(LOWER, MODELLED, { sources: [T.order], grains: ["week", "drop"],
    treatment: "Charged on collected value only. The fee rate is a stated assumption until confirmed against courier statements." }));
m("rto_shipping_waste", "economics", "RTO shipping waste", "EGP",
  "(outbound leg + return leg) on reversed orders that had dispatched",
  o(LOWER, MODELLED, { sources: [T.reversal, T.order, T.geo], grains: ["week", "drop", "governorate", "courier_zone"] }));
m("contribution_margin", "economics", "Contribution margin", "EGP",
  "gross_profit − ad_spend − fulfilment_cost_outbound − cod_collection_fees − rto_shipping_waste",
  o(HIGHER, MODELLED, { sources: [T.order, T.line, T.variant, T.ad, T.reversal, T.geo], grains: ["week", "drop", "offer"],
    treatment: "Modelled while any component is modelled (freight, COD fees). The objective function (§0): delivered contribution margin per drop." }));
m("contribution_per_order", "economics", "Contribution per order", "EGP",
  "contribution_margin ÷ delivered_orders",
  o(HIGHER, MODELLED, { sources: [T.order, T.line, T.variant, T.ad, T.reversal, T.geo], grains: ["week", "drop", "offer"] }));
m("blended_mer", "economics", "Blended MER", "multiple",
  "net_sales_attributed ÷ ad_spend",
  o(HIGHER, { sources: [T.order, T.line, T.reversal, T.ad], grains: ["week", "drop"],
    treatment: "Always rendered beside delivered_mer, with mer_gap as its own figure." }));
m("delivered_mer", "economics", "Delivered MER", "multiple",
  "delivered_revenue ÷ ad_spend",
  o(HIGHER, { sources: [T.order, T.ad], grains: ["week", "drop"] }));
m("mer_gap", "economics", "MER gap", "multiple",
  "blended_mer − delivered_mer",
  o(LOWER, { sources: [T.order, T.line, T.reversal, T.ad], grains: ["week", "drop"] }));
m("blended_cac", "economics", "Blended CAC", "EGP",
  "ad_spend ÷ new_customer_orders",
  o(LOWER, { sources: [T.order, T.ad], grains: ["week", "drop", "offer"] }));
m("contribution_cac_ratio", "economics", "Contribution ÷ CAC", "multiple",
  "contribution_per_order ÷ blended_cac",
  o(HIGHER, MODELLED, { sources: [T.order, T.line, T.variant, T.ad, T.reversal, T.geo], grains: ["week", "drop", "offer"],
    treatment: "Below 1 means incremental orders lose money — the most important threshold in the system; it must be impossible to miss." }));
m("bundle_attach_rate", "economics", "Bundle attach rate", "ratio",
  "orders containing a bundle line ÷ orders",
  o(HIGHER, { sources: [T.order, T.line], grains: ECON_GRAINS }));
m("true_leakage", "economics", "True leakage", "ratio",
  "(discounts + reversals_attributed) ÷ gross_sales",
  o(LOWER, { sources: [T.order, T.line, T.reversal], grains: ["week", "drop", "offer"] }));

// Waterfall steps as a share of gross — "each step an EGP figure and a share of gross".
const SHARE = (key, label, formula, extra = {}) =>
  m(key, "economics", label, "ratio", formula, o({ sources: [T.order, T.line], grains: ["week", "drop"] }, extra));
SHARE("discounts_share_of_gross", "Discounts, share of gross", "discounts ÷ gross_sales", LOWER);
SHARE("reversals_share_of_gross", "Reversals, share of gross", "reversals_attributed ÷ gross_sales", o(LOWER, { sources: [T.order, T.line, T.reversal] }));
SHARE("net_sales_share_of_gross", "Net sales, share of gross", "net_sales_attributed ÷ gross_sales", o(HIGHER, { sources: [T.order, T.line, T.reversal] }));
SHARE("cogs_share_of_gross", "COGS, share of gross", "cogs_delivered ÷ gross_sales", o(LOWER, { sources: [T.order, T.line, T.variant] }));
SHARE("gross_profit_share_of_gross", "Gross profit, share of gross", "gross_profit ÷ gross_sales", o(HIGHER, { sources: [T.order, T.line, T.variant] }));
SHARE("ad_spend_share_of_gross", "Ad spend, share of gross", "ad_spend ÷ gross_sales", o(LOWER, { sources: [T.order, T.line, T.ad] }));
SHARE("fulfilment_share_of_gross", "Fulfilment, share of gross", "fulfilment_cost_outbound ÷ gross_sales", o(LOWER, MODELLED, { sources: [T.order, T.line, T.geo] }));
SHARE("cod_fees_share_of_gross", "COD fees, share of gross", "cod_collection_fees ÷ gross_sales", o(LOWER, MODELLED));
SHARE("rto_waste_share_of_gross", "RTO waste, share of gross", "rto_shipping_waste ÷ gross_sales", o(LOWER, MODELLED, { sources: [T.order, T.line, T.reversal, T.geo] }));
SHARE("contribution_share_of_gross", "Contribution, share of gross", "contribution_margin ÷ gross_sales", o(HIGHER, MODELLED, { sources: [T.order, T.line, T.variant, T.ad, T.reversal, T.geo] }));

// ---------------------------------------------------------------------------
// §5 Acquisition
// ---------------------------------------------------------------------------
const ACQ = ["week", "drop", ...G.ads];
const ACQ_CREATIVE = [...ACQ, ...G.creativeRollups];

m("impressions", "acquisition", "Impressions", "count", "Σ fact_ad_daily.impressions",
  o(NONE, PLATFORM, { sources: [T.ad], grains: ACQ_CREATIVE }));
m("reach", "acquisition", "Reach", "count", "platform reach fetched at the grain itself",
  o(NONE, PLATFORM, { sources: [T.adset], grains: ["platform", "campaign", "adset"],
    treatment: "Never summed across ads or adsets: reach does not add. Each grain is fetched at that grain." }));
m("frequency", "acquisition", "Frequency", "decimal", "impressions ÷ reach at the grain",
  o(NONE, PLATFORM, { sources: [T.ad, T.adset], grains: ["platform", "campaign", "adset", "ad"] }));
m("cpm", "acquisition", "CPM", "EGP", "ad_spend ÷ impressions × 1000",
  o(LOWER, PLATFORM, { sources: [T.ad], grains: ACQ_CREATIVE }));
m("outbound_ctr", "acquisition", "Outbound CTR", "ratio", "clicks_outbound ÷ impressions",
  o(HIGHER, PLATFORM, { sources: [T.ad], grains: ACQ_CREATIVE, basis_label: "Outbound clicks" }));
m("cpc_outbound", "acquisition", "CPC (outbound)", "EGP", "ad_spend ÷ clicks_outbound",
  o(LOWER, PLATFORM, { sources: [T.ad], grains: ACQ_CREATIVE, basis_label: "Outbound clicks" }));
m("landing_page_views", "acquisition", "Landing page views", "count", "Σ fact_ad_daily.landing_page_views",
  o(HIGHER, PLATFORM, { sources: [T.ad], grains: ACQ_CREATIVE }));
m("platform_atc", "acquisition", "Platform add-to-cart", "count", "Σ fact_ad_daily.platform_atc",
  o(NONE, PLATFORM, { sources: [T.ad], grains: ACQ_CREATIVE }));
m("platform_ic", "acquisition", "Platform initiate checkout", "count", "Σ fact_ad_daily.platform_ic",
  o(NONE, PLATFORM, { sources: [T.ad], grains: ACQ_CREATIVE }));
m("platform_purchases", "acquisition", "Platform purchases", "count", "Σ fact_ad_daily.platform_purchases",
  o(NONE, PLATFORM, { sources: [T.ad], grains: ACQ_CREATIVE,
    treatment: "Raw count renders beside every conversion-denominated rate." }));
m("platform_revenue", "acquisition", "Platform revenue", "EGP", "Σ fact_ad_daily.platform_revenue",
  o(NONE, PLATFORM, { sources: [T.ad], grains: ACQ_CREATIVE,
    treatment: "Directional. Never summed with Shopify revenue under any aggregation." }));
m("platform_roas", "acquisition", "Platform ROAS", "multiple", "platform_revenue ÷ ad_spend",
  o(NONE, PLATFORM, { sources: [T.ad], grains: ACQ_CREATIVE,
    treatment: "Never ranks ads at ad level; ranking happens at adset or campaign level, or above a stated minimum-conversion threshold." }));
m("cpa_platform", "acquisition", "CPA (platform)", "EGP", "ad_spend ÷ platform_purchases",
  o(LOWER, PLATFORM, { sources: [T.ad], grains: ACQ_CREATIVE }));
m("attributed_orders", "acquisition", "Attributed orders", "count",
  "Shopify orders whose attributed_ad_id resolves to the entity (click id or UTM)",
  o(HIGHER, { sources: [T.order, T.dimAd], grains: ACQ_CREATIVE, basis_label: "Shopify orders, click/UTM attribution" }));
m("attributed_net_sales", "acquisition", "Attributed net sales", "EGP",
  "net_sales_attributed of orders attributed to the entity",
  o(HIGHER, { sources: [T.order, T.line, T.reversal, T.dimAd], grains: ACQ_CREATIVE, basis_label: "Shopify orders, click/UTM attribution" }));
m("attribution_coverage", "acquisition", "Attribution coverage", "ratio",
  "orders carrying a click id or UTM ad id ÷ orders",
  o(NONE, HIGHER, { sources: [T.order] }));
m("paid_share_of_revenue", "acquisition", "Paid share of revenue", "ratio",
  "net sales of paid-attributed orders ÷ net_sales_attributed",
  o({ sources: [T.order, T.line, T.reversal],
    treatment: "A floor, not a total, while attribution_coverage is below 1." }));
m("new_customer_cac", "acquisition", "New-customer CAC", "EGP",
  "ad_spend ÷ new-customer orders attributed to the entity",
  o(LOWER, { sources: [T.order, T.ad, T.dimAd], grains: ACQ,
    treatment: "The only CAC that means anything. At week grain it is a ceiling while attribution is partial." }));
m("spend_pace", "acquisition", "Spend pace", "ratio",
  "ad spend since drop_date ÷ planned drop-window budget (dim_drop.planned_ad_budget)",
  o(NONE, { sources: [T.ad, T.drop], grains: ["week", "drop"] }));
m("incrementality_proxy", "acquisition", "Incrementality proxy", "EGP",
  "net sales at constant spend, drop-day normalised",
  o(MODELLED, { sources: [T.order, T.line, T.reversal, T.ad, T.drop] }));
// Demand signals — buying demand versus creating demand.
m("direct_sessions_ga4", "acquisition", "Direct sessions", "count", "GA4 sessions with channel group Direct",
  o(HIGHER, GA4_SESSIONS, { sources: [T.ga4] }));
m("organic_sessions_ga4", "acquisition", "Organic sessions", "count", "GA4 sessions with organic search or organic social channel groups",
  o(HIGHER, GA4_SESSIONS, { sources: [T.ga4] }));
m("branded_search_clicks", "acquisition", "Branded search", "count", "search clicks on brand queries",
  o(HIGHER, PLATFORM, { sources: [], treatment: "No source connected (Search Console). Missing until one is." }));
m("returning_visitor_share_ga4", "acquisition", "Returning visitor share", "ratio", "GA4 returning-user sessions ÷ GA4 sessions",
  o(HIGHER, GA4_SESSIONS, { sources: [T.ga4] }));
m("organic_direct_orders", "acquisition", "Organic and direct orders", "count",
  "orders with no paid attribution whose referrer is direct or organic",
  o(HIGHER, { sources: [T.order] }));
m("instagram_follower_growth", "acquisition", "Instagram follower growth", "count", "followers at period end − followers at period start",
  o(HIGHER, PLATFORM, { sources: [], treatment: "No source connected. Missing until one is." }));
m("instagram_engagement_rate", "acquisition", "Instagram engagement rate", "ratio", "engagements ÷ reach on organic posts",
  o(HIGHER, PLATFORM, { sources: [], treatment: "No source connected. Missing until one is." }));
m("organic_video_views", "acquisition", "Organic video views", "count", "views on organic posts",
  o(HIGHER, PLATFORM, { sources: [], treatment: "No source connected. Missing until one is." }));
m("assisted_channel_share", "acquisition", "Assisted channel share", "ratio",
  "conversions with a non-last-click channel in the path ÷ conversions",
  o(MODELLED, GA4_SESSIONS, { sources: [T.ga4], treatment: "Attribution-model output, not a count." }));

// ---------------------------------------------------------------------------
// §6 Creative Intelligence
// ---------------------------------------------------------------------------
const CREATIVE = ["week", "campaign", "adset", "ad", ...G.creativeRollups, "product"];

m("hook_rate", "creative", "Hook rate", "ratio", "video_plays_3s ÷ impressions",
  o(HIGHER, PLATFORM, { sources: [T.ad], grains: CREATIVE }));
m("hold_rate", "creative", "Hold rate", "ratio", "thruplays ÷ video_plays_3s",
  o(HIGHER, PLATFORM, { sources: [T.ad], grains: CREATIVE }));
m("completion_rate", "creative", "Completion", "ratio", "video_p100 ÷ video_plays_3s",
  o(HIGHER, PLATFORM, { sources: [T.ad], grains: CREATIVE }));
m("land_rate", "creative", "Land rate", "ratio", "landing_page_views ÷ clicks_outbound",
  o(HIGHER, PLATFORM, { sources: [T.ad], grains: CREATIVE, basis_label: "Outbound clicks",
    treatment: "Stated on outbound clicks only; never switched to link clicks mid-table." }));
m("days_active", "creative", "Days active", "days", "days with delivery since the ad first spent",
  o(NONE, { sources: [T.ad], grains: ["ad"] }));
m("fatigue_hook_slope", "creative", "Hook-rate fatigue slope", "decimal",
  "slope of daily hook_rate against days_active and frequency",
  o(NONE, MODELLED, { sources: [T.ad], grains: ["ad"],
    treatment: "Fatigue is a slope; the decision is when the slope turns, not when a number crosses a picked threshold." }));
m("fatigue_ctr_slope", "creative", "CTR fatigue slope", "decimal",
  "slope of daily outbound_ctr against days_active and frequency",
  o(NONE, MODELLED, { sources: [T.ad], grains: ["ad"] }));
m("creative_tagging_coverage", "creative", "Tagging coverage", "ratio",
  "spend on ads with angle, hook_type, format, creator, offer, concept and promoted product all set ÷ ad_spend",
  o(NONE, HIGHER, { sources: [T.ad, T.dimAd], treatment: "An untagged share is a state, not a silent omission." }));
m("ad_status_coverage", "creative", "Ad status coverage", "ratio",
  "ads with delivery in the period whose effective_status is known ÷ ads with delivery",
  o(NONE, HIGHER, { sources: [T.ad, T.dimAd],
    treatment: "Without status, exposure counts include paused and archived ads." }));
m("promoted_close_rate", "creative", "Promoted-product close rate", "ratio",
  "attributed orders containing the promoted product ÷ attributed orders",
  o({ sources: [T.order, T.line, T.dimAd], grains: ["week", "ad", "concept", "product"],
    treatment: "High = closer. Low with high traffic = acquisition engine: it pulls traffic that converts on something else." }));

// ---------------------------------------------------------------------------
// §7 Funnel and CRO — GA4 and Shopify series, never mixed, each labelled
// ---------------------------------------------------------------------------
const GA4_GRAINS = ["week", "breakdown"];

m("sessions_ga4", "funnel", "Sessions (GA4)", "count", "Σ sessions",
  o(HIGHER, GA4_SESSIONS, { sources: [T.ga4], grains: GA4_GRAINS }));
m("engaged_sessions_ga4", "funnel", "Engaged sessions (GA4)", "count", "Σ engaged_sessions",
  o(HIGHER, GA4_SESSIONS, { sources: [T.ga4], grains: GA4_GRAINS }));
m("engagement_rate_ga4", "funnel", "Engagement rate (GA4)", "ratio", "engaged_sessions ÷ sessions",
  o(HIGHER, GA4_SESSIONS, { sources: [T.ga4], grains: GA4_GRAINS }));
m("avg_engagement_time_ga4", "funnel", "Avg engagement time (GA4)", "seconds", "engagement_time_sec ÷ sessions",
  o(HIGHER, GA4_SESSIONS, { sources: [T.ga4], grains: GA4_GRAINS }));
m("view_item_ga4", "funnel", "View item (GA4)", "count", "Σ view_item events",
  o(HIGHER, GA4_EVENTS, { sources: [T.ga4], grains: GA4_GRAINS }));
m("add_to_cart_ga4", "funnel", "Add to cart (GA4)", "count", "Σ add_to_cart events",
  o(HIGHER, GA4_EVENTS, { sources: [T.ga4], grains: GA4_GRAINS }));
m("begin_checkout_ga4", "funnel", "Begin checkout (GA4)", "count", "Σ begin_checkout events",
  o(HIGHER, GA4_EVENTS, { sources: [T.ga4], grains: GA4_GRAINS }));
m("add_payment_info_ga4", "funnel", "Add payment info (GA4)", "count", "Σ add_payment_info events",
  o(HIGHER, GA4_EVENTS, { sources: [T.ga4], grains: GA4_GRAINS }));
m("purchase_ga4", "funnel", "Purchase (GA4)", "count", "Σ purchase events",
  o(HIGHER, GA4_EVENTS, { sources: [T.ga4], grains: GA4_GRAINS }));
m("view_item_rate_ga4", "funnel", "View item per session (GA4)", "ratio", "view_item events ÷ GA4 sessions",
  o(HIGHER, GA4_SESSIONS, { sources: [T.ga4], grains: GA4_GRAINS, basis_label: "GA4 events per GA4 session" }));
m("view_to_atc_rate_ga4", "funnel", "View → ATC (GA4)", "ratio", "add_to_cart events ÷ view_item events",
  o(HIGHER, GA4_EVENTS, { sources: [T.ga4], grains: GA4_GRAINS }));
m("atc_rate_ga4", "funnel", "ATC rate (GA4)", "ratio", "add_to_cart events ÷ GA4 sessions",
  o(HIGHER, GA4_SESSIONS, { sources: [T.ga4], grains: GA4_GRAINS, basis_label: "GA4 events per GA4 session" }));
m("atc_to_checkout_rate_ga4", "funnel", "ATC → checkout (GA4)", "ratio", "begin_checkout events ÷ add_to_cart events",
  o(HIGHER, GA4_EVENTS, { sources: [T.ga4], grains: GA4_GRAINS }));
m("checkout_to_payment_rate_ga4", "funnel", "Checkout → payment info (GA4)", "ratio", "add_payment_info events ÷ begin_checkout events",
  o(HIGHER, GA4_EVENTS, { sources: [T.ga4], grains: GA4_GRAINS }));
m("payment_to_purchase_rate_ga4", "funnel", "Payment info → purchase (GA4)", "ratio", "purchase events ÷ add_payment_info events",
  o(HIGHER, GA4_EVENTS, { sources: [T.ga4], grains: GA4_GRAINS }));
m("cvr_ga4", "funnel", "CVR (GA4)", "ratio", "purchase events ÷ GA4 sessions",
  o(HIGHER, GA4_SESSIONS, { sources: [T.ga4], grains: GA4_GRAINS }));
m("unattributed_session_share_ga4", "funnel", "Unattributed sessions (GA4)", "ratio",
  "GA4 sessions with source (not set) or channel Unassigned ÷ GA4 sessions",
  o(NONE, LOWER, GA4_SESSIONS, { sources: [T.ga4] }));
m("ga4_other_row_share", "funnel", "GA4 (other) row share", "ratio",
  "sessions in GA4 cardinality-truncation (other) rows ÷ sessions",
  o(NONE, LOWER, GA4_SESSIONS, { sources: [T.ga4], grains: GA4_GRAINS,
    treatment: "Truncation rows surface as such rather than silently distorting a segment." }));

const SHOP_GRAINS = ["week", "breakdown", "offer"];
m("sessions_shopify", "funnel", "Sessions (Shopify)", "count", "Σ Shopify sessions",
  o(HIGHER, SHOPIFY_SESSIONS, { sources: [T.sessions], grains: SHOP_GRAINS }));
m("sessions_with_cart_add_shopify", "funnel", "Sessions with add to cart (Shopify)", "count", "Σ sessions_with_cart_add",
  o(HIGHER, SHOPIFY_SESSIONS, { sources: [T.sessions], grains: SHOP_GRAINS }));
m("sessions_reached_checkout_shopify", "funnel", "Sessions reaching checkout (Shopify)", "count", "Σ sessions_reached_checkout",
  o(HIGHER, SHOPIFY_SESSIONS, { sources: [T.sessions], grains: SHOP_GRAINS }));
m("sessions_converted_shopify", "funnel", "Sessions converted (Shopify)", "count", "Σ sessions_converted",
  o(HIGHER, SHOPIFY_SESSIONS, { sources: [T.sessions], grains: SHOP_GRAINS }));
m("atc_rate_shopify", "funnel", "ATC rate", "ratio", "sessions_with_cart_add ÷ Shopify sessions",
  o(HIGHER, SHOPIFY_SESSIONS, { sources: [T.sessions], grains: SHOP_GRAINS }));
m("checkout_rate_shopify", "funnel", "Checkout rate", "ratio", "sessions_reached_checkout ÷ Shopify sessions",
  o(HIGHER, SHOPIFY_SESSIONS, { sources: [T.sessions], grains: SHOP_GRAINS }));
m("checkout_completion_rate_shopify", "funnel", "Checkout completion", "ratio", "sessions_converted ÷ sessions_reached_checkout",
  o(HIGHER, SHOPIFY_SESSIONS, { sources: [T.sessions], grains: SHOP_GRAINS }));
m("cvr_shopify", "funnel", "CVR", "ratio", "sessions_converted ÷ Shopify sessions",
  o(HIGHER, SHOPIFY_SESSIONS, { sources: [T.sessions], grains: SHOP_GRAINS }));
m("purchase_to_delivered_rate", "funnel", "Purchase → delivered", "ratio",
  "delivered orders ÷ non-excluded orders created in the period",
  o(HIGHER, { sources: [T.order], grains: ["week", "governorate", "courier_zone", "offer"], basis_label: "Shopify orders",
    treatment: "Right-censored: in-transit orders count as not delivered until they resolve; coverage states the resolved share." }));
m("funnel_largest_loss_egp", "funnel", "Largest single funnel loss", "EGP",
  "EGP value of the rung with the largest drop-off against the store's own distribution",
  o(NONE, MODELLED, { sources: [T.ga4, T.sessions, T.order] }));
m("oos_pdp_sessions_ga4", "funnel", "Sessions landing on out-of-stock PDPs", "count",
  "GA4 sessions whose landing page is a product with no variant in stock that day",
  o(LOWER, GA4_SESSIONS, { sources: [T.ga4, T.inventory, T.product] }));
m("oos_atc_attempts", "funnel", "ATC attempts on out-of-stock variants", "count",
  "add-to-cart attempts on variants with qty_on_hand = 0",
  o(LOWER, { sources: [], treatment: "Capture requirement: the storefront disables add to cart on sold-out variants, so no standard event records the attempt. Needs a custom event." }));
m("oos_lost_revenue", "funnel", "Revenue lost to stock-outs", "EGP",
  "oos sessions × the product's own CVR × AOV",
  o(NONE, LOWER, MODELLED, { sources: [T.ga4, T.inventory, T.order] }));

// ---------------------------------------------------------------------------
// §8 Product and Inventory
// ---------------------------------------------------------------------------
const MERCH = ["week", "product", "variant", "size", "category"];

m("orders_containing", "product", "Orders containing", "count", "orders with at least one line of the entity",
  o(HIGHER, { sources: [T.order, T.line], grains: ["product", "variant", "size", "category"] }));
m("landing_sessions_ga4", "product", "Sessions landing on PDP (GA4)", "count", "GA4 sessions whose landing page is the product page",
  o(HIGHER, GA4_SESSIONS, { sources: [T.ga4], grains: ["product"] }));
m("pdp_views_ga4", "product", "Item views (GA4)", "count", "Σ items_viewed",
  o(HIGHER, GA4_ITEMS, { sources: [T.ga4Item], grains: ["product", "variant", "category"] }));
m("product_atc_rate_ga4", "product", "Item ATC rate (GA4)", "ratio", "items_added_to_cart ÷ items_viewed",
  o(HIGHER, GA4_ITEMS, { sources: [T.ga4Item], grains: ["product", "variant", "category"] }));
m("product_cvr_ga4", "product", "Item CVR (GA4)", "ratio", "items_purchased ÷ items_viewed",
  o(HIGHER, GA4_ITEMS, { sources: [T.ga4Item], grains: ["product", "variant", "category"] }));
m("unit_cogs", "product", "Unit COGS", "EGP", "current unit_cogs_snapshot",
  o(NONE, { sources: [T.variant], grains: ["product", "variant"] }));
m("reversal_rate_units", "product", "Reversal rate (units)", "ratio",
  "reversed units from cancelled orders' line items ÷ units ordered",
  o(LOWER, { sources: [T.reversalLine, T.line], grains: MERCH,
    treatment: "From line items, not courier outcomes, which miss cancellations that never shipped. Never merged with genuine returns." }));
m("genuine_return_rate_units", "product", "Return rate (units)", "ratio",
  "refunded units (fact_refund_line) ÷ delivered units",
  o(LOWER, { sources: [T.refundLine, T.line, T.order], grains: MERCH }));
m("exchange_rate_units", "product", "Exchange rate (units)", "ratio",
  "exchanged units (fact_exchange) ÷ delivered units",
  o(LOWER, { sources: [T.exchange, T.line, T.order], grains: MERCH }));
m("inventory_on_hand", "product", "Inventory on hand", "count", "qty_on_hand at period end (fact_inventory_daily)",
  o(NONE, { sources: [T.inventory], grains: ["product", "variant", "size", "category", "location"] }));
m("days_of_cover", "product", "Days of cover", "days", "inventory_on_hand ÷ units per day over the trailing 7 days",
  o(NONE, { sources: [T.inventory, T.line], grains: ["product", "variant", "size"] }));
m("sell_through_vs_commitment", "product", "Sell-through against commitment", "ratio",
  "units sold since drop_date ÷ units committed to the drop",
  o(HIGHER, { sources: [T.line, T.drop, T.inventory], grains: ["product", "variant", "size", "drop"] }));
m("full_price_sell_through", "product", "Full-price sell-through", "ratio",
  "units sold at full price since drop_date ÷ units committed",
  o(HIGHER, { sources: [T.line, T.drop, T.inventory], grains: ["product", "variant"] }));
m("discounted_sell_through", "product", "Discounted sell-through", "ratio",
  "units sold at a discount since drop_date ÷ units committed",
  o({ sources: [T.line, T.drop, T.inventory], grains: ["product", "variant"] }));
m("velocity_vs_trailing", "product", "Velocity against own trailing weeks", "ratio",
  "units per day in the period ÷ own units per day over the trailing 4 weeks",
  o(NONE, { sources: [T.line], grains: ["product", "variant"],
    treatment: "Calendar-trailing, so it inherits the drop cycle; read beside days_since_drop_at_launch." }));
m("days_since_drop_at_launch", "product", "Drop-day at launch", "days", "launched_at − drop_date of the product's drop",
  o(NONE, { sources: [T.product, T.drop], grains: ["product"] }));
m("bundle_participation_rate", "product", "Bundle participation", "ratio", "units sold within bundles ÷ units sold",
  o({ sources: [T.line], grains: ["product", "variant"] }));
m("size_units_share", "product", "Size share of units", "ratio", "units of the size ÷ units of the product",
  o(NONE, { sources: [T.line, T.variant], grains: ["size", "variant"],
    treatment: "The size curve. A size selling out first is the reorder signal; a size never moving is the buy-plan error." }));
m("low_cover_paid_spend", "product", "Paid spend on low-cover products", "EGP",
  "ad spend on ads promoting a product whose days_of_cover is below the store's own low-cover percentile",
  o(NONE, LOWER, { sources: [T.ad, T.dimAd, T.inventory], grains: ["week", "product"] }));
// Physical locations: partner stores (weekly report imports) and the own POS store.
m("location_units_sold", "product", "Units sold at location", "count",
  "units sold in the location's reported period (partner report) or POS orders (own store)",
  o(HIGHER, { sources: [T.locationSku, T.order, T.line], grains: ["location", "product", "variant"] }));
m("location_stock_on_hand", "product", "Stock at location", "count", "stock on hand at the end of the location's reported period",
  o(NONE, { sources: [T.locationSku, T.inventory], grains: ["location", "product", "variant"] }));
m("online_share_of_units", "product", "Online share of units", "ratio",
  "online units ÷ units across all locations, same period",
  o(NONE, { sources: [T.line, T.locationSku], grains: ["product", "variant", "category"],
    treatment: "What sells online and not physically, and vice versa. Partner periods are aligned to the week they fall in; mismatched periods make the comparison partial." }));

// ---------------------------------------------------------------------------
// §9 Offer and Pricing
// ---------------------------------------------------------------------------
m("full_price_revenue", "offer", "Full-price revenue", "EGP", "net sales of lines sold at full price",
  o(HIGHER, { sources: [T.line, T.order, T.reversal], grains: ["week", "offer", "product"] }));
m("discounted_revenue", "offer", "Discounted revenue", "EGP", "net sales of lines sold with any discount",
  o({ sources: [T.line, T.order, T.reversal], grains: ["week", "offer", "product"] }));
m("discount_depth_nominal", "offer", "Discount depth (nominal)", "ratio", "the offer's stated depth",
  o(NONE, { sources: [T.offer], grains: ["offer"] }));
m("discount_depth_realised", "offer", "Discount depth (realised)", "ratio", "discounts ÷ gross_sales on lines the offer touched",
  o({ sources: [T.line, T.order, T.offer], grains: ["week", "offer"] }));
m("returning_customer_share", "offer", "Returning-customer share", "ratio", "orders with is_new_customer = 0 ÷ orders",
  o({ sources: [T.order], grains: ["week", "offer", "drop"] }));
m("revenue_per_customer", "offer", "Revenue per customer", "EGP", "net_sales_attributed ÷ distinct customers",
  o(HIGHER, { sources: [T.order, T.line, T.reversal], grains: ["week", "offer", "cohort", "segment"] }));
m("velocity_in_window", "offer", "Sell-through velocity in window", "decimal", "units per day inside the offer window",
  o(NONE, { sources: [T.line, T.offer], grains: ["offer", "product"] }));
m("velocity_outside_window", "offer", "Sell-through velocity outside window", "decimal",
  "units per day in an equal-length window outside the offer, drop-day aligned",
  o(NONE, { sources: [T.line, T.offer], grains: ["offer", "product"] }));
m("offer_pull_forward_share", "offer", "Pulled-forward share", "ratio",
  "in-window units that displaced full-price purchases that would have happened anyway ÷ in-window units",
  o(NONE, MODELLED, { sources: [T.line, T.offer, T.drop], grains: ["offer"],
    treatment: "The question is whether the offer raised contribution, and whether the demand was incremental." }));
m("full_price_repeat_rate", "offer", "Full-price repeat rate", "ratio",
  "cohort customers with at least one later full-price order ÷ cohort size",
  o(HIGHER, { sources: [T.customer, T.order, T.line], grains: ["cohort", "offer"] }));
m("training_effect_gap", "offer", "Training effect", "ratio",
  "full_price_repeat_rate of customers acquired inside offer windows − outside them",
  o(NONE, { sources: [T.customer, T.order, T.line, T.offer], grains: ["week", "offer"],
    treatment: "The measurable cost of a discounting regime, tracked by acquisition_offer_id." }));

// ---------------------------------------------------------------------------
// §10 Customer
// ---------------------------------------------------------------------------
const COHORT = ["cohort"];
m("new_customer_share", "customer", "New-customer share", "ratio", "new_customer_orders ÷ orders",
  o({ sources: [T.order], grains: ["week", "drop", "offer", ...G.ads] }));
m("cohort_size", "customer", "Cohort size", "count", "customers whose first order falls in the cohort",
  o(NONE, { sources: [T.customer], grains: COHORT }));
m("repeat_rate_30d", "customer", "Repeat rate, 30 days", "ratio", "cohort customers with a second order within 30 days ÷ cohort size",
  o(NONE, HIGHER, { sources: [T.customer, T.order], grains: COHORT, treatment: "Right-censored: partial until 30 days have elapsed for every customer in the cohort." }));
m("repeat_rate_60d", "customer", "Repeat rate, 60 days", "ratio", "cohort customers with a second order within 60 days ÷ cohort size",
  o(NONE, HIGHER, { sources: [T.customer, T.order], grains: COHORT, treatment: "Right-censored until 60 days have elapsed." }));
m("repeat_rate_90d", "customer", "Repeat rate, 90 days", "ratio", "cohort customers with a second order within 90 days ÷ cohort size",
  o(NONE, HIGHER, { sources: [T.customer, T.order], grains: COHORT, treatment: "Right-censored until 90 days have elapsed." }));
m("repeat_rate_180d", "customer", "Repeat rate, 180 days", "ratio", "cohort customers with a second order within 180 days ÷ cohort size",
  o(NONE, HIGHER, { sources: [T.customer, T.order], grains: COHORT, treatment: "Right-censored until 180 days have elapsed." }));
m("orders_per_customer", "customer", "Orders per customer", "decimal", "orders ÷ distinct customers",
  o(NONE, HIGHER, { sources: [T.customer, T.order], grains: ["cohort", "segment"] }));
m("time_to_second_purchase", "customer", "Time to second purchase", "days", "median days from first to second order",
  o(NONE, LOWER, { sources: [T.customer, T.order], grains: COHORT }));
m("ltv_to_date", "customer", "LTV to date", "EGP", "net_sales_attributed per cohort customer, to date",
  o(NONE, HIGHER, { sources: [T.customer, T.order, T.line, T.reversal], grains: ["cohort", "segment"],
    treatment: "Measured to date, never projected. A projected LTV is a separate modelled metric." }));
m("discount_dependence", "customer", "Discount dependence", "ratio", "discounted orders ÷ orders, per customer, averaged over the cohort",
  o(NONE, LOWER, { sources: [T.customer, T.order], grains: ["cohort", "segment"] }));
m("segment_customers", "customer", "Customers in segment", "count", "customers matching the segment rule at period end",
  o(NONE, { sources: [T.customer, T.order], grains: ["segment"],
    treatment: "Segments: new, returning, vip, lapsed, one_time, discount_dependent, repeat_refuser. Each rule is stated in code; a rule change is a new definition version." }));
m("new_vs_returning_cvr_gap", "customer", "Returning − new CVR", "ratio", "cvr_ga4 of returning users − cvr_ga4 of new users",
  o(GA4_SESSIONS, { sources: [T.ga4], treatment: "Sizes the owned-channel opportunity directly." }));

// ---------------------------------------------------------------------------
// §11 Post-purchase — three systems: RTO, refunds, exchanges. Never merged.
// ---------------------------------------------------------------------------
const RTO = ["week", "drop", "governorate", "courier_zone", "courier", "product", "size", ...G.ads];

m("rto_orders", "post_purchase", "RTO orders", "count", "reversed orders, by order week",
  o(LOWER, { sources: [T.reversal], grains: RTO }));
m("rto_units", "post_purchase", "RTO units", "count", "Σ units on reversed orders, by order week",
  o(LOWER, { sources: [T.reversal, T.reversalLine], grains: RTO }));
m("reversal_rate", "post_purchase", "Reversal rate", "ratio", "reversed orders ÷ orders, by order week",
  o(LOWER, { sources: [T.reversal, T.order], grains: [...RTO, "offer", "segment"], basis_label: "Orders, order week",
    treatment: "Cancellations are RTO. Right-censored: recent weeks rise as late cancellations arrive; coverage states the resolved share." }));
m("reversal_value_rate", "post_purchase", "Reversal rate (value)", "ratio", "reversals_attributed ÷ gross_sales",
  o(LOWER, { sources: [T.reversal, T.order, T.line], grains: ["week", "drop", "governorate", "product"] }));
m("post_dispatch_reversal_share", "post_purchase", "Post-dispatch share of reversals", "ratio",
  "reversal value cancelled after the first fulfilment ÷ reversal value",
  o(LOWER, { sources: [T.reversal], grains: ["week", "drop", "governorate", "courier_zone"],
    treatment: "From fulfilment state at cancellation. Orders with unknown state are left out and reported through coverage." }));
m("rto_rate_cod", "post_purchase", "Reversal rate, COD", "ratio", "reversed COD orders ÷ COD orders, by order week",
  o(LOWER, { sources: [T.reversal, T.order], grains: ["week", "drop", "governorate"] }));
m("rto_rate_prepaid", "post_purchase", "Reversal rate, prepaid", "ratio", "reversed prepaid orders ÷ prepaid orders, by order week",
  o(LOWER, { sources: [T.reversal, T.order], grains: ["week", "drop", "governorate"] }));
m("delivery_attempts_avg", "post_purchase", "Delivery attempts", "decimal", "mean attempt_count on shipped orders",
  o(LOWER, { sources: [T.order], grains: ["week", "governorate", "courier_zone", "courier"] }));
m("courier_sla_days", "post_purchase", "Courier SLA", "days", "median days from first fulfilment to delivery",
  o(LOWER, { sources: [T.order], grains: ["week", "courier_zone", "courier"] }));
m("rto_cost_total", "post_purchase", "RTO cost", "EGP", "ad spend attributed to reversed orders + outbound leg + return leg",
  o(LOWER, MODELLED, { sources: [T.reversal, T.order, T.ad, T.geo], grains: ["week", "drop", "governorate", "product", ...G.ads] }));
m("rto_cost_per_reversed_order", "post_purchase", "RTO cost per reversed order", "EGP", "rto_cost_total ÷ rto_orders",
  o(LOWER, MODELLED, { sources: [T.reversal, T.order, T.ad, T.geo], grains: ["week", "drop"] }));
m("reason_classified_share", "post_purchase", "Reasons classified", "ratio",
  "reversal value with a reason_code ÷ reversal value",
  o(NONE, HIGHER, { sources: [T.reversal],
    treatment: "Where the platform's cancel reason carries no signal this is a capture requirement (courier failure reasons or a process change), not a computation." }));
m("rto_reason_share", "post_purchase", "RTO reason share", "ratio", "reversal value with the reason ÷ reversal value",
  o(NONE, { sources: [T.reversal], grains: ["reason"] }));
// Refunds
m("refund_value", "post_purchase", "Refunds", "EGP", "Σ genuine Shopify refund amounts, by refund week",
  o(LOWER, { sources: [T.refund], grains: ["week", "product", "size", "governorate", "reason"],
    treatment: "Genuine Refund objects only. Never merged with reversals at any layer." }));
m("refund_orders", "post_purchase", "Refunded orders", "count", "orders with a genuine refund in the period",
  o(LOWER, { sources: [T.refund], grains: ["week", "governorate"] }));
m("refund_units", "post_purchase", "Refunded units", "count", "Σ refunded line quantities",
  o(LOWER, { sources: [T.refundLine], grains: ["week", "product", "size", "variant"] }));
m("refund_rate", "post_purchase", "Refund rate", "ratio", "refunded orders ÷ delivered orders",
  o(LOWER, { sources: [T.refund, T.order], grains: ["week", "product", "governorate", ...G.ads] }));
m("time_to_return", "post_purchase", "Time to return", "days", "median days from delivered_at to refund created_at",
  o(NONE, { sources: [T.refund, T.order], grains: ["week", "product"] }));
m("return_cost", "post_purchase", "Return cost", "EGP", "refunded goods + return shipping",
  o(LOWER, MODELLED, { sources: [T.refund, T.refundLine, T.geo], grains: ["week", "product"] }));
m("return_reason_share", "post_purchase", "Return reason share", "ratio", "refund value with the reason ÷ refund value",
  o(NONE, { sources: [T.refund], grains: ["reason"] }));
// Exchanges
m("exchange_orders", "post_purchase", "Exchanged orders", "count", "orders with an exchange requested in the period",
  o(LOWER, { sources: [T.exchange], grains: ["week", "governorate"] }));
m("exchange_units", "post_purchase", "Exchanged units", "count", "Σ exchanged quantities",
  o(LOWER, { sources: [T.exchange], grains: ["week", "product", "variant", "size"] }));
m("exchange_rate", "post_purchase", "Exchange rate", "ratio", "orders with an exchange ÷ delivered orders",
  o(LOWER, { sources: [T.exchange, T.order], grains: ["week", "product"] }));
m("exchange_price_difference", "post_purchase", "Exchange price difference", "EGP", "Σ price_difference on exchanges",
  o(NONE, { sources: [T.exchange], grains: ["week", "product"] }));
m("exchange_cost", "post_purchase", "Exchange shipping cost", "EGP", "Σ shipping_cost on exchanges",
  o(LOWER, { sources: [T.exchange], grains: ["week", "product"] }));
m("time_to_exchange", "post_purchase", "Time to exchange", "days", "median days from requested_at to completed_at",
  o(LOWER, { sources: [T.exchange], grains: ["week"] }));
m("exchange_size_swap_share", "post_purchase", "Size-only exchanges", "ratio",
  "exchanges where only the size changed ÷ exchanges",
  o(NONE, { sources: [T.exchange], grains: ["week", "product", "size"],
    treatment: "A fit signal: returns and exchanges by size surface fit problems that otherwise read as quality problems." }));
m("exchange_reason_share", "post_purchase", "Exchange reason share", "ratio", "exchanges with the reason ÷ exchanges",
  o(NONE, { sources: [T.exchange], grains: ["reason"] }));
// Interventions
m("interventions_unmeasured", "post_purchase", "Unmeasured interventions", "count", "intervention_log rows with measurement_status = unmeasured",
  o(NONE, LOWER, { sources: [T.interventions] }));
m("intervention_effect", "post_purchase", "Intervention effect", "decimal", "after_value − before_value on the intervention's own cohort metric",
  o(NONE, { sources: [T.interventions], grains: ["intervention"],
    treatment: "An intervention with no measured cohort is unmeasured, never effective." }));

// ---------------------------------------------------------------------------
// §12 Forecast and Drop Planning
// ---------------------------------------------------------------------------
m("drop_lift", "forecast", "Drop lift", "multiple",
  "net sales over drop days 0–6 ÷ net sales over the 7 days before drop_date",
  o(HIGHER, { sources: [T.order, T.line, T.reversal, T.drop], grains: ["week", "drop"] }));
m("decay_rate", "forecast", "Decay rate", "ratio", "fitted daily decay of net sales after drop day 0",
  o(MODELLED, { sources: [T.order, T.line, T.drop], grains: ["week", "drop"] }));
m("inventory_depletion_pace", "forecast", "Inventory depletion pace", "ratio", "committed units sold by the drop-day ÷ units committed",
  o(HIGHER, { sources: [T.line, T.drop, T.inventory], grains: ["week", "drop", "product", "size"],
    treatment: "Renders beside revenue pace: a drop can beat revenue forecast while destroying the size curve." }));
m("projected_sellout_date", "forecast", "Projected sell-out", "date", "date inventory_on_hand reaches zero at the current velocity",
  o(NONE, MODELLED, { sources: [T.inventory, T.line], grains: ["product", "variant", "size"] }));
m("cadence_gap_days", "forecast", "Cadence gap", "days", "drop_date − prior drop_date",
  o(NONE, { sources: [T.drop], grains: ["drop"] }));
m("cadence_gap_revenue_cost", "forecast", "Cadence gap cost", "EGP", "floor-level net sales foregone across gap days beyond the season's median gap",
  o(NONE, MODELLED, { sources: [T.drop, T.order], grains: ["drop"] }));
m("prior_season_sell_through", "forecast", "Prior-season sell-through", "ratio", "units sold ÷ units committed, previous season",
  o(NONE, { sources: [T.line, T.drop, T.product, T.variant], grains: ["category", "size"] }));
m("forecast_abs_pct_error", "forecast", "Forecast error", "ratio", "|actual − forecast| ÷ actual, scored after the drop",
  o(NONE, LOWER, { sources: [T.forecasts], grains: ["drop", "forecast"],
    treatment: "A forecast never scored is a wish." }));
m("forecasts_logged_before_drop", "forecast", "Forecasts logged before drop", "count", "forecast_log rows for the drop produced before drop_date",
  o(NONE, HIGHER, { sources: [T.forecasts], grains: ["week", "drop"] }));

// ---------------------------------------------------------------------------
// §13 Decisions, Experiments, Memory
// ---------------------------------------------------------------------------
m("decisions_logged", "decisions", "Decisions logged", "count", "decision_log rows decided in the period",
  o(NONE, { sources: [T.decisions] }));
m("decisions_due_for_review", "decisions", "Decisions due for review", "count", "decisions past review_date with no actual_result",
  o(NONE, LOWER, { sources: [T.decisions] }));
m("experiments_running", "decisions", "Experiments running", "count", "experiments started and not ended",
  o(NONE, { sources: [T.experiments] }));
m("experiments_inconclusive", "decisions", "Experiments inconclusive", "count", "experiments ended with result_status inconclusive",
  o(NONE, { sources: [T.experiments] }));
m("decision_center_egp_at_stake", "decisions", "EGP at stake, decision center", "EGP", "Σ EGP at stake across open decision-center items",
  o(NONE, MODELLED, { sources: [T.order, T.ad, T.ga4, T.sessions, T.inventory] }));

// ---------------------------------------------------------------------------
// Redefinitions — never edit a row above; add a version here.
// ---------------------------------------------------------------------------

// A later version of an existing metric: the latest row, changed, version + 1.
// Grain additions change where a metric is served, not what it means, so they
// govern all history: effective from the day after v1's start.
function redefine(key, changes, meta) {
  const latest = definitions.filter((d) => d.metric_key === key).sort((a, b) => b.version - a.version)[0];
  if (!latest) throw new Error(`redefine: no metric ${key}`);
  definitions.push({
    ...latest,
    ...changes,
    version: latest.version + 1,
    effective_from: meta.effective_from,
    effective_to: null,
    change_note: meta.change_note,
    created_at: meta.created_at,
    migration: meta.migration
  });
}

// payment type, first-time vs repeat.
const RTO_CUTS = { effective_from: "1970-01-02", created_at: "2026-09-15T00:00:00Z", migration: "0015",
  change_note: "v2: adds city, price_band, payment_type, traffic_source and segment grains (founder question 2). Meaning unchanged, so it governs all history." };
for (const key of ["reversal_rate", "rto_orders"]) {
  const v1 = definitions.find((d) => d.metric_key === key && d.version === 1);
  redefine(key, { grains: [...v1.grains, "city", "price_band", "payment_type", "traffic_source", "segment"].filter((g, i, a) => a.indexOf(g) === i) }, RTO_CUTS);
}

// 0016 (2026-09-15): fulfilment no longer counts the outbound leg of returned
// parcels — rto_shipping_waste carries both legs of those, and contribution would
// otherwise charge that leg twice. v1 was never computed, so v2 governs all history.
redefine("fulfilment_cost_outbound", {
  formula: "courier rate by zone × shipped orders that were not returned; a returned parcel's outbound and return legs are in rto_shipping_waste",
  treatment: "Modelled from the founder's rate card (Cairo/Giza 75, Delta 85, rest of Egypt 150) until courier invoices are loaded. An order with no province code is unpriced and counts against coverage."
}, { effective_from: "1970-01-02", created_at: "2026-09-15T00:00:00Z", migration: "0016",
  change_note: "v2: excludes returned parcels so contribution does not charge their outbound leg twice. v1 was never computed." });

// 0018 (2026-09-16): the sell-through curve — founder question 5. The curve itself
// (units by day since drop) needs only order lines; the denominator needs a stock
// snapshot taken before the launch, which first exists for the 2026-09-20 drop.
const SELL_THROUGH = { effective_from: "1970-01-02", created_at: "2026-09-16T00:00:00Z", migration: "0018",
  change_note: "v1: added with the drop view (founder question 5)." };
const DROP_UNIT_GRAINS = ["product", "variant", "size", "drop"];
m("units_sold_since_drop", "product", "Units sold since drop", "count",
  "units on non-excluded orders from drop day 0 through the day shown",
  o(HIGHER, { sources: [T.line, T.order, T.drop], grains: DROP_UNIT_GRAINS, basis_label: "Shopify units", ...SELL_THROUGH,
    treatment: "Counted by the order's own drop and drop-day, so day 3 of one drop is day 3 of another. Cancelled orders stay in until they are excluded by rule." }));
// The drop view reads both against the whole drop, not one product: a new version,
// because 0012 is applied and an applied migration never changes.
for (const key of ["full_price_sell_through", "discounted_sell_through"]) {
  const v1 = definitions.find((d) => d.metric_key === key && d.version === 1);
  redefine(key, { grains: [...v1.grains, "drop"] }, { ...SELL_THROUGH,
    change_note: "v2: adds the drop grain for the drop view. Meaning unchanged, so it governs all history." });
}
m("units_committed", "product", "Units committed at launch", "count",
  "qty_on_hand at the last stock snapshot before drop_date, at locations that fulfil online orders",
  o(NONE, { sources: [T.inventory, T.drop], grains: DROP_UNIT_GRAINS, basis_label: "Stock snapshot", ...SELL_THROUGH,
    treatment: "Snapshots began 2026-09-14, so drops before then have no commitment and sell-through is missing, not zero. Stock at locations not marked as fulfilling online orders is left out; unclassified locations lower coverage." }));

// A request is not a refund: none of the first export's 42 requests had money
// returned. These count what customers asked for, by the week their order was
// placed, so a rate per SKU is a rate against that SKU's own sales.
const YANET_RETURNS = { effective_from: "1970-01-02", created_at: "2026-09-16T00:00:00Z", migration: "0020",
  change_note: "v1: added with the Yanet import (founder question 3)." };
const RETURN_RATE_GRAINS = ["week", "product", "variant", "size", "category"];
const RETURN_SETTLE_NOTE = "Requests arrive 1-9 days after the order (measured over the first export: 94% within 7 days), so a week is only fully readable 14 days after it ends; coverage states the settled share. Orders placed before the first uploaded request file have no request data at all and read missing, never 0.";
m("return_requests_units", "post_purchase", "Units asked to return", "count",
  "units on Yanet return requests, counted against the week the order was placed",
  o(LOWER, { sources: [T.returnRequest, T.order, T.line], grains: [...RETURN_RATE_GRAINS, "reason"], basis_label: "Yanet requests", ...YANET_RETURNS,
    treatment: RETURN_SETTLE_NOTE }));
m("exchange_requests_units", "post_purchase", "Units asked to exchange", "count",
  "units on Yanet exchange requests, counted against the week the order was placed",
  o(LOWER, { sources: [T.returnRequest, T.order, T.line], grains: [...RETURN_RATE_GRAINS, "reason"], basis_label: "Yanet requests", ...YANET_RETURNS,
    treatment: RETURN_SETTLE_NOTE }));
m("return_request_rate_units", "post_purchase", "Return request rate (units)", "ratio",
  "units asked to return ÷ units sold, both by the order's own date",
  o(LOWER, { sources: [T.returnRequest, T.order, T.line], grains: RETURN_RATE_GRAINS, basis_label: "Units sold", ...YANET_RETURNS,
    treatment: `A request, not a refund: the customer asked, the money may not have moved. ${RETURN_SETTLE_NOTE}` }));
m("exchange_request_rate_units", "post_purchase", "Exchange request rate (units)", "ratio",
  "units asked to exchange ÷ units sold, both by the order's own date",
  o(LOWER, { sources: [T.returnRequest, T.order, T.line], grains: RETURN_RATE_GRAINS, basis_label: "Units sold", ...YANET_RETURNS,
    treatment: `Kept apart from returns on purpose: an exchange keeps the revenue and costs a second shipment. ${RETURN_SETTLE_NOTE}` }));

// process: once a return is approved, the inventory team tells ShipBlu and the
// courier hands the money back. Checked against Shopify on 2026-09-16 — all 41
// still OPEN, while 33 of those orders were COD. A refund metric that counted only
// Shopify's own refund objects would therefore read near zero forever.
const REFUND_CHANNELS = { effective_from: "1970-01-02", created_at: "2026-09-16T00:00:00Z", migration: "0021",
  change_note: "v2: counts money returned through either channel — Shopify's own refunds and approved Yanet returns paid back by the courier — and attributes it to the order's week." };
const REFUND_CHANNEL_NOTE = "Two channels, never double-counted: Shopify's own refund amount, and an approved Yanet return, which the courier pays back in cash and Shopify never records. An approved request is treated as money out, because that is when the founder's process releases it; a request still awaiting approval is not.";
redefine("refund_value", {
  formula: "Σ Shopify refunded amounts + Σ goods value on approved Yanet returns, by the order's week",
  treatment: `${REFUND_CHANNEL_NOTE} At product, size and reason the Shopify half cannot be split into lines, so coverage states the share that is attributable.`
}, REFUND_CHANNELS);
redefine("refund_orders", { formula: "orders with money returned through either channel, by the order's week", treatment: REFUND_CHANNEL_NOTE }, REFUND_CHANNELS);
redefine("refund_units", {
  formula: "Σ units on approved Yanet returns",
  treatment: `${REFUND_CHANNEL_NOTE} Only the Yanet channel carries lines; a Shopify refund is an amount against the order, so units under-count where that channel is used.`
}, REFUND_CHANNELS);
redefine("refund_rate", { formula: "orders with money returned ÷ delivered orders, by the order's week", treatment: REFUND_CHANNEL_NOTE }, REFUND_CHANNELS);

// The refund step in the contribution chain. A returned item's COGS is not credited
// back: nothing records whether it was resold. Where it is, this understates.
redefine("contribution_margin", {
  formula: "gross_profit − ad_spend − fulfilment_cost_outbound − cod_collection_fees − rto_shipping_waste − refund_value",
  treatment: "Modelled while any component is modelled (freight, COD fees). Refunds are subtracted whichever channel paid them; the returned item's COGS is not credited back, because nothing yet records whether it was resold, so a restocked return reads worse than it was. The objective function (§0): delivered contribution margin per drop."
}, { ...REFUND_CHANNELS,
  change_note: "v2: subtracts refunds. Returns leave through the courier as well as Shopify, so a contribution line without them overstates every week that had one." });

// 0022 (2026-09-16): two corrections from the founder, both real money.
// 1. The return shipping and restocking fees are deducted from the customer's
//    900, and ShipBlu's remittance is short by 900.
// 2. Returns go back on the shelf, so the cost of those goods is not spent.
// A third version needs a later date than the second it closes.
const RETURN_NET = { effective_from: "1970-01-03", created_at: "2026-09-16T00:00:00Z", migration: "0022",
  change_note: "v3: refunds are net of the fees the customer pays, and returned goods are credited back to COGS." };
redefine("refund_value", {
  formula: "Σ Shopify refunded amounts + Σ (goods value − return shipping fee − restocking fee) on approved Yanet returns, by the order's week",
  treatment: "The cash the customer actually receives, which is what the courier's remittance is short by. The fees are withheld from the refund, not paid by the business. Two channels, never double-counted: Shopify's own refunds, and approved Yanet returns the courier pays back."
}, RETURN_NET);
redefine("return_cost", {
  formula: "refund_value − the cost of the returned goods, which go back on the shelf",
  treatment: "What a return leaves behind once the goods are back and sellable: the cash that left, less what those goods cost. Where a returned unit has no cost on file it cannot be credited, and coverage says how much of the return could be."
}, RETURN_NET);
redefine("contribution_margin", {
  formula: "gross_profit − ad_spend − fulfilment_cost_outbound − cod_collection_fees − rto_shipping_waste − refund_value + returned goods COGS",
  treatment: "Modelled while any component is modelled (freight, COD fees). Refunds leave net of the fees the customer pays, and returned stock is credited back at what it cost, because it goes back on the shelf. A returned unit with no cost on file cannot be credited and reads slightly pessimistic. The objective function (§0): delivered contribution margin per drop."
}, { ...RETURN_NET,
  change_note: "v3: refunds subtracted net of customer-paid fees, and returned goods credited back to COGS since they are restocked." });

// page views with outbound clicks and said so deliberately — but on this account
// ads), because the two count different things. Landing page views pair with link
const LAND_LINK = { effective_from: "1970-01-03", created_at: "2026-09-16T00:00:00Z", migration: "0024",
  change_note: "v2: measured against link clicks, because landing ÷ outbound clicks exceeded 100% on real data and could not be a rate." };
redefine("land_rate", {
  formula: "landing_page_views ÷ clicks_link",
  basis_label: "Link clicks",
  treatment: "Stated on link clicks, which is what landing page views are counted against. Ad rows written before 2026-09-16 have no link clicks and read missing rather than wrong."
}, LAND_LINK);

// Meta counts a purchase at checkout. This business is COD with roughly a quarter of
// orders reversed and a further few per cent refunded, so Meta's ROAS counts money
// that never arrives. An order carries the ad id in utm_content, so delivered money
// can be put against the ad that earned it — for the orders that arrive carrying it,
// which is a minority. Stated beside Meta's number, never blended into it.
const DELIVERED_ROAS = { effective_from: "1970-01-03", created_at: "2026-09-17T00:00:00Z", migration: "0025",
  change_note: "v1: added with the ad chain (delivered money against the ad that earned it)." };
m("delivered_roas_attributed", "acquisition", "Delivered ROAS", "multiple",
  "delivered revenue of orders attributed to the entity ÷ ad_spend",
  // Not at week grain: MER already answers that question without depending on
  // attribution at all. This one exists to rank ads against each other.
  o(HIGHER, { sources: [T.order, T.ad, T.dimAd], grains: [...G.ads, ...G.creativeRollups], basis_label: "Shopify delivered revenue", ...DELIVERED_ROAS,
    treatment: "Money that actually arrived, against spend. A floor, not a total: only orders carrying the ad id can be counted, and coverage states what share of Meta's own purchase count that is. Never merged with platform ROAS, which counts at checkout." }));

// 0028 (2026-09-17): an ad's chain says which stage is failing; these say whether it
// is getting worse. The window is split in half and the ad is compared against
// itself, so nothing here depends on how it ranks against other ads.
const AD_TREND = { effective_from: "1970-01-03", created_at: "2026-09-17T00:00:00Z", migration: "0028",
  change_note: "v1: added so an ad can be read as improving or decaying, not only as a level." };
const AD_TREND_GRAINS = [...G.ads, "format", "angle"];
const AD_TREND_NOTE = "The window split in two: the later half against the earlier one, the ad against itself. Both halves must clear the impression threshold or the change is not shown, because a fortnight of noise can invent any trend.";
m("cpm_trend", "creative", "CPM trend", "ratio",
  "CPM in the later half of the window ÷ CPM in the earlier half − 1",
  o(LOWER, PLATFORM, { sources: [T.ad], grains: AD_TREND_GRAINS, basis_label: "Impressions", ...AD_TREND,
    treatment: `Rising CPM on a flat creative is the auction charging more for the same attention. ${AD_TREND_NOTE}` }));
m("ctr_trend", "creative", "CTR trend", "ratio",
  "outbound CTR in the later half of the window ÷ CTR in the earlier half − 1",
  o(HIGHER, PLATFORM, { sources: [T.ad], grains: AD_TREND_GRAINS, basis_label: "Impressions", ...AD_TREND,
    treatment: `Falling CTR with rising frequency is the audience tiring of the creative. ${AD_TREND_NOTE}` }));

// ---------------------------------------------------------------------------
// Structural registries seeded alongside the definitions
// ---------------------------------------------------------------------------

// Named funnel breakdowns (§7). dims are logical names; each writer maps them to
// its source's API names. 'total' is the unsegmented day.
const breakdowns = [
  ["ga4.total", "ga4", [], "All sessions", "Unsegmented total; segments summed under thresholding never equal it"],
  ["ga4.device", "ga4", ["device"], "Device", null],
  ["ga4.source_medium", "ga4", ["source_medium"], "Source / medium", null],
  ["ga4.channel_group", "ga4", ["channel_group"], "Channel group", null],
  ["ga4.new_or_returning", "ga4", ["new_or_returning"], "New vs returning", null],
  ["ga4.landing_page", "ga4", ["landing_page"], "Landing page", null],
  ["ga4.region", "ga4", ["region"], "Governorate", null],
  ["ga4.campaign", "ga4", ["campaign"], "Campaign", null],
  ["ga4.device__source_medium", "ga4", ["device", "source_medium"], "Device × source / medium", "The most useful funnel view in the system"],
  ["ga4.device__new_or_returning", "ga4", ["device", "new_or_returning"], "Device × new vs returning", null],
  ["ga4.channel_group__device", "ga4", ["channel_group", "device"], "Channel group × device", null],
  ["ga4.landing_page__device", "ga4", ["landing_page", "device"], "Landing page × device", null],
  ["ga4.source_medium__landing_page", "ga4", ["source_medium", "landing_page"], "Source / medium × landing page", null],
  ["ga4.campaign__device", "ga4", ["campaign", "device"], "Campaign × device", null],
  ["ga4.device__source_medium__new_or_returning", "ga4", ["device", "source_medium", "new_or_returning"], "Device × source / medium × new vs returning", null],
  ["shopify.total", "shopify_sessions", [], "All sessions", null],
  ["shopify.device", "shopify_sessions", ["device"], "Device", null],
  ["shopify.referrer_source", "shopify_sessions", ["referrer_source"], "Referrer source", null],
  ["shopify.landing_page", "shopify_sessions", ["landing_page"], "Landing page", null],
  ["shopify.device__referrer_source", "shopify_sessions", ["device", "referrer_source"], "Device × referrer source", null]
].map(([breakdown_id, source, dims, label, purpose], i) => ({ breakdown_id, source, dims, label, purpose, sort_order: i + 1 }));

// Reason taxonomy with owner routing (§11). applies_to is open: three systems.
const reasons = [
  ["wrong_size", "Wrong size", ["rto", "refund", "exchange"], "sizing_content"],
  ["quality", "Quality", ["rto", "refund", "exchange"], "manufacturing"],
  ["unreachable", "Customer unreachable", ["rto"], "address_gate"],
  ["invalid_address", "Invalid address", ["rto"], "address_gate"],
  ["refused", "Refused at door", ["rto"], "confirmation_and_offer"],
  ["price_regret", "Price regret", ["rto", "refund"], "confirmation_and_offer"],
  ["delivery_failure", "Delivery failure", ["rto"], "courier"],
  ["other", "Other (stated)", ["rto", "refund", "exchange"], null],
  ["unclassified", "No usable reason", ["rto", "refund", "exchange"], null],
  // not cover. "I didn't like the item" is an expectation gap, not a size or a
  // defect; "Wrong item/size received" is a picking error, not the customer's.
  ["disliked_item", "Didn't like the item", ["refund", "exchange"], "product_content", "0013"],
  ["wrong_item_received", "Wrong item or size received", ["refund", "exchange"], "fulfilment", "0013"]
].map(([reason_code, label, applies_to, owner, migration], i) => ({
  reason_code, label, applies_to, owner, sort_order: i + 1, migration: migration || SEED_MIGRATION
}));

// ROAS counts money that arrived; between them sits what the ad's orders were booked
// at. On a COD account with a quarter reversed the three are far apart, and which one
// someone means is the whole argument, so all three are shown and never blended.
const NET_ROAS = { effective_from: "1970-01-04", created_at: "2026-09-22T00:00:00Z", migration: "0032",
  change_note: "v1: added so booked money has its own line between Meta's checkout count and delivered money." };
m("net_roas_attributed", "acquisition", "Net ROAS", "multiple",
  "net sales of orders attributed to the entity ÷ ad_spend",
  o(HIGHER, { sources: [T.order, T.ad, T.dimAd], grains: [...G.ads, ...G.creativeRollups], basis_label: "Shopify net sales", ...NET_ROAS,
    treatment: "Booked, not collected: cancellations are already out, delivery has not happened yet. A floor, not a total — only orders carrying the ad id are counted, and coverage states what share of Meta's own purchase count that is. Read it between platform ROAS, which counts at checkout, and delivered ROAS, which counts money that arrived." }));

// 0031 (2026-09-22): demand, measured on our own sessions.
//
// The demand block was nine empty tiles. Every metric in it is defined on GA4 or on
// and there is no Instagram connector at all, so the whole section read "not wired
// up" and said nothing about whether demand was growing.
//
// Shopify's own session data answers most of the question and has been loaded since
// April. Its referrer buckets are not GA4 channel groups — `social` mixes paid and
// organic social, and `direct` catches everything with no referrer, including app
// browsers — so these are their own metrics, named for what they are, never merged
// with the GA4 ones.
const DEMAND_SHOPIFY = { effective_from: "1970-01-04", created_at: "2026-09-22T00:00:00Z", migration: "0031",
  change_note: "v1: added because the GA4 demand block has no data source and never had one." };
const REFERRER_NOTE = "Shopify's own referrer bucket, not a GA4 channel group. `social` counts paid and organic social together, so it is traffic from social, not organic demand on its own.";
m("direct_sessions_shopify", "acquisition", "Direct sessions", "count",
  "Σ Shopify sessions whose referrer bucket is direct",
  o(HIGHER, SHOPIFY_SESSIONS, { sources: [T.sessions], ...DEMAND_SHOPIFY,
    treatment: `${REFERRER_NOTE} Direct also catches sessions that arrive with no referrer at all, which includes in-app browsers, so it is a ceiling on people who came looking for the brand.` }));
m("search_sessions_shopify", "acquisition", "Search sessions", "count",
  "Σ Shopify sessions whose referrer bucket is search",
  o(HIGHER, SHOPIFY_SESSIONS, { sources: [T.sessions], ...DEMAND_SHOPIFY, treatment: REFERRER_NOTE }));
m("social_sessions_shopify", "acquisition", "Social sessions", "count",
  "Σ Shopify sessions whose referrer bucket is social",
  o(NONE, SHOPIFY_SESSIONS, { sources: [T.sessions], ...DEMAND_SHOPIFY,
    treatment: `${REFERRER_NOTE} It rises with ad spend, so it is not a demand signal on its own — read it against direct and search.` }));
m("unpaid_session_share_shopify", "acquisition", "Non-social session share", "ratio",
  "(sessions − social sessions) ÷ sessions",
  o(HIGHER, SHOPIFY_SESSIONS, { sources: [T.sessions], ...DEMAND_SHOPIFY,
    treatment: "How much of the week's traffic did not come through social. A proxy for demand that does not depend on spend, and a crude one: paid traffic that loses its referrer lands in direct." }));

// when the own store's POS location exists.
const locations = [
  { location_id: "online", name: "Online store", kind: "online", channel: "shopify_online", partner_name: null, notes: null },
  { location_id: "own_store", name: "Coddiwomple store", kind: "own_store", channel: "shopify_pos", partner_name: null,
    notes: "Own physical store on Shopify POS, opening end of September 2026." },
  { location_id: "partner_genz", name: "GenZ", kind: "partner_store", channel: "partner_report", partner_name: "GenZ",
    notes: "Multi-brand store. Weekly report: stock, units sold, SKUs." },
  { location_id: "partner_go_native", name: "Go Native", kind: "partner_store", channel: "partner_report", partner_name: "Go Native",
    notes: "Multi-brand store. Weekly report: stock, units sold, SKUs." }
];

module.exports = {
  SEED_MIGRATION,
  SEED_CREATED_AT,
  V1_EFFECTIVE_FROM,
  definitions,
  breakdowns,
  reasons,
  locations
};

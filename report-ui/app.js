(() => {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const requestedWeek = (params.get("week_start") || "").trim();
  const isLocalReportHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const requestedApiOverride = (params.get("api") || "").trim();
  const configuredApi = (
    (isLocalReportHost ? requestedApiOverride : "") ||
    window.REPORT_CONFIG?.apiBase ||
    "/api"
  ).trim();
  const apiBase = configuredApi.replace(/\/+$/, "");
  const accessSessionError =
    "The secured report session could not be completed. Reload this page to renew Cloudflare Access. A separate API-host sign-in is no longer required.";
  const tabs = ["Revenue", "Funnel", "Paid", "Creative", "Inventory", "Returns"];
  let reportData = null;
  let reportWeeks = [];
  let selectedWeekState = null;
  let selectedWeek = requestedWeek;
  const requestedView = (params.get("view") || "").trim();
  let activeTab = tabs.includes(requestedView) ? requestedView : "Revenue";
  let loadingTimers = [];
  let syncPollTimer = 0;
  let activeSyncRunId = "";
  let reportLoadSequence = 0;
  let pendingAiGeneration = null;
  let aiGenerationRestoreFocus = null;
  const sidebarDesktopQuery = window.matchMedia("(min-width: 1101px)");
  const sidebarCollapsedStorageKey = "coddi-report-sidebar-collapsed";
  const aiSuggestedGoals = [
    "Grow net sales next week",
    "Protect margin",
    "Sell through slow-moving inventory",
    "Scale paid ads safely",
    "Reduce refunds and returns",
    "Clear inventory without hurting winners",
    "Find why revenue dropped",
    "Prepare restock/buying plan for next week",
    "Improve conversion rate",
    "Reduce wasted ad spend",
    "Identify what to scale",
    "Identify what to stop"
  ];
  let aiReportState = {
    mode: "general",
    goalText: "",
    lastReport: null,
    productIntelligence: null,
    adsCreativeIntelligence: null,
    productSort: "most_sold",
    productFilters: new Set(),
    productPage: 1,
    productPageSize: 12,
    adsDecisionPage: 1,
    adsDecisionPageSize: 10,
    adsDecisionSort: "highest_spend",
    adsDecisionIndexOpen: true,
    creativeDecisionPage: 1,
    creativeDecisionPageSize: 8,
    creativeDecisionSort: "highest_spend",
    creativeDecisionIndexOpen: false,
    adsDecisionFilter: "all",
    lookupInProgress: true,
    lookupSequence: 0,
    generationInProgress: false
  };
  let adMappingState = {
    filter: "unresolved",
    search: "",
    page: 1,
    pageSize: 8,
    savingAdId: ""
  };
  const $ = (id) => document.getElementById(id);
  const clean = (value) => String(value ?? "").trim();
  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const hasNumber = (value) =>
    value !== "" && value != null && Number.isFinite(Number(value));
  const escapeHtml = (value) =>
    clean(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const tooltipAttr = (value) => clean(value)
    ? ` data-tooltip="${escapeHtml(value)}"`
    : "";

  function compactList(values = [], empty = "None") {
    const list = (values || []).map(clean).filter(Boolean);
    return list.length ? list.join(", ") : empty;
  }

  function formatNumber(value, digits = 0) {
    if (!hasNumber(value)) return "N/A";
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(Number(value));
  }

  function formatCompact(value) {
    if (!hasNumber(value)) return "N/A";
    return new Intl.NumberFormat("en-US", {
      notation: Math.abs(Number(value)) >= 10000 ? "compact" : "standard",
      maximumFractionDigits: 1
    }).format(Number(value));
  }

  function formatMoney(value, currency) {
    if (!hasNumber(value)) return "N/A";
    return `${formatCompact(value)} ${escapeHtml(currency || "EGP")}`;
  }

  function formatMoneyFull(value, currency) {
    if (!hasNumber(value)) return "N/A";
    return `${formatNumber(value, 0)} ${escapeHtml(currency || "EGP")}`;
  }

  function formatPercent(value, digits = 2) {
    if (!hasNumber(value)) return "N/A";
    return `${formatNumber(Number(value) * 100, digits)}%`;
  }

  function formatMultiple(value, digits = 2) {
    if (!hasNumber(value)) return "N/A";
    return `${formatNumber(value, digits)}x`;
  }

  function formatExecutiveSummary(data) {
    const currency = data.week?.currency || "EGP";
    const scoreboard = data.scoreboard || {};
    const salesChange = hasNumber(scoreboard.net_sales?.wow_pct)
      ? ` (${number(scoreboard.net_sales.wow_pct) >= 0 ? "+" : ""}${formatPercent(scoreboard.net_sales.wow_pct)} vs last week)`
      : "";

    return [
      `Net sales ${formatMoneyFull(scoreboard.net_sales?.current, currency)}${salesChange}`,
      `${formatNumber(scoreboard.orders?.current)} orders`,
      `AOV ${formatMoneyFull(scoreboard.aov?.current, currency)}`,
      `MER ${formatMultiple(scoreboard.mer?.current)}`,
      `Shopify CVR ${formatPercent(scoreboard.conversion_rate?.current)}`
    ].join(" | ");
  }

  function formatNarrativeMetrics(value) {
    let text = clean(value);
    const percentageLabels = [
      "refund rate",
      "item return rate",
      "return rate",
      "product-view rate",
      "product view rate",
      "atc rate",
      "add-to-cart rate",
      "checkout-start rate",
      "checkout start rate",
      "checkout completion rate",
      "link ctr",
      "ctr link",
      "lpv/link-click rate",
      "lpv rate",
      "hook rate",
      "hold rate p50",
      "hold rate",
      "sell-through"
    ];

    for (const label of percentageLabels) {
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(${escapedLabel}\\s*(?:is|of|:)?\\s*)(0?\\.\\d+)`, "gi");
      text = text.replace(pattern, (_, prefix, raw) => `${prefix}${formatPercent(raw)}`);
    }

    text = text.replace(
      /\b(0?\.\d+)\s+of sold skus\b/gi,
      (_, raw) => `${formatPercent(raw)} of sold SKUs`
    );

    return text
      .replace(/\bPDP\b/g, "product page")
      .replace(/\bOOS\b/g, "out of stock")
      .replace(/\b7d\b/gi, "7-day")
      .replace(/\b3d\b/gi, "3-day");
  }

  function clearLoadingTimers() {
    for (const timer of loadingTimers) window.clearTimeout(timer);
    loadingTimers = [];
  }

  function clearSyncPoll() {
    if (syncPollTimer) window.clearTimeout(syncPollTimer);
    syncPollTimer = 0;
  }

  function updateSidebarToggle() {
    const toggle = $("sidebar-toggle");
    if (!toggle) return;
    const isDesktop = sidebarDesktopQuery.matches;
    const expanded = isDesktop
      ? !document.body.classList.contains("sidebar-collapsed")
      : document.body.classList.contains("sidebar-open");
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggle.textContent = isDesktop
      ? (expanded ? "Hide tools" : "Show tools")
      : (expanded ? "Close tools" : "Tools");
  }

  function setSidebarOpen(open) {
    document.body.classList.toggle("sidebar-open", !sidebarDesktopQuery.matches && !!open);
    updateSidebarToggle();
  }

  function setDesktopSidebarCollapsed(collapsed, persist = false) {
    document.body.classList.toggle("sidebar-collapsed", !!collapsed);
    if (persist) {
      try {
        window.localStorage.setItem(sidebarCollapsedStorageKey, collapsed ? "true" : "false");
      } catch {
        // The sidebar still works when browser storage is unavailable.
      }
    }
    updateSidebarToggle();
  }

  function getSavedDesktopSidebarState() {
    try {
      return window.localStorage.getItem(sidebarCollapsedStorageKey) === "true";
    } catch {
      return false;
    }
  }

  function initSidebarControls() {
    setDesktopSidebarCollapsed(getSavedDesktopSidebarState());
    setSidebarOpen(false);
    $("sidebar-toggle")?.addEventListener("click", () => {
      if (sidebarDesktopQuery.matches) {
        setDesktopSidebarCollapsed(
          !document.body.classList.contains("sidebar-collapsed"),
          true
        );
        return;
      }
      setSidebarOpen(!document.body.classList.contains("sidebar-open"));
    });
    $("sidebar-backdrop")?.addEventListener("click", () => setSidebarOpen(false));
    document.querySelectorAll(".sidebar-nav a").forEach((link) => {
      link.addEventListener("click", () => {
        if (!sidebarDesktopQuery.matches) setSidebarOpen(false);
      });
    });
    sidebarDesktopQuery.addEventListener("change", () => {
      document.body.classList.remove("sidebar-open");
      updateSidebarToggle();
    });
  }

  function initSectionCollapse(buttonId, contentId, storageKey) {
    const button = $(buttonId);
    const content = $(contentId);
    if (!button || !content) return;
    let expanded = true;
    try {
      expanded = window.localStorage.getItem(storageKey) !== "collapsed";
    } catch {
      expanded = true;
    }
    const apply = () => {
      content.hidden = !expanded;
      button.setAttribute("aria-expanded", expanded ? "true" : "false");
      button.textContent = expanded ? "Collapse" : "Expand";
    };
    apply();
    button.addEventListener("click", () => {
      expanded = !expanded;
      apply();
      try {
        window.localStorage.setItem(storageKey, expanded ? "expanded" : "collapsed");
      } catch {
        // Section collapsing still works without browser storage.
      }
    });
  }

  function initSectionCollapseControls() {
    initSectionCollapse("ad-mapping-collapse", "ad-mapping-body", "coddi:collapse:ad-mapping");
    initSectionCollapse("ai-report-collapse", "ai-report-content", "coddi:collapse:ai-report");
    initSectionCollapse("product-diagnosis-collapse", "product-diagnosis-grid", "coddi:collapse:product-diagnosis");
  }

  function startLoadingMessages() {
    const message = $("loading-message");
    loadingTimers = [
      window.setTimeout(() => {
        message.textContent = "The report is large. Downloading product, SKU, ad, and action detail…";
      }, 1800),
      window.setTimeout(() => {
        message.textContent = "Still working. The completed weekly dataset can take several seconds to parse.";
      }, 6500)
    ];
  }

  function formatDate(value, withTime = false) {
    if (!value) return "Not available";
    const date = new Date(withTime ? value : `${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime())) return clean(value);
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
      timeZone: "UTC"
    }).format(date);
  }

  function formatDateRange(weekStart, weekEnd) {
    const start = formatDate(weekStart).replace(/, \d{4}$/, "");
    const end = formatDate(weekEnd);
    return `${start} - ${end}`;
  }

  function formatElapsed(startedAt, updatedAt = "") {
    const start = new Date(startedAt);
    if (!startedAt || !Number.isFinite(start.getTime())) return "Starting";
    const end = updatedAt ? new Date(updatedAt) : new Date();
    const elapsedMs = Math.max(0, (Number.isFinite(end.getTime()) ? end : new Date()).getTime() - start.getTime());
    const minutes = Math.floor(elapsedMs / 60000);
    const seconds = Math.floor((elapsedMs % 60000) / 1000);
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      return `${hours}h ${minutes % 60}m`;
    }
    return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  function setSelectedWeekInUrl(weekStart, replace = false) {
    const next = new URL(window.location.href);
    next.searchParams.set("week_start", weekStart);
    if (isLocalReportHost && requestedApiOverride) {
      next.searchParams.set("api", apiBase);
    } else {
      next.searchParams.delete("api");
    }
    const method = replace ? "replaceState" : "pushState";
    window.history[method]({}, "", next.toString());
  }

  function reportApiUrl(path) {
    return new URL(`${apiBase}${path}`, window.location.origin);
  }

  async function readApiJson(response) {
    const contentType = clean(response.headers.get("Content-Type")).toLowerCase();
    let data = null;

    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch {
        throw new Error(`The report API returned invalid JSON (${response.status}).`);
      }
    }

    if (data == null) {
      const accessRedirect = response.redirected || /cloudflareaccess\.com/i.test(response.url || "");
      if (response.status === 401 || response.status === 403 || accessRedirect) {
        throw new Error(accessSessionError);
      }
      throw new Error(`The report API returned an unexpected response (${response.status}).`);
    }

    if (!response.ok || data?.ok === false) {
      throw new Error(data?.error || (
        response.status === 401 || response.status === 403
          ? accessSessionError
          : `Report API returned ${response.status}.`
      ));
    }

    return data;
  }

  async function apiGet(path, query = {}) {
    const url = reportApiUrl(path);
    for (const [key, value] of Object.entries(query)) {
      if (clean(value)) url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      credentials: "include"
    });
    return readApiJson(response);
  }

  async function apiPost(path, query = {}, body = null) {
    const url = reportApiUrl(path);
    for (const [key, value] of Object.entries(query)) {
      if (clean(value)) url.searchParams.set(key, value);
    }

    const headers = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    const response = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "include"
    });
    return readApiJson(response);
  }

  async function apiDelete(path, query = {}) {
    const url = reportApiUrl(path);
    for (const [key, value] of Object.entries(query)) {
      if (clean(value)) url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), {
      method: "DELETE",
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    return readApiJson(response);
  }

  function trendClass(value, inverse = false) {
    if (!hasNumber(value)) return "neutral";
    const adjusted = Number(value) * (inverse ? -1 : 1);
    if (adjusted > 0.02) return "good";
    if (adjusted < -0.02) return "bad";
    return "neutral";
  }

  function statusBadge(label, tone) {
    return `<span class="metric-status ${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
  }

  const fundingStatusLabels = {
    setup_required: "Setup Required", calibrating: "Calibrating", calculating: "Calculating", healthy: "Healthy",
    warning: "Warning", urgent: "Urgent", critical: "Critical", coverage_failed: "Coverage Failed",
    settlement_pending: "Settlement Pending", recalibration_required: "Recalibration Required",
    billing_event_review_required: "Billing Event Review Required", activity_sync_incomplete: "Activity Sync Incomplete",
    meta_account_restricted: "Meta Account Restricted", meta_billing_declined: "Meta Billing Declined", meta_api_error: "Meta API Error"
  };

  function fundingMoney(value) {
    return hasNumber(value) ? `${formatNumber(value, 2)} EGP` : "—";
  }

  function renderFundingMonitor(data) {
    if (!data || !$('funding-monitor')) return;
    const snapshot = data.snapshot || {};
    const status = clean(data.status || "setup_required");
    const badge = $("funding-status");
    badge.textContent = fundingStatusLabels[status] || status.replace(/_/g, " ");
    badge.className = `funding-status ${status}`;
    $("funding-monitor-explanation").textContent = clean(data.explanation);
    $("funding-wallet").textContent = fundingMoney(snapshot.estimatedMetaFundsEgp);
    $("funding-owed").textContent = fundingMoney(snapshot.currentAmountOwedEgp);
    $("funding-coverage").textContent = fundingMoney(snapshot.riskAdjustedCoverageEgp);
    $("funding-runway").textContent = hasNumber(snapshot.hoursRemaining) ? `${formatNumber(snapshot.hoursRemaining, 1)} h` : "Unavailable";
    $("funding-recharge").textContent = fundingMoney(snapshot.recommendedRechargeEgp);
    $("funding-reserve").textContent = fundingMoney(snapshot.operationalReserveEgp);
    $("funding-velocity").textContent = hasNumber(snapshot.effectiveVelocityEgpPerHour)
      ? `${fundingMoney(snapshot.effectiveVelocityEgpPerHour)}/h · ${fundingMoney(snapshot.effectiveVelocityEgpPerDay)}/day`
      : "Unavailable";
    $("funding-windows").textContent = [snapshot.velocity3hEgpPerHour, snapshot.velocity6hEgpPerHour, snapshot.velocity24hEgpPerHour]
      .map((value) => hasNumber(value) ? `${formatNumber(value, 0)}` : "—").join(" / ") + " EGP/h";
    $("funding-confidence").textContent = `${clean(snapshot.velocitySource || "Unavailable").replace(/_/g, " ")} · ${clean(snapshot.confidence || "unavailable")}`;
    $("funding-latest-add").textContent = data.latestFunding ? `${fundingMoney(data.latestFunding.amountEgp)} · ${formatDate(data.latestFunding.occurredAtUtc, true)}` : "None detected";
    $("funding-latest-charge").textContent = data.latestBillingCharge ? `${fundingMoney(data.latestBillingCharge.amountEgp)} · ${formatDate(data.latestBillingCharge.occurredAtUtc, true)}` : "None detected";
    $("funding-sync").textContent = data.activitySync?.complete
      ? `Complete · ${formatDate(data.activitySync.lastSuccessfulAtUtc, true)}`
      : data.activitySync?.lastSuccessfulAtUtc ? `Incomplete · ${formatDate(data.activitySync.lastSuccessfulAtUtc, true)}` : "Not started";
    $("funding-notice").hidden = !data.setupRequired;
    const settings = data.settings || {};
    if (hasNumber(settings.fixedReserveEgp)) $("funding-fixed-reserve").value = Number(settings.fixedReserveEgp).toFixed(2);
    if (hasNumber(settings.reservePercentage)) $("funding-reserve-percentage").value = settings.reservePercentage;
    if (hasNumber(settings.fallbackDailySpendEgp)) $("funding-fallback-daily").value = Number(settings.fallbackDailySpendEgp).toFixed(2);
    if (hasNumber(settings.settlementGraceMinutes)) $("funding-grace").value = settings.settlementGraceMinutes;
    if (hasNumber(settings.rechargeRoundingEgp)) $("funding-rounding").value = Number(settings.rechargeRoundingEgp).toFixed(2);
  }

  async function loadFundingMonitor() {
    try {
      renderFundingMonitor(await apiGet("/meta-funds-monitor/status"));
    } catch (error) {
      if ($("funding-status")) {
        $("funding-status").textContent = "Monitor unavailable";
        $("funding-status").className = "funding-status critical";
        $("funding-admin-message").textContent = clean(error?.message || error);
      }
    }
  }

  async function submitFundingCalibration(event) {
    event.preventDefault();
    const button = $("funding-calibrate");
    button.disabled = true;
    $("funding-admin-message").textContent = "Validating calibration against Meta…";
    try {
      await apiPost("/meta-funds-monitor/calibrate", {}, {
        fundsEgp: clean($("funding-calibration-amount").value),
        fallbackDailySpendEgp: clean($("funding-fallback-daily").value),
        fixedReserveEgp: clean($("funding-fixed-reserve").value),
        reservePercentage: clean($("funding-reserve-percentage").value),
        settlementGraceMinutes: clean($("funding-grace").value),
        rechargeRoundingEgp: clean($("funding-rounding").value),
        confirm: $("funding-confirm").checked,
        recalibration: $("funding-recalibration").checked
      });
      $("funding-admin-message").textContent = "Calibration saved. Automatic activity processing begins from this boundary.";
      $("funding-confirm").checked = false;
      await loadFundingMonitor();
    } catch (error) {
      $("funding-admin-message").textContent = clean(error?.message || error);
    } finally { button.disabled = false; }
  }

  async function submitFundingSettings(event) {
    event.preventDefault();
    try {
      await apiPost("/meta-funds-monitor/settings", {}, {
        fixedReserveEgp: clean($("funding-fixed-reserve").value),
        reservePercentage: clean($("funding-reserve-percentage").value),
        fallbackDailySpendEgp: clean($("funding-fallback-daily").value),
        settlementGraceMinutes: clean($("funding-grace").value),
        rechargeRoundingEgp: clean($("funding-rounding").value)
      });
      $("funding-admin-message").textContent = "Monitor safety settings saved.";
      await loadFundingMonitor();
    } catch (error) { $("funding-admin-message").textContent = clean(error?.message || error); }
  }

  async function loadFundingDrilldown(view) {
    const path = view === "reconciliation" ? "/meta-funds-monitor/reconciliation" : `/meta-funds-monitor/${view}`;
    const target = $("funding-drilldown");
    target.hidden = false;
    target.textContent = "Loading secured monitor detail…";
    try { target.textContent = JSON.stringify(await apiGet(path, { limit: 50 }), null, 2); }
    catch (error) { target.textContent = clean(error?.message || error); }
  }

  function initFundingMonitorControls() {
    $("funding-calibration-form")?.addEventListener("submit", submitFundingCalibration);
    $("funding-settings-form")?.addEventListener("submit", submitFundingSettings);
    $("funding-telegram-test")?.addEventListener("click", async () => {
      try {
        $("funding-admin-message").textContent = "Sending one clearly labelled TEST notification…";
        const result = await apiPost("/meta-funds-monitor/telegram-test", {}, {});
        $("funding-admin-message").textContent = clean(result.message || "Telegram TEST sent.");
      } catch (error) { $("funding-admin-message").textContent = clean(error?.message || error); }
    });
    document.querySelectorAll("[data-funding-view]").forEach((button) => button.addEventListener("click", () => loadFundingDrilldown(button.dataset.fundingView)));
  }

  function guardrailStatus(value, healthyAt, watchAt = null) {
    if (!hasNumber(value)) return null;
    const n = number(value);
    const watch = watchAt == null ? healthyAt * 0.8 : watchAt;
    if (n >= healthyAt) return { label: "Healthy", tone: "healthy" };
    if (n >= watch) return { label: "Watch", tone: "watch" };
    return { label: "Focus", tone: "focus" };
  }

  function goalStatus(value, goal, watchAt, sampleSize = 0, minimumSample = 20) {
    if (!hasNumber(value)) return null;
    if (sampleSize && number(sampleSize) < minimumSample) {
      return { label: "Low sample", tone: "inline" };
    }
    if (number(value) >= goal) return { label: "Healthy", tone: "healthy" };
    if (number(value) >= watchAt) return { label: "Watch", tone: "watch" };
    return { label: "Focus", tone: "focus" };
  }

  function rateCell(value, goal, watchAt, sampleSize = 0) {
    const status = goalStatus(value, goal, watchAt, sampleSize);
    if (!status) return "N/A";

    const distance = number(value) - goal;
    const distanceText = status.label === "Low sample"
      ? "Not enough views"
      : distance >= 0
        ? `${formatNumber(distance * 100, 1)} points above goal`
        : `${formatNumber(Math.abs(distance) * 100, 1)} points below goal`;

    return `
      <div class="rate-cell">
        <strong>${formatPercent(value)}</strong>
        ${statusBadge(status.label, status.tone)}
        <span class="rate-distance">${escapeHtml(distanceText)}</span>
      </div>
    `;
  }

  function aggregateFunnelProducts(rows) {
    const products = new Map();

    for (const row of rows || []) {
      const key = clean(row.item_name).toLowerCase() || clean(row.item_id);
      if (!key) continue;

      if (!products.has(key)) {
        products.set(key, {
          item_id: clean(row.item_id),
          item_name: clean(row.item_name) || "Unnamed product",
          item_views: 0,
          add_to_carts: 0,
          begin_checkouts: 0,
          purchases: 0,
          item_revenue: 0
        });
      }

      const product = products.get(key);
      product.item_views += number(row.item_views);
      product.add_to_carts += number(row.add_to_carts);
      product.begin_checkouts += number(row.begin_checkouts);
      product.purchases += number(row.purchases);
      product.item_revenue += number(row.item_revenue);
    }

    return [...products.values()]
      .map((product) => ({
        ...product,
        view_to_cart_rate: product.item_views
          ? product.add_to_carts / product.item_views
          : "",
        cart_to_checkout_rate: product.add_to_carts
          ? product.begin_checkouts / product.add_to_carts
          : "",
        checkout_to_purchase_rate: product.begin_checkouts
          ? product.purchases / product.begin_checkouts
          : "",
        view_to_purchase_rate: product.item_views
          ? product.purchases / product.item_views
          : ""
      }))
      .sort((a, b) => b.item_views - a.item_views);
  }

  function funnelPerformanceScore(row) {
    const ratios = [
      number(row.view_to_cart_rate) / 0.08,
      number(row.cart_to_checkout_rate) / 0.35,
      number(row.view_to_purchase_rate) / 0.01
    ];

    return ratios.reduce((sum, ratio) => sum + Math.min(ratio, 1.5), 0) / ratios.length;
  }

  function normalizedProductName(value) {
    return clean(value)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function attachInventoryToFunnelRows(funnelRows, inventoryRows) {
    const inventoryByName = new Map();

    for (const row of inventoryRows || []) {
      const key = normalizedProductName(row.product_title);
      if (key) inventoryByName.set(key, row);
    }

    return funnelRows.map((row) => ({
      ...row,
      inventory: inventoryByName.get(normalizedProductName(row.item_name)) || null
    }));
  }

  function isStockConstrained(row) {
    const inventory = row.inventory;
    if (!inventory) return false;

    return (
      number(inventory.ending_inventory_units) <= 5 ||
      (number(inventory.daily_velocity_7d) > 0 && number(inventory.days_of_cover_7d) < 14) ||
      number(inventory.oos_variant_rate) >= 0.5
    );
  }

  function hasHealthyStock(row) {
    const inventory = row.inventory;
    if (!inventory) return false;

    return (
      number(inventory.ending_inventory_units) >= 15 &&
      (number(inventory.daily_velocity_7d) <= 0 || number(inventory.days_of_cover_7d) >= 14) &&
      number(inventory.oos_variant_rate) < 0.5
    );
  }

  function hasFunnelShortfall(row) {
    return (
      number(row.view_to_cart_rate) < 0.08 ||
      number(row.cart_to_checkout_rate) < 0.35 ||
      number(row.view_to_purchase_rate) < 0.01
    );
  }

  function stockContext(row) {
    const inventory = row.inventory;
    if (!inventory) return `<span class="stock-context unknown">Not matched</span>`;

    const stock = number(inventory.ending_inventory_units);
    const cover = number(inventory.days_of_cover_7d);
    const oosRate = number(inventory.oos_variant_rate);
    const constrained = isStockConstrained(row);
    const label = constrained ? "Stock constrained" : hasHealthyStock(row) ? "Healthy stock" : "Watch stock";
    const tone = constrained ? "constrained" : hasHealthyStock(row) ? "healthy" : "watch";
    const coverText = cover >= 999 ? "no current velocity" : `${formatNumber(cover, 1)} days cover`;

    return `
      <span class="stock-context ${tone}">${escapeHtml(label)}</span>
      <small>${formatNumber(stock)} units · ${escapeHtml(coverText)} · ${formatPercent(oosRate)} sizes out of stock</small>
    `;
  }

  function sevenDaySellThrough(row) {
    const units = number(row.current_7d_units);
    const stock = Math.max(0, number(row.ending_inventory_units));
    return units + stock > 0 ? units / (units + stock) : "";
  }

  function trendStatus(metric, inverse = false) {
    if (!hasNumber(metric?.wow_pct)) return null;
    const adjusted = number(metric.wow_pct) * (inverse ? -1 : 1);
    if (adjusted >= 0.05) return { label: "Improving", tone: "healthy" };
    if (adjusted <= -0.05) return { label: "Needs focus", tone: "focus" };
    return { label: "Stable", tone: "inline" };
  }

  function kpiCard(label, metric, formatter, options = {}) {
    const wow = metric?.wow_pct;
    const trend = hasNumber(wow)
      ? `${Number(wow) > 0 ? "+" : ""}${formatPercent(wow)} vs last week`
      : "No prior-week comparison";
    const context = hasNumber(metric?.four_week_average)
      ? `4W average ${formatter(metric.four_week_average)} | ${formatPercent(metric.vs_four_week_average_pct)} vs 4W`
      : options.context || "Four-week benchmark unavailable";

    return `
      <article class="kpi-card">
        <span class="kpi-label">${escapeHtml(label)}</span>
        <div class="kpi-value">${formatter(metric?.current)}</div>
        <span class="trend ${trendClass(wow, options.inverse)}">${escapeHtml(trend)}</span>
        ${options.status ? statusBadge(options.status.label, options.status.tone) : ""}
        <p class="kpi-context">${context}</p>
        ${options.meaning ? `<p class="metric-meaning"><span>What this tells us:</span> ${escapeHtml(options.meaning)}</p>` : ""}
      </article>
    `;
  }

  function fact(label, value, meaning = "", status = null) {
    return `
      <div class="fact">
        <span>${escapeHtml(label)}</span>
        <strong>${value}</strong>
        ${status ? statusBadge(status.label, status.tone) : ""}
        ${meaning ? `<p class="metric-meaning"><span>What this tells us:</span> ${escapeHtml(meaning)}</p>` : ""}
      </div>
    `;
  }

  function pressureFact(label, value) {
    return `<div class="pressure-item"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`;
  }

  function inventoryKpi(label, value, context, tone = "", meaning = "") {
    return `
      <article class="inventory-kpi ${tone}">
        <span>${escapeHtml(label)}</span>
        <strong>${value}</strong>
        <small>${escapeHtml(context)}</small>
        ${meaning ? `<p class="metric-meaning"><span>What this tells us:</span> ${escapeHtml(meaning)}</p>` : ""}
      </article>
    `;
  }

  function metricGuide(items) {
    return `
      <div class="metric-guide">
        ${items.map(([term, meaning]) => `
          <div class="metric-guide-item">
            <strong>${escapeHtml(term)}</strong>
            ${escapeHtml(meaning)}
          </div>
        `).join("")}
      </div>
    `;
  }

  function humanizeLabel(value) {
    const text = clean(value);
    if (!text) return "";
    if (!/^[A-Z0-9_ -]+$/.test(text)) return text;
    return text
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function renderTable(columns, rows, emptyMessage = "No rows available for this week.") {
    if (!rows.length) return `<div class="empty">${escapeHtml(emptyMessage)}</div>`;
    return `
      <div class="table-wrap">
        <table>
          <thead><tr>${columns.map((column) => `<th>${escapeHtml(column.label)}${column.goal ? `<small>${escapeHtml(column.goal)}</small>` : ""}</th>`).join("")}</tr></thead>
          <tbody>
            ${rows.map((row) => `<tr>${columns.map((column) => `<td>${column.render(row)}</td>`).join("")}</tr>`).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function evidenceHeader(title, description) {
    return `
      <div class="evidence-title">
        <div><p class="kicker">Section detail</p><h3>${escapeHtml(title)}</h3></div>
        <p>${escapeHtml(description)}</p>
      </div>
    `;
  }

  function classifyDiagnosis(data) {
    const summary = data.summary || {};
    const combined = [
      summary.final_diagnosis,
      summary.main_driver,
      summary.shopify_main_problem_trigger,
      summary.ga4_main_funnel_problem,
      summary.meta_main_problem
    ].join(" ").toLowerCase();

    const choices = [
      ["Inventory constraint", ["inventory", "stockout", "out of stock", "restock", "availability"]],
      ["Returns pressure", ["return", "refund"]],
      ["Checkout friction", ["checkout", "payment"]],
      ["Product conversion", ["add-to-cart", "add to cart", "pdp", "product-view"]],
      ["Paid efficiency", ["meta", "roas", "paid acquisition", "creative fatigue"]],
      ["Traffic quality", ["traffic", "sessions", "landing-page"]]
    ];

    const match = choices.find(([, words]) => words.some((word) => combined.includes(word)));
    const label = match?.[0] || "Mixed performance";
    const action = data.actions?.[0] || {};
    const titles = {
      "Inventory constraint": "Protect demand from stockouts",
      "Returns pressure": "Reduce revenue lost after purchase",
      "Checkout friction": "Recover customers at checkout",
      "Product conversion": "Improve product-page conversion",
      "Paid efficiency": "Reduce inefficient paid spend",
      "Traffic quality": "Improve traffic volume and quality",
      "Mixed performance": "Choose the highest-confidence constraint"
    };
    const evidence = [
      summary.main_driver,
      summary.shopify_main_problem_trigger,
      summary.ga4_main_funnel_problem,
      summary.meta_main_problem
    ].filter(Boolean).slice(0, 3);

    return {
      label,
      title: titles[label],
      copy: summary.final_diagnosis || "No single dominant issue was isolated from the available report rows.",
      evidence: evidence.length ? evidence : ["The report does not contain a complete diagnosis for this week."],
      impact: action.expected_impact || summary.biggest_opportunity || "Focus the team on the highest-confidence business issue.",
      check: action.next_week_check || "Confirm that the selected KPI improves in the next completed week."
    };
  }

  function weekByStart(weekStart) {
    return reportWeeks.find((week) => clean(week.week_start) === clean(weekStart)) || null;
  }

  // Data availability for a week. Falls back to the deprecated sync_status alias
  // so the UI keeps working against a Worker that has not yet been redeployed.
  function weekDataStatus(week) {
    return clean(week?.data_status || week?.sync_status).toLowerCase();
  }

  // Run state, shown rather than enforced. A week can legitimately read
  // "data complete, last run failed" — a replay through the individual sync
  // endpoints does exactly that and leaves the audit row untouched on purpose.
  function weekRunBadge(week) {
    const runStatus = clean(week?.run_status).toLowerCase();
    if (!runStatus || runStatus === "none" || runStatus === "complete") return "";
    return ` — last run ${statusLabel(runStatus)}`;
  }

  // P1.12 freshness, also shown rather than enforced. "stale" means the report
  // row predates a source row it was derived from, so the week's numbers are
  // internally inconsistent — worth seeing, not worth hiding. "unknown" means a
  // synced_at was blank and the comparison could not be made; it is never
  // silently treated as fresh.
  function weekFreshnessBadge(week) {
    const freshness = clean(week?.freshness).toLowerCase();
    if (freshness === "stale") {
      const sources = (week?.stale_sources || []).join(", ");
      return sources ? ` — stale vs ${sources}` : " — stale";
    }
    if (freshness === "unknown") return " — freshness unknown";
    return "";
  }

  function selectableWeeks() {
    // Availability is a data question. A week whose Workflow run failed but
    // whose data is complete is viewable; run_status is shown as a badge.
    return reportWeeks.filter((week) => week.is_complete && weekDataStatus(week) === "complete");
  }

  function statusTone(status) {
    const normalized = clean(status).toLowerCase();
    if (normalized === "complete") return "complete";
    if (normalized === "running" || normalized === "queued" || normalized === "in_progress") return "progress";
    if (["failed", "errored", "terminated", "stalled"].includes(normalized)) return "failed";
    if (normalized === "partial") return "partial";
    return "empty";
  }

  function statusLabel(status) {
    const normalized = clean(status).toLowerCase();
    if (normalized === "complete") return "Complete";
    if (normalized === "running") return "In progress";
    if (normalized === "queued") return "Queued";
    if (normalized === "missing") return "Workflow missing";
    if (normalized === "errored") return "Errored";
    if (normalized === "terminated") return "Terminated";
    if (normalized === "stalled") return "Stalled";
    if (normalized === "failed") return "Failed";
    if (normalized === "partial") return "Partial";
    return "Not synced";
  }

  function renderSyncIndicator(data) {
    const run = data.sync_status || {};
    const week = weekByStart(data.week?.week_start) || {};
    const status = run.status || week.sync_status || (week.is_complete ? "complete" : "not_synced");
    const failedStep = run.current_step || week.failed_step || "";
    const message = run.error_message || week.error_message || "";
    const updatedAt = run.updated_at || week.updated_at || "";

    $("sync-status-badge").textContent = statusLabel(status);
    $("sync-status-badge").className = `sync-badge ${statusTone(status)}`;
    $("sync-status-detail").textContent =
      statusTone(status) === "failed" || statusTone(status) === "partial"
        ? [failedStep && `Step: ${failedStep}`, message, updatedAt && `Updated ${formatDate(updatedAt, true)}`].filter(Boolean).join(" | ")
        : updatedAt
          ? `Updated ${formatDate(updatedAt, true)}`
          : "Operational sync status";
  }

  function sourceText(label, status) {
    return `${label} ${statusLabel(status || "not_synced").toLowerCase()}`;
  }

  async function renderSyncProgress(week) {
    clearLoadingTimers();
    clearSyncPoll();
    $("loading-state").hidden = true;
    $("error-state").hidden = true;
    $("report").hidden = true;
    $("sync-state").hidden = false;

    let status = null;
    try {
      status = await apiGet("/sync-status", { week_start: week.week_start });
    } catch (error) {
      $("sync-message").textContent = clean(error?.message || error);
    }

    const run = status?.selected_run || week || {};
    const workflow = status?.selected_workflow_status || {};
    const workflowState = clean(workflow.status).toLowerCase();
    const terminalWorkflow = ["errored", "terminated"].includes(workflowState);
    const runStatus = terminalWorkflow ? "failed" : (run.status || week.sync_status || week.completeness || "queued");
    const tone = statusTone(runStatus);
    const weekEnd = run.week_end || week.week_end || "";
    const workflowError = clean(workflow.error?.message || workflow.rollback?.error?.message || "");
    const failureMessage = workflowError || clean(run.last_provider_error || run.error_message || week.error_message);
    activeSyncRunId = clean(run.run_id || week.run_id);

    $("sync-title").textContent =
      tone === "failed" ? "Weekly sync needs attention" :
      tone === "complete" ? "Weekly sync complete" :
      "Weekly sync is running";
    $("sync-subtitle").textContent =
      `${formatDateRange(run.week_start || week.week_start, weekEnd)} is ${statusLabel(runStatus).toLowerCase()}. ` +
      `The report will open automatically after the final completeness check passes.`;
    $("sync-panel-badge").textContent = statusLabel(runStatus);
    $("sync-panel-badge").className = `sync-badge ${tone}`;
    $("sync-current-step").textContent = run.current_step || "queued";
    $("sync-retry-count").textContent = formatNumber(run.retry_count || 0);
    $("sync-step-attempt").textContent = formatNumber(run.step_attempt || 0);
    $("sync-elapsed").textContent = formatElapsed(run.started_at, run.finished_at);
    $("sync-ga4").textContent = sourceText("GA4", run.ga4_status);
    $("sync-meta").textContent = sourceText("Meta", run.meta_status);
    $("sync-shopify").textContent = sourceText("Shopify", run.shopify_status);
    $("sync-report").textContent = sourceText("Report", run.report_status);

    const detail = [
      workflow.status && `Workflow: ${workflow.status}`,
      run.next_retry_at && `Next retry: ${formatDate(run.next_retry_at, true)}`,
      failureMessage
    ].filter(Boolean);
    $("sync-message").textContent = detail.join(" | ") || "Waiting for the next durable Workflow step update.";
    $("sync-error-detail").hidden = tone !== "failed";
    $("sync-error-step").textContent = run.current_step || week.failed_step || "Unknown step";
    $("sync-error-cause").textContent = failureMessage || "The Workflow stopped without recording an error message.";
    $("sync-retry-week").hidden = tone !== "failed" || !activeSyncRunId;

    if (tone === "complete") {
      await loadReportWeeks();
      await loadReport();
      return;
    }

    if (["queued", "running", "in_progress"].includes(clean(runStatus).toLowerCase())) {
      syncPollTimer = window.setTimeout(() => renderSyncProgress(week), 10000);
    }
  }

  async function retrySelectedWeek() {
    if (!activeSyncRunId) return;
    const button = $("sync-retry-week");
    button.disabled = true;
    button.textContent = "Retrying...";
    try {
      const result = await apiPost("/sync-retry", { run_id: activeSyncRunId });
      selectedWeek = clean(result.run?.week_start || selectedWeek);
      selectedWeekState = {
        ...(selectedWeekState || {}),
        ...(result.run || {}),
        sync_status: result.run?.status || "queued"
      };
      await renderSyncProgress(selectedWeekState);
    } catch (error) {
      $("sync-error-detail").hidden = false;
      $("sync-error-cause").textContent = clean(error?.message || error);
    } finally {
      button.disabled = false;
      button.textContent = "Retry this week";
    }
  }

  function renderWeekControls(data) {
    const select = $("week-select");
    const options = reportWeeks.map((week) => {
      const complete = week.is_complete && weekDataStatus(week) === "complete";
      const runBadge = `${weekRunBadge(week)}${weekFreshnessBadge(week)}`;
      const label = `${formatDateRange(week.week_start, week.week_end)}${complete ? runBadge : ` (${statusLabel(weekDataStatus(week) || week.completeness)})`}`;
      return `<option value="${escapeHtml(week.week_start)}" ${week.week_start === data.week.week_start ? "selected" : ""} ${complete ? "" : "disabled"}>${escapeHtml(label)}</option>`;
    });

    select.innerHTML = options.length
      ? options.join("")
      : `<option value="${escapeHtml(data.week.week_start)}">${escapeHtml(formatDateRange(data.week.week_start, data.week.week_end))}</option>`;

    const available = selectableWeeks();
    const index = available.findIndex((week) => week.week_start === data.week.week_start);
    $("previous-week").disabled = index < 0 || index >= available.length - 1;
    $("next-week").disabled = index <= 0;
    $("week-range-label").textContent = formatDateRange(data.week.week_start, data.week.week_end);
    renderSyncIndicator(data);
  }

  function goToWeek(weekStart) {
    if (!weekStart || weekStart === selectedWeek) return;
    selectedWeek = weekStart;
    setSelectedWeekInUrl(weekStart);
    loadReport();
  }

  async function syncLatestWeek() {
    const button = $("sync-latest");
    button.disabled = true;
    button.textContent = "Syncing...";
    try {
      const result = await apiPost("/sync-week", { week_start: "latest" });
      selectedWeek = result.resolved_week_start || selectedWeek;
      if (selectedWeek) setSelectedWeekInUrl(selectedWeek, true);
      await loadReportWeeks();
      await loadReport();
    } catch (error) {
      showError(clean(error?.message || error));
    } finally {
      button.disabled = false;
      button.textContent = "Sync latest";
    }
  }

  function renderLeadership(data) {
    const summary = data.summary || {};
    const currency = data.week?.currency || "EGP";
    const scoreboard = data.scoreboard || {};
    $("executive-summary").textContent = formatExecutiveSummary(data);
    $("decision-focus").textContent =
      formatNarrativeMetrics(
        summary.main_driver ||
        summary.final_diagnosis ||
        "Review the evidence and select one primary action."
      );
    $("date-range").textContent =
      `${formatDate(data.week.week_start)} to ${formatDate(data.week.week_end)}`;
    $("report-status").textContent = summary.report_status || "Report data available";
    $("synced-at").textContent = `Synced ${formatDate(summary.synced_at, true)}`;
    $("week-chip").textContent = `Week of ${formatDate(data.week.week_start)}`;
    $("footer-week").textContent = `${data.week.week_start} to ${data.week.week_end}`;
    renderWeekControls(data);
    $("caveats").hidden = true;
    $("caveat-list").innerHTML = "";

    $("leadership-kpis").innerHTML = [
      kpiCard("Net sales", scoreboard.net_sales, (v) => formatMoney(v, currency)),
      kpiCard("Orders", scoreboard.orders, formatNumber),
      kpiCard("AOV", scoreboard.aov, (v) => formatMoney(v, currency)),
      kpiCard("Conversion rate", scoreboard.conversion_rate, formatPercent, {
        meaning: "The share of GA4 sessions that became Shopify orders.",
        status: trendStatus(scoreboard.conversion_rate)
      }),
      kpiCard("MER", scoreboard.mer, formatMultiple, {
        meaning: "Shopify net sales generated for every 1 EGP spent on Meta.",
        status: trendStatus(scoreboard.mer)
      })
    ].join("");

    const shopify = data.revenue?.weekly || {};
    const skuRows = data.inventory?.skus || [];
    const soldStockouts = number(shopify.stockout_sold_skus);
    const lowCoverSkus = skuRows.filter((row) =>
      number(row.daily_velocity_7d) > 0 &&
      number(row.days_of_cover_7d) < 14
    ).length;

    $("inventory-kpis").innerHTML = [
      inventoryKpi(
        "Sold SKUs now out of stock",
        formatNumber(soldStockouts),
        `${formatPercent(shopify.sold_sku_oos_rate)} of ${formatNumber(shopify.sold_skus)} sold SKUs`,
        soldStockouts > 0 ? "alert" : "",
        "Proven-demand SKUs that cannot capture another sale until replenished."
      ),
      inventoryKpi(
        "Weekly sell-through",
        formatPercent(shopify.weekly_sell_through_rate),
        "Net units sold / (net units sold + ending stock)",
        "",
        "How quickly available inventory converted into sales this week."
      ),
      inventoryKpi(
        "Ending inventory",
        formatNumber(shopify.ending_inventory_units),
        "Units remaining across active SKUs"
      ),
      inventoryKpi(
        "Under 14 days cover",
        formatNumber(lowCoverSkus),
        "SKUs with current demand and low cover",
        lowCoverSkus > 0 ? "alert" : "",
        "Items likely to run out within 2 weeks if current demand continues."
      ),
      inventoryKpi(
        "Net items per order",
        formatNumber(shopify.net_items_per_order, 2),
        "Basket depth after returned units",
        "",
        "The average number of kept items in each order."
      )
    ].join("");

    if (data.warnings?.length) {
      $("caveats").hidden = false;
      $("caveat-list").innerHTML = data.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
    }
  }

  function renderDrivers(data) {
    const currency = data.week.currency || "EGP";
    const summary = data.summary || {};
    const shopify = data.revenue.weekly || {};
    const ga4 = data.funnel.weekly || {};
    const scoreboard = data.scoreboard || {};

    const drivers = [
      {
        number: "01",
        title: "Traffic",
        value: formatCompact(ga4.sessions),
        copy: `${formatCompact(ga4.users)} users and ${formatPercent(ga4.engagement_rate)} engagement rate.`
      },
      {
        number: "02",
        title: "Conversion",
        value: formatPercent(scoreboard.conversion_rate?.current),
        copy: `${formatPercent(ga4.atc_rate)} add-to-cart rate and ${formatPercent(ga4.checkout_completion_rate)} checkout completion.`
      },
      {
        number: "03",
        title: "Order value",
        value: formatMoney(scoreboard.aov?.current, currency),
        copy: `${formatNumber(shopify.net_items_per_order, 2)} net items per order.`
      }
    ];

    $("driver-tree").innerHTML = drivers.map((driver) => `
      <article class="driver-card">
        <span class="driver-number">${driver.number}</span>
        <h3>${driver.title}</h3>
        <div class="driver-value">${driver.value}</div>
        <p>${driver.copy}</p>
      </article>
    `).join("");

    $("pressure-strip").innerHTML = [
      pressureFact("Discount rate", formatPercent(shopify.discount_rate)),
      pressureFact("Refund rate", formatPercent(shopify.refund_rate)),
      pressureFact("Sold SKU out-of-stock rate", formatPercent(shopify.sold_sku_oos_rate)),
      pressureFact("Primary opportunity", escapeHtml(summary.biggest_opportunity || "Not isolated"))
    ].join("");
  }

  function renderDiagnosis(data) {
    const diagnosis = classifyDiagnosis(data);
    $("diagnosis-label").textContent = diagnosis.label;
    $("diagnosis-title").textContent = diagnosis.title;
    $("diagnosis-copy").textContent = formatNarrativeMetrics(diagnosis.copy);
    $("diagnosis-evidence").innerHTML = diagnosis.evidence
      .map((item) => `<li>${escapeHtml(formatNarrativeMetrics(item))}</li>`)
      .join("");
    $("diagnosis-impact").textContent = formatNarrativeMetrics(diagnosis.impact);
    $("diagnosis-check").textContent = formatNarrativeMetrics(diagnosis.check);
  }

  function diagnosisMetric(fields = {}, key, formatter = formatNumber) {
    const value = fields[key];
    return hasNumber(value) ? formatter(value) : "N/A";
  }

  function diagnosisTooltip(row) {
    const fields = row.evidence_fields || {};
    const explanation = row.classification_explanation || {};
    const classification = clean(row.classification);
    if (/Supply-constrained/.test(classification)) {
      return `Strong demand + low stock. Sold ${diagnosisMetric(fields, "units_sold")} units this week, ${diagnosisMetric(fields, "ending_inventory_units")} left. Cover: ${diagnosisMetric(fields, "days_of_cover_7d", (v) => `${formatNumber(v, 1)} days`)}.`;
    }
    if (/Demand\/conversion/.test(classification)) {
      return `Healthy stock with a measured funnel shortfall. Views: ${diagnosisMetric(fields, "item_views")}, ATC: ${diagnosisMetric(fields, "view_to_cart_rate", formatPercent)}, cart to checkout: ${diagnosisMetric(fields, "cart_to_checkout_rate", formatPercent)}, purchase: ${diagnosisMetric(fields, "view_to_purchase_rate", formatPercent)}.`;
    }
    if (/Unavailable/.test(classification)) {
      return `No sellable stock. This item is excluded from slow-moving and weak-sample decisions until availability returns.`;
    }
    if (/Low exposure|insufficient traffic|Weak sample/.test(classification)) {
      return `Sold ${diagnosisMetric(fields, "units_sold")} units but only ${diagnosisMetric(fields, "item_views")} views. Not enough traffic to diagnose demand yet.`;
    }
    if (/Return-risk/.test(classification)) {
      return `Return risk. Returned ${diagnosisMetric(fields, "returned_items")} units; return rate ${diagnosisMetric(fields, "return_rate_units", formatPercent)}. Cause is still a hypothesis.`;
    }
    if (/Slow-moving|Dead/.test(classification)) {
      return `High stock + weak movement. Stock: ${diagnosisMetric(fields, "ending_inventory_units")}; current 7d units: ${diagnosisMetric(fields, "current_7d_units")}.`;
    }
    return explanation.investigation_path || "Monitor. Evidence is not strong enough for a primary action.";
  }

  function diagnosisDetails(row) {
    const explanation = row.classification_explanation || {};
    const money = explanation.money || {};
    return `
      <details class="diagnosis-formula">
        <summary>Details</summary>
        <p><strong>Logic:</strong> ${escapeHtml(explanation.formula || "Classification formula unavailable.")}</p>
        <p><strong>Passed:</strong> ${escapeHtml(compactList(explanation.passed_thresholds))}</p>
        <p><strong>Failed:</strong> ${escapeHtml(compactList(explanation.failed_thresholds))}</p>
        <p><strong>Next-week money:</strong> ${money.amount ? `${escapeHtml(money.label || "EGP next week")} ${formatMoneyFull(money.amount, money.currency || reportData?.week?.currency)}` : `${escapeHtml(money.label || "Unquantified")} - ${escapeHtml(money.unquantified_reason || "No defensible estimate.")}`}</p>
      </details>
    `;
  }

  function diagnosisItem(row) {
    const fields = row.evidence_fields || {};
    const explanation = row.classification_explanation || {};
    const money = explanation.money || {};
    return `
      <article class="diagnosis-item has-tooltip"${tooltipAttr(diagnosisTooltip(row))}>
        <strong>${escapeHtml(row.entity_name || row.entity_id || "Unnamed entity")}</strong>
        <span class="diagnosis-class">${escapeHtml(row.classification || "Unclassified")}</span>
        <dl>
          <div><dt>Sales</dt><dd>${diagnosisMetric(fields, "net_sales", (v) => formatMoney(v, reportData?.week?.currency || "EGP"))}</dd></div>
          <div><dt>Units</dt><dd>${diagnosisMetric(fields, "units_sold")}</dd></div>
          <div><dt>Stock</dt><dd>${diagnosisMetric(fields, "ending_inventory_units")}</dd></div>
          <div><dt>Cover</dt><dd>${diagnosisMetric(fields, "days_of_cover_7d", (v) => `${formatNumber(v, 1)} days`)}</dd></div>
          <div><dt>Views</dt><dd>${diagnosisMetric(fields, "item_views")}</dd></div>
          <div><dt>ATC</dt><dd>${diagnosisMetric(fields, "view_to_cart_rate", formatPercent)}</dd></div>
          <div><dt>Checkout</dt><dd>${diagnosisMetric(fields, "cart_to_checkout_rate", formatPercent)}</dd></div>
          <div><dt>Purchase</dt><dd>${diagnosisMetric(fields, "view_to_purchase_rate", formatPercent)}</dd></div>
        </dl>
        <p>${escapeHtml(explanation.investigation_path || "Hover for formula, thresholds, and next-week money logic.")}</p>
        <small>${money.amount ? `${escapeHtml(money.label || "EGP next week")}: ${formatMoneyFull(money.amount, money.currency || reportData?.week?.currency)}` : escapeHtml(money.label || "Unquantified")}</small>
        ${diagnosisDetails(row)}
      </article>
    `;
  }

  function renderDiagnosisBucket(title, copy, rows, tooltip = "") {
    return `
      <section class="diagnosis-bucket">
        <h3>${escapeHtml(title)} <span class="diagnosis-count">${formatNumber(rows.length)}</span> <button type="button" class="info-dot has-tooltip" aria-label="${escapeHtml(title)} logic"${tooltipAttr(tooltip)}>i</button></h3>
        <p>${escapeHtml(copy)}</p>
        <div class="diagnosis-items">
          ${rows.length ? rows.slice(0, 5).map(diagnosisItem).join("") : `<div class="empty">No entities in this bucket for the selected week.</div>`}
        </div>
      </section>
    `;
  }

  function fallbackProductDiagnosis(data) {
    const productRows = new Map();
    for (const row of [
      ...(data.revenue?.products || []),
      ...(data.inventory?.products || [])
    ]) {
      const key = clean(row.product_id) || normalizedProductName(row.product_title);
      if (!key) continue;
      productRows.set(key, { ...(productRows.get(key) || {}), ...row });
    }
    const funnelByName = new Map(
      aggregateFunnelProducts(data.funnel?.products || [])
        .map((row) => [normalizedProductName(row.item_name), row])
    );
    const classifyProduct = (row) => {
      const funnel = funnelByName.get(normalizedProductName(row.product_title)) || null;
      const stockKnown = hasNumber(row.ending_inventory_units);
      const stock = stockKnown ? number(row.ending_inventory_units) : "";
      const units = number(row.units_sold || row.net_units_sold);
      const current7d = number(row.current_7d_units);
      const velocity = number(row.daily_velocity_7d);
      const cover = hasNumber(row.days_of_cover_7d) ? number(row.days_of_cover_7d) : "";
      const oosRate = hasNumber(row.oos_variant_rate) ? number(row.oos_variant_rate) : 0;
      const provenDemand = units >= 5 || current7d >= 5 || velocity >= 0.7;
      const healthyStock = stockKnown && stock >= 15 &&
        (velocity <= 0 || (cover !== "" && cover >= 14)) &&
        oosRate < 0.5;
      const funnelShortfall = funnel && (
        (hasNumber(funnel.view_to_cart_rate) && number(funnel.view_to_cart_rate) < 0.08) ||
        (hasNumber(funnel.cart_to_checkout_rate) && number(funnel.cart_to_checkout_rate) < 0.35) ||
        (hasNumber(funnel.view_to_purchase_rate) && number(funnel.view_to_purchase_rate) < 0.01)
      );
      let classification = "Weak sample / reject";
      let investigation = "Collect more qualified traffic before assigning a product problem.";
      if (stockKnown && stock <= 0) {
        classification = provenDemand ? "Supply-constrained continuity risk" : "Unavailable / no sellable stock";
        investigation = provenDemand
          ? "Protect demand until sellable stock returns."
          : "Do not judge movement while the product has no sellable stock.";
      } else if (provenDemand && (oosRate >= 0.5 || (cover !== "" && cover < 14))) {
        classification = "Supply-constrained continuity risk";
        investigation = "Restock constrained sizes or redirect demand before adding traffic.";
      } else if (funnel && number(funnel.item_views) >= 20 && healthyStock && funnelShortfall) {
        classification = "Demand/conversion-constrained";
        investigation = "Investigate the weakest measured PDP, cart, or purchase step while stock is healthy.";
      } else if (stockKnown && stock >= 15 && current7d <= 2) {
        classification = number(funnel?.item_views) < 20
          ? "Slow-moving / insufficient traffic"
          : units <= 0 ? "Dead or near-dead inventory" : "Slow-moving inventory";
        investigation = "Test qualified exposure before broad discounting.";
      } else if (stockKnown && stock > 0 && (units > 0 || number(funnel?.item_views) > 0)) {
        classification = "Healthy / monitor";
        investigation = "Monitor demand, stock cover, and variant availability.";
      }
      if (number(row.returned_items) >= 3 && hasNumber(row.return_rate_units) && number(row.return_rate_units) >= 0.12) {
        classification = "Return-risk product";
        investigation = "Investigate return reasons, fit, imagery, quality, and expectation mismatch.";
      }
      return {
        entity_type: "product",
        entity_id: clean(row.product_id || row.product_title),
        entity_name: clean(row.product_title || "Unnamed product"),
        classification,
        evidence_fields: { ...row, ...(funnel || {}) },
        classification_explanation: {
          formula: "Sales + stock/cover/OOS determine supply; aggregated GA4 traffic + funnel shortfall + healthy stock determine demand; zero stock is unavailable.",
          investigation_path: investigation
        }
      };
    };
    const classifyFallbackSku = (row) => {
      const stockKnown = hasNumber(row.ending_inventory_units);
      const stock = stockKnown ? number(row.ending_inventory_units) : "";
      const units = number(row.units_sold || row.net_units_sold);
      const current7d = number(row.current_7d_units);
      const velocity = number(row.daily_velocity_7d);
      const unavailable = clean(row.is_oos).toUpperCase() === "TRUE" || (stockKnown && stock <= 0);
      const provenDemand = units >= 5 || current7d >= 5 || velocity >= 0.7;
      let classification = "Weak sample / reject";
      if (unavailable) {
        classification = provenDemand ? "Supply-constrained winner" : "Unavailable / no sellable stock";
      } else if (stockKnown && stock >= 15 && current7d <= 2) {
        classification = units <= 0 ? "Dead or near-dead inventory" : "Slow-moving inventory";
      } else if (stockKnown && stock > 0 && (units > 0 || current7d > 0)) {
        classification = "Healthy / monitor";
      }
      if (number(row.returned_items) >= 3 && hasNumber(row.return_rate_units) && number(row.return_rate_units) >= 0.12) {
        classification = "Return-risk SKU";
      }
      return {
        entity_type: "sku",
        entity_id: clean(row.variant_id || row.sku),
        entity_name: clean(row.sku || row.variant_title || row.product_title),
        classification,
        evidence_fields: row,
        classification_explanation: {
          formula: "SKU demand + stock/OOS determine supply; zero stock without proven demand is unavailable.",
          investigation_path: unavailable
            ? "Keep unavailable SKUs out of slow-mover decisions."
            : "Monitor SKU movement and stock cover."
        }
      };
    };
    return {
      products: [...productRows.values()].map(classifyProduct),
      skus: (data.inventory?.skus || []).map(classifyFallbackSku)
    };
  }

  function renderProductDiagnosis(diagnosis) {
    const dx = diagnosis || fallbackProductDiagnosis(reportData || {});
    const rows = [...(dx.products || []), ...(dx.skus || [])];
    const by = (pattern) => rows.filter((row) => pattern.test(clean(row.classification)));
    const unavailable = rows.filter((row) => {
      const classification = clean(row.classification);
      const stock = row.evidence_fields?.ending_inventory_units;
      return /Unavailable/.test(classification) ||
        (hasNumber(stock) && number(stock) <= 0 && !/Supply-constrained|Return-risk/.test(classification));
    });
    const slowOrMonitor = by(/Healthy \/ monitor|Weak sample \/ reject|Slow-moving|Dead or near-dead|Low exposure/)
      .filter((row) => hasNumber(row.evidence_fields?.ending_inventory_units) && number(row.evidence_fields.ending_inventory_units) > 0);
    const sectionLogic = "Supply: proven demand + low stock/cover/OOS. Demand: at least 20 aggregated product views + healthy stock/size availability + a shortfall in ATC, cart-to-checkout, or view-to-purchase. Slow/monitor: sellable stock only. Zero-stock items are unavailable, never slow. Returns: returned units >= 3 + return rate >= 12%.";
    $("product-diagnosis-grid").innerHTML = [
      renderDiagnosisBucket(
        "Supply-constrained products/SKUs",
        "Proven demand with low stock or low stock cover. These create restock or demand-protection actions.",
        by(/Supply-constrained winner|Supply-constrained continuity risk/),
        sectionLogic
      ),
      renderDiagnosisBucket(
        "Demand/conversion-constrained",
        "Enough product traffic and healthy stock, but at least one measured funnel stage is weak. These call for PDP, offer, creative, cart, or merchandising work.",
        by(/Demand\/conversion-constrained/),
        sectionLogic
      ),
      renderDiagnosisBucket(
        "Returns / product quality risk",
        "Entities where returns or refunds are material enough to investigate as hypotheses, not assumed causes.",
        by(/Return-risk/),
        sectionLogic
      ),
      renderDiagnosisBucket(
        "Unavailable / no sellable stock",
        "Zero-stock products and SKUs are separated from movement analysis. They cannot be called slow while customers cannot buy them.",
        unavailable,
        sectionLogic
      ),
      renderDiagnosisBucket(
        "Slow-moving or low-confidence (in stock)",
        "Only sellable inventory appears here. These items need an exposure test, monitoring, or a stronger sample before becoming default actions.",
        slowOrMonitor,
        sectionLogic
      )
    ].join("");
  }

  function renderAiGoalSuggestions() {
    const target = $("ai-goal-suggestions");
    if (!target) return;
    target.innerHTML = aiSuggestedGoals.map((goal) =>
      `<button type="button" data-ai-goal="${escapeHtml(goal)}">${escapeHtml(goal)}</button>`
    ).join("");
  }

  function setAiReportStatus(message, type = "loading") {
    const status = $("ai-report-status");
    if (!status) return;
    status.hidden = false;
    status.className = `ai-report-status ${escapeHtml(type)}`;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-busy", type === "loading" ? "true" : "false");
    const labels = {
      error: "AI report unavailable",
      blocked: "AI report blocked",
      cached: "Saved AI report loaded",
      empty: "No saved AI report yet",
      loading: "Checking saved AI report"
    };
    status.innerHTML = `
      <span class="ai-status-indicator" aria-hidden="true"></span>
      <div><strong>${escapeHtml(labels[type] || labels.loading)}</strong><p>${escapeHtml(message)}</p></div>
    `;
  }

  function clearAiReportStatus() {
    const status = $("ai-report-status");
    if (!status) return;
    status.hidden = true;
    status.textContent = "";
  }

  function updateAiGenerationControls() {
    const disabled = !reportData?.week?.week_start || aiReportState.lookupInProgress || aiReportState.generationInProgress;
    [$("ai-generate-general"), $("ai-generate-goal")].forEach((button) => {
      if (button) button.disabled = disabled;
    });
    const regenerate = $("ai-report-regenerate");
    if (regenerate) regenerate.disabled = disabled || !aiReportState.lastReport;
  }

  function beginAiReportLookup(message) {
    aiReportState.lookupInProgress = true;
    aiReportState.lastReport = null;
    aiReportState.productIntelligence = null;
    aiReportState.adsCreativeIntelligence = null;
    $("ai-report-card").hidden = true;
    $("ai-report-output").hidden = true;
    setAiReportStatus(message, "loading");
    updateAiGenerationControls();
  }

  function mappingProductKey(product = {}) {
    return clean(product.product_id || product.product_title).toLowerCase();
  }

  function mappingProducts() {
    const byKey = new Map();
    for (const product of [
      ...(reportData?.revenue?.products || []),
      ...(reportData?.inventory?.products || [])
    ]) {
      const key = mappingProductKey(product);
      if (!key) continue;
      byKey.set(key, { ...(byKey.get(key) || {}), ...product });
    }
    return [...byKey.values()].sort((a, b) =>
      number(b.net_sales) - number(a.net_sales) ||
      clean(a.product_title).localeCompare(clean(b.product_title))
    );
  }

  function adMappingResolved(ad = {}) {
    return (ad.mapped_products || []).length > 0 &&
      number(ad.mapping_confidence) >= 80 &&
      !/unmapped|needs_manual_review|dynamic_catalogue|invalid/i.test(clean(ad.mapping_state));
  }

  function adMappingPriority(ad = {}) {
    if (!adMappingResolved(ad)) return 0;
    if (clean(ad.mapping_method) !== "manual") return 1;
    return 2;
  }

  function adMappingRows() {
    const query = clean(adMappingState.search).toLowerCase();
    return (reportData?.creative?.ads || [])
      .filter((ad) => {
        const resolved = adMappingResolved(ad);
        if (adMappingState.filter === "unresolved" && resolved) return false;
        if (adMappingState.filter === "mapped" && !resolved) return false;
        if (!query) return true;
        const haystack = [
          ad.ad_name,
          ad.campaign_name,
          ad.adset_name,
          ...(ad.mapped_products || []).map((product) => product.product_title)
        ].map(clean).join(" ").toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) =>
        adMappingPriority(a) - adMappingPriority(b) ||
        number(b.spend) - number(a.spend) ||
        clean(a.ad_name).localeCompare(clean(b.ad_name))
      );
  }

  function adMappingPage(rows = []) {
    const pageCount = Math.max(1, Math.ceil(rows.length / adMappingState.pageSize));
    adMappingState.page = Math.max(1, Math.min(adMappingState.page, pageCount));
    const start = (adMappingState.page - 1) * adMappingState.pageSize;
    return {
      pageCount,
      start,
      end: Math.min(rows.length, start + adMappingState.pageSize),
      rows: rows.slice(start, start + adMappingState.pageSize)
    };
  }

  function adFormatLabel(ad = {}) {
    const format = clean(ad.ad_format || "unknown");
    return format === "catalogue" ? "Catalogue" : format === "video" ? "Video" : format === "static" ? "Static" : "Format unknown";
  }

  function renderAdMappingCard(ad, products, currency) {
    const selectedKeys = new Set((ad.mapped_products || []).map(mappingProductKey));
    const resolved = adMappingResolved(ad);
    const pickerProducts = products.slice().sort((a, b) => {
      const aSelected = selectedKeys.has(mappingProductKey(a)) ? 0 : 1;
      const bSelected = selectedKeys.has(mappingProductKey(b)) ? 0 : 1;
      return aSelected - bSelected || number(b.net_sales) - number(a.net_sales);
    });
    const previewLabel = `Open full-screen preview for ${clean(ad.ad_name || "ad")}`;
    const thumbnailReason = clean(ad.thumbnail_unavailable_reason || "Meta did not return an image for this ad.");
    const thumbnail = clean(ad.thumbnail_url)
      ? `<button type="button" class="ad-mapping-thumbnail" data-preview-ad="${escapeHtml(ad.ad_id)}" aria-label="${escapeHtml(previewLabel)}"><img src="${escapeHtml(ad.thumbnail_url)}" alt="" loading="lazy"></button>`
      : `<button type="button" class="ad-mapping-thumbnail unavailable has-tooltip" data-preview-ad="${escapeHtml(ad.ad_id)}" aria-label="${escapeHtml(previewLabel)}"${tooltipAttr(thumbnailReason)}><span><strong>Image unavailable</strong><small>Open preview</small></span></button>`;
    const mappedProducts = (ad.mapped_products || []).map((product) =>
      `<span>${escapeHtml(product.product_title || product.product_id)}</span>`
    ).join("");
    return `
      <article class="ad-mapping-card ${resolved ? "resolved" : "unresolved"}" data-ad-mapping-card="${escapeHtml(ad.ad_id)}">
        ${thumbnail}
        <div class="ad-mapping-main">
          <header>
            <div>
              <div class="ad-mapping-badges">
                <span class="${resolved ? "resolved" : "unresolved"}">${resolved ? "Mapped" : "Unresolved"}</span>
                <span>${escapeHtml(adFormatLabel(ad))}</span>
                <span>${escapeHtml(clean(ad.mapping_method) === "manual" ? "Manual" : clean(ad.mapping_method) ? "Automatic" : "No match")}</span>
              </div>
              <h3><button type="button" class="ad-preview-title" data-preview-ad="${escapeHtml(ad.ad_id)}">${escapeHtml(ad.ad_name || "Unnamed ad")}</button></h3>
              <p>${escapeHtml(ad.campaign_name || "Campaign unavailable")} / ${escapeHtml(ad.adset_name || "Ad set unavailable")}</p>
            </div>
            <button class="icon-btn" type="button" data-ad-map-toggle="${escapeHtml(ad.ad_id)}" aria-label="Map products to ${escapeHtml(ad.ad_name || "ad")}">+</button>
          </header>
          <div class="ad-mapping-metrics">
            <span><b>Spend</b>${formatMoney(ad.spend, currency)}</span>
            <span><b>ROAS</b>${formatMultiple(ad.roas)}</span>
            <span><b>Purchases</b>${formatNumber(ad.purchases)}</span>
            <span><b>CTR</b>${formatPercent(ad.ctr_link)}</span>
          </div>
          <div class="ad-mapped-products">${mappedProducts || `<span class="empty-map">No verified product</span>`}</div>
          <div class="ad-product-picker" data-ad-product-picker hidden>
            <div class="ad-product-picker-head">
              <input type="search" data-ad-product-search placeholder="Search products" aria-label="Search products for ${escapeHtml(ad.ad_name || "ad")}">
              <span>${ad.multi_product_mapping_allowed ? "Multiple products" : "One product"}</span>
            </div>
            <div class="ad-product-options">
              ${pickerProducts.map((product) => {
                const key = mappingProductKey(product);
                const title = clean(product.product_title || product.product_id || "Unnamed product");
                return `
                  <label data-ad-product-option="${escapeHtml(title.toLowerCase())}">
                    <input type="checkbox" data-ad-product-checkbox value="${escapeHtml(key)}"${selectedKeys.has(key) ? " checked" : ""}>
                    <span><strong>${escapeHtml(title)}</strong><small>${formatNumber(product.ending_inventory_units)} stock / ${formatMoney(product.net_sales, currency)} sales</small></span>
                  </label>
                `;
              }).join("") || `<div class="empty">No products are available for this week.</div>`}
            </div>
            <div class="ad-product-picker-actions">
              <button type="button" data-ad-map-save="${escapeHtml(ad.ad_id)}">Save</button>
              <button type="button" class="secondary" data-ad-map-cancel>Cancel</button>
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function renderAdMappingWorkspace() {
    const list = $("ad-mapping-list");
    if (!list || !reportData) return;
    const ads = reportData.creative?.ads || [];
    const resolvedCount = ads.filter(adMappingResolved).length;
    $("ad-mapping-total").textContent = formatNumber(ads.length);
    $("ad-mapping-mapped").textContent = formatNumber(resolvedCount);
    $("ad-mapping-unresolved").textContent = formatNumber(ads.length - resolvedCount);
    const rows = adMappingRows();
    const page = adMappingPage(rows);
    list.innerHTML = page.rows.length
      ? page.rows.map((ad) => renderAdMappingCard(ad, mappingProducts(), reportData.week?.currency || "EGP")).join("")
      : `<div class="ad-mapping-empty"><strong>No ads in this view</strong><p>Change the filter or search term.</p></div>`;
    $("ad-mapping-page").textContent = `Page ${formatNumber(adMappingState.page)} of ${formatNumber(page.pageCount)} · ${rows.length ? `${formatNumber(page.start + 1)}-${formatNumber(page.end)}` : "0"} of ${formatNumber(rows.length)}`;
    $("ad-mapping-previous").disabled = adMappingState.page <= 1;
    $("ad-mapping-next").disabled = adMappingState.page >= page.pageCount;
    document.querySelectorAll("[data-ad-mapping-filter]").forEach((button) => {
      button.classList.toggle("active", clean(button.dataset.adMappingFilter) === adMappingState.filter);
    });
    wireAdMappingCards();
  }

  function setAdMappingStatus(message, type = "") {
    const target = $("ad-mapping-status");
    if (!target) return;
    target.textContent = clean(message);
    target.className = `ad-mapping-status ${clean(type)}`;
  }

  async function refreshCreativeMetadataForWeek() {
    if (!reportData?.week?.week_start) return;
    const visibleCards = [...document.querySelectorAll("[data-ad-mapping-card]")];
    const cardsMissingImages = visibleCards.filter((card) => !card.querySelector("img"));
    const targetCards = cardsMissingImages.length ? cardsMissingImages : visibleCards;
    const visibleAdIds = [...new Set(targetCards
      .map((card) => clean(card.dataset.adMappingCard))
      .filter(Boolean))]
      .slice(0, 24);
    const buttons = [
      $("ad-mapping-refresh-creatives"),
      document.getElementById("creative-refresh")
    ].filter(Boolean);
    buttons.forEach((button) => {
      button.disabled = true;
      button.dataset.originalLabel = button.textContent;
      button.textContent = "Refreshing";
    });
    setAdMappingStatus(
      visibleAdIds.length
        ? `Fetching Meta creative images for ${formatNumber(visibleAdIds.length)} ad${visibleAdIds.length === 1 ? "" : "s"} on this page...`
        : "Fetching missing Meta creative images for this week..."
    );
    try {
      const result = await apiPost("/creative-metadata/refresh", {}, {
        week_start: reportData.week.week_start,
        ad_ids: visibleAdIds
      });
      reportData = await apiGet("/report-data", { week_start: reportData.week.week_start });
      renderAdMappingWorkspace();
      renderEvidence(reportData);
      const stored = (result.stored_ids || []).length;
      const storedImages = (result.stored_image_ids || []).length;
      const errors = (result.errors || []).length;
      setAdMappingStatus(
        storedImages
          ? `Saved ${formatNumber(storedImages)} creative image${storedImages === 1 ? "" : "s"}${errors ? `; ${formatNumber(errors)} ads still need Meta metadata` : ""}.`
          : stored
            ? `Refreshed ${formatNumber(stored)} creative record${stored === 1 ? "" : "s"}. Meta returned dynamic previews but no new static card images.`
          : clean(result.unavailable_reason || "Meta did not return creative images for this week."),
        stored ? "success" : "error"
      );
    } catch (error) {
      setAdMappingStatus(clean(error?.message || error), "error");
    } finally {
      buttons.forEach((button) => {
        button.disabled = false;
        button.textContent = button.dataset.originalLabel || "Refresh images";
      });
    }
  }

  function selectedMappingProducts(card) {
    const products = new Map(mappingProducts().map((product) => [mappingProductKey(product), product]));
    return [...card.querySelectorAll("[data-ad-product-checkbox]:checked")]
      .map((input) => products.get(clean(input.value)))
      .filter(Boolean)
      .map((product) => ({
        product_id: clean(product.product_id),
        product_title: clean(product.product_title)
      }));
  }

  async function saveAdMappingSet(adId, card, button) {
    const ad = (reportData?.creative?.ads || []).find((row) => clean(row.ad_id) === clean(adId));
    if (!ad || adMappingState.savingAdId) return;
    const products = selectedMappingProducts(card);
    if (products.length > 1 && !ad.multi_product_mapping_allowed) {
      setAdMappingStatus("Only video or catalogue ads can be mapped to several products.", "error");
      return;
    }
    adMappingState.savingAdId = adId;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Saving";
    setAdMappingStatus(`Saving ${ad.ad_name || "ad"}...`);
    try {
      await apiPost("/ad-product-mappings", {}, {
        week_start: reportData.week.week_start,
        ad_id: adId,
        ad_name: ad.ad_name,
        product_mappings: products,
        source: "report-mapping-workspace"
      });
      reportData = await apiGet("/report-data", { week_start: reportData.week.week_start });
      renderAdMappingWorkspace();
      renderEvidence(reportData);
      if (aiReportState.lastReport) await loadCachedAiReport(aiReportState.mode || "general");
      setAdMappingStatus(`Saved ${products.length} product mapping${products.length === 1 ? "" : "s"} for ${ad.ad_name || "ad"}.`, "success");
    } catch (error) {
      setAdMappingStatus(clean(error?.message || error), "error");
      button.disabled = false;
      button.textContent = original;
    } finally {
      adMappingState.savingAdId = "";
    }
  }

  function wireAdMappingCards() {
    document.querySelectorAll("[data-ad-mapping-card]").forEach((card) => {
      const adId = clean(card.getAttribute("data-ad-mapping-card"));
      const ad = (reportData?.creative?.ads || []).find((row) => clean(row.ad_id) === adId) || {};
      card.querySelector("[data-ad-map-toggle]")?.addEventListener("click", () => {
        const picker = card.querySelector("[data-ad-product-picker]");
        if (picker) picker.hidden = !picker.hidden;
      });
      card.querySelector("[data-ad-map-cancel]")?.addEventListener("click", () => {
        const picker = card.querySelector("[data-ad-product-picker]");
        if (picker) picker.hidden = true;
      });
      card.querySelector("[data-ad-product-search]")?.addEventListener("input", (event) => {
        const query = clean(event.target.value).toLowerCase();
        card.querySelectorAll("[data-ad-product-option]").forEach((option) => {
          option.hidden = query && !clean(option.getAttribute("data-ad-product-option")).includes(query);
        });
      });
      card.querySelectorAll("[data-ad-product-checkbox]").forEach((input) => {
        input.addEventListener("change", () => {
          if (!input.checked || ad.multi_product_mapping_allowed) return;
          card.querySelectorAll("[data-ad-product-checkbox]").forEach((other) => {
            if (other !== input) other.checked = false;
          });
        });
      });
      card.querySelector("[data-ad-map-save]")?.addEventListener("click", (event) =>
        saveAdMappingSet(adId, card, event.currentTarget)
      );
      card.querySelectorAll("[data-preview-ad]").forEach((button) => {
        button.addEventListener("click", () => openCreativePreview(adId));
      });
    });
  }

  function initAdMappingControls() {
    $("ad-mapping-search")?.addEventListener("input", (event) => {
      adMappingState.search = clean(event.target.value);
      adMappingState.page = 1;
      renderAdMappingWorkspace();
    });
    document.querySelectorAll("[data-ad-mapping-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        adMappingState.filter = clean(button.dataset.adMappingFilter || "unresolved");
        adMappingState.page = 1;
        renderAdMappingWorkspace();
      });
    });
    $("ad-mapping-previous")?.addEventListener("click", () => {
      adMappingState.page -= 1;
      renderAdMappingWorkspace();
    });
    $("ad-mapping-next")?.addEventListener("click", () => {
      adMappingState.page += 1;
      renderAdMappingWorkspace();
    });
    $("ad-mapping-refresh-creatives")?.addEventListener("click", refreshCreativeMetadataForWeek);
  }

  function aiBulletList(items = []) {
    const list = (items || []).map(clean).filter(Boolean);
    return list.length
      ? `<ul>${list.map((item) => `<li>${escapeHtml(formatNarrativeMetrics(item))}</li>`).join("")}</ul>`
      : `<p class="muted">No item generated.</p>`;
  }

  function renderAiActionPlan(actions = []) {
    const list = (actions || []).slice(0, 7);
    if (!list.length) return `<p class="muted">No action plan generated.</p>`;
    return `<ol class="ai-action-list">${list.map((action) => `
      <li>
        <strong>${escapeHtml(action.action || "Action")}</strong>
        <p>${escapeHtml(formatNarrativeMetrics(action.why_it_matters || action.why || ""))}</p>
        <div class="ai-action-kv">
          <span><b>Owner</b>${escapeHtml(action.owner || "Unassigned")}</span>
          <span><b>Proof</b>${escapeHtml(formatNarrativeMetrics(action.proof || action.evidence || "Not recorded"))}</span>
          <span><b>Expected result</b>${escapeHtml(formatNarrativeMetrics(action.expected_result || action.expected_metric_impact || "N/A"))}</span>
          <span><b>Success</b>${escapeHtml(formatNarrativeMetrics(action.success_threshold || "Define threshold"))}</span>
          <span><b>Stop</b>${escapeHtml(formatNarrativeMetrics(action.stop_condition || "Define stop condition"))}</span>
          <span><b>Confidence</b>${escapeHtml(action.confidence || "low")}</span>
          <span><b>Next-week EGP</b>${escapeHtml(formatNarrativeMetrics(action.egp_risk_or_upside_next_week || "Unquantified"))}</span>
        </div>
      </li>
    `).join("")}</ol>`;
  }

  function renderAiAnalystConclusion(report = {}) {
    const conclusion = report.analyst_conclusion || {};
    const rows = [
      ["Diagnosis", conclusion.diagnosis || aiFirstText(report.analyst_read || report.executive_summary, "No diagnosis generated.")],
      ["Main decision", conclusion.main_decision || report.main_decision || "No decision generated."],
      ["Biggest risk", conclusion.biggest_risk || aiFirstText(report.next_week_implications || report.risks_opportunities_next_week, "No risk generated.")],
      ["Biggest opportunity", conclusion.biggest_opportunity || "No opportunity generated."]
    ];
    return `
      <section class="ai-analyst-conclusion" aria-label="Analyst conclusion">
        <div class="ai-conclusion-main">
          <span>Senior analyst read</span>
          <strong>${escapeHtml(formatNarrativeMetrics(rows[0][1]))}</strong>
        </div>
        <div class="ai-conclusion-grid">
          ${rows.slice(1).map(([label, value]) => `
            <article>
              <span>${escapeHtml(label)}</span>
              <p>${escapeHtml(formatNarrativeMetrics(value))}</p>
            </article>
          `).join("")}
        </div>
      </section>
    `;
  }

  function renderAiProofStrip(insights = {}) {
    const cards = (insights.proof_cards || []).slice(0, 6);
    if (!cards.length) return "";
    return `
      <section class="ai-proof-strip" aria-label="Conclusive proof">
        <div class="ai-section-head">
          <h3>Conclusive proof</h3>
          <p>Deterministic evidence cards that support the analyst memo before the prose begins.</p>
        </div>
        <div class="ai-proof-grid">
          ${cards.map((card) => `
            <article class="ai-proof-card ${escapeHtml(card.type || "neutral")}">
              <div>
                <span>${escapeHtml(card.title || "Proof")}</span>
                <strong>${escapeHtml(card.label || "Signal")}</strong>
              </div>
              <ul>
                ${(card.stats || []).slice(0, 3).map((stat) => `<li>${escapeHtml(formatNarrativeMetrics(stat))}</li>`).join("")}
              </ul>
              <p>${escapeHtml(formatNarrativeMetrics(card.meaning || ""))}</p>
              <a href="${escapeHtml(card.anchor || "#evidence")}">Open evidence</a>
            </article>
          `).join("")}
        </div>
      </section>
    `;
  }

  function aiMetricTrend(metric = {}) {
    if (!hasNumber(metric.wow_pct)) return "";
    const value = number(metric.wow_pct);
    return `<span class="ai-metric-trend ${value >= 0 ? "up" : "down"}">${value >= 0 ? "+" : ""}${formatPercent(value)} WoW</span>`;
  }

  function aiMetricCard(label, metric = {}, formatter = formatNumber, note = "") {
    return `
      <div class="ai-metric-card">
        <span>${escapeHtml(label)}</span>
        <strong>${formatter(metric?.current ?? metric)}</strong>
        ${metric && typeof metric === "object" ? aiMetricTrend(metric) : ""}
        ${note ? `<small>${escapeHtml(note)}</small>` : ""}
      </div>
    `;
  }

  function aiVisualWidth(value, max, floor = 6) {
    return Math.max(floor, Math.min(100, Math.round((number(value) / Math.max(1, number(max))) * 100)));
  }

  function aiFirstText(items = [], fallback = "No signal generated.") {
    return clean((Array.isArray(items) ? items : []).find((item) => clean(item)) || fallback);
  }

  function aiQuickRead(report = {}) {
    const cards = [
      ["Analyst read", aiFirstText(report.analyst_read || report.executive_summary, "No analyst read generated.")],
      ["Actually working", aiFirstText(report.what_is_working || report.what_worked, "No clear win generated.")],
      ["Actually broken", aiFirstText(report.what_is_broken || report.what_did_not_work, "No core problem generated.")],
      ["Next week", aiFirstText(report.next_week_implications || report.risks_opportunities_next_week, "No next-week implication generated.")]
    ];
    return `
      <section class="ai-quick-read" aria-label="AI report quick read">
        <div class="ai-section-head">
          <h3>One-minute read</h3>
          <p>Skim these first, then use the sections below for detail and evidence.</p>
        </div>
        <div class="ai-quick-grid">
          ${cards.map(([label, value]) => `
            <article>
              <span>${escapeHtml(label)}</span>
              <p>${escapeHtml(formatNarrativeMetrics(value))}</p>
            </article>
          `).join("")}
        </div>
      </section>
    `;
  }

  function aiTopProductsChart(products = [], currency = "EGP") {
    const rows = (products || [])
      .filter((row) => hasNumber(row.net_sales))
      .sort((a, b) => number(b.net_sales) - number(a.net_sales))
      .slice(0, 6);
    if (!rows.length) return `<p class="muted">No product revenue chart available.</p>`;
    const max = Math.max(...rows.map((row) => number(row.net_sales)), 1);
    return `
      <div class="ai-bar-chart" aria-label="Top products by net sales">
        ${rows.map((row) => {
          const width = aiVisualWidth(row.net_sales, max);
          return `
            <div class="ai-bar-row">
              <span>${escapeHtml(row.product_title || row.item_name || "Unnamed product")}</span>
              <div><i style="width:${width}%"></i></div>
              <strong>${formatMoney(row.net_sales, currency)}</strong>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function aiFunnelChart(data = {}) {
    const weekly = data.funnel?.weekly || {};
    const steps = [
      ["Sessions", weekly.sessions],
      ["Product views", weekly.view_item_events],
      ["Add to carts", weekly.add_to_cart_events],
      ["Checkout starts", weekly.begin_checkout_events],
      ["GA4 purchases", weekly.purchase_events],
      ["Shopify orders", data.revenue?.weekly?.orders]
    ].filter(([, value]) => hasNumber(value));
    if (!steps.length) return `<p class="muted">No funnel chart available.</p>`;
    const max = Math.max(...steps.map(([, value]) => number(value)), 1);
    return `
      <div class="ai-funnel-chart" aria-label="Funnel progression">
        ${steps.map(([label, value]) => {
          const width = aiVisualWidth(value, max, 8);
          return `
            <div class="ai-funnel-step">
              <div><span>${escapeHtml(label)}</span><strong>${formatCompact(value)}</strong></div>
              <i style="width:${width}%"></i>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function aiPaidEfficiencyChart(data = {}) {
    const currency = data.week?.currency || "EGP";
    const rows = (data.paid?.campaigns || [])
      .filter((row) => hasNumber(row.spend) || hasNumber(row.purchase_value))
      .sort((a, b) => number(b.spend) - number(a.spend))
      .slice(0, 5);
    if (!rows.length) return `<p class="muted">No campaign efficiency chart available.</p>`;
    const max = Math.max(...rows.map((row) => number(row.spend)), 1);
    return `
      <div class="ai-bar-chart ai-paid-chart" aria-label="Paid campaign spend and ROAS">
        ${rows.map((row) => `
          <div class="ai-bar-row">
            <span>${escapeHtml(row.campaign_name || "Unnamed campaign")}</span>
            <div><i style="width:${aiVisualWidth(row.spend, max)}%"></i></div>
            <strong>${formatMoney(row.spend, currency)} / ${formatMultiple(row.roas)}</strong>
          </div>
        `).join("")}
      </div>
    `;
  }

  function aiCreativeScaleChart(data = {}) {
    const ads = data.creative?.ads || [];
    const buckets = [
      ["Blocked", ads.filter((ad) => /do_not_scale|blocked|risk/i.test(clean(ad.scale_state))).length],
      ["Mapped", ads.filter((ad) => /mapped_product|multiple_mapped_products/i.test(clean(ad.mapping_state))).length],
      ["Review", ads.filter((ad) => /needs_manual_review|unmapped|dynamic/i.test(clean(ad.mapping_state))).length],
      ["Spend with stock risk", ads.filter((ad) => /inventory|stock/i.test(clean(ad.scale_state || ad.scale_explanation))).length]
    ];
    const max = Math.max(...buckets.map(([, value]) => value), 1);
    if (!ads.length) return `<p class="muted">No creative scale chart available.</p>`;
    return `
      <div class="ai-bar-chart ai-creative-chart" aria-label="Creative scale readiness">
        ${buckets.map(([label, value]) => `
          <div class="ai-bar-row">
            <span>${escapeHtml(label)}</span>
            <div><i style="width:${aiVisualWidth(value, max)}%"></i></div>
            <strong>${formatNumber(value)}</strong>
          </div>
        `).join("")}
      </div>
    `;
  }

  function aiActionMetricChart(actions = []) {
    const counts = new Map();
    for (const action of actions || []) {
      const key = clean(action.expected_result || action.expected_metric_impact || "Unspecified result");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const rows = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6);
    if (!rows.length) return `<p class="muted">No action emphasis chart available.</p>`;
    const max = Math.max(...rows.map(([, value]) => value), 1);
    return `
      <section class="ai-action-emphasis" aria-label="Action emphasis by metric">
        <div class="ai-section-head">
          <h3>Action emphasis</h3>
          <p>Where the generated recommendations concentrate, by expected metric impact.</p>
        </div>
        <div class="ai-bar-chart">
          ${rows.map(([label, value]) => `
            <div class="ai-bar-row">
              <span>${escapeHtml(humanizeLabel(label))}</span>
              <div><i style="width:${aiVisualWidth(value, max, 12)}%"></i></div>
              <strong>${formatNumber(value)} action${value === 1 ? "" : "s"}</strong>
            </div>
          `).join("")}
        </div>
      </section>
    `;
  }

  function aiRiskOpportunityStrip(data = {}) {
    const currency = data.week?.currency || "EGP";
    const weekly = data.revenue?.weekly || {};
    const paid = data.paid?.weekly || {};
    const topProduct = (data.revenue?.products || [])
      .slice()
      .sort((a, b) => number(b.net_sales) - number(a.net_sales))[0] || {};
    const refundRate = weekly.refund_rate ?? data.returns?.refund_rate;
    const checkoutStart = data.funnel?.weekly?.checkout_start_rate;
    const chips = [
      ["Inventory watch", topProduct.product_title ? `${topProduct.product_title}: ${formatNumber(topProduct.ending_inventory_units)} units left` : "No top product stock signal"],
      ["Paid efficiency", `ROAS ${formatMultiple(paid.roas)}; spend ${formatMoney(paid.spend, currency)}`],
      ["Checkout friction", `Checkout start ${formatPercent(checkoutStart)} vs 35% goal`],
      ["Return quality", `Refund rate ${formatPercent(refundRate)}`]
    ];
    return `<div class="ai-signal-strip">${chips.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>`;
  }

  function renderAiDecisionDashboard(report) {
    const data = reportData || {};
    const currency = data.week?.currency || "EGP";
    const scoreboard = data.scoreboard || {};
    const paid = data.paid?.weekly || {};
    const weekly = data.revenue?.weekly || {};
    return `
      <section class="ai-decision-dashboard">
        <div class="ai-dashboard-head">
          <div>
            <h3>Commercial snapshot</h3>
            <p>Decision-grade metrics from the selected week, paired with the AI narrative below.</p>
          </div>
          <strong>${escapeHtml(data.week?.week_start || selectedWeek || "")}</strong>
        </div>
        <div class="ai-metric-grid">
          ${aiMetricCard("Net sales", scoreboard.net_sales, (v) => formatMoneyFull(v, currency))}
          ${aiMetricCard("Orders", scoreboard.orders, formatNumber)}
          ${aiMetricCard("Units", { current: weekly.units_sold, wow_pct: weekly.units_sold_wow_pct }, formatNumber)}
          ${aiMetricCard("AOV", scoreboard.aov, (v) => formatMoneyFull(v, currency))}
          ${aiMetricCard("MER", scoreboard.mer, formatMultiple)}
          ${aiMetricCard("Meta ROAS", paid.roas, formatMultiple)}
        </div>
        <div class="ai-visual-grid">
          <div class="ai-visual-panel">
            <h3>Revenue concentration</h3>
            ${aiTopProductsChart(data.revenue?.products, currency)}
          </div>
          <div class="ai-visual-panel">
            <h3>Funnel progression</h3>
            ${aiFunnelChart(data)}
          </div>
          <div class="ai-visual-panel">
            <h3>Paid efficiency</h3>
            ${aiPaidEfficiencyChart(data)}
          </div>
          <div class="ai-visual-panel">
            <h3>Creative scale readiness</h3>
            ${aiCreativeScaleChart(data)}
          </div>
        </div>
        ${aiRiskOpportunityStrip(data)}
      </section>
      <section class="ai-main-decision-panel">
        <h3>Main decision</h3>
        <p class="ai-main-decision">${escapeHtml(formatNarrativeMetrics(report.main_decision || ""))}</p>
      </section>
    `;
  }

  function productIdentityKey(product = {}) {
    return clean(product.product_id || product.identity?.product_id || product.title || product.identity?.title).toLowerCase();
  }

  function mergeProductIntelligence(result = {}) {
    const deterministic = result.product_intelligence || result.report_pack?.product_intelligence || {};
    const ai = result.report?.product_intelligence || {};
    const baseProducts = Array.isArray(deterministic.products) ? deterministic.products : [];
    const aiProducts = new Map((Array.isArray(ai.products) ? ai.products : []).map((product) => [productIdentityKey(product), product]));
    const products = baseProducts.map((product) => {
      const aiProduct = aiProducts.get(productIdentityKey(product)) || aiProducts.get(clean(product.identity?.title).toLowerCase()) || {};
      const aiDetail = aiProduct.detail || {};
      return {
        ...product,
        ai_generated: Boolean(aiProduct.title || aiProduct.card_diagnosis),
        status_label: clean(aiProduct.status_label) || product.status_label,
        card_diagnosis: clean(aiProduct.card_diagnosis) || product.card_diagnosis,
        primary_action: clean(aiProduct.primary_action) || product.primary_action,
        confidence: clean(aiProduct.confidence) || product.confidence,
        detail: {
          ...(product.detail || {}),
          why_selling_or_not: clean(aiDetail.why_selling_or_not) || product.detail?.why_selling_or_not,
          what_is_working: Array.isArray(aiDetail.what_is_working) && aiDetail.what_is_working.length ? aiDetail.what_is_working : product.detail?.what_is_working || [],
          what_is_not_working: Array.isArray(aiDetail.what_is_not_working) && aiDetail.what_is_not_working.length ? aiDetail.what_is_not_working : product.detail?.what_is_not_working || [],
          action_to_take: clean(aiDetail.action_to_take) || product.detail?.action_to_take,
          evidence: Array.isArray(aiDetail.evidence) && aiDetail.evidence.length ? aiDetail.evidence : product.detail?.evidence || [],
          what_not_to_do: Array.isArray(aiDetail.what_not_to_do) && aiDetail.what_not_to_do.length ? aiDetail.what_not_to_do : product.detail?.what_not_to_do || [],
          confidence: clean(aiDetail.confidence) || product.detail?.confidence || product.confidence
        }
      };
    });
    for (const aiProduct of Array.isArray(ai.products) ? ai.products : []) {
      if (!products.some((product) => productIdentityKey(product) === productIdentityKey(aiProduct))) {
        products.push({
          identity: { product_id: aiProduct.product_id, title: aiProduct.title, image_url: "", image_missing_reason: "No deterministic Shopify product row matched this AI product." },
          sales: {},
          inventory: {},
          variants: [],
          funnel: {},
          returns: {},
          mapped_ads: [],
          paid_support: {},
          ...aiProduct,
          ai_generated: true
        });
      }
    }
    return {
      title: clean(ai.title || deterministic.title) || "Product Intelligence",
      subtitle: clean(ai.subtitle || deterministic.subtitle) || "Every active product connected to sales, stock, variants, ads, funnel, returns, and historical performance.",
      summary: deterministic.summary || {},
      guide: {
        ...(ai.guide || {}),
        data_coverage: deterministic.guide_evidence?.data_coverage || {}
      },
      mapping_rule_notes: deterministic.mapping_rule_notes || [],
      products
    };
  }

  function mergeAdsCreativeIntelligence(result = {}) {
    const deterministic = result.ads_creative_intelligence || result.report_pack?.ads_creative_intelligence || {};
    const ai = result.report?.ads_creative_intelligence || {};
    const aiAds = new Map((ai.ads || []).map((ad) => [clean(ad.ad_id), ad]));
    const aiCreatives = new Map((ai.creatives || []).map((creative) => [clean(creative.creative_id), creative]));
    const ads = (deterministic.ads || []).map((ad) => ({
      ...ad,
      ai_decision: aiAds.get(clean(ad.ad_id)) || null
    }));
    for (const ad of ai.ads || []) {
      if (!ads.some((row) => clean(row.ad_id) === clean(ad.ad_id))) {
        ads.push({ ad_id: ad.ad_id, ad_name: ad.ad_name, performance: {}, mapping: {}, product_context: [], ai_decision: ad });
      }
    }
    const creatives = (deterministic.creatives || []).map((creative) => ({
      ...creative,
      ai_decision: aiCreatives.get(clean(creative.creative_id)) || null
    }));
    for (const creative of ai.creatives || []) {
      if (!creatives.some((row) => clean(row.creative_id) === clean(creative.creative_id))) {
        creatives.push({ creative_id: creative.creative_id, creative_name: creative.creative_name, performance: {}, product_context: [], ai_decision: creative });
      }
    }
    return {
      title: clean(ai.title || deterministic.title) || "Ads & Creative Intelligence",
      subtitle: clean(ai.subtitle || deterministic.subtitle) || "Meta ads and creative decisions connected to product demand, funnel quality, stock, variants, returns, and commercial context.",
      account_read: clean(ai.account_read),
      summary: deterministic.summary || {},
      benchmarks: deterministic.benchmarks || {},
      guide: {
        ...(ai.guide || {}),
        data_coverage: deterministic.guide_evidence?.data_coverage || {}
      },
      ads,
      creatives
    };
  }

  function productTitle(product) {
    return clean(product.identity?.title || product.title || "Unnamed product");
  }

  function statusClass(value) {
    return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "review";
  }

  function signedPercent(value) {
    if (!hasNumber(value)) return "N/A";
    const sign = number(value) > 0 ? "+" : "";
    return `${sign}${formatPercent(value, 1)}`;
  }

  function productMatchesFilter(product, filter) {
    const status = clean(product.status_label);
    const units = number(product.sales?.units_sold);
    const stock = number(product.inventory?.ending_inventory_units);
    if (!filter) return true;
    if (filter === "Selling this week") return units > 0;
    if (filter === "Active but not selling") return units <= 0 && stock > 0;
    if (filter === "Low stock") return Boolean(product.inventory?.low_stock) || /low stock/i.test(status);
    if (filter === "Demand/conversion issue") return /demand|conversion/i.test(status) || /conversion|interest/i.test(clean(product.funnel?.signal_label));
    if (filter === "Paid-driven") return /paid-driven/i.test(status);
    if (filter === "Genuine winner") return /genuine winner/i.test(status);
    if (filter === "Needs review / weak data") return /review|weak data/i.test(status);
    return true;
  }

  function highSpendLowRoasPriority(product = {}) {
    const spend = number(product.paid_support?.mapped_spend);
    if (spend <= 0) return -1;
    const roas = hasNumber(product.paid_support?.mapped_roas)
      ? Math.max(0, number(product.paid_support.mapped_roas))
      : 0;
    return spend * Math.max(0, 2 - roas) / 2;
  }

  function sortedProducts(products = []) {
    const sort = aiReportState.productSort || "most_sold";
    const rows = products
      .filter((product) => [...aiReportState.productFilters].every((filter) => productMatchesFilter(product, filter)))
      .slice();
    const by = (fn, dir = -1) => rows.sort((a, b) => dir * (number(fn(a)) - number(fn(b))));
    if (sort === "least_sold") {
      return rows
        .filter((product) => number(product.inventory?.ending_inventory_units) > 0)
        .sort((a, b) =>
          number(a.sales?.units_sold) - number(b.sales?.units_sold) ||
          number(b.inventory?.ending_inventory_units) - number(a.inventory?.ending_inventory_units) ||
          productTitle(a).localeCompare(productTitle(b))
        );
    }
    if (sort === "highest_revenue") return by((p) => p.sales?.net_sales, -1);
    if (sort === "lowest_revenue_with_stock") return rows.sort((a, b) => {
      const aStock = number(a.inventory?.ending_inventory_units) > 0 ? 0 : 1;
      const bStock = number(b.inventory?.ending_inventory_units) > 0 ? 0 : 1;
      return aStock - bStock || number(a.sales?.net_sales) - number(b.sales?.net_sales);
    });
    if (sort === "biggest_wow_drop") return by((p) => p.sales?.units_wow_pct, 1);
    if (sort === "biggest_wow_growth") return by((p) => p.sales?.units_wow_pct, -1);
    if (sort === "lowest_stock_cover") return rows.sort((a, b) => {
      const av = hasNumber(a.inventory?.days_of_cover_7d) ? number(a.inventory.days_of_cover_7d) : 9999;
      const bv = hasNumber(b.inventory?.days_of_cover_7d) ? number(b.inventory.days_of_cover_7d) : 9999;
      return av - bv;
    });
    if (sort === "highest_ad_spend") return by((p) => p.paid_support?.mapped_spend, -1);
    if (sort === "highest_spend_lowest_roas") return rows.sort((a, b) => {
      const priorityDelta = highSpendLowRoasPriority(b) - highSpendLowRoasPriority(a);
      const spendDelta = number(b.paid_support?.mapped_spend) - number(a.paid_support?.mapped_spend);
      const aRoas = hasNumber(a.paid_support?.mapped_roas) ? number(a.paid_support.mapped_roas) : -1;
      const bRoas = hasNumber(b.paid_support?.mapped_roas) ? number(b.paid_support.mapped_roas) : -1;
      return priorityDelta || spendDelta || aRoas - bRoas;
    });
    if (sort === "worst_conversion_with_traffic") return rows.sort((a, b) => {
      const aTraffic = number(a.funnel?.item_views) >= 30 ? 0 : 1;
      const bTraffic = number(b.funnel?.item_views) >= 30 ? 0 : 1;
      const av = hasNumber(a.funnel?.view_to_purchase_rate) ? number(a.funnel.view_to_purchase_rate) : 9999;
      const bv = hasNumber(b.funnel?.view_to_purchase_rate) ? number(b.funnel.view_to_purchase_rate) : 9999;
      return aTraffic - bTraffic || av - bv;
    });
    return by((p) => p.sales?.units_sold, -1);
  }

  function productPageState(products = []) {
    const pageSize = Math.max(4, number(aiReportState.productPageSize) || 12);
    const pageCount = Math.max(1, Math.ceil(products.length / pageSize));
    aiReportState.productPage = Math.min(Math.max(1, number(aiReportState.productPage) || 1), pageCount);
    const start = (aiReportState.productPage - 1) * pageSize;
    return {
      pageSize,
      pageCount,
      start,
      end: Math.min(start + pageSize, products.length),
      products: products.slice(start, start + pageSize)
    };
  }

  function productMetricChip(label, value) {
    return `<span><b>${escapeHtml(label)}</b>${escapeHtml(value)}</span>`;
  }

  function productMapKey(product = {}) {
    return clean(product.identity?.product_id || product.product_id || product.identity?.title || product.title).toLowerCase();
  }

  function adMapsToProduct(ad = {}, product = {}) {
    const productId = clean(product.identity?.product_id || product.product_id);
    const title = clean(product.identity?.title || product.title).toLowerCase();
    return (ad.mapped_products || []).some((mapped) => {
      const mappedId = clean(mapped.product_id);
      const mappedTitle = clean(mapped.product_title || mapped.title).toLowerCase();
      return (productId && mappedId === productId) || (title && mappedTitle === title);
    });
  }

  function manualMappingsForProduct(product = {}) {
    const productId = clean(product.identity?.product_id || product.product_id);
    const title = clean(product.identity?.title || product.title).toLowerCase();
    return (reportData?.creative?.ad_product_mappings || []).filter((mapping) =>
      (productId && clean(mapping.product_id) === productId) ||
      (title && clean(mapping.product_title).toLowerCase() === title)
    );
  }

  function productAdCandidates(product = {}) {
    const mappedIds = new Set((product.mapped_ads || []).map((ad) => clean(ad.ad_id)).filter(Boolean));
    return (reportData?.creative?.ads || [])
      .slice()
      .sort((a, b) => {
        const aUnresolved = adMappingResolved(a) ? 1 : 0;
        const bUnresolved = adMappingResolved(b) ? 1 : 0;
        const aMapped = mappedIds.has(clean(a.ad_id)) || adMapsToProduct(a, product) ? 0 : 1;
        const bMapped = mappedIds.has(clean(b.ad_id)) || adMapsToProduct(b, product) ? 0 : 1;
        return aUnresolved - bUnresolved || aMapped - bMapped || number(b.spend) - number(a.spend);
      })
      .slice(0, 120);
  }

  function renderProductAdPicker(product, currency) {
    const mappedIds = new Set([
      ...(product.mapped_ads || []).map((ad) => clean(ad.ad_id)),
      ...manualMappingsForProduct(product).map((mapping) => clean(mapping.ad_id))
    ].filter(Boolean));
    const candidates = productAdCandidates(product);
    return `
      <div class="product-ad-picker" data-product-ad-picker hidden>
        <div class="ad-picker-toolbar">
          <input type="search" data-ad-picker-search placeholder="Search ads" aria-label="Search ads">
          <button type="button" data-save-product-ad-map="${escapeHtml(productMapKey(product))}">Save</button>
          <button type="button" data-cancel-product-ad-map>Cancel</button>
        </div>
        <div class="ad-picker-list">
          ${candidates.map((ad) => {
            const checked = mappedIds.has(clean(ad.ad_id)) || adMapsToProduct(ad, product);
            const label = `${clean(ad.ad_name || "Unnamed ad")} ${clean(ad.campaign_name)} ${clean(ad.adset_name)}`.toLowerCase();
            return `
              <label class="ad-picker-row" data-ad-picker-row="${escapeHtml(label)}">
                <input type="checkbox" data-map-ad-checkbox value="${escapeHtml(ad.ad_id)}"${checked ? " checked" : ""}>
                <span>
                  <strong>${escapeHtml(ad.ad_name || "Unnamed ad")}</strong>
                  <small>${escapeHtml(ad.campaign_name || "Campaign unknown")} / ${escapeHtml(ad.adset_name || "Ad set unknown")}</small>
                </span>
                <b>${formatMoney(ad.spend, currency)}</b>
                <em>${formatMultiple(ad.roas)}</em>
              </label>
            `;
          }).join("") || `<div class="empty">No ads are available for this week.</div>`}
        </div>
      </div>
    `;
  }

  function renderProductImage(product) {
    const imageUrl = clean(product.identity?.image_url || product.image_url);
    if (imageUrl) return `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(productTitle(product))}" loading="lazy">`;
    return `<div class="product-image-missing"><b>No image</b><span>${escapeHtml(product.identity?.image_missing_reason || "No Shopify image URL stored.")}</span></div>`;
  }

  function renderVariantChips(product) {
    const variants = (product.variants || []).slice(0, 5);
    if (!variants.length) return `<span class="variant-chip review">No variant rows</span>`;
    return variants.map((variant) => `
      <span class="variant-chip ${variant.availability_state === "available" ? "available" : "unavailable"}">
        ${escapeHtml(variant.variant_title || variant.sku || "Variant")}
        <b>${formatNumber(variant.ending_inventory_units)}</b>
      </span>
    `).join("");
  }

  function renderProductCard(product, index, currency) {
    const title = productTitle(product);
    const status = clean(product.status_label || "Needs review / weak data");
    return `
      <article class="product-card" data-product-index="${index}" tabindex="0" role="button" aria-label="Open ${escapeHtml(title)} product detail">
        <div class="product-thumb">${renderProductImage(product)}</div>
        <div class="product-card-main">
          <div class="product-card-top">
            <h3>${escapeHtml(title)}</h3>
            <span class="product-status ${statusClass(status)}">${escapeHtml(status)}</span>
          </div>
          <p>${escapeHtml(product.card_diagnosis || "No diagnosis available for this product.")}</p>
          <div class="product-metrics">
            ${productMetricChip("Units", formatNumber(product.sales?.units_sold))}
            ${productMetricChip("Revenue", formatMoney(product.sales?.net_sales, currency))}
            ${productMetricChip("WoW units", signedPercent(product.sales?.units_wow_pct))}
            ${productMetricChip("WoW revenue", signedPercent(product.sales?.revenue_wow_pct))}
            ${productMetricChip("Stock", formatNumber(product.inventory?.ending_inventory_units))}
            ${productMetricChip("Cover", hasNumber(product.inventory?.days_of_cover_7d) ? `${formatNumber(product.inventory.days_of_cover_7d, 1)}d` : "N/A")}
            ${productMetricChip("Ad spend", formatMoney(product.paid_support?.mapped_spend, currency))}
            ${productMetricChip("ROAS", formatMultiple(product.paid_support?.mapped_roas))}
          </div>
          <div class="product-card-row">
            <span class="history-pill">${escapeHtml(product.historical_signal?.label || "Historical signal limited")}</span>
            <span class="paid-pill">${escapeHtml(product.paid_support?.label || "No mapped paid support")}</span>
          </div>
          <div class="variant-strip">${renderVariantChips(product)}</div>
          <div class="product-action"><b>Action</b><span>${escapeHtml(product.primary_action || "Review this product before changing spend or merchandising.")}</span></div>
        </div>
      </article>
    `;
  }

  function renderProductDrawer(product, currency) {
    if (!product) return "";
    const detail = product.detail || {};
    const ads = product.mapped_ads || [];
    return `
      <aside class="product-drawer" data-product-drawer aria-label="Product detail drawer">
        <div class="drawer-panel">
          <button class="ghost-btn drawer-close" type="button" data-product-drawer-close>Close</button>
          <div class="drawer-head">
            <div class="product-thumb large">${renderProductImage(product)}</div>
            <div>
              <span class="product-status ${statusClass(product.status_label)}">${escapeHtml(product.status_label || "Needs review")}</span>
              <h3>${escapeHtml(productTitle(product))}</h3>
              <p>${escapeHtml(detail.why_selling_or_not || product.card_diagnosis || "")}</p>
            </div>
          </div>
          <div class="drawer-grid">
            <section>
              <h4>Working</h4>
              ${aiBulletList(detail.what_is_working || [])}
            </section>
            <section>
              <h4>Not working</h4>
              ${aiBulletList(detail.what_is_not_working || [])}
            </section>
            <section>
              <h4>Action</h4>
              <p>${escapeHtml(detail.action_to_take || product.primary_action || "")}</p>
            </section>
            <section>
              <h4>Evidence</h4>
              ${aiBulletList(detail.evidence || [])}
            </section>
            <section>
              <h4>What not to do</h4>
              ${aiBulletList(detail.what_not_to_do || [])}
            </section>
            <section>
              <h4>Funnel / returns</h4>
              <p>${escapeHtml(product.funnel?.signal_label || "No funnel signal")} - ${escapeHtml(product.funnel?.evidence || "No product-level funnel row.")}</p>
              <p>${escapeHtml(product.returns?.signal_label || "No returns signal")}.</p>
            </section>
          </div>
          <section class="drawer-section">
            <h4>Variants and SKUs</h4>
            <div class="drawer-variants">${renderVariantChips(product)}</div>
          </section>
          <section class="drawer-section">
            <div class="drawer-section-head">
              <h4>Mapped ads</h4>
              <button class="icon-btn" type="button" data-map-ads-toggle aria-label="Map ads to ${escapeHtml(productTitle(product))}">+</button>
            </div>
            ${renderProductAdPicker(product, currency)}
            ${ads.length ? `<div class="mapped-ad-list">${ads.map((ad) => `
              <article class="mapped-ad">
                <div class="ad-thumb">${clean(ad.thumbnail_url) ? `<img src="${escapeHtml(ad.thumbnail_url)}" alt="" loading="lazy">` : `<span>${escapeHtml(ad.thumbnail_unavailable_reason || "No thumbnail stored.")}</span>`}</div>
                <div>
                  <strong>${escapeHtml(ad.ad_name || "Unnamed ad")}</strong>
                  <small>${escapeHtml(ad.campaign_name || "Campaign unknown")} / ${escapeHtml(ad.adset_name || "Ad set unknown")}</small>
                  <dl>
                    <div><dt>Spend</dt><dd>${formatMoney(ad.spend, currency)}</dd></div>
                    <div><dt>Value</dt><dd>${formatMoney(ad.purchase_value, currency)}</dd></div>
                    <div><dt>ROAS</dt><dd>${formatMultiple(ad.roas)}</dd></div>
                    <div><dt>CTR</dt><dd>${formatPercent(ad.ctr_link)}</dd></div>
                    <div><dt>Freq</dt><dd>${formatNumber(ad.frequency, 2)}</dd></div>
                    <div><dt>Purchases</dt><dd>${formatNumber(ad.purchases)}</dd></div>
                    <div><dt>CPP</dt><dd>${formatMoney(ad.cost_per_purchase, currency)}</dd></div>
                    <div><dt>Mapping</dt><dd>${escapeHtml(ad.mapping_quality === "high_confidence" ? "High confidence" : "Review-only")} (${formatNumber(ad.mapping_confidence)}%)</dd></div>
                  </dl>
                  <p>${escapeHtml(ad.mapping_basis || "No mapping basis supplied.")}</p>
                  <p>${escapeHtml(ad.scale_state || "observe")}: ${escapeHtml(ad.scale_reason || "No scale reason supplied.")}</p>
                </div>
              </article>
            `).join("")}</div>` : `<p class="muted">No mapped ads for this product. Dynamic/mixed or low-confidence ads remain review-only.</p>`}
          </section>
        </div>
      </aside>
    `;
  }

  function productGuideActionClass(value) {
    return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "monitor";
  }

  function guideImpactRange(impact = {}, fallbackCurrency = "EGP") {
    if (!impact.applicable || !hasNumber(impact.amount_high) || number(impact.amount_high) <= 0) return "";
    const low = Math.max(0, number(impact.amount_low));
    const high = Math.max(low, number(impact.amount_high));
    const currency = clean(impact.currency || fallbackCurrency);
    if (Math.abs(high - low) < 0.01) return `${formatNumber(high)} ${currency}`;
    return `${formatNumber(low)}-${formatNumber(high)} ${currency}`;
  }

  function renderProductIntelligenceGuide(guide = {}, currency = "EGP") {
    const steps = Array.isArray(guide.steps) ? guide.steps : [];
    if (!steps.length) return "";
    const coverage = guide.data_coverage || {};
    const actionSteps = steps.filter((step) => step.needs_action_this_week);
    const quantifiedSteps = steps.filter((step) => guideImpactRange(step.estimated_impact, currency));
    const largestImpact = quantifiedSteps.reduce((largest, step) =>
      number(step.estimated_impact?.amount_high) > number(largest?.estimated_impact?.amount_high) ? step : largest, null);
    return `
      <details class="product-week-guide">
        <summary>
          <span class="guide-summary-copy">
            <strong>${escapeHtml(guide.title || "Product Intelligence Guide for the Week")}</strong>
            <small>${escapeHtml(guide.subtitle || `${steps.length} AI-ranked commercial priorities.`)}</small>
          </span>
          <span class="guide-summary-stats" aria-label="Guide summary">
            <span><b>${formatNumber(actionSteps.length)}</b> act this week</span>
            <span><b>${formatNumber(quantifiedSteps.length)}</b> quantified</span>
            <span><b>${largestImpact ? escapeHtml(guideImpactRange(largestImpact.estimated_impact, currency)) : "Not forced"}</b> largest exposure</span>
          </span>
        </summary>
        <div class="product-week-guide-body">
          <div class="guide-range-priority">
            <span>Catalogue read</span>
            <p>${escapeHtml(guide.range_read || "Prioritize the highest-impact product action first.")}</p>
          </div>
          <ol class="guide-action-list">
            ${steps.map((step, index) => {
              const impactRange = guideImpactRange(step.estimated_impact, currency);
              return `
              <li class="${productGuideActionClass(step.urgency)}">
                <span class="guide-rank">${formatNumber(step.rank || index + 1)}</span>
                <div class="guide-step-main">
                  <div class="guide-step-head">
                    <div>
                      <span class="guide-product-name">${escapeHtml(step.product_title || "Catalogue priority")}</span>
                      <h4>${escapeHtml(step.headline || "Review the measured signal")}</h4>
                    </div>
                    <span class="guide-step-badges">
                      <b>${escapeHtml(step.needs_action_this_week ? "Act this week" : "Monitor")}</b>
                      <small>${escapeHtml(step.urgency || "monitor")} / ${escapeHtml(step.confidence || "low")} confidence</small>
                    </span>
                  </div>
                  <p class="guide-situation">${escapeHtml(step.what_is_happening || "")}</p>
                  <div class="guide-evidence-strip">
                    ${(step.evidence || []).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
                  </div>
                  ${impactRange ? `
                    <div class="guide-money-impact ${productGuideActionClass(step.estimated_impact?.direction)}">
                      <span>${escapeHtml(step.estimated_impact?.direction === "upside" ? "Revenue opportunity" : "Money at risk")}</span>
                      <strong>${escapeHtml(impactRange)}</strong>
                      <p>${escapeHtml(step.estimated_impact?.explanation || step.estimated_impact?.type || "")}</p>
                      <small>${escapeHtml(step.estimated_impact?.basis || "")}</small>
                    </div>
                  ` : ""}
                  <div class="guide-decision-grid">
                    <div><span>Judgment</span><p>${escapeHtml(step.judgment || "")}</p></div>
                    <div><span>This week</span><p>${escapeHtml(step.action || "")}</p></div>
                    <div><span>Next decision signal</span><p>${escapeHtml(step.next_signal || "")}</p></div>
                  </div>
                </div>
              </li>
            `;
            }).join("")}
          </ol>
          <div class="guide-data-coverage">
            <strong>Evidence boundary</strong>
            ${(coverage.limitations || []).map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
          </div>
        </div>
      </details>
    `;
  }

  function renderProductIntelligenceContent() {
    const intelligence = aiReportState.productIntelligence || {};
    const products = sortedProducts(intelligence.products || []);
    const page = productPageState(products);
    const currency = reportData?.week?.currency || "EGP";
    const summary = intelligence.summary || {};
    const filters = ["Selling this week", "Active but not selling", "Low stock", "Demand/conversion issue", "Paid-driven", "Genuine winner", "Needs review / weak data"];
    const sortOptions = [
      ["most_sold", "Most sold this week"],
      ["least_sold", "Least sold this week (in stock)"],
      ["highest_revenue", "Highest revenue this week"],
      ["lowest_revenue_with_stock", "Lowest revenue with stock"],
      ["biggest_wow_drop", "Biggest WoW drop"],
      ["biggest_wow_growth", "Biggest WoW growth"],
      ["lowest_stock_cover", "Lowest stock cover"],
      ["highest_ad_spend", "Highest ad spend"],
      ["highest_spend_lowest_roas", "Highest Spend, Lowest ROAS"],
      ["worst_conversion_with_traffic", "Worst conversion with traffic"]
    ];
    return `
      <section class="product-intelligence">
        <div class="product-intelligence-head">
          <div>
            <span class="kicker">AI generated report</span>
            <h3>${escapeHtml(intelligence.title || "Product Intelligence")}</h3>
            <p>${escapeHtml(intelligence.subtitle || "Every active product connected to sales, stock, variants, ads, funnel, returns, and historical performance.")}</p>
          </div>
          <div class="product-summary-grid">
            ${productMetricChip("Products", formatNumber(summary.total_products ?? products.length))}
            ${productMetricChip("Sold", formatNumber(summary.sold_products))}
            ${productMetricChip("In stock, 0 sales", formatNumber(summary.active_in_stock_zero_sales))}
            ${productMetricChip("Paid-driven", formatNumber(summary.paid_driven))}
          </div>
        </div>
        ${renderProductIntelligenceGuide(intelligence.guide || {}, currency)}
        <div class="product-controls">
          <label>Sort by
            <select data-product-sort>
              ${sortOptions.map(([value, label]) => `<option value="${value}"${value === aiReportState.productSort ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}
            </select>
          </label>
          <label>Per page
            <select data-product-page-size>
              ${[8, 12, 24, 48].map((value) => `<option value="${value}"${value === page.pageSize ? " selected" : ""}>${value}</option>`).join("")}
            </select>
          </label>
          <div class="product-filter-bar">
            ${filters.map((filter) => `<button type="button" class="${aiReportState.productFilters.has(filter) ? "active" : ""}" data-product-filter="${escapeHtml(filter)}">${escapeHtml(filter)}</button>`).join("")}
          </div>
        </div>
        <div class="product-pagination">
          <button type="button" data-product-page="prev"${aiReportState.productPage <= 1 ? " disabled" : ""}>Previous</button>
          <span>Page ${formatNumber(aiReportState.productPage)} of ${formatNumber(page.pageCount)} · showing ${products.length ? formatNumber(page.start + 1) : "0"}-${formatNumber(page.end)} of ${formatNumber(products.length)}</span>
          <button type="button" data-product-page="next"${aiReportState.productPage >= page.pageCount ? " disabled" : ""}>Next</button>
        </div>
        <div class="product-list" data-product-list>
          ${page.products.length ? page.products.map((product, index) => renderProductCard(product, page.start + index, currency)).join("") : `<div class="empty">No products matched the selected filters.</div>`}
        </div>
        <p class="mapping-note">${escapeHtml((intelligence.mapping_rule_notes || [])[1] || "Low-confidence mappings are review-only and do not drive conclusions.")}</p>
      </section>
    `;
  }

  function adsDecisionLabel(row = {}) {
    return clean(row.ai_decision?.action_label || "monitor").toLowerCase();
  }

  function adsDecisionProductTitles(row = {}) {
    const aiTitles = row.ai_decision?.product_titles || [];
    const deterministicTitles = (row.product_context || []).map((product) => product.product_title);
    return [...new Set([...aiTitles, ...deterministicTitles].map(clean).filter(Boolean))];
  }

  function reportAdForDecision(adId) {
    return (reportData?.creative?.ads || [])
      .find((ad) => clean(ad.ad_id) === clean(adId)) || null;
  }

  function decisionPreviewSource(row = {}, isCreative = false) {
    const adIds = (isCreative ? row.ad_ids || [] : [row.ad_id])
      .map(clean)
      .filter(Boolean);
    const sourceAds = adIds.map(reportAdForDecision).filter(Boolean);
    const sourceAd = sourceAds.find((ad) => clean(ad.thumbnail_url)) || sourceAds[0] || {};
    return {
      ad_id: clean(sourceAd.ad_id || adIds[0]),
      ad_name: clean(sourceAd.ad_name || row.ad_name || row.creative_name || "Ad"),
      thumbnail_url: clean(sourceAd.thumbnail_url || row.thumbnail_url),
      unavailable_reason: clean(
        sourceAd.thumbnail_unavailable_reason ||
        row.thumbnail_unavailable_reason ||
        "Meta did not return a stored thumbnail for this ad."
      )
    };
  }

  function renderDecisionIndexPreview(row = {}, isCreative = false) {
    const source = decisionPreviewSource(row, isCreative);
    const adCount = Math.max(1, number(row.performance?.ad_count || row.ad_ids?.length) || 1);
    if (!source.ad_id) {
      return `<span class="decision-preview-wrap unavailable"><span><strong>No preview</strong><small>No ad ID</small></span></span>`;
    }
    const label = isCreative
      ? `Open a representative ad for ${clean(row.creative_name || "this creative concept")}`
      : `Open ${source.ad_name}`;
    const preview = source.thumbnail_url
      ? `<img src="${escapeHtml(source.thumbnail_url)}" alt="" loading="lazy">`
      : `<span><strong>Preview</strong><small>Open ad</small></span>`;
    return `
      <span class="decision-preview-wrap">
        <button type="button"
          class="decision-index-preview${source.thumbnail_url ? "" : " unavailable"} has-tooltip"
          data-index-preview-ad="${escapeHtml(source.ad_id)}"
          aria-label="${escapeHtml(label)}"
          ${tooltipAttr(source.thumbnail_url ? `${label} full screen.` : source.unavailable_reason)}>
          ${preview}
          ${isCreative && adCount > 1 ? `<em>${formatNumber(adCount)} ads</em>` : ""}
        </button>
      </span>
    `;
  }

  function decisionEntityName(row = {}) {
    return clean(row.ad_name || row.creative_name || row.ai_decision?.ad_name || row.ai_decision?.creative_name);
  }

  function compareDecisionMetric(a, b, getter, direction = "desc") {
    const aValue = getter(a);
    const bValue = getter(b);
    const aHasValue = hasNumber(aValue);
    const bHasValue = hasNumber(bValue);
    if (aHasValue !== bHasValue) return aHasValue ? -1 : 1;
    if (aHasValue && bHasValue) {
      const delta = direction === "asc"
        ? number(aValue) - number(bValue)
        : number(bValue) - number(aValue);
      if (delta) return delta;
    }
    return decisionEntityName(a).localeCompare(decisionEntityName(b));
  }

  function sortDecisionRows(rows = [], sort = "highest_spend", isCreative = false) {
    const metric = (row, key) => row.performance?.[key];
    const comparators = {
      highest_spend: (a, b) => compareDecisionMetric(a, b, (row) => metric(row, "spend")),
      highest_roas: (a, b) => compareDecisionMetric(a, b, (row) => metric(row, "roas")),
      lowest_roas: (a, b) => compareDecisionMetric(a, b, (row) => metric(row, "roas"), "asc"),
      most_purchases: (a, b) => compareDecisionMetric(a, b, (row) => metric(row, "purchases")),
      highest_cpp: (a, b) => compareDecisionMetric(a, b, (row) => metric(row, "cost_per_purchase")),
      highest_frequency: (a, b) => compareDecisionMetric(
        a,
        b,
        (row) => metric(row, isCreative ? "frequency_proxy" : "frequency")
      ),
      lowest_ctr: (a, b) => compareDecisionMetric(a, b, (row) => metric(row, "ctr_link"), "asc"),
      most_ads: (a, b) => compareDecisionMetric(a, b, (row) => metric(row, "ad_count"))
    };
    return [...rows].sort(comparators[sort] || comparators.highest_spend);
  }

  function adsDecisionRows(intelligence = {}) {
    const rows = (intelligence.ads || [])
      .filter((ad) => aiReportState.adsDecisionFilter === "all" || adsDecisionLabel(ad) === aiReportState.adsDecisionFilter);
    return sortDecisionRows(rows, aiReportState.adsDecisionSort, false);
  }

  function creativeDecisionRows(creatives = []) {
    return sortDecisionRows(creatives, aiReportState.creativeDecisionSort, true);
  }

  function decisionPage(rows, pageKey, sizeKey) {
    const size = Math.max(4, number(aiReportState[sizeKey]) || 10);
    const count = Math.max(1, Math.ceil(rows.length / size));
    aiReportState[pageKey] = Math.max(1, Math.min(number(aiReportState[pageKey]) || 1, count));
    const start = (aiReportState[pageKey] - 1) * size;
    return {
      count,
      start,
      end: Math.min(rows.length, start + size),
      rows: rows.slice(start, start + size)
    };
  }

  function renderAdsActionChart(ads = [], currency = "EGP") {
    const groups = new Map();
    for (const ad of ads) {
      const label = adsDecisionLabel(ad);
      const current = groups.get(label) || { count: 0, spend: 0 };
      current.count += 1;
      current.spend += number(ad.performance?.spend);
      groups.set(label, current);
    }
    const rows = [...groups.entries()].sort((a, b) => b[1].spend - a[1].spend || b[1].count - a[1].count);
    if (!rows.length) return `<div class="empty">No ad decisions were generated.</div>`;
    const maxSpend = Math.max(...rows.map(([, value]) => value.spend), 1);
    return `
      <div class="ads-action-chart" aria-label="Ad spend by AI decision">
        ${rows.map(([label, value]) => `
          <div>
            <span class="decision-label ${statusClass(label)}">${escapeHtml(humanizeLabel(label))}</span>
            <i><b style="width:${aiVisualWidth(value.spend, maxSpend, 4)}%"></b></i>
            <strong>${formatMoney(value.spend, currency)}</strong>
            <small>${formatNumber(value.count)} ad${value.count === 1 ? "" : "s"}</small>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderAdsCreativeGuide(guide = {}, currency = "EGP") {
    const steps = guide.steps || [];
    if (!steps.length) return `<div class="ai-upgrade-note"><strong>Ads guide not generated</strong><p>Regenerate this saved report once to add the coordinated ads and creative analysis.</p></div>`;
    const quantified = steps.filter((step) => guideImpactRange(step.estimated_impact, currency));
    return `
      <section class="ads-week-guide" aria-labelledby="ads-guide-title">
        <header>
          <div>
            <span class="kicker">Ranked decisions</span>
            <h4 id="ads-guide-title">${escapeHtml(guide.title || "Ads & Creative Intelligence Guide for the Week")}</h4>
            <p>${escapeHtml(guide.subtitle || "")}</p>
          </div>
          <div class="ads-guide-stats">
            <span><b>${formatNumber(steps.length)}</b> priorities</span>
            <span><b>${formatNumber(quantified.length)}</b> quantified</span>
          </div>
        </header>
        <div class="guide-range-priority">
          <span>Account read</span>
          <p>${escapeHtml(guide.range_read || "Prioritize the highest-impact advertising decision first.")}</p>
        </div>
        <ol class="guide-action-list ads-guide-actions">
          ${steps.map((step, index) => {
            const impactRange = guideImpactRange(step.estimated_impact, currency);
            const entityIds = [
              ...(step.ad_ids || []).map((id) => `Ad ${id}`),
              ...(step.creative_ids || []).map((id) => `Creative ${id}`),
              ...(step.product_ids || []).map((id) => `Product ${id}`)
            ].slice(0, 6);
            return `
              <li class="${statusClass(step.action_label || step.urgency)}">
                <span class="guide-rank">${formatNumber(step.rank || index + 1)}</span>
                <div class="guide-step-main">
                  <div class="guide-step-head">
                    <div>
                      <span class="guide-product-name">${escapeHtml(humanizeLabel(step.action_label || "Monitor"))} · ${escapeHtml(step.cause_owner || "insufficient evidence")}</span>
                      <h4>${escapeHtml(step.headline || "Review the measured signal")}</h4>
                    </div>
                    <span class="guide-step-badges">
                      <b>${escapeHtml(step.urgency || "monitor")}</b>
                      <small>${escapeHtml(step.confidence || "low")} confidence</small>
                    </span>
                  </div>
                  ${entityIds.length ? `<div class="guide-entity-strip">${entityIds.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
                  <p class="guide-situation">${escapeHtml(step.what_is_happening || "")}</p>
                  <div class="guide-evidence-strip">${(step.evidence || []).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
                  ${impactRange ? `
                    <div class="guide-money-impact ${statusClass(step.estimated_impact?.direction)}">
                      <span>${escapeHtml(step.estimated_impact?.direction === "upside" ? "Revenue opportunity" : "Money at risk")}</span>
                      <strong>${escapeHtml(impactRange)}</strong>
                      <p>${escapeHtml(step.estimated_impact?.explanation || step.estimated_impact?.type || "")}</p>
                      <small>${escapeHtml(step.estimated_impact?.basis || "")}</small>
                    </div>
                  ` : ""}
                  <div class="guide-decision-grid">
                    <div><span>Judgment</span><p>${escapeHtml(step.judgment || "")}</p></div>
                    <div><span>This week</span><p>${escapeHtml(step.action || "")}</p></div>
                    <div><span>Next decision signal</span><p>${escapeHtml(step.next_signal || "")}</p></div>
                  </div>
                </div>
              </li>
            `;
          }).join("")}
        </ol>
        <details class="guide-data-coverage">
          <summary>Evidence boundary</summary>
          ${(guide.data_coverage?.limitations || []).map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
        </details>
      </section>
    `;
  }

  function renderAdDecisionRow(ad, currency) {
    const decision = ad.ai_decision || {};
    const performance = ad.performance || {};
    const products = adsDecisionProductTitles(ad);
    return `
      <details class="ad-decision-row">
        <summary>
          ${renderDecisionIndexPreview(ad, false)}
          <span class="decision-entity">
            <b>${escapeHtml(ad.ad_name || decision.ad_name || "Unnamed ad")}</b>
            <small>${escapeHtml(ad.campaign_name || "Campaign unavailable")} / ${escapeHtml(ad.adset_name || "Ad set unavailable")}</small>
          </span>
          <span class="decision-label ${statusClass(decision.action_label)}">${escapeHtml(humanizeLabel(decision.action_label || "Not generated"))}</span>
          <span><b>${formatMoney(performance.spend, currency)}</b><small>Spend</small></span>
          <span><b>${formatMultiple(performance.roas)}</b><small>ROAS</small></span>
          <span><b>${formatNumber(performance.purchases)}</b><small>Purchases</small></span>
        </summary>
        <div class="decision-detail">
          <div class="decision-context">
            <span>${escapeHtml(ad.ad_format || "unknown")} format</span>
            <span>${escapeHtml(decision.cause_owner || "insufficient evidence")}</span>
            <span>${escapeHtml(products.join(", ") || "No verified product mapping")}</span>
          </div>
          <p><strong>Read:</strong> ${escapeHtml(decision.diagnosis || "This saved report predates ad-level AI decisions.")}</p>
          <div class="guide-evidence-strip">${(decision.evidence || []).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
          <div class="decision-action-grid">
            <div><span>This week</span><p>${escapeHtml(decision.action || "Regenerate to create an ad-level decision.")}</p></div>
            <div><span>Next signal</span><p>${escapeHtml(decision.next_signal || "No follow-up signal generated.")}</p></div>
          </div>
        </div>
      </details>
    `;
  }

  function renderCreativeDecisionRow(creative, currency) {
    const decision = creative.ai_decision || {};
    const performance = creative.performance || {};
    const products = adsDecisionProductTitles(creative);
    return `
      <details class="ad-decision-row creative-decision-row">
        <summary>
          ${renderDecisionIndexPreview(creative, true)}
          <span class="decision-entity">
            <b>${escapeHtml(creative.creative_name || decision.creative_name || "Unnamed creative")}</b>
            <small>${formatNumber(performance.ad_count || creative.ad_ids?.length)} ads / ${formatNumber(performance.campaign_count || creative.campaign_names?.length)} campaigns</small>
          </span>
          <span class="decision-label ${statusClass(decision.action_label)}">${escapeHtml(humanizeLabel(decision.action_label || "Not generated"))}</span>
          <span><b>${formatMoney(performance.spend, currency)}</b><small>Spend</small></span>
          <span><b>${formatMultiple(performance.roas)}</b><small>ROAS</small></span>
          <span><b>${formatNumber(performance.purchases)}</b><small>Purchases</small></span>
        </summary>
        <div class="decision-detail">
          <div class="decision-context">
            <span>${escapeHtml(creative.ad_format || "unknown")} format</span>
            <span>${escapeHtml(decision.cause_owner || "insufficient evidence")}</span>
            <span>${escapeHtml(products.join(", ") || "No verified product mapping")}</span>
          </div>
          <p><strong>Read:</strong> ${escapeHtml(decision.diagnosis || "This saved report predates creative-level AI decisions.")}</p>
          <div class="guide-evidence-strip">${(decision.evidence || []).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
          <div class="decision-action-grid">
            <div><span>This week</span><p>${escapeHtml(decision.action || "Regenerate to create a creative-level decision.")}</p></div>
            <div><span>Next signal</span><p>${escapeHtml(decision.next_signal || "No follow-up signal generated.")}</p></div>
          </div>
        </div>
      </details>
    `;
  }

  function renderAdsCreativeIntelligenceContent() {
    const intelligence = aiReportState.adsCreativeIntelligence || {};
    const ads = intelligence.ads || [];
    const creatives = intelligence.creatives || [];
    const currency = reportData?.week?.currency || "EGP";
    const adRows = adsDecisionRows(intelligence);
    const creativeRows = creativeDecisionRows(creatives);
    const adPage = decisionPage(adRows, "adsDecisionPage", "adsDecisionPageSize");
    const creativePage = decisionPage(creativeRows, "creativeDecisionPage", "creativeDecisionPageSize");
    const actionLabels = [...new Set(ads.map(adsDecisionLabel))].sort();
    const adSortOptions = [
      ["highest_spend", "Highest spend"],
      ["highest_roas", "Highest ROAS"],
      ["lowest_roas", "Lowest ROAS"],
      ["most_purchases", "Most purchases"],
      ["highest_cpp", "Highest cost per purchase"],
      ["highest_frequency", "Highest frequency"],
      ["lowest_ctr", "Lowest link CTR"]
    ];
    const creativeSortOptions = [
      ["highest_spend", "Highest spend"],
      ["highest_roas", "Highest ROAS"],
      ["lowest_roas", "Lowest ROAS"],
      ["most_purchases", "Most purchases"],
      ["most_ads", "Used by most ads"],
      ["highest_cpp", "Highest cost per purchase"],
      ["highest_frequency", "Highest frequency"],
      ["lowest_ctr", "Lowest link CTR"]
    ];
    return `
      <section class="ads-creative-intelligence">
        <div class="ads-intelligence-head">
          <div>
            <span class="kicker">AI generated report</span>
            <h3>${escapeHtml(intelligence.title || "Ads & Creative Intelligence")}</h3>
            <p>${escapeHtml(intelligence.subtitle || "Meta ads and creative decisions connected to complete product context.")}</p>
          </div>
          <div class="ads-summary-grid">
            ${productMetricChip("Ads", formatNumber(intelligence.summary?.ads_in_analysis ?? ads.length))}
            ${productMetricChip("Creatives", formatNumber(intelligence.summary?.creatives_in_analysis ?? creatives.length))}
            ${productMetricChip("Need mapping", formatNumber(intelligence.summary?.ads_needing_mapping))}
            ${productMetricChip("Spend", formatMoney(intelligence.summary?.spend, currency))}
          </div>
        </div>
        <div class="ads-account-read">
          <span>Account read</span>
          <p>${escapeHtml(intelligence.account_read || "Regenerate this report once to add the coordinated Meta account read.")}</p>
        </div>
        <section class="ads-decision-overview">
          <div class="ai-section-head">
            <h4>Spend by decision</h4>
            <p>Budget distribution across the AI's primary action for each ad.</p>
          </div>
          ${renderAdsActionChart(ads, currency)}
        </section>
        ${renderAdsCreativeGuide(intelligence.guide || {}, currency)}
        <details class="decision-index" data-decision-index="ads"${aiReportState.adsDecisionIndexOpen ? " open" : ""}>
          <summary>
            <span><strong>Ad decision index</strong><small>${formatNumber(adRows.length)} ads in this view</small></span>
          </summary>
          <p class="decision-index-intro">Use this index to decide what to do with each individual ad this week, using its spend, return, purchases, product context, and next decision signal.</p>
          <div class="decision-index-toolbar">
            <div class="decision-index-controls">
              <label>Decision
                <select data-ads-decision-filter>
                  <option value="all">All decisions</option>
                  ${actionLabels.map((label) => `<option value="${escapeHtml(label)}"${label === aiReportState.adsDecisionFilter ? " selected" : ""}>${escapeHtml(humanizeLabel(label))}</option>`).join("")}
                </select>
              </label>
              <label>Sort by
                <select data-ads-decision-sort>
                  ${adSortOptions.map(([value, label]) => `<option value="${value}"${value === aiReportState.adsDecisionSort ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}
                </select>
              </label>
            </div>
            <span>Page ${formatNumber(aiReportState.adsDecisionPage)} of ${formatNumber(adPage.count)}</span>
            <div class="decision-index-pagination">
              <button type="button" data-ads-page="prev"${aiReportState.adsDecisionPage <= 1 ? " disabled" : ""}>Previous</button>
              <button type="button" data-ads-page="next"${aiReportState.adsDecisionPage >= adPage.count ? " disabled" : ""}>Next</button>
            </div>
          </div>
          <div class="decision-list">${adPage.rows.map((ad) => renderAdDecisionRow(ad, currency)).join("") || `<div class="empty">No ads match this decision filter.</div>`}</div>
        </details>
        <details class="decision-index" data-decision-index="creatives"${aiReportState.creativeDecisionIndexOpen ? " open" : ""}>
          <summary>
            <span><strong>Creative concept index</strong><small>${formatNumber(creativeRows.length)} underlying creatives</small></span>
          </summary>
          <p class="decision-index-intro">Use this index to compare the underlying creative concepts across every ad using them, separating the strength of the idea from campaign, audience, or delivery effects.</p>
          <div class="decision-index-toolbar">
            <div class="decision-index-controls">
              <label>Sort by
                <select data-creatives-decision-sort>
                  ${creativeSortOptions.map(([value, label]) => `<option value="${value}"${value === aiReportState.creativeDecisionSort ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}
                </select>
              </label>
            </div>
            <span>Page ${formatNumber(aiReportState.creativeDecisionPage)} of ${formatNumber(creativePage.count)}</span>
            <div class="decision-index-pagination">
              <button type="button" data-creatives-page="prev"${aiReportState.creativeDecisionPage <= 1 ? " disabled" : ""}>Previous</button>
              <button type="button" data-creatives-page="next"${aiReportState.creativeDecisionPage >= creativePage.count ? " disabled" : ""}>Next</button>
            </div>
          </div>
          <div class="decision-list">${creativePage.rows.map((creative) => renderCreativeDecisionRow(creative, currency)).join("") || `<div class="empty">No creative decisions were generated.</div>`}</div>
        </details>
      </section>
    `;
  }

  function renderAiReportContent() {
    return [
      renderProductIntelligenceContent(),
      renderAdsCreativeIntelligenceContent()
    ].join("");
  }

  function refreshAiReportContent() {
    const content = $("ai-report-content");
    if (!content) return;
    content.innerHTML = renderAiReportContent();
    wireProductIntelligenceEvents();
    wireAdsCreativeIntelligenceEvents();
  }

  function rememberDecisionIndexState(content) {
    const adsIndex = content.querySelector('[data-decision-index="ads"]');
    const creativesIndex = content.querySelector('[data-decision-index="creatives"]');
    if (adsIndex) aiReportState.adsDecisionIndexOpen = adsIndex.open;
    if (creativesIndex) aiReportState.creativeDecisionIndexOpen = creativesIndex.open;
  }

  function wireAdsCreativeIntelligenceEvents() {
    const content = $("ai-report-content");
    if (!content) return;
    content.querySelectorAll("[data-decision-index]").forEach((details) => {
      details.addEventListener("toggle", () => rememberDecisionIndexState(content));
    });
    content.querySelector("[data-ads-decision-filter]")?.addEventListener("change", (event) => {
      rememberDecisionIndexState(content);
      aiReportState.adsDecisionFilter = clean(event.target.value || "all");
      aiReportState.adsDecisionPage = 1;
      refreshAiReportContent();
    });
    content.querySelector("[data-ads-decision-sort]")?.addEventListener("change", (event) => {
      rememberDecisionIndexState(content);
      aiReportState.adsDecisionSort = clean(event.target.value || "highest_spend");
      aiReportState.adsDecisionPage = 1;
      refreshAiReportContent();
    });
    content.querySelector("[data-creatives-decision-sort]")?.addEventListener("change", (event) => {
      rememberDecisionIndexState(content);
      aiReportState.creativeDecisionSort = clean(event.target.value || "highest_spend");
      aiReportState.creativeDecisionPage = 1;
      refreshAiReportContent();
    });
    content.querySelectorAll("[data-ads-page]").forEach((button) => {
      button.addEventListener("click", () => {
        rememberDecisionIndexState(content);
        aiReportState.adsDecisionPage += button.dataset.adsPage === "next" ? 1 : -1;
        refreshAiReportContent();
      });
    });
    content.querySelectorAll("[data-creatives-page]").forEach((button) => {
      button.addEventListener("click", () => {
        rememberDecisionIndexState(content);
        aiReportState.creativeDecisionPage += button.dataset.creativesPage === "next" ? 1 : -1;
        refreshAiReportContent();
      });
    });
    content.querySelectorAll("[data-index-preview-ad]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openCreativePreview(button.dataset.indexPreviewAd);
      });
    });
  }

  function wireProductIntelligenceEvents() {
    const content = $("ai-report-content");
    if (!content) return;
    content.querySelector("[data-product-sort]")?.addEventListener("change", (event) => {
      aiReportState.productSort = event.target.value || "most_sold";
      aiReportState.productPage = 1;
      refreshAiReportContent();
    });
    content.querySelector("[data-product-page-size]")?.addEventListener("change", (event) => {
      aiReportState.productPageSize = number(event.target.value) || 12;
      aiReportState.productPage = 1;
      refreshAiReportContent();
    });
    content.querySelectorAll("[data-product-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        const filter = button.getAttribute("data-product-filter") || "";
        if (aiReportState.productFilters.has(filter)) aiReportState.productFilters.delete(filter);
        else aiReportState.productFilters.add(filter);
        aiReportState.productPage = 1;
        refreshAiReportContent();
      });
    });
    content.querySelectorAll("[data-product-page]").forEach((button) => {
      button.addEventListener("click", () => {
        const direction = button.getAttribute("data-product-page");
        aiReportState.productPage += direction === "next" ? 1 : -1;
        refreshAiReportContent();
      });
    });
    content.querySelectorAll("[data-product-index]").forEach((card) => {
      const open = () => {
        const products = sortedProducts(aiReportState.productIntelligence?.products || []);
        const product = products[number(card.getAttribute("data-product-index"))];
        content.querySelector("[data-product-drawer]")?.remove();
        content.insertAdjacentHTML("beforeend", renderProductDrawer(product, reportData?.week?.currency || "EGP"));
        content.querySelector("[data-product-drawer-close]")?.addEventListener("click", () => content.querySelector("[data-product-drawer]")?.remove());
        wireProductDrawerMappingEvents(product);
      };
      card.addEventListener("click", open);
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
  }

  async function archiveAdProductMapping(mappingId) {
    return apiDelete("/ad-product-mappings", { mapping_id: mappingId });
  }

  async function refreshProductIntelligenceAfterMapping(productKey) {
    reportData = await apiGet("/report-data", { week_start: reportData.week.week_start });
    renderAdMappingWorkspace();
    renderEvidence(reportData);
    const result = await apiGet("/ai-report", {
      week_start: reportData.week.week_start,
      mode: aiReportState.mode || "general",
      goal_text: aiReportState.goalText || ""
    });
    renderAiReport(result);
    const content = $("ai-report-content");
    const products = sortedProducts(aiReportState.productIntelligence?.products || []);
    const index = products.findIndex((row) => productMapKey(row) === productKey);
    if (index >= 0) {
      content.querySelector("[data-product-drawer]")?.remove();
      content.insertAdjacentHTML("beforeend", renderProductDrawer(products[index], reportData?.week?.currency || "EGP"));
      content.querySelector("[data-product-drawer-close]")?.addEventListener("click", () => content.querySelector("[data-product-drawer]")?.remove());
      wireProductDrawerMappingEvents(products[index]);
    }
    setAiReportStatus("Ad mapping saved and Product Intelligence refreshed.", "cached");
  }

  async function saveProductAdMappings(product = {}) {
    const drawer = document.querySelector("[data-product-drawer]");
    const productKey = productMapKey(product);
    const selected = new Set([...drawer.querySelectorAll("[data-map-ad-checkbox]:checked")]
      .map((input) => clean(input.value))
      .filter(Boolean));
    const manual = manualMappingsForProduct(product);
    const productId = clean(product.identity?.product_id || product.product_id);
    const productTitleValue = productTitle(product);
    const existingManualByAd = new Map(manual.map((mapping) => [clean(mapping.ad_id), mapping]));
    const writes = [];

    for (const adId of selected) {
      if (existingManualByAd.has(adId)) continue;
      const ad = (reportData?.creative?.ads || []).find((row) => clean(row.ad_id) === adId) || {};
      writes.push(apiPost("/ad-product-mappings", {}, {
        week_start: reportData.week.week_start,
        ad_id: adId,
        ad_name: ad.ad_name,
        product_id: productId,
        product_title: productTitleValue,
        confidence: 100,
        evidence: { manual_review: true, source: "product-intelligence-drawer" }
      }));
    }

    for (const mapping of manual) {
      if (!selected.has(clean(mapping.ad_id))) writes.push(archiveAdProductMapping(mapping.mapping_id));
    }

    await Promise.all(writes);
    await refreshProductIntelligenceAfterMapping(productKey);
  }

  function wireProductDrawerMappingEvents(product = {}) {
    const drawer = document.querySelector("[data-product-drawer]");
    if (!drawer) return;
    drawer.querySelector("[data-map-ads-toggle]")?.addEventListener("click", () => {
      const picker = drawer.querySelector("[data-product-ad-picker]");
      if (picker) picker.hidden = !picker.hidden;
    });
    drawer.querySelector("[data-cancel-product-ad-map]")?.addEventListener("click", () => {
      const picker = drawer.querySelector("[data-product-ad-picker]");
      if (picker) picker.hidden = true;
    });
    drawer.querySelector("[data-ad-picker-search]")?.addEventListener("input", (event) => {
      const query = clean(event.target.value).toLowerCase();
      drawer.querySelectorAll("[data-ad-picker-row]").forEach((row) => {
        row.hidden = query && !clean(row.getAttribute("data-ad-picker-row")).includes(query);
      });
    });
    drawer.querySelector("[data-save-product-ad-map]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      const original = button.textContent;
      button.textContent = "Saving";
      try {
        await saveProductAdMappings(product);
      } catch (error) {
        button.disabled = false;
        button.textContent = original;
        setAiReportStatus(clean(error?.message || error), "error");
      }
    });
  }

  function renderAiReport(result) {
    const card = $("ai-report-card");
    const output = $("ai-report-output");
    const metadata = result?.metadata || {};
    const requestedReportWeek = clean(reportData?.week?.week_start || selectedWeek);
    const returnedReportWeek = clean(metadata.selected_week || metadata.week_start);
    if (!result?.report || !["cached", "generated"].includes(clean(result.status).toLowerCase())) {
      aiReportState.lastReport = null;
      aiReportState.productIntelligence = null;
      aiReportState.adsCreativeIntelligence = null;
      card.hidden = true;
      if (output) output.hidden = true;
      return false;
    }
    if (returnedReportWeek && returnedReportWeek !== requestedReportWeek) {
      aiReportState.lastReport = null;
      aiReportState.productIntelligence = null;
      aiReportState.adsCreativeIntelligence = null;
      card.hidden = true;
      if (output) output.hidden = true;
      setAiReportStatus(`Saved report week ${returnedReportWeek} does not match selected week ${requestedReportWeek}. Nothing was rendered.`, "error");
      return false;
    }
    const intelligence = mergeProductIntelligence(result || {});
    const adsIntelligence = mergeAdsCreativeIntelligence(result || {});
    aiReportState.productIntelligence = intelligence;
    aiReportState.adsCreativeIntelligence = adsIntelligence;
    aiReportState.lastReport = result;
    if (!intelligence.products?.length && !adsIntelligence.ads?.length) {
      card.hidden = true;
      if (output) output.hidden = true;
      return false;
    }
    clearAiReportStatus();
    card.hidden = false;
    if (output) output.hidden = false;
    $("ai-report-mode").textContent = metadata.mode === "goal" ? "Goal-focused weekly intelligence" : "Weekly intelligence";
    $("ai-report-title").textContent = "Product, Ads & Creative Intelligence";
    $("ai-report-meta").textContent = [
      metadata.selected_week || metadata.week_start || reportData?.week?.week_start || selectedWeek,
      metadata.generated_at ? `Generated ${formatDate(metadata.generated_at)}` : "",
      metadata.model ? `Model ${metadata.model}` : "",
      metadata.report_pack_hash ? `Pack ${metadata.report_pack_hash.slice(0, 10)}` : "",
      metadata.cached || result.status === "cached" ? "Loaded from saved report" : "Generated and saved",
      metadata.evidence_changed_since_generation ? "Underlying evidence changed; regenerate only when updated AI wording is needed" : "",
      Array.isArray(metadata.validation_warnings) && metadata.validation_warnings.length ? "Compacted to fast-read report format" : ""
    ].filter(Boolean).join(" | ");
    refreshAiReportContent();
    return true;
  }

  async function loadCachedAiReport(mode = "general") {
    if (!reportData?.week?.week_start) return;
    const lookupSequence = ++aiReportState.lookupSequence;
    const lookupWeek = reportData.week.week_start;
    aiReportState.mode = mode;
    aiReportState.goalText = mode === "goal" ? clean($("ai-goal-text").value) : "";
    beginAiReportLookup(`Looking for a saved AI report for ${lookupWeek}. This does not call the AI provider.`);
    try {
      const result = await apiGet("/ai-report", {
        week_start: lookupWeek,
        mode,
        goal_text: aiReportState.goalText
      });
      if (lookupSequence !== aiReportState.lookupSequence || reportData?.week?.week_start !== lookupWeek) return null;
      if (result.status === "cached" && result.report) {
        renderAiReport(result);
        setAiReportStatus(
          result.metadata?.guide_upgrade_required
            ? "This saved report predates the coordinated Product, Ads & Creative Intelligence format. Regenerate once to create and save both guides in one AI request."
            : result.metadata?.evidence_changed_since_generation
            ? "Loaded the saved report for this week. Its live metrics were refreshed; Regenerate only to update the AI diagnosis."
            : "Loaded from D1 cache. No AI provider call was made.",
          result.metadata?.guide_upgrade_required ? "blocked" : "cached"
        );
        return result;
      }
      aiReportState.lastReport = null;
      aiReportState.productIntelligence = null;
      aiReportState.adsCreativeIntelligence = null;
      $("ai-report-card").hidden = true;
      $("ai-report-output").hidden = true;
      setAiReportStatus(`No AI report has been generated for ${lookupWeek}. Create it once to save it for this week.`, "empty");
      return result;
    } catch (error) {
      if (lookupSequence !== aiReportState.lookupSequence || reportData?.week?.week_start !== lookupWeek) return null;
      $("ai-report-card").hidden = true;
      $("ai-report-output").hidden = true;
      setAiReportStatus(`Could not check saved AI reports: ${clean(error?.message || error)}`, "error");
      return null;
    } finally {
      if (lookupSequence === aiReportState.lookupSequence && reportData?.week?.week_start === lookupWeek) {
        aiReportState.lookupInProgress = false;
        updateAiGenerationControls();
      }
    }
  }

  function downloadAiReport() {
    const card = $("ai-report-card");
    if (!card || card.hidden || !aiReportState.lastReport?.report) {
      setAiReportStatus("Generate an AI report before downloading.", "error");
      return;
    }
    const title = clean($("ai-report-title").textContent || "Coddiwomple weekly AI report");
    const filenameWeek = clean(reportData?.week?.week_start || selectedWeek || "week").replace(/[^0-9-]/g, "");
    const exportState = {
      productFilters: aiReportState.productFilters,
      productSort: aiReportState.productSort,
      productPage: aiReportState.productPage,
      productPageSize: aiReportState.productPageSize,
      adsDecisionFilter: aiReportState.adsDecisionFilter,
      adsDecisionPage: aiReportState.adsDecisionPage,
      adsDecisionPageSize: aiReportState.adsDecisionPageSize,
      creativeDecisionPage: aiReportState.creativeDecisionPage,
      creativeDecisionPageSize: aiReportState.creativeDecisionPageSize
    };
    aiReportState.productFilters = new Set();
    aiReportState.productSort = "most_sold";
    aiReportState.productPage = 1;
    aiReportState.productPageSize = Math.max(80, aiReportState.productIntelligence?.products?.length || 0);
    aiReportState.adsDecisionFilter = "all";
    aiReportState.adsDecisionPage = 1;
    aiReportState.adsDecisionPageSize = Math.max(80, aiReportState.adsCreativeIntelligence?.ads?.length || 0);
    aiReportState.creativeDecisionPage = 1;
    aiReportState.creativeDecisionPageSize = Math.max(60, aiReportState.adsCreativeIntelligence?.creatives?.length || 0);
    const fullReportContent = renderAiReportContent();
    Object.assign(aiReportState, exportState);
    const exportNode = card.cloneNode(true);
    const exportContent = exportNode.querySelector("#ai-report-content");
    if (exportContent) {
      exportContent.hidden = false;
      exportContent.innerHTML = fullReportContent;
    }
    exportNode.querySelector(".ai-report-toolbar")?.remove();
    exportNode.querySelectorAll("details").forEach((details) => {
      details.open = true;
    });
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;padding:32px;background:#f4f6f8;color:#172033;font-family:Segoe UI,Arial,sans-serif;line-height:1.55}
main{max-width:1040px;margin:0 auto;background:#fff;border:1px solid #dfe4ea;border-radius:8px;overflow:hidden}
header{padding:22px 26px;border-bottom:1px solid #dfe4ea;background:#f8fafc}
h1,h2,h3,p{margin-top:0}h1{font-size:26px;margin-bottom:6px}.kicker{color:#3156d3;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
section{padding:18px 26px;border-bottom:1px solid #edf0f3}.ai-metric-grid,.ai-visual-grid,.ai-signal-strip{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.ai-metric-card,.ai-visual-panel,.ai-signal-strip div,.ai-action-list>li{border:1px solid #dfe4ea;border-radius:8px;padding:12px;background:#fff}.ai-metric-card strong{display:block;font-size:22px}
.ai-analyst-conclusion{padding:0!important;border:1px solid #cfd8e3;border-radius:8px;overflow:hidden}.ai-conclusion-main{padding:18px 20px;background:#172033;color:white}.ai-conclusion-main span,.ai-conclusion-grid span,.ai-proof-card span{display:block;font-size:11px;font-weight:850;text-transform:uppercase}.ai-conclusion-main span{color:#cbd7ff}.ai-conclusion-main strong{display:block;font-family:Georgia,serif;font-size:24px;line-height:1.25;overflow-wrap:anywhere}.ai-conclusion-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:#dfe4ea}.ai-conclusion-grid article{padding:12px;background:#f8fafc}.ai-conclusion-grid p{margin:6px 0 0;font-weight:700;overflow-wrap:anywhere}
.ai-section-head{display:flex;justify-content:space-between;gap:18px;align-items:baseline}.ai-section-head p{max-width:520px;margin-bottom:0;color:#667085;font-size:13px}
.ai-proof-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.ai-proof-card{display:grid;gap:9px;border:1px solid #dfe4ea;border-left:4px solid #667085;border-radius:8px;padding:12px;background:#f8fafc}.ai-proof-card.risk{border-left-color:#b42318;background:#fff0ee}.ai-proof-card.opportunity{border-left-color:#18794e;background:#eaf7f0}.ai-proof-card.decision{border-left-color:#3156d3;background:#edf1ff}.ai-proof-card strong{display:block;margin-top:3px;overflow-wrap:anywhere}.ai-proof-card ul{margin:0;padding-left:17px;font-size:12px}.ai-proof-card p{margin:0;font-size:13px;overflow-wrap:anywhere}.ai-proof-card a{color:#3156d3;font-size:12px;font-weight:800}
.ai-quick-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;border:1px solid #dfe4ea;border-radius:8px;overflow:hidden;background:#dfe4ea}.ai-quick-grid article{padding:12px;background:#f8fafc}.ai-quick-grid span{display:block;color:#667085;font-size:11px;font-weight:800;text-transform:uppercase}.ai-quick-grid p{margin:6px 0 0;font-weight:700;overflow-wrap:anywhere}
.ai-bar-row,.ai-funnel-step{display:grid;grid-template-columns:160px 1fr auto;gap:10px;align-items:center;margin:8px 0}.ai-bar-row span,.ai-funnel-step span{overflow-wrap:anywhere}.ai-bar-row div,.ai-funnel-step i{height:9px;border-radius:999px;background:#edf1ff}.ai-bar-row i{display:block;height:9px;border-radius:999px;background:#3156d3}
.ai-funnel-step{grid-template-columns:1fr}.ai-funnel-step i{display:block;background:#18794e}.ai-main-decision{padding:12px 14px;border-left:3px solid #3156d3;background:#edf1ff;font-weight:800}
.ai-action-emphasis{padding:14px;border:1px solid #dfe4ea;border-radius:8px;background:#fff}.ai-action-kv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.ai-action-kv span{display:grid;font-size:12px;overflow-wrap:anywhere}.ai-evidence-links a{display:inline-block;margin:4px;padding:6px 9px;border:1px solid #dfe4ea;border-radius:8px;color:#3156d3;text-decoration:none}
.product-intelligence{display:grid;gap:14px}.product-intelligence-head,.product-controls{display:grid;grid-template-columns:1fr;gap:12px}.product-summary-grid,.product-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.product-summary-grid span,.product-metrics span{display:grid;padding:8px;border:1px solid #dfe4ea;border-radius:8px;background:#f8fafc}.product-pagination{display:flex;gap:10px;justify-content:space-between;padding:10px;border:1px solid #dfe4ea;border-radius:8px;background:#fff}.product-pagination button{padding:7px 10px;border:1px solid #dfe4ea;border-radius:8px;background:#f8fafc}.product-list{display:grid;gap:12px}.product-card{display:grid;grid-template-columns:100px 1fr;gap:12px;padding:12px;border:1px solid #dfe4ea;border-radius:8px}.product-thumb{aspect-ratio:1/1.15;overflow:hidden;border:1px solid #dfe4ea;border-radius:8px;background:#f3f5f8}.product-thumb img{width:100%;height:100%;object-fit:cover}.product-card-top{display:flex;gap:8px;justify-content:space-between}.product-status,.variant-chip,.history-pill,.paid-pill{display:inline-flex;margin:2px;padding:4px 7px;border-radius:999px;background:#edf1ff;color:#3156d3;font-size:11px;font-weight:800}.variant-chip.available{background:#eaf7f0;color:#18794e}.variant-chip.unavailable{background:#fff0ee;color:#b42318}.product-action{margin-top:8px;padding-top:8px;border-top:1px solid #dfe4ea}.product-drawer{display:none}
.product-week-guide{border:1px solid #cbd3dc;border-radius:8px;overflow:hidden}.product-week-guide>summary{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:14px;background:#f2f5f7}.guide-summary-copy{display:grid}.guide-summary-copy small{color:#667085}.guide-summary-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#dfe4ea}.guide-summary-stats span{display:grid;padding:7px;background:#fff;font-size:11px}.guide-range-priority{display:grid;grid-template-columns:120px 1fr;gap:12px;padding:14px;background:#172033;color:#fff}.guide-range-priority p{margin:0}.guide-action-list{margin:0;padding:0;list-style:none}.guide-action-list li{display:grid;grid-template-columns:36px 1fr;gap:10px;padding:14px;border-bottom:1px solid #dfe4ea}.guide-step-main{display:grid;gap:10px}.guide-step-head{display:flex;justify-content:space-between;gap:12px}.guide-step-head h4,.guide-situation,.guide-decision-grid p,.guide-money-impact p{margin:0}.guide-step-badges{display:grid;text-align:right}.guide-step-badges small,.guide-data-coverage{color:#667085;font-size:10px}.guide-evidence-strip{display:flex;flex-wrap:wrap;gap:5px}.guide-evidence-strip span{padding:4px 6px;border:1px solid #dfe4ea;border-radius:6px;font-size:10px}.guide-money-impact{display:grid;grid-template-columns:120px 140px 1fr;gap:8px;padding:10px;background:#fff0ee}.guide-money-impact.upside{background:#eaf7f0}.guide-money-impact small{grid-column:2/-1;color:#667085}.guide-decision-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#dfe4ea}.guide-decision-grid div{padding:9px;background:#fff}.guide-data-coverage{display:grid;grid-template-columns:120px repeat(3,1fr);gap:10px;padding:12px;background:#f8fafc}.guide-data-coverage p{margin:0}
.ads-creative-intelligence{display:grid;gap:16px;margin-top:28px;padding-top:24px;border-top:5px solid #173f2d}.ads-intelligence-head{display:grid;grid-template-columns:1fr 1fr;gap:16px}.ads-summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#dfe4ea}.ads-summary-grid span{display:grid;padding:8px;background:#f8fafc;font-size:11px}.ads-account-read{display:grid;grid-template-columns:120px 1fr;gap:12px;padding:14px;background:#173f2d;color:#fff}.ads-account-read p{margin:0}.ads-decision-overview,.ads-week-guide,.decision-index{border:1px solid #dfe4ea;border-radius:8px;overflow:hidden}.ads-decision-overview{padding:14px}.ads-action-chart{display:grid;gap:8px}.ads-action-chart>div{display:grid;grid-template-columns:90px 1fr 100px 50px;gap:8px;align-items:center}.ads-action-chart i{height:8px;background:#e1e6eb}.ads-action-chart i b{display:block;height:100%;background:#3156d3}.decision-label{display:inline-flex;padding:4px 7px;border-radius:999px;background:#edf1ff;color:#3156d3;font-size:10px;font-weight:800}.ads-week-guide>header,.decision-index>summary,.decision-index-toolbar{padding:12px;background:#f8fafc}.ads-guide-stats{display:flex;gap:8px}.guide-entity-strip,.decision-context{display:flex;flex-wrap:wrap;gap:5px}.guide-entity-strip span,.decision-context span{padding:3px 6px;background:#edf0f3;border-radius:5px;font-size:10px}.decision-index-toolbar{display:flex;justify-content:space-between;border-top:1px solid #dfe4ea}.ad-decision-row{border-top:1px solid #dfe4ea}.ad-decision-row>summary{display:grid;grid-template-columns:1fr 90px repeat(3,75px);gap:8px;padding:11px}.decision-entity small,.ad-decision-row summary small{display:block;color:#667085;font-size:10px}.decision-detail{display:grid;gap:9px;padding:12px 18px;background:#fbfcfd}.decision-action-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#dfe4ea}.decision-action-grid div{padding:9px;background:#fff}.ai-upgrade-note{padding:12px;background:#fff6d8}
@media(max-width:720px){body{padding:14px}.ai-metric-grid,.ai-visual-grid,.ai-signal-strip,.ai-action-kv,.ai-quick-grid,.ai-conclusion-grid,.ai-proof-grid,.product-summary-grid,.product-metrics,.product-week-guide>summary,.guide-summary-stats,.guide-range-priority,.guide-data-coverage,.guide-money-impact,.guide-decision-grid{grid-template-columns:1fr}.product-card{grid-template-columns:1fr}.guide-step-head{display:grid}.guide-step-badges{text-align:left}.guide-money-impact small{grid-column:auto}.ai-bar-row{grid-template-columns:1fr}.ai-section-head{display:grid}}
</style>
</head>
<body><main>${exportNode.innerHTML}</main></body></html>`;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `coddiwomple-ai-report-${filenameWeek || "week"}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function buildAiGenerationPrerequisites({ regenerate = false } = {}) {
    const weekStart = clean(reportData?.week?.week_start || selectedWeek);
    const weekState = weekByStart(weekStart) || selectedWeekState || {};
    const sync = reportData?.sync_status || {};
    // Gate on data, not on the run. sync.status here is reportData.sync_status,
    // an object of genuine run state on /report-data - deliberately not consulted
    // for readiness, only surfaced to the user elsewhere.
    const dataStatus = weekDataStatus(weekState) || clean(weekState.completeness).toLowerCase();
    const weekMismatch = Boolean(selectedWeek && weekStart && clean(selectedWeek) !== weekStart);
    const syncReady = Boolean(reportData?.week?.week_start) && !weekMismatch && weekState.is_complete !== false && dataStatus === "complete";
    const products = reportData?.revenue?.products || [];
    const funnelProducts = reportData?.funnel?.products || [];
    const ads = reportData?.creative?.ads || [];
    const unresolvedAds = ads.filter((ad) => !adMappingResolved(ad));
    const unresolvedSpend = unresolvedAds.reduce((total, ad) => total + number(ad.spend), 0);
    const adsWithPreview = ads.filter((ad) => clean(ad.thumbnail_url || ad.preview_url));
    const missingPreviewCount = Math.max(0, ads.length - adsWithPreview.length);
    const warnings = (reportData?.warnings || []).map(clean).filter(Boolean);
    const currency = reportData?.week?.currency || "EGP";
    const sourceCoverage = [
      `${formatNumber(products.length)} Shopify product${products.length === 1 ? "" : "s"}`,
      `${formatNumber(funnelProducts.length)} GA4 product row${funnelProducts.length === 1 ? "" : "s"}`,
      `${formatNumber(ads.length)} Meta ad${ads.length === 1 ? "" : "s"}`
    ].join(", ");
    const checks = [
      {
        state: syncReady ? "ready" : "blocked",
        title: "Selected week and sync",
        description: syncReady
          ? `${formatDateRange(weekStart, reportData?.week?.week_end)} is loaded from a completed sync.`
          : weekMismatch
            ? `The loaded evidence belongs to ${weekStart || "another week"}, not ${selectedWeek}. Wait for the selected week to finish loading.`
            : `The selected week is ${statusLabel(syncStatus || "not_synced").toLowerCase()}. Complete the weekly sync before generating.`
      },
      {
        state: products.length && funnelProducts.length && ads.length ? "ready" : "warning",
        title: "Source evidence",
        description: `${sourceCoverage} available.${products.length && funnelProducts.length && ads.length ? "" : " A source with zero rows will leave part of the intelligence incomplete."}`
      },
      {
        state: unresolvedAds.length ? "warning" : "ready",
        title: "Ad-to-product mapping",
        description: unresolvedAds.length
          ? `${formatNumber(unresolvedAds.length)} of ${formatNumber(ads.length)} ads are still unmapped or need review, representing ${formatMoneyFull(unresolvedSpend, currency)} in recorded spend. Product and stock guidance for those ads may be limited.`
          : ads.length
            ? `All ${formatNumber(ads.length)} ads have a resolved product mapping.`
            : "No Meta ads were returned for this week, so there are no mappings to review."
      },
      {
        state: missingPreviewCount ? "warning" : "ready",
        title: "Creative media",
        description: missingPreviewCount
          ? `${formatNumber(missingPreviewCount)} of ${formatNumber(ads.length)} ads do not have stored preview media. Their performance metrics remain available, but visual creative review will be limited.`
          : ads.length
            ? `Preview media is stored for all ${formatNumber(ads.length)} ads.`
            : "Creative media coverage is not applicable because no Meta ads were returned."
      },
      {
        state: warnings.length ? "warning" : "ready",
        title: "Recorded data caveats",
        description: warnings.length
          ? `${formatNumber(warnings.length)} data caveat${warnings.length === 1 ? " is" : "s are"} attached to this week. Review the most relevant items below.`
          : "No source-data caveats are recorded for this week.",
        details: warnings.length > 4
          ? [...warnings.slice(0, 4), `${warnings.length - 4} more caveat${warnings.length - 4 === 1 ? " is" : "s are"} listed in the report.`]
          : warnings
      }
    ];
    const blockedCount = checks.filter((check) => check.state === "blocked").length;
    const warningCount = checks.filter((check) => check.state === "warning").length;
    return {
      checks,
      blocked: blockedCount > 0,
      blockedCount,
      warningCount,
      title: blockedCount ? "Generation is not ready" : warningCount ? "Review before generating" : "Ready to generate",
      summary: blockedCount
        ? "The selected week is not ready for an AI request yet."
        : warningCount
          ? `${warningCount} prerequisite area${warningCount === 1 ? " needs" : "s need"} attention. You can continue, but the gaps may weaken parts of the advice.`
          : "The selected week has the expected evidence and mappings.",
      paidNotice: regenerate
        ? "This makes one new paid AI request and replaces the saved analysis for this evidence pack."
        : "The server checks the saved report first. A paid AI request is made only when no matching report exists for this week and report mode.",
      confirmLabel: blockedCount ? "Generation unavailable" : warningCount ? (regenerate ? "Regenerate anyway" : "Generate anyway") : (regenerate ? "Regenerate report" : "Generate report")
    };
  }

  function renderAiGenerationPrerequisites(review) {
    $("ai-prerequisite-title").textContent = review.title;
    $("ai-prerequisite-summary").textContent = review.summary;
    $("ai-prerequisite-list").innerHTML = review.checks.map((check) => {
      const stateLabel = check.state === "blocked" ? "Blocked" : check.state === "warning" ? "Review" : "Ready";
      const details = check.details?.length
        ? `<ul>${check.details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>`
        : "";
      return `
        <li class="ai-prerequisite-item ${check.state}">
          <span class="ai-prerequisite-state">${stateLabel}</span>
          <div><strong>${escapeHtml(check.title)}</strong><p>${escapeHtml(check.description)}</p>${details}</div>
        </li>
      `;
    }).join("");
    $("ai-prerequisite-cost").textContent = review.paidNotice;
    $("ai-prerequisite-confirm").textContent = review.confirmLabel;
    $("ai-prerequisite-confirm").disabled = review.blocked;
  }

  function closeAiGenerationReview(restoreFocus = true) {
    const modal = $("ai-prerequisite-modal");
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove("modal-open");
    pendingAiGeneration = null;
    if (restoreFocus && aiGenerationRestoreFocus?.focus) aiGenerationRestoreFocus.focus();
    aiGenerationRestoreFocus = null;
  }

  function generateAiReport(mode = "general", regenerate = false) {
    const goalText = mode === "goal" ? clean($("ai-goal-text").value) : "";
    if (mode === "goal" && !goalText) {
      setAiReportStatus("Enter a goal or choose one of the suggested goal options.", "error");
      return;
    }
    if (aiReportState.lookupInProgress) {
      setAiReportStatus("The saved-report check is still running. Generation will be available as soon as it finishes.", "loading");
      return;
    }
    if (!reportData?.week?.week_start || aiReportState.generationInProgress) return;
    const review = buildAiGenerationPrerequisites({ regenerate });
    pendingAiGeneration = { mode, regenerate, goalText, blocked: review.blocked };
    aiGenerationRestoreFocus = document.activeElement;
    renderAiGenerationPrerequisites(review);
    $("ai-prerequisite-modal").hidden = false;
    document.body.classList.add("modal-open");
    (review.blocked ? $("ai-prerequisite-cancel") : $("ai-prerequisite-confirm")).focus();
  }

  async function executeAiReportGeneration(mode = "general", regenerate = false, goalText = "") {
    aiReportState.mode = mode;
    aiReportState.goalText = goalText;
    const button = regenerate
      ? $("ai-report-regenerate")
      : mode === "goal"
        ? $("ai-generate-goal")
        : $("ai-generate-general");
    const originalLabel = button?.textContent || "";
    aiReportState.generationInProgress = true;
    updateAiGenerationControls();
    if (button) {
      button.textContent = regenerate ? "Regenerating..." : "Creating...";
    }
    setAiReportStatus(
      regenerate
        ? "Regenerating AI report and saving a fresh version for this evidence pack."
        : "Checking this week for a saved report, then creating one only if none exists.",
      "loading"
    );
    $("ai-report-card").hidden = true;
    $("ai-report-output").hidden = true;
    try {
      const result = await apiPost("/ai-report/generate", {}, {
        week_start: reportData?.week?.week_start || selectedWeek,
        mode,
        goal_text: aiReportState.goalText,
        regenerate
      });
      if (result.status === "blocked" || result.unavailable) {
        aiReportState.lastReport = null;
        aiReportState.productIntelligence = null;
        aiReportState.adsCreativeIntelligence = null;
        setAiReportStatus(result.error || "AI report generation is not configured. Missing server-side AI provider key.", "blocked");
        return;
      }
      if (!renderAiReport(result)) return;
      const storageWarning = clean(result.metadata?.storage_warning || "");
      setAiReportStatus(
        result.status === "cached"
          ? "Loaded from saved D1 report without calling the AI provider."
          : storageWarning
            ? `Generated, but the saved-report write reported: ${storageWarning}`
            : "Generated and saved. Future visits to this week will load the saved report.",
        storageWarning ? "blocked" : "cached"
      );
    } catch (error) {
      setAiReportStatus(clean(error?.message || error), "error");
    } finally {
      aiReportState.generationInProgress = false;
      if (button) {
        button.textContent = originalLabel;
      }
      updateAiGenerationControls();
    }
  }

  function revenueEvidence(data) {
    const currency = data.week.currency;
    const weekly = data.revenue.weekly || {};
    const columns = [
      { label: "Product", render: (row) => `<strong>${escapeHtml(row.product_title || "Unnamed product")}</strong>` },
      { label: "Net sales", render: (row) => formatMoney(row.net_sales, currency) },
      { label: "Units", render: (row) => formatNumber(row.units_sold) },
      { label: "Returns", render: (row) => formatNumber(row.returned_items) },
      { label: "Stock", render: (row) => formatNumber(row.ending_inventory_units) }
    ];
    return `
      ${evidenceHeader("Revenue quality", "Read gross demand, discounts, refunds, and the products creating net sales together.")}
      <div class="fact-grid">
        ${fact("Gross sales", formatMoney(weekly.gross_sales, currency))}
        ${fact("Discounts", formatMoney(weekly.discounts, currency))}
        ${fact("Refunds", formatMoney(weekly.refunds, currency))}
        ${fact("Net sales", formatMoney(weekly.net_sales, currency))}
        ${fact("AOV", formatMoney(weekly.aov, currency))}
      </div>
      <h4 class="subsection-title">Top products by net sales</h4>
      ${renderTable(columns, data.revenue.products.slice(0, 10))}
    `;
  }

  function funnelEvidence(data) {
    const weekly = data.funnel.weekly || {};
    const productRows = attachInventoryToFunnelRows(
      aggregateFunnelProducts(data.funnel.products),
      data.inventory.products
    );
    const steps = [
      ["Sessions", weekly.sessions],
      ["Product views", weekly.view_item_events],
      ["Add to carts", weekly.add_to_cart_events],
      ["Checkout starts", weekly.begin_checkout_events],
      ["GA4 purchases", weekly.purchase_events],
      ["Shopify orders", data.revenue.weekly?.orders]
    ];
    const columns = [
      { label: "Product", render: (row) => `<strong>${escapeHtml(row.item_name || "Unnamed product")}</strong>` },
      { label: "Views", render: (row) => formatNumber(row.item_views) },
      { label: "View -> cart", goal: "Goal >= 8%", render: (row) => rateCell(row.view_to_cart_rate, 0.08, 0.05, row.item_views) },
      { label: "Cart -> checkout", goal: "Goal >= 35%", render: (row) => rateCell(row.cart_to_checkout_rate, 0.35, 0.25, row.item_views) },
      { label: "View -> purchase", goal: "Goal >= 1%", render: (row) => rateCell(row.view_to_purchase_rate, 0.01, 0.006, row.item_views) }
    ];
    const diagnosticColumns = [
      columns[0],
      columns[1],
      { label: "Stock context", render: stockContext },
      ...columns.slice(2)
    ];
    return `
      ${evidenceHeader("Onsite funnel", "Follow customers from product view to purchase, then compare products that convert well with those losing demand.")}
      <div class="funnel-row">
        ${steps.map(([label, value]) => `<div class="funnel-step"><strong>${formatCompact(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("")}
      </div>
      <div class="fact-grid">
        ${fact("Product view rate", formatPercent(weekly.product_view_rate), "Product-view events generated per session. It can exceed 100% when sessions view multiple products.")}
        ${fact("Add-to-cart rate", formatPercent(weekly.atc_rate), "The share of product views that led to an add-to-cart event.", guardrailStatus(weekly.atc_rate, 0.08, 0.06))}
        ${fact("Checkout start", formatPercent(weekly.checkout_start_rate), "The share of add-to-carts that progressed into checkout.", guardrailStatus(weekly.checkout_start_rate, 0.35, 0.3))}
        ${fact("Checkout completion", formatPercent(weekly.checkout_completion_rate), "The share of checkout starts that produced a GA4 purchase.", guardrailStatus(weekly.checkout_completion_rate, 0.35, 0.3))}
        ${fact("Shopify CVR", formatPercent(data.scoreboard.conversion_rate?.current), "Shopify orders divided by GA4 sessions.", trendStatus(data.scoreboard.conversion_rate))}
      </div>
      <p class="benchmark-note"><strong>How to read this:</strong> Sizes are combined into one product because GA4 often records the default selected size. The working goals are 8% view-to-cart, 35% cart-to-checkout, and 1% view-to-purchase. Colors and distance-to-goal only appear once a product has at least 20 views. “Genuine conversion issues” require at least 15 units in stock, at least 14 days of cover when selling, and fewer than half of sizes out of stock.</p>
      <div class="comparison-grid">
        <section class="comparison-panel">
          <div class="comparison-heading">
            <h4>Best-converting products</h4>
            <p>Products closest to or above the working goals. Protect availability and reuse what is working on their product pages.</p>
          </div>
          ${renderTable(
            columns,
            productRows
              .filter((row) => number(row.item_views) >= 20)
              .sort((a, b) => funnelPerformanceScore(b) - funnelPerformanceScore(a) || number(b.item_views) - number(a.item_views))
              .slice(0, 6),
            "No product has enough views for a reliable best-converting list."
          )}
        </section>
        <section class="comparison-panel">
          <div class="comparison-heading">
            <h4>Genuine conversion issues</h4>
            <p>Products below the funnel goals despite healthy stock and size availability. These are the strongest candidates for product-page, offer, price, or product-appeal work.</p>
          </div>
          ${renderTable(
            diagnosticColumns,
            productRows
              .filter((row) =>
                number(row.item_views) >= 20 &&
                hasHealthyStock(row) &&
                hasFunnelShortfall(row)
              )
              .sort((a, b) => funnelPerformanceScore(a) - funnelPerformanceScore(b) || number(b.item_views) - number(a.item_views))
              .slice(0, 8),
            "No healthy-stock product has enough views and a clear funnel shortfall this week."
          )}
        </section>
        <section class="comparison-panel stock-constrained-panel">
          <div class="comparison-heading">
            <h4>Funnel issues explained by stock</h4>
            <p>Weak funnel results where low stock, low days of cover, or missing sizes are likely suppressing conversion. Restock or redirect demand before judging the product page.</p>
          </div>
          ${renderTable(
            diagnosticColumns,
            productRows
              .filter((row) =>
                number(row.item_views) >= 20 &&
                isStockConstrained(row) &&
                hasFunnelShortfall(row)
              )
              .sort((a, b) => number(b.item_views) - number(a.item_views) || funnelPerformanceScore(a) - funnelPerformanceScore(b))
              .slice(0, 8),
            "No stock-constrained product has enough views and a funnel shortfall this week."
          )}
        </section>
      </div>
    `;
  }

  function paidEvidence(data) {
    const currency = data.week.currency;
    const weekly = data.paid.weekly || {};
    const columns = [
      { label: "Campaign", render: (row) => `<strong>${escapeHtml(row.campaign_name || "Unnamed campaign")}</strong><small>${escapeHtml(row.objective)}</small>` },
      { label: "Spend", render: (row) => formatMoney(row.spend, currency) },
      { label: "CTR", render: (row) => formatPercent(row.ctr_link) },
      { label: "LPV rate", render: (row) => formatPercent(row.lpv_rate_from_link_click) },
      { label: "CPA", render: (row) => formatMoney(row.cpa, currency) },
      { label: "ROAS", render: (row) => formatMultiple(row.roas) }
    ];
    return `
      ${evidenceHeader("Paid acquisition", "Compare platform return with the traffic quality and business-level efficiency it produced.")}
      <div class="fact-grid">
        ${fact("Spend", formatMoney(weekly.spend, currency))}
        ${fact("Meta ROAS", formatMultiple(weekly.roas), "", guardrailStatus(weekly.roas, 1.5, 1.2))}
        ${fact("MER", formatMultiple(data.scoreboard.mer?.current), "", trendStatus(data.scoreboard.mer))}
        ${fact("Link CTR", formatPercent(weekly.ctr_link), "", guardrailStatus(weekly.ctr_link, 0.008, 0.006))}
        ${fact("Cost per LPV", formatMoney(weekly.cost_per_lpv, currency))}
      </div>
      ${metricGuide([
        ["Meta ROAS", "Meta-attributed purchase value generated for every 1 EGP spent."],
        ["MER", "Total Shopify net sales generated for every 1 EGP spent on Meta."],
        ["LPV rate", "The share of Meta link clicks that became a recorded landing-page view."]
      ])}
      ${renderTable(columns, data.paid.campaigns.slice(0, 12))}
    `;
  }

  function isCatalogLike(row) {
    const name = `${clean(row.ad_name)} ${clean(row.adset_name)} ${clean(row.campaign_name)}`.toLowerCase();
    return ["catalog", "catalogue", "carousel", "dynamic", "advantage+", "asc", "collection"]
      .some((term) => name.includes(term));
  }

  function hasVideoEvidence(row) {
    return !isCatalogLike(row) &&
      number(row.video_plays_3s) >= 100 &&
      number(row.video_p25_watched) > 0 &&
      number(row.video_p50_watched) > 0;
  }

  function creativeEvidence(data) {
    const currency = data.week.currency;
    const ads = data.creative.ads || [];
    const unmapped = ads.filter((row) => ["unmapped", "needs_manual_review"].includes(clean(row.mapping_state)));
    const mapped = ads.filter((row) => clean(row.mapping_state) === "mapped_product" || clean(row.mapping_state) === "multiple_mapped_products");
    const cards = ads.slice(0, 24).map((row) => {
      const thumbnail = clean(row.thumbnail_url)
        ? `<button type="button" class="creative-thumb has-tooltip" data-preview-ad="${escapeHtml(row.ad_id)}" aria-label="Open preview for ${escapeHtml(row.ad_name || "ad")}"${tooltipAttr(`Thumbnail source: ${row.thumbnail_source || "metadata"}. Preview: ${row.preview_supported ? "supported" : row.preview_unavailable_reason || "unsupported"}.`)}><img src="${escapeHtml(row.thumbnail_url)}" alt=""></button>`
        : `<button type="button" class="creative-thumb unavailable has-tooltip" data-preview-ad="${escapeHtml(row.ad_id)}"${tooltipAttr(row.thumbnail_unavailable_reason || "Meta did not provide a thumbnail field for this ad.")}><span>${escapeHtml(row.thumbnail_unavailable_reason || "Thumbnail unavailable from Meta")}</span></button>`;
      const mappedProducts = (row.mapped_products || []).map((product) => clean(product.product_title)).filter(Boolean).join(", ");
      const mappingLabel = humanizeLabel(row.mapping_state || "unmapped");
      const mappingConfidence = hasNumber(row.mapping_confidence) ? `${formatNumber(row.mapping_confidence, 0)}%` : "N/A";
      const mappingEvidence = row.mapping_evidence || {};
      const matchedTokens = Array.isArray(mappingEvidence.matched_tokens) ? mappingEvidence.matched_tokens.join(", ") : clean(mappingEvidence.matched_tokens);
      const competing = (mappingEvidence.competing_candidates || [])
        .map((candidate) => `${candidate.product_title} (${formatNumber(candidate.confidence, 0)}%)`)
        .join(", ");
      return `
        <article class="creative-card" data-ad-id="${escapeHtml(row.ad_id)}">
          ${thumbnail}
          <div class="creative-card-main">
            <div class="creative-card-head">
              <div>
                <h4>${escapeHtml(row.ad_name || "Unnamed ad")}</h4>
                <p>${escapeHtml(row.campaign_name || "Campaign unavailable")} / ${escapeHtml(row.adset_name || "Ad set unavailable")}</p>
              </div>
              <span class="pill ${escapeHtml(row.scale_state === "do_not_scale_inventory" || row.scale_state === "do_not_scale_return_quality" ? "critical" : row.mapping_state === "mapped_product" ? "good" : "watch")}">${escapeHtml(humanizeLabel(row.scale_state || "observe"))}</span>
            </div>
            <div class="creative-metrics">
              <div><span>Spend</span><strong>${formatMoney(row.spend, currency)}</strong></div>
              <div><span>ROAS</span><strong>${formatMultiple(row.roas)}</strong></div>
              <div><span>CTR</span><strong>${formatPercent(row.ctr_link)}</strong></div>
              <div><span>Frequency</span><strong>${formatNumber(row.frequency, 2)}</strong></div>
              <div><span>Purchases</span><strong>${formatNumber(row.purchases)}</strong></div>
              <div><span>Cost / purchase</span><strong>${formatMoney(row.cost_per_purchase || row.cpa, currency)}</strong></div>
              <div><span>Purchase value</span><strong>${formatMoney(row.purchase_value, currency)}</strong></div>
            </div>
            <div class="creative-context">
              <p><strong>Mapping:</strong> ${escapeHtml(mappingLabel)} (${escapeHtml(row.mapping_method || "no method")}, ${mappingConfidence}). ${escapeHtml(mappedProducts || "No verified product mapping.")}</p>
              <p><strong>Mapping basis:</strong> ${escapeHtml(mappingEvidence.basis || mappingEvidence.confidence_basis || "No deterministic basis recorded.")}${matchedTokens ? `; matched tokens: ${escapeHtml(matchedTokens)}` : ""}${competing ? `; competing candidates: ${escapeHtml(competing)}` : ""}</p>
              <p><strong>Thumbnail / preview:</strong> ${escapeHtml(row.thumbnail_status || "unavailable")}${row.thumbnail_source ? ` from ${escapeHtml(row.thumbnail_source)}` : ` - ${escapeHtml(row.thumbnail_unavailable_reason || "No thumbnail source recorded.")}`}; preview ${escapeHtml(row.preview_supported ? `supported${row.preview_source ? ` from ${row.preview_source}` : ""}` : row.preview_unavailable_reason || "unsupported")}.</p>
              <p><strong>Stock / quality:</strong> ${hasNumber(row.mapped_product_stock) ? `${formatNumber(row.mapped_product_stock)} units available` : "Stock unavailable until mapping is verified"}${hasNumber(row.mapped_product_return_rate) ? `; return rate ${formatPercent(row.mapped_product_return_rate)}` : ""}.</p>
              <p><strong>Scale state:</strong> ${escapeHtml(row.scale_explanation || "No scale recommendation.")}</p>
            </div>
          </div>
        </article>
      `;
    }).join("");
    return `
      ${evidenceHeader("Creative performance", "Inspect ad-level return, attention, product mapping, and whether stock or returns block scaling. Name-only matches are review suggestions, not factual joins.")}
      <div class="creative-toolbar">
        <button type="button" id="creative-refresh">Refresh Meta creative metadata</button>
        <div><strong>${formatNumber(mapped.length)}</strong> mapped ads</div>
        <div><strong>${formatNumber(unmapped.length)}</strong> ads need mapping review</div>
        <div><strong>${escapeHtml(data.creative.preview_support || "unavailable")}</strong> preview support</div>
      </div>
      ${metricGuide([
        ["Hook rate", "The share of impressions that reached a 3-second video play; it tests the opening."],
        ["Hold rate", "The share of 3-second viewers who reached 50% of the video; it tests the body."],
        ["Mapping confidence", "Manual or URL-based mappings can unlock product stock/return context. Naming heuristics remain review-only."]
      ])}
      <div class="creative-grid">${cards || `<div class="empty">No ad-level creative rows are available for this week.</div>`}</div>
    `;
  }

  async function openCreativePreview(adId) {
    const modal = $("creative-modal");
    const body = $("creative-modal-body");
    const ad = (reportData?.creative?.ads || []).find((row) => clean(row.ad_id) === clean(adId)) || {};
    $("creative-modal-title").textContent = clean(ad.ad_name || `Ad ${adId}`);
    body.innerHTML = `<div class="empty">Requesting protected Meta preview...</div>`;
    modal.hidden = false;
    try {
      const preview = await apiGet("/ad-preview", { week_start: reportData?.week?.week_start || selectedWeek, ad_id: adId });
      $("creative-modal-title").textContent = preview.metadata?.ad_name || clean(ad.ad_name || `Ad ${adId}`);
      const imageUrl = clean(preview.metadata?.thumbnail_url || ad.thumbnail_url);
      if (preview.supported && preview.preview_html) {
        body.innerHTML = `<iframe class="creative-preview-frame" title="Meta ad preview" sandbox="allow-scripts" srcdoc="${escapeHtml(preview.preview_html)}"></iframe>`;
      } else if (imageUrl) {
        body.innerHTML = `<img class="creative-preview-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(ad.ad_name || "Ad creative")}">`;
      } else {
        body.innerHTML = `<div class="empty"><strong>Preview unsupported</strong><p>${escapeHtml(preview.unavailable_reason || "Meta did not return a supported preview format.")}</p></div>`;
      }
    } catch (error) {
      body.innerHTML = clean(ad.thumbnail_url)
        ? `<img class="creative-preview-image" src="${escapeHtml(ad.thumbnail_url)}" alt="${escapeHtml(ad.ad_name || "Ad creative")}">`
        : `<div class="empty"><strong>Preview unavailable</strong><p>${escapeHtml(clean(error?.message || error))}</p></div>`;
    }
  }

  function closeCreativePreview() {
    const modal = $("creative-modal");
    if (!modal) return;
    modal.hidden = true;
    $("creative-modal-body").innerHTML = "";
  }

  async function saveManualMapping(adId) {
    const select = [...document.querySelectorAll("[data-map-product]")]
      .find((element) => clean(element.dataset.mapProduct) === clean(adId));
    const productId = clean(select?.value);
    if (!productId) return;
    const product = (reportData?.revenue?.products || []).find((row) => clean(row.product_id || row.product_title) === productId) || {};
    const ad = (reportData?.creative?.ads || []).find((row) => clean(row.ad_id) === clean(adId)) || {};
    await apiPost("/ad-product-mappings", {}, {
      week_start: reportData.week.week_start,
      ad_id: adId,
      ad_name: ad.ad_name,
      product_id: clean(product.product_id || productId),
      product_title: clean(product.product_title || productId),
      confidence: 100,
      evidence: { manual_review: true, source: "report-ui" }
    });
    reportData = await apiGet("/report-data", { week_start: reportData.week.week_start });
    renderAdMappingWorkspace();
    renderEvidence(reportData);
  }

  async function removeManualMapping(adId) {
    const mapping = (reportData?.creative?.ad_product_mappings || []).find((row) => clean(row.ad_id) === clean(adId));
    if (!mapping) return;
    await apiDelete("/ad-product-mappings", { mapping_id: mapping.mapping_id });
    reportData = await apiGet("/report-data", { week_start: reportData.week.week_start });
    renderAdMappingWorkspace();
    renderEvidence(reportData);
  }

  function wireCreativeEvents(data) {
    if (activeTab !== "Creative") return;
    document.querySelectorAll("#evidence-panel [data-preview-ad]").forEach((button) => {
      button.addEventListener("click", () => openCreativePreview(button.dataset.previewAd));
    });
    document.getElementById("creative-refresh")?.addEventListener("click", refreshCreativeMetadataForWeek);
  }

  function inventoryEvidence(data) {
    const currency = data.week.currency;
    const products = data.inventory.products || [];
    const skus = data.inventory.skus || [];
    const allPriorities = skus
      .filter((row) => clean(row.is_oos) === "TRUE" || (number(row.daily_velocity_7d) > 0 && number(row.days_of_cover_7d) < 14));
    const priorities = allPriorities.slice(0, 14);
    const fastMovers = [...products]
      .filter((row) => number(row.current_7d_units) > 10)
      .sort(
        (a, b) =>
          number(b.current_7d_units) - number(a.current_7d_units) ||
          number(b.weekly_sell_through_rate) - number(a.weekly_sell_through_rate)
      )
      .slice(0, 6);
    const slowMovers = [...products]
      .filter(
        (row) =>
          number(row.ending_inventory_units) >= 15 &&
          number(row.current_7d_units) <= 10
      )
      .sort(
        (a, b) =>
          number(a.current_7d_units) - number(b.current_7d_units) ||
          number(b.ending_inventory_units) - number(a.ending_inventory_units)
      )
      .slice(0, 6);
    const columns = [
      { label: "SKU", render: (row) => `<strong>${escapeHtml(row.sku || row.variant_title || "Unnamed SKU")}</strong><small>${escapeHtml(row.product_title)}</small>` },
      { label: "Units", render: (row) => formatNumber(row.units_sold) },
      { label: "Net sales", render: (row) => formatMoney(row.net_sales, currency) },
      { label: "Stock", render: (row) => formatNumber(row.ending_inventory_units) },
      { label: "Cover", render: (row) => hasNumber(row.days_of_cover_7d) ? `${formatNumber(row.days_of_cover_7d, 1)} days` : "N/A" },
      { label: "Status", render: (row) => clean(row.is_oos) === "TRUE" ? `<span class="pill critical">Out of stock</span>` : `<span class="pill watch">Low cover</span>` }
    ];
    const moverColumns = [
      { label: "Product", render: (row) => `<strong>${escapeHtml(row.product_title || "Unnamed product")}</strong>` },
      { label: "7D units", render: (row) => formatNumber(row.current_7d_units) },
      { label: "7D sell-through", render: (row) => formatPercent(sevenDaySellThrough(row)) },
      { label: "Stock", render: (row) => formatNumber(row.ending_inventory_units) },
      { label: "Cover", render: (row) => number(row.days_of_cover_7d) >= 999 ? "No current velocity" : `${formatNumber(row.days_of_cover_7d, 1)} days` }
    ];
    return `
      ${evidenceHeader("Inventory and merchandising", "Protect proven demand first, then separate genuine low-cover risk from slow or dead stock.")}
      <div class="fact-grid">
        ${fact("Products tracked", formatNumber(products.length))}
        ${fact("SKUs tracked", formatNumber(skus.length))}
        ${fact("Out-of-stock SKUs", formatNumber(skus.filter((row) => clean(row.is_oos) === "TRUE").length))}
        ${fact("Sold SKUs now out of stock", formatNumber(data.revenue.weekly?.stockout_sold_skus), "SKUs that sold during the report week but cannot currently capture another sale.")}
        ${fact("Low-cover priorities", formatNumber(allPriorities.length), "Out-of-stock SKUs plus selling SKUs with less than 14 days of cover.")}
        ${fact("Ending inventory", formatNumber(data.revenue.weekly?.ending_inventory_units), "Units currently available across active SKUs.")}
      </div>
      <p class="benchmark-note"><strong>7-day sell-through:</strong> Units sold in the latest 7 days divided by those units plus ending stock. It estimates how quickly available stock is moving. Read it with days of cover because restocks or returns during the week can change the percentage.</p>
      <div class="mover-grid">
        <section class="mover-panel">
          <h4>Fast-moving products</h4>
          <p><strong>What this tells us:</strong> Products with more than 10 units sold in the latest 7 days. Protect stock, sizes, and visibility; avoid discounting them without a clear reason.</p>
          ${renderTable(moverColumns, fastMovers, "No product reached the fast-mover threshold this week.")}
        </section>
        <section class="mover-panel">
          <h4>Slow-moving stock candidates</h4>
          <p><strong>What this tells us:</strong> Products with at least 15 units on hand and 10 or fewer units sold in the latest 7 days. Check launch timing and stock age before changing price or placement.</p>
          ${renderTable(moverColumns, slowMovers, "No stocked product meets the slow-mover threshold.")}
        </section>
      </div>
      <h4 class="subsection-title">SKU availability priorities</h4>
      ${renderTable(columns, priorities)}
    `;
  }

  function returnsEvidence(data) {
    const currency = data.week.currency;
    const columns = [
      { label: "Product / SKU", render: (row) => `<strong>${escapeHtml(row.product_title || "Unnamed product")}</strong><small>${escapeHtml(row.sku || row.variant_title)}</small>` },
      { label: "Returns", render: (row) => formatNumber(row.returned_items) },
      { label: "Units sold", render: (row) => formatNumber(row.units_sold) },
      { label: "Return rate", render: (row) => formatPercent(row.return_rate_units) },
      { label: "Refunds", render: (row) => formatMoney(row.refunds, currency) }
    ];
    return `
      ${evidenceHeader("Returns and revenue leakage", "Identify products where gross demand is not translating into durable net value.")}
      <div class="fact-grid">
        ${fact("Refund rate", formatPercent(data.returns.refund_rate))}
        ${fact("Item return rate", formatPercent(data.returns.item_return_rate))}
        ${fact("Returned items", formatNumber(data.returns.returned_items))}
        ${fact("Returned orders", formatNumber(data.returns.returned_orders))}
        ${fact("Affected products", formatNumber(data.returns.products.length))}
      </div>
      <h4 class="subsection-title">Top returned products</h4>
      ${renderTable(columns, data.returns.products.slice(0, 12))}
      <h4 class="subsection-title">Top returned SKUs</h4>
      ${renderTable(columns, data.returns.skus.slice(0, 12))}
    `;
  }

  function renderEvidence(data) {
    $("evidence-tabs").innerHTML = tabs.map((tab) => `
      <button
        class="tab"
        type="button"
        role="tab"
        id="tab-${tab.toLowerCase()}"
        data-tab="${tab}"
        aria-controls="evidence-panel"
        aria-selected="${tab === activeTab}"
        tabindex="${tab === activeTab ? "0" : "-1"}"
      >
        ${tab}
      </button>
    `).join("");

    const renderers = {
      Revenue: revenueEvidence,
      Funnel: funnelEvidence,
      Paid: paidEvidence,
      Creative: creativeEvidence,
      Inventory: inventoryEvidence,
      Returns: returnsEvidence
    };
    $("evidence-panel").innerHTML = renderers[activeTab](data);
    wireCreativeEvents(data);

    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        activeTab = button.dataset.tab;
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set("view", activeTab);
        window.history.replaceState({}, "", nextUrl);
        renderEvidence(data);
      });
      button.addEventListener("keydown", (event) => {
        const currentIndex = tabs.indexOf(button.dataset.tab);
        let nextIndex = currentIndex;

        if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
        if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        if (nextIndex === currentIndex) return;

        event.preventDefault();
        activeTab = tabs[nextIndex];
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set("view", activeTab);
        window.history.replaceState({}, "", nextUrl);
        renderEvidence(data);
        document.querySelector(`[data-tab="${activeTab}"]`)?.focus();
      });
    });
  }

  function ownerGroup(owner) {
    const value = clean(owner).toLowerCase();
    if (value.includes("operation")) return "Operations";
    if (value.includes("media")) return "Media Buying";
    if (value.includes("creative")) return "Creative";
    if (value.includes("ecommerce") || value.includes("website") || value.includes("merch")) return "Ecommerce";
    if (value.includes("management") || value.includes("ceo") || value.includes("leadership")) return "Management";
    return "Other";
  }

  function severityRank(value) {
    return { Critical: 0, Action: 1, Watch: 2, Info: 3 }[clean(value)] ?? 9;
  }

  function diagnosisEntities(data, issue) {
    const diagnosisRows = [
      ...(data.inventory?.sku_diagnoses || []),
      ...(data.inventory?.product_diagnoses || [])
    ];

    return diagnosisRows
      .filter((row) => clean(row.diagnosis_label) === clean(issue))
      .map((row) => clean(row.sku || row.product_title))
      .filter(Boolean);
  }

  function canonicalActionIssue(issue) {
    const normalized = clean(issue).toUpperCase().replace(/[^A-Z0-9]+/g, "_");

    if (
      normalized === "STOCKOUT_WINNER" ||
      normalized === "SOLD_SKUS_ARE_GOING_OUT_OF_STOCK"
    ) {
      return {
        key: "SOLD_WINNERS_OOS",
        label: "Sold winners are out of stock"
      };
    }

    return {
      key: normalized || "ACTION_REQUIRED",
      label: humanizeLabel(issue) || "Action required"
    };
  }

  function consolidateActions(data) {
    const groups = new Map();

    for (const action of data.actions || []) {
      const canonical = canonicalActionIssue(action.issue);
      const key = [
        ownerGroup(action.owner),
        canonical.key
      ].join("|");

      if (!groups.has(key)) {
        groups.set(key, {
          ...action,
          issue: canonical.label,
          signal_count: 0,
          evidence_items: [],
          affected_entities: [],
          fix_items: []
        });
      }

      const grouped = groups.get(key);
      grouped.signal_count += 1;

      if (
        severityRank(action.severity) <
        severityRank(grouped.severity)
      ) {
        grouped.severity = action.severity;
      }

      const evidence = formatNarrativeMetrics(action.evidence);
      if (evidence && !grouped.evidence_items.includes(evidence)) {
        grouped.evidence_items.push(evidence);
      }

      const fix = formatNarrativeMetrics(action.fix);
      if (fix && !grouped.fix_items.includes(fix)) {
        grouped.fix_items.push(fix);
      }

      for (const entity of diagnosisEntities(data, action.issue)) {
        if (!grouped.affected_entities.includes(entity)) {
          grouped.affected_entities.push(entity);
        }
      }
    }

    return [...groups.values()]
      .map((action) => {
        const affected = action.affected_entities.slice(0, 6);
        const remaining = action.affected_entities.length - affected.length;
        const affectedText = affected.length
          ? `Affected: ${affected.join(", ")}${remaining > 0 ? `, plus ${remaining} more` : ""}.`
          : "";
        const evidenceText = action.evidence_items.slice(0, 2).join(" ");

        return {
          ...action,
          evidence: [affectedText, evidenceText].filter(Boolean).join(" "),
          fix: action.fix_items[0] || action.fix
        };
      })
      .sort(
        (a, b) =>
          severityRank(a.severity) - severityRank(b.severity) ||
          b.signal_count - a.signal_count
      );
  }

  function formatActionMoneyRisk(risk) {
    if (!risk || !hasNumber(risk.amount)) {
      return `<span class="money-label has-tooltip"${tooltipAttr("Unquantified: no defensible positive next-week EGP estimate from current evidence.")}>Unquantified</span>`;
    }
    const label = risk.display_label || (/upside/i.test(clean(risk.type)) ? "EGP upside next week" : "EGP at risk next week");
    const details = `${label} = next-week estimate from this week's demand/efficiency evidence. ${risk.confidence || "low"} confidence.`;
    return `<span class="money-label has-tooltip"${tooltipAttr(details)}>${escapeHtml(label)}: ${formatMoneyFull(risk.amount, risk.currency || reportData?.week?.currency)} (${escapeHtml(risk.confidence || "low")})</span>`;
  }

  function formatKeyValues(values = {}, limit = 6) {
    const entries = Object.entries(values || {})
      .filter(([, value]) => clean(value) !== "")
      .slice(0, limit);
    if (!entries.length) return `<span class="muted">No baseline fields recorded.</span>`;
    return entries.map(([key, value]) => `
      <span><strong>${escapeHtml(humanizeLabel(key))}</strong>${escapeHtml(formatNarrativeMetrics(value))}</span>
    `).join("");
  }

  function formatActionList(items = [], empty = "None recorded.") {
    const list = (items || []).map(clean).filter(Boolean);
    if (!list.length) return `<span class="muted">${escapeHtml(empty)}</span>`;
    return `<ul>${list.slice(0, 5).map((item) => `<li>${escapeHtml(formatNarrativeMetrics(item))}</li>`).join("")}</ul>`;
  }

  function scoredActionCard(item) {
    const action = item.final_action || item;
    const displayCategory = action.display_category || item.display_category || "";
    const typeLabel =
      displayCategory === "mandatory_goal_aligned" ? "Mandatory + goal-aligned" :
      displayCategory === "mandatory" || action.action_type === "mandatory" ? "Mandatory general" :
      displayCategory === "goal_driven" ? "Goal-driven" :
      displayCategory === "experiment" || action.recommendation_type === "experiment" ? "Experiment" :
      "Supporting";
    const pillClass =
      displayCategory === "mandatory_goal_aligned" ? "critical" :
      displayCategory === "mandatory" ? "action" :
      displayCategory === "goal_driven" ? "good" :
      displayCategory === "experiment" ? "watch" :
      clean(action.severity).toLowerCase() || "info";
    const metric = humanizeLabel(action.expected_metric_affected || action.expected_metric || "");
    const score = action.priority_score ?? item.total_score;
    const confidence = action.confidence ?? item.confidence_score;
    const scoreParts = item.formula?.components || {};
    return `
      <article class="action-card">
        <div class="action-meta">
          <span class="pill ${escapeHtml(pillClass)}">${escapeHtml(typeLabel)}</span>
          <span class="signal-count">Score ${formatNumber(score, 1)} | Confidence ${formatNumber(confidence, 0)}</span>
        </div>
        <h4>${escapeHtml(humanizeLabel(action.action_title || action.issue) || "Action required")}</h4>
        <p><strong>Intervention:</strong> ${escapeHtml(formatNarrativeMetrics(action.intervention || action.fix || "Define the corrective action."))}</p>
        <p><strong>Evidence:</strong> ${escapeHtml(formatNarrativeMetrics(action.evidence || "Not recorded."))}</p>
        <p><strong>Hypothesis:</strong> ${escapeHtml(formatNarrativeMetrics(action.business_hypothesis || action.hypothesis || "Hypothesis not recorded."))}</p>
        <p><strong>Why this goal:</strong> ${escapeHtml(action.goal_connection || action.why_supports_goal || "Supports the active goal.")}</p>
        <div class="action-grid">
          <div><span>Entity</span><strong>${escapeHtml(action.entity_name || action.entity_id || "Sitewide")}</strong></div>
          <div><span>Metric</span><strong>${escapeHtml(metric || "N/A")}</strong></div>
          <div><span>Direction</span><strong>${escapeHtml(action.expected_direction || "improve")}</strong></div>
          <div><span>EGP risk/upside next week</span><strong>${formatActionMoneyRisk(action.money_risk)}</strong></div>
        </div>
        <div class="action-detail">
          <div>
            <span>Baseline</span>
            <div class="mini-kv">${formatKeyValues(action.baseline || action.evidence_fields)}</div>
          </div>
          <div>
            <span>Experiment / measurement</span>
            <p>${escapeHtml(action.experiment_duration || "Review in the next weekly report.")}</p>
            <p><strong>Success:</strong> ${escapeHtml(formatNarrativeMetrics(action.success_threshold || "Define a measurable success threshold."))}</p>
            <p><strong>Stop:</strong> ${escapeHtml(formatNarrativeMetrics(action.stop_condition || "Stop if the metric worsens materially."))}</p>
          </div>
        </div>
        <p><strong>Financial guardrail:</strong> ${escapeHtml(formatNarrativeMetrics(action.financial_guardrail || "Check margin and inventory before committing spend or discounts."))}</p>
        <p><strong>Why visible:</strong> ${escapeHtml(formatNarrativeMetrics(action.survived_filter_reason || action.category_reason || "Passed strict evidence, goal, materiality, and guardrail checks."))}</p>
        <details>
          <summary>Evidence, assumptions, and score</summary>
          <div class="detail-columns">
            <div><strong>Alternative explanations</strong>${formatActionList(action.alternative_explanations, "No alternatives recorded.")}</div>
            <div><strong>Assumptions / missing data</strong>${formatActionList([...(action.assumptions || []), ...(action.missing_data || [])], "No missing-data warnings recorded.")}</div>
            <div><strong>Score components</strong><div class="mini-kv">${formatKeyValues(scoreParts, 8)}</div></div>
          </div>
        </details>
        <footer><strong>Check:</strong> ${escapeHtml(formatNarrativeMetrics(action.next_week_check || "Review the expected metric, financial guardrail, and stop condition next week."))}</footer>
      </article>
    `;
  }

  function scrollToGoalActions() {
    const target = document.getElementById("goal-driven-actions") || $("actions");
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.add("highlight-action-group");
    window.setTimeout(() => target.classList.remove("highlight-action-group"), 3200);
  }

  function renderScoredActions(scored) {
    const sections = [
      ["mandatory-goal-aligned-actions", "Mandatory + goal-aligned overlap", scored.mandatory_goal_aligned || [], "Mandatory issues that also directly support the active goal. They appear here once, not again in general actions."],
      ["mandatory-actions", "Mandatory general actions", scored.mandatory_corrections || [], "Hard corrections that protect data integrity, availability, quality, or wasted spend even when they do not match the goal."],
      ["goal-driven-actions", "Goal-driven actions", scored.goal_driven_priorities || [], "Ranked actions that directly support the active business goal after guardrail validation."],
      ["experiment-actions", "Experiments / opportunities", scored.experiments_opportunities || [], "Measured tests for uncertain causes such as price, offer, PDP, merchandising, creative, or traffic quality."]
    ].filter(([id, , actions]) => actions.length || id === "goal-driven-actions");

    const bridge = scored.performance_bridge || scored.evidence_packet?.performance_bridge || {};
    const bridgeText = (bridge.narrative || []).length
      ? ` What changed: ${(bridge.narrative || []).join("; ")}.`
      : "";
    const visibleCount = scored.all?.length || 0;
    const eligibleCount = scored.eligible_candidate_count ?? visibleCount;
    const hiddenCount = scored.hidden_eligible_candidates ?? Math.max(0, eligibleCount - visibleCount);
    const limits = scored.presentation_limits;
    const limitText = limits?.total
      ? ` Visible actions are capped at ${limits.total} (${limits.mandatory} mandatory, ${limits.goal_driven} goal-driven, ${limits.experiment} experiments).`
      : "";
    $("action-summary").textContent =
      `${formatNumber(scored.generated_candidate_count || scored.all?.length || 0)} candidate interventions generated, ` +
      `${formatNumber(eligibleCount)} survived strict eligibility, ${formatNumber(visibleCount)} shown, ` +
      `${formatNumber(hiddenCount)} eligible hidden by ranking caps, and ${formatNumber(scored.rejected_candidates?.length || 0)} rejected by evidence or guardrails against ${scored.goal_name || "the active goal"}. Categories are ordered first, then defensible EGP at risk/upside and confidence.${limitText}${bridgeText}`;
    $("action-groups").innerHTML = sections.length
      ? sections.map(([id, name, actions, summary]) => `
        <section class="action-group" id="${escapeHtml(id)}">
          <header class="action-group-head">
            <div>
              <h3>${escapeHtml(name)}</h3>
              <span>${escapeHtml(summary)}</span>
            </div>
            <div class="action-group-summary"><span>${actions.length} ${actions.length === 1 ? "action" : "actions"}</span></div>
          </header>
          <div class="action-list">${actions.length ? actions.map(scoredActionCard).join("") : `<div class="empty">No eligible goal-driven action survived the active goal, evidence, materiality, sample-size, and conflict gates.</div>`}</div>
        </section>
      `).join("")
      : `<div class="empty">No scored actions were available for this week.</div>`;
  }

  function renderActions(data) {
    const order = ["Operations", "Ecommerce", "Media Buying", "Creative", "Management", "Other"];
    const groups = new Map(order.map((name) => [name, []]));
    const consolidatedActions = consolidateActions(data);
    $("action-summary").textContent =
      `${formatNumber(data.actions?.length || 0)} findings combined into ` +
      `${formatNumber(consolidatedActions.length)} prioritized actions.`;
    for (const action of consolidatedActions) {
      groups.get(ownerGroup(action.owner)).push(action);
    }

    const populated = order.filter((name) => groups.get(name).length);
    $("action-groups").innerHTML = populated.length
      ? populated.map((name) => {
          const actions = groups.get(name);
          return `
            <section class="action-group">
              <header class="action-group-head">
                <h3>${name}</h3>
                <div class="action-group-summary">
                  <span>${actions.length} prioritized ${actions.length === 1 ? "action" : "actions"}</span>
                </div>
              </header>
              <div class="action-list">
                ${actions.map((action) => `
                  <article class="action-card">
                    <div class="action-meta">
                      <span class="pill ${escapeHtml(clean(action.severity).toLowerCase() || "info")}">${escapeHtml(action.severity || "Action")}</span>
                      <span class="signal-count">${formatNumber(action.signal_count)} ${action.signal_count === 1 ? "finding" : "findings"}</span>
                    </div>
                    <h4>${escapeHtml(humanizeLabel(action.issue) || "Action required")}</h4>
                    <p><strong>Evidence:</strong> ${escapeHtml(formatNarrativeMetrics(action.evidence || "Not recorded."))}</p>
                    <p><strong>Next move:</strong> ${escapeHtml(formatNarrativeMetrics(action.fix || "Define the corrective action."))}</p>
                    <footer><strong>Check:</strong> ${escapeHtml(formatNarrativeMetrics(action.next_week_check || "Review progress next week."))}</footer>
                  </article>
                `).join("")}
              </div>
            </section>
          `;
        }).join("")
      : `<div class="empty">No actions were recorded for this week.</div>`;
  }

  function renderVerificationList() {
    const items = [
      [1, "Pre-generation ad mapping workspace", "#ad-mapping", "Delivered"],
      [2, "Goal changes action ranking/filtering", "#actions", "Delivered"],
      [3, "Clear report hierarchy", "#leadership", "Delivered"],
      [4, "Max 10 visible actions total", "#actions", "Delivered"],
      [5, "Actions split into mandatory / goal-driven / overlap / experiments", "#actions", "Delivered"],
      [6, "EGP at risk/upside used for prioritization where defensible", "#actions", "Delivered"],
      [7, "Weak candidates rejected before scoring", "#actions", "Delivered"],
      [8, "Winner/restock logic requires proven demand and stock-cover risk", "#product-diagnosis", "Delivered"],
      [9, "Supply-constrained vs demand/conversion-constrained product split", "#product-diagnosis", "Delivered"],
      [10, "Returns/refunds action generated when material", "#actions", "Delivered"],
      [11, "Meta creative to product mapping confidence shown", "#evidence", "Delivered"],
      [12, "Creative cards show thumbnail/preview state + ad metrics + product + stock", "#evidence", "Delivered"],
      [13, "Strong creative + low stock produces do-not-scale state", "#evidence", "Delivered"],
      [14, "Low-confidence/unmapped ads do not create product-stock recommendations", "#evidence", "Delivered"],
      [15, "Monitoring observations are not mixed into default actions", "#actions", "Delivered"],
      [16, "Section-level product diagnosis hover explains formulas and thresholds", "#product-diagnosis", "Delivered"],
      [17, "Product-level hover explains stock, variants, velocity, funnel metrics, and why the bucket was chosen", "#product-diagnosis", "Delivered"],
      [18, "Low-sales low-traffic products are labeled as insufficient exposure instead of forced demand constraints", "#product-diagnosis", "Delivered"],
      [19, "Creative thumbnails use available Meta thumbnail/preview fields only", "#evidence", "Delivered"],
      [20, "Unavailable creative thumbnails show a specific unsupported reason and metadata source state", "#evidence", "Delivered"],
      [21, "Creative-to-product naming heuristic removes Coddiwomple/common ecommerce words before matching", "#evidence", "Delivered"],
      [22, "Ambiguous naming matches remain manual review with competing candidates shown", "#evidence", "Delivered"],
      [23, "Money values are labeled as EGP at risk/upside next week with formula hovers", "#actions", "Delivered"],
      [24, "Unquantifiable opportunities show Unquantified instead of 0 EGP", "#actions", "Delivered"],
      [25, "Ad mapping saves the complete product set without an AI call", "#ad-mapping", "Delivered"],
      [26, "AI report generator appears at the top of the report", "#ai-report", "Delivered"],
      [27, "General weekly AI report can be generated", "#ai-report", "Delivered"],
      [28, "Goal-focused AI report can be generated from custom input", "#ai-report", "Delivered"],
      [29, "Suggested goal options are available", "#ai-report", "Delivered"],
      [30, "AI goal interpretation changes report framing and action priorities", "#ai-report", "Delivered"],
      [31, "AI report considers products, SKUs, variants, inventory, sell-through, returns, funnel, ads, creatives, creative-product mapping, pricing/offer proxies, and conversion", "#ai-report", "Delivered"],
      [32, "AI report identifies paid-driven vs product-driven performance where data supports it", "#ai-report", "Delivered"],
      [33, "AI report identifies scale blockers such as strong creative + low stock", "#ai-report", "Delivered"],
      [34, "AI report is capped to a concise fast-read structure", "#ai-report", "Delivered"],
      [35, "AI report includes max 10 concrete actions with evidence, success threshold, stop condition, owner, confidence, and next-week risk/upside where defensible", "#ai-report", "Delivered"],
      [36, "AI report includes what not to do", "#ai-report", "Delivered"],
      [37, "AI report links to supporting evidence sections", "#ai-report", "Delivered"],
      [38, "AI generation is server-side and secured", "#ai-report", "Delivered"],
      [39, "Missing AI provider config shows a clear blocked state instead of fake output", "#ai-report", "Delivered"],
      [40, "Tooltip duplication is removed and custom tooltips are concise", "#product-diagnosis", "Delivered"],
      [41, "AI report starts with analyst conclusion, not raw metrics", "#ai-report", "Delivered"],
      [42, "AI report includes conclusive proof strip/charts before the memo", "#ai-report", "Delivered"],
      [43, "Every metric shown in the memo is tied to business meaning", "#ai-report", "Delivered"],
      [44, "AI prompt says diagnose, do not summarize", "#ai-report", "Delivered"],
      [45, "Insight compiler prepares diagnosis candidates before the AI call", "#ai-report", "Delivered"],
      [46, "AI report distinguishes paid-driven performance from product-driven performance where data supports it", "#ai-report", "Delivered"],
      [47, "AI report identifies scale blockers such as strong creative + low stock", "#ai-report", "Delivered"],
      [48, "AI report explains slow movers by exposure/traffic before recommending discounts", "#ai-report", "Delivered"],
      [49, "Goal-focused report materially changes priorities and what-not-to-do guidance", "#ai-report", "Delivered"],
      [50, "Action plan is capped at 7 by default", "#ai-report", "Delivered"],
      [51, "Report remains concise and understandable without reading the full dashboard", "#ai-report", "Delivered"],
      [52, "AI report includes Product and Ads & Creative Intelligence in one generation", "#ai-report", "Delivered"],
      [53, "Product list includes sold products and active in-stock products with zero sales", "#ai-report", "Delivered"],
      [54, "Products show images or clear missing-image reason", "#ai-report", "Delivered"],
      [55, "Products show variant availability with green/red status and quantities", "#ai-report", "Delivered"],
      [56, "Products can be sorted by most sold and least sold", "#ai-report", "Delivered"],
      [57, "Products show week-over-week performance", "#ai-report", "Delivered"],
      [58, "Products show general/historical performance signal", "#ai-report", "Delivered"],
      [59, "Product cards distinguish genuine winners from paid-driven sellers where data supports it", "#ai-report", "Delivered"],
      [60, "Product click opens detail explaining why it is selling or not selling", "#ai-report", "Delivered"],
      [61, "Product detail shows what is working, what is not, and what action to take", "#ai-report", "Delivered"],
      [62, "Product detail shows mapped ads and ad performance", "#ai-report", "Delivered"],
      [63, "Ad-to-product naming mapping is confirmed/fixed for near-exact names", "#ai-report", "Delivered"],
      [64, "Low-confidence mappings are review-only and do not drive conclusions", "#ai-report", "Delivered"],
      [65, "Product detail connects variants, inventory, funnel, returns, ads, and sales into one explanation", "#ai-report", "Delivered"],
      [66, "Product section remains simple and not visually cluttered", "#ai-report", "Delivered"],
      [67, "Saved AI reports auto-load from D1 and can be downloaded without regenerating", "#ai-report", "Delivered"]
    ];
    const target = document.getElementById("verification-list");
    if (!target) return;
    target.innerHTML = items.map(([number, behavior, anchor, status]) => `
      <li>
        <strong>${number}. ${escapeHtml(behavior)} - ${escapeHtml(status)}</strong>
        <span>Where: <a href="${anchor}">${anchor.replace("#", "")}</a>. Blocked items: none for behavior; thumbnails/previews show an unsupported state when Meta metadata is unavailable.</span>
      </li>
    `).join("");
  }

  function initAiReportControls() {
    $("ai-generate-general").addEventListener("click", () => generateAiReport("general", false));
    $("ai-generate-goal").addEventListener("click", () => generateAiReport("goal", false));
    $("ai-report-regenerate").addEventListener("click", () => generateAiReport(aiReportState.mode || "general", true));
    $("ai-report-download").addEventListener("click", downloadAiReport);
    $("ai-prerequisite-confirm").addEventListener("click", () => {
      const request = pendingAiGeneration;
      if (!request || request.blocked) return;
      closeAiGenerationReview();
      executeAiReportGeneration(request.mode, request.regenerate, request.goalText);
    });
    $("ai-prerequisite-cancel").addEventListener("click", () => closeAiGenerationReview());
    $("ai-prerequisite-close").addEventListener("click", () => closeAiGenerationReview());
    document.querySelectorAll("[data-ai-prerequisite-close]").forEach((element) => {
      element.addEventListener("click", () => closeAiGenerationReview());
    });
    $("ai-goal-suggestions").addEventListener("click", (event) => {
      const button = event.target.closest("[data-ai-goal]");
      if (!button) return;
      $("ai-goal-text").value = clean(button.getAttribute("data-ai-goal"));
      $("ai-goal-text").focus();
    });
    updateAiGenerationControls();
  }

  function renderReport(data) {
    clearLoadingTimers();
    clearSyncPoll();
    reportData = data;
    adMappingState.page = 1;
    renderLeadership(data);
    renderAiGoalSuggestions();
    renderAdMappingWorkspace();
    renderDrivers(data);
    renderDiagnosis(data);
    renderProductDiagnosis(data.diagnosis || null);
    renderEvidence(data);
    renderActions(data);
    if ($("weekly-report-range")) {
      $("weekly-report-range").textContent = `${formatDate(data.week?.week_start)} - ${formatDate(data.week?.week_end)}`;
    }
    loadFundingMonitor();
    $("loading-state").hidden = true;
    $("error-state").hidden = true;
    $("sync-state").hidden = true;
    $("error-message").textContent = "";
    $("report").hidden = false;
  }

  function showError(message) {
    clearLoadingTimers();
    clearSyncPoll();
    $("loading-state").hidden = true;
    $("report").hidden = true;
    $("sync-state").hidden = true;
    $("error-state").hidden = false;
    $("error-message").textContent = message;
  }

  async function loadReportWeeks() {
    const data = await apiGet("/report-weeks");
    reportWeeks = Array.isArray(data.weeks) ? data.weeks : [];

    if (selectedWeek) {
      const selected = weekByStart(selectedWeek);
      if (!selected) {
        throw new Error(`The selected week ${selectedWeek} is not available in the completed report weeks.`);
      }
      selectedWeekState = selected;
      return selectedWeek;
    }

    selectedWeek = clean(data.latest_completed_available_week);
    if (!selectedWeek) {
      throw new Error("No fully completed synced report week is available yet.");
    }
    selectedWeekState = weekByStart(selectedWeek);
    setSelectedWeekInUrl(selectedWeek, true);
    return selectedWeek;
  }

  async function loadReport() {
    if (!apiBase) {
      showError("Missing API base URL. Open this page with ?api=https://your-worker.example.com and optionally &week_start=YYYY-MM-DD.");
      return;
    }

    const loadSequence = ++reportLoadSequence;
    const loadWeek = selectedWeek;
    aiReportState.lookupSequence += 1;
    beginAiReportLookup(
      loadWeek
        ? `Loading ${loadWeek}. The saved AI report check will run as soon as the weekly evidence is ready.`
        : "Loading the selected week. The saved AI report check will run as soon as the weekly evidence is ready."
    );

    if (selectedWeekState && (!selectedWeekState.is_complete || weekDataStatus(selectedWeekState) !== "complete")) {
      await renderSyncProgress(selectedWeekState);
      return;
    }

    $("loading-state").hidden = false;
    $("error-state").hidden = true;
    $("report").hidden = true;
    $("sync-state").hidden = true;
    $("loading-message").textContent = "Reading the completed report data. The saved AI report check follows automatically.";
    startLoadingMessages();

    try {
      const data = await apiGet("/report-data", { week_start: loadWeek });
      if (loadSequence !== reportLoadSequence || loadWeek !== selectedWeek) return;
      beginAiReportLookup(`Weekly evidence for ${data.week?.week_start || loadWeek} is ready. Checking saved AI reports now.`);
      renderReport(data);
      await loadCachedAiReport("general");
    } catch (error) {
      if (loadSequence !== reportLoadSequence) return;
      const message = clean(error?.message || error);
      if (/failed to fetch|networkerror|load failed/i.test(message)) {
        showError(accessSessionError);
        return;
      }
      showError(message);
    }
  }

  window.CoddiReport = {
    renderReport,
    getData: () => reportData
  };

  async function init() {
    try {
      initSidebarControls();
      initSectionCollapseControls();
      if (!apiBase) {
        showError("Missing API base URL. Open this page with ?api=https://your-worker.example.com and optionally &week_start=YYYY-MM-DD.");
        return;
      }

      await loadReportWeeks();
      initAiReportControls();
      initAdMappingControls();
      initFundingMonitorControls();
      $("week-select").addEventListener("change", (event) => goToWeek(event.target.value));
      $("previous-week").addEventListener("click", () => {
        const available = selectableWeeks();
        const index = available.findIndex((week) => week.week_start === selectedWeek);
        if (index >= 0 && index < available.length - 1) goToWeek(available[index + 1].week_start);
      });
      $("next-week").addEventListener("click", () => {
        const available = selectableWeeks();
        const index = available.findIndex((week) => week.week_start === selectedWeek);
        if (index > 0) goToWeek(available[index - 1].week_start);
      });
      $("sync-latest").addEventListener("click", syncLatestWeek);
      $("sync-refresh").addEventListener("click", async () => {
        if (selectedWeekState) await renderSyncProgress(selectedWeekState);
      });
      $("sync-retry-week").addEventListener("click", retrySelectedWeek);
      $("sync-open-latest").addEventListener("click", async () => {
        clearSyncPoll();
        selectedWeek = "";
        selectedWeekState = null;
        await loadReportWeeks();
        await loadReport();
      });
      $("creative-modal-close")?.addEventListener("click", closeCreativePreview);
      document.querySelectorAll("[data-creative-close]").forEach((element) => {
        element.addEventListener("click", closeCreativePreview);
      });
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (!$("ai-prerequisite-modal").hidden) {
          closeAiGenerationReview();
          return;
        }
        closeCreativePreview();
      });
      await loadReport();
    } catch (error) {
      const message = clean(error?.message || error);
      if (/failed to fetch|networkerror|load failed/i.test(message)) {
        showError(accessSessionError);
        return;
      }
      showError(message);
    }
  }

  init();
})();

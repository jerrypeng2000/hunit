/**
 * AjkAPI client SDK reference implementation (Application Interface Standard v2.0).
 *
 * Minimal contract every client should expose:
 *   resolveApp, getEntitlement, consume, subscribe, unsubscribe
 *
 * Dependency-free so it can be copied into extensions, desktop web apps,
 * Electron renderers, mobile WebViews, or games.
 */

const DEFAULTS = {
  baseUrl: 'https://ajkapi.9zos.com',
  appSlug: '',
  appId: 0,
  accessToken: '',
  proxyPath: '',
};

const STORAGE_KEY = 'ajkapi-app-settings';
const FREE_DAILY_QUOTA = 10;

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readSettings() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
  } catch {
    return Object.assign({}, DEFAULTS);
  }
}

function writeSettings(next) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

function readLocalUsage() {
  try {
    const data = JSON.parse(localStorage.getItem('ajkapi-local-usage') || '{}');
    return data.date === todayKey() ? data : { date: todayKey(), used: 0 };
  } catch {
    return { date: todayKey(), used: 0 };
  }
}

function writeLocalUsage(usage) {
  localStorage.setItem('ajkapi-local-usage', JSON.stringify(usage));
}

function headers(settings) {
  return {
    'Content-Type': 'application/json',
    Authorization: settings.accessToken || '',
  };
}

function endpoint(settings, apiPath) {
  const base = settings.proxyPath
    ? `${location.origin}${settings.proxyPath}`
    : settings.baseUrl;
  return `${base}/${apiPath}`;
}

async function fetchJson(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function localEntitlement(errorMsg = '') {
  const usage = readLocalUsage();
  const remaining = Math.max(0, FREE_DAILY_QUOTA - usage.used);
  return {
    local: true,
    error: errorMsg,
    free_enabled: true,
    free_daily_quota: FREE_DAILY_QUOTA,
    free_used_today: usage.used,
    free_remaining_today: remaining,
    plugin_monthly_active: false,
    monthly_price_quota: 0,
    monthly_price_yuan: 0,
    monthly_duration_days: 30,
    auto_renew: true,
    renew_failed: false,
    need_recharge: false,
    recharge_url: '',
    requires_upgrade: false,
  };
}

async function resolveApp(settings) {
  if (settings.appId > 0) return settings;
  if (!settings.appSlug) return settings;
  const { status, body } = await fetchJson(
    endpoint(settings, `api/marketplace/apps/${encodeURIComponent(settings.appSlug)}`)
  );
  const id = body && body.data && body.data.app && body.data.app.id;
  if (status === 200 && id) {
    const next = Object.assign({}, settings, { appId: id });
    writeSettings(next);
    return next;
  }
  return settings;
}

async function getEntitlement() {
  let settings = readSettings();
  if (!settings.accessToken) return localEntitlement('Not connected to AjkAPI');

  settings = await resolveApp(settings);
  if (!settings.appId) return localEntitlement('App slug was not found');

  try {
    const { status, body } = await fetchJson(
      endpoint(settings, `api/billing/app-quota?app_id=${settings.appId}`),
      { headers: headers(settings) }
    );
    if (status === 401 || status === 403) {
      return localEntitlement('Invalid or expired token');
    }
    if (status !== 200) {
      throw new Error(`Quota query failed (${status})`);
    }
    const data = (body && body.data) || {};
    const detail = data.detail || data;
    return Object.assign({}, detail, {
      local: false,
      user_id: data.user_id || 0,
      recharge_url: data.recharge_url || detail.recharge_url || '',
    });
  } catch (err) {
    if (/AbortError|Failed to fetch|NetworkError|timeout/i.test(String(err && err.message))) {
      return localEntitlement('Network unavailable, using local free quota');
    }
    throw err;
  }
}

async function consume(count = 1) {
  let settings = readSettings();
  if (!settings.accessToken) return localConsume(count);
  settings = await resolveApp(settings);

  const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const { status, body } = await fetchJson(endpoint(settings, 'api/billing/consume'), {
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify({
      app_id: settings.appId,
      call_count: count,
      token_count: 0,
      request_id: requestId,
    }),
  });

  if (status !== 200 && status !== 402) {
    if (status === 401 || status === 403) return localConsume(count);
    throw new Error((body && body.message) || `Billing failed (${status})`);
  }

  const data = (body && body.data) || {};
  return {
    success: Boolean(body && body.success),
    requires_upgrade: Boolean(data.requires_upgrade || data.RequiresUpgrade),
    need_recharge: Boolean(data.need_recharge),
    recharge_url: data.recharge_url || '',
    source: data.source,
    message: (body && body.message) || data.message,
    free_remaining_today: data.free_remaining_today,
  };
}

function localConsume(count) {
  const usage = readLocalUsage();
  if (usage.date !== todayKey()) {
    usage.date = todayKey();
    usage.used = 0;
  }
  if (count > 1 || usage.used >= FREE_DAILY_QUOTA) {
    return {
      success: false,
      requires_upgrade: true,
      need_recharge: false,
      recharge_url: '',
      message: count > 1 ? 'Batch operations require a membership' : 'Daily free quota used up',
    };
  }
  usage.used += 1;
  writeLocalUsage(usage);
  return {
    success: true,
    source: 'free',
    free_used_today: usage.used,
    free_remaining_today: Math.max(0, FREE_DAILY_QUOTA - usage.used),
    requires_upgrade: false,
    need_recharge: false,
  };
}

async function subscribe() {
  let settings = readSettings();
  if (!settings.accessToken) throw new Error('Connect to AjkAPI first');
  settings = await resolveApp(settings);
  const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const { status, body } = await fetchJson(endpoint(settings, 'api/billing/app-subscribe'), {
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify({ app_id: settings.appId, request_id: requestId }),
  });
  if (status !== 200) {
    const err = new Error((body && body.message) || `Subscribe failed (${status})`);
    err.needRecharge = Boolean(body && body.data && body.data.need_recharge);
    err.rechargeUrl = (body && body.data && body.data.recharge_url) || '';
    throw err;
  }
  return body.data;
}

async function unsubscribe() {
  let settings = readSettings();
  if (!settings.accessToken) throw new Error('Connect to AjkAPI first');
  settings = await resolveApp(settings);
  const { status, body } = await fetchJson(endpoint(settings, 'api/billing/app-unsubscribe'), {
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify({ app_id: settings.appId }),
  });
  if (status !== 200) {
    throw new Error((body && body.message) || `Unsubscribe failed (${status})`);
  }
  return body.data;
}

export const AjkApiClient = {
  readSettings,
  writeSettings,
  resolveApp,
  getEntitlement,
  consume,
  subscribe,
  unsubscribe,
};

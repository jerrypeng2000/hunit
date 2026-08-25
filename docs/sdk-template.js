/**
 * AjkAPI client SDK reference implementation (Application Interface Standard v3.2).
 *
 * Minimal contract every client should expose:
 *   getCapabilities, resolveApp, getEntitlement, getModels, consume, subscribe, unsubscribe, redeem
 *
 * v3.0/v3.1 additions:
 *   - getModels(): app model list (default / switch / multimodal / auto)
 *   - consume(count, opts): opts.model_name marks an AI call, opts.feature marks a free feature
 *   - subscribe(mode): 'monthly' (basic subscription) or 'one_time' (lifetime buyout)
 *   - redeem(key): redeem a code (balance / AI credits pack) directly in the client
 *
 * Dependency-free transport reference. Each platform MUST replace the settings
 * storage with its secure adapter described in section 12 of the standard:
 * H5 uses a same-origin BFF/HttpOnly cookie, desktop uses the OS credential
 * vault, Android uses Keystore, iOS uses Keychain, and MV3 extensions prefer
 * chrome.storage.session. Do not persist a long-lived token in localStorage.
 */

const DEFAULTS = {
  baseUrl: 'https://ajkapi.9zos.com',
  appSlug: '',
  appId: 0,
  accessToken: '',
  proxyPath: '',
};

const STORAGE_KEY = 'ajkapi-app-settings';
const SESSION_TOKEN_KEY = 'ajkapi-access-token';
const FREE_DAILY_QUOTA = 10;
let runtimeAccessToken = '';
let runtimeLocalUsage = { date: '', used: 0 };

/**
 * getCapabilities v3.2: negotiate features with public, private, and OEM
 * deployments instead of guessing from a hostname or server version.
 */
async function getCapabilities() {
  const settings = readSettings();
  const { status, body } = await fetchJson(endpoint(settings, 'v1/capabilities'), {
    headers: { Accept: 'application/json' },
  });
  if (status !== 200 || !body || body.object !== 'gateway.capabilities') {
    throw new Error(`Capability negotiation failed (${status})`);
  }
  return body;
}

function getStorage(kind) {
  try {
    const storage = globalThis[kind];
    const probe = `__ajkapi_probe_${kind}`;
    storage?.setItem(probe, '1');
    storage?.removeItem(probe);
    return storage || null;
  } catch {
    return null;
  }
}

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readSettings() {
  const persistent = getStorage('localStorage');
  const session = getStorage('sessionStorage');
  try {
    const publicSettings = JSON.parse(persistent?.getItem(STORAGE_KEY) || '{}');
    // Tokens are session-only in this browser reference. Native clients must
    // replace this with their OS vault/Keystore/Keychain adapter.
    const accessToken = runtimeAccessToken || session?.getItem(SESSION_TOKEN_KEY) || '';
    return Object.assign({}, DEFAULTS, publicSettings, { accessToken });
  } catch {
    return Object.assign({}, DEFAULTS, { accessToken: runtimeAccessToken });
  }
}

function writeSettings(next) {
  const persistent = getStorage('localStorage');
  const session = getStorage('sessionStorage');
  const publicSettings = Object.assign({}, next);
  runtimeAccessToken = String(publicSettings.accessToken || '');
  delete publicSettings.accessToken;
  persistent?.setItem(STORAGE_KEY, JSON.stringify(publicSettings));
  if (runtimeAccessToken) {
    session?.setItem(SESSION_TOKEN_KEY, runtimeAccessToken);
  } else {
    session?.removeItem(SESSION_TOKEN_KEY);
  }
}

function readLocalUsage() {
  const persistent = getStorage('localStorage');
  try {
    const data = persistent
      ? JSON.parse(persistent.getItem('ajkapi-local-usage') || '{}')
      : runtimeLocalUsage;
    return data.date === todayKey() ? data : { date: todayKey(), used: 0 };
  } catch {
    return { date: todayKey(), used: 0 };
  }
}

function writeLocalUsage(usage) {
  runtimeLocalUsage = usage;
  getStorage('localStorage')?.setItem('ajkapi-local-usage', JSON.stringify(usage));
}

function headers(settings) {
  const result = { 'Content-Type': 'application/json' };
  if (settings.accessToken) result.Authorization = settings.accessToken;
  return result;
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
    auto_renew: false,
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
  if (!settings.accessToken && !settings.proxyPath) {
    return localEntitlement('Not connected to AjkAPI');
  }

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

/**
 * getModels v3.0: fetch selectable models for this app.
 * Returns { default_model, default_multimodal_model, auto_select, models: [...] }
 * UI guidance:
 *   - render models list with display_name + coefficient ("消耗倍率")
 *   - multimodal tasks (with images) must pick models with multimodal=true,
 *     or switch to default_multimodal_model automatically
 *   - "auto" option: text -> default_model, image -> default_multimodal_model
 */
async function getModels() {
  const settings = readSettings();
  if ((!settings.accessToken && !settings.proxyPath) || !settings.appId) {
    return { models: [], auto_select: false };
  }
  const { status, body } = await fetchJson(
    endpoint(settings, `api/billing/app-models?app_id=${settings.appId}`),
    { headers: headers(settings) }
  );
  if (status !== 200 || !body || !body.success) {
    return { models: [], auto_select: false };
  }
  return body.data || { models: [], auto_select: false };
}

/**
 * consume v3.0.
 * opts: { model_name?: string, feature?: string, token_count?: number }
 *   - model_name non-empty => AI call (billed against AI credits when the basic
 *     subscription excludes AI). Pass the model chosen via getModels().
 *   - feature matching free_features is free only when model_name is empty.
 *     AI calls always use metered credits, bounded quota, or balance.
 */
async function consume(count = 1, opts = {}) {
  let settings = readSettings();
  if (!settings.accessToken && !settings.proxyPath) return localConsume(count);
  settings = await resolveApp(settings);

  const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const { status, body } = await fetchJson(endpoint(settings, 'api/billing/consume'), {
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify({
      app_id: settings.appId,
      call_count: count,
      token_count: opts.token_count || 0,
      model_name: opts.model_name || '',
      feature: opts.feature || '',
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
    credits_remaining: data.credits_remaining,
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

/**
 * subscribe v3.0: mode 'monthly' (default) or 'one_time' (lifetime buyout).
 */
async function subscribe(mode = 'monthly') {
  let settings = readSettings();
  if (!settings.accessToken && !settings.proxyPath) throw new Error('Connect to AjkAPI first');
  settings = await resolveApp(settings);
  const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const { status, body } = await fetchJson(endpoint(settings, 'api/billing/app-subscribe'), {
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify({ app_id: settings.appId, mode, request_id: requestId }),
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
  if (!settings.accessToken && !settings.proxyPath) throw new Error('Connect to AjkAPI first');
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

/**
 * redeem v3.0: redeem a code inside the client (balance card / AI credits pack /
 * subscription / addon). On success the client should refresh getEntitlement().
 */
async function redeem(key) {
  const settings = readSettings();
  if (!settings.accessToken && !settings.proxyPath) throw new Error('Connect to AjkAPI first');
  const { status, body } = await fetchJson(endpoint(settings, 'api/billing/redeem'), {
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify({ key: String(key || '').trim() }),
  });
  if (status !== 200) {
    throw new Error((body && body.message) || `Redeem failed (${status})`);
  }
  return body.data;
}

/**
 * listCreditsPackages v3.0: gradient monthly AI credits packs + one-time booster packs.
 */
async function listCreditsPackages() {
  const settings = readSettings();
  const { status, body } = await fetchJson(
    endpoint(settings, 'api/credits/packages'),
    { headers: headers(settings) }
  );
  if (status !== 200 || !body || !body.success) return [];
  const data = body.data;
  return Array.isArray(data) ? data : data.items || [];
}

export const AjkApiClient = {
  getCapabilities,
  readSettings,
  writeSettings,
  resolveApp,
  getEntitlement,
  getModels,
  consume,
  subscribe,
  unsubscribe,
  redeem,
  listCreditsPackages,
};

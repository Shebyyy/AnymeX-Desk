import { fetch } from 'sdk';
import { DESK_BASE_URL, DESK_SYNC_SECRET } from './constants.js';

function headers(custom = {}) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${DESK_SYNC_SECRET}`,
    ...custom,
  };
}

function toQueryString(params) {
  const parts = [];
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/**
 * Fetch open or filtered reports from Desk.
 */
export async function getReports({ kind = '', platform = '', category = '', state = 'open', page = 1 } = {}) {
  const qs = toQueryString({
    kind,
    platform,
    category,
    state,
    page: String(page),
  });

  const url = `${DESK_BASE_URL}/api/v1/reports.json${qs}`;
  try {
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return { data: [], meta: {} };
    return await res.json();
  } catch (err) {
    console.error('getReports error:', err);
    return { data: [], meta: {} };
  }
}

/**
 * Fetch live release versions (stable, beta, plugin) from AnymeX Desk API.
 */
export async function getReleases() {
  const url = `${DESK_BASE_URL}/api/v1/releases`;
  try {
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error('getReleases error:', err);
    return null;
  }
}

/**
 * Fast similarity search for duplicate warning and inline query.
 */
export async function searchSimilar(query, kind = '') {
  if (!query || String(query).trim().length < 2) return [];
  const qs = toQueryString({
    q: String(query).trim(),
    kind: kind || '',
  });

  const url = `${DESK_BASE_URL}/api/v1/similar${qs}`;
  try {
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return [];
    const json = await res.json();
    return json.results || [];
  } catch (err) {
    console.error('searchSimilar error:', err);
    return [];
  }
}

/**
 * Get single report details by ID.
 */
export async function getReportDetails(id) {
  const url = `${DESK_BASE_URL}/api/telegram/report?id=${encodeURIComponent(id)}`;
  try {
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(`getReportDetails (${id}) error:`, err);
    return null;
  }
}

/**
 * Submit a newly completed report from the Telegram wizard to AnymeX Desk.
 */
export async function submitReport(reportData) {
  const url = `${DESK_BASE_URL}/api/telegram/report`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(reportData),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      return { ok: false, error: errJson.error || `Server responded with HTTP ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    console.error('submitReport error:', err);
    return { ok: false, error: `Network error: ${err.message || 'Could not connect to Desk API'}` };
  }
}

/**
 * Triage update (Staff action from Telegram button).
 */
export async function updateTriageStatus(reportId, status, staffUser) {
  const url = `${DESK_BASE_URL}/api/telegram/triage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        reportId,
        status,
        staff: staffUser,
      }),
    });
    return await res.json();
  } catch (err) {
    console.error('updateTriageStatus error:', err);
    return { ok: false, error: 'Network error updating status' };
  }
}

/**
 * Upvote a report.
 */
export async function toggleVote(reportId, telegramUser) {
  const url = `${DESK_BASE_URL}/api/telegram/vote`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        reportId,
        user: telegramUser,
      }),
    });
    return await res.json();
  } catch (err) {
    console.error('toggleVote error:', err);
    return { ok: false, error: 'Network error voting' };
  }
}

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

/**
 * Fetch open or filtered reports from Desk.
 */
export async function getReports({ kind = '', platform = '', category = '', state = 'open', page = 1 } = {}) {
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (platform) params.set('platform', platform);
  if (category) params.set('category', category);
  if (state) params.set('state', state);
  params.set('page', String(page));

  const url = `${DESK_BASE_URL}/api/v1/reports.json?${params.toString()}`;
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
 * Fast similarity search for duplicate warning and inline query.
 */
export async function searchSimilar(query, kind = '') {
  if (!query || query.trim().length < 2) return [];
  const params = new URLSearchParams({ q: query.trim() });
  if (kind) params.set('kind', kind);

  const url = `${DESK_BASE_URL}/api/v1/similar?${params.toString()}`;
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
    return await res.json();
  } catch (err) {
    console.error('submitReport error:', err);
    return { ok: false, error: 'Network error submitting report' };
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

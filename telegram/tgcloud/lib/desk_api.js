import { fetch, FormData, InputFile } from 'sdk';
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
 * Upload an attachment (image/video/log) to AnymeX Desk and sync to Discord forum.
 */
export async function uploadAttachment(reportId, fileBytes, fileName, fileType, reporterName) {
  const url = `${DESK_BASE_URL}/api/telegram/upload`;
  const form = new FormData();
  form.append('reportId', String(reportId));
  form.append('reporterName', reporterName || 'Telegram User');
  form.append('fileType', fileType || 'image');

  let mime = 'application/octet-stream';
  const lowerName = (fileName || '').toLowerCase();
  if (lowerName.endsWith('.png')) mime = 'image/png';
  else if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) mime = 'image/jpeg';
  else if (lowerName.endsWith('.webp')) mime = 'image/webp';
  else if (lowerName.endsWith('.gif')) mime = 'image/gif';
  else if (fileType === 'video' || lowerName.endsWith('.mp4')) mime = 'video/mp4';
  else if (lowerName.endsWith('.webm')) mime = 'video/webm';
  else if (lowerName.endsWith('.txt') || lowerName.endsWith('.log')) mime = 'text/plain';
  else if (lowerName.endsWith('.json')) mime = 'application/json';
  else if (lowerName.endsWith('.pdf')) mime = 'application/pdf';
  else if (lowerName.endsWith('.zip')) mime = 'application/zip';
  else if (fileType === 'image') mime = 'image/jpeg';

  form.append('file', new InputFile(fileBytes, fileName || 'attachment.bin', { type: mime }));

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DESK_SYNC_SECRET}`,
      },
      body: form,
    });
    if (!res.ok) {
      console.error('uploadAttachment HTTP error:', res.status, await res.text());
      return { ok: false };
    }
    return await res.json();
  } catch (err) {
    console.error('uploadAttachment error:', err);
    return { ok: false };
  }
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

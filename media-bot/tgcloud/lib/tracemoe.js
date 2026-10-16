import { fetch } from 'sdk';

const TRACEMOE_API = 'https://api.trace.moe/search?cutBorders=true';

/**
 * Perform reverse image search for an anime scene using trace.moe.
 *
 * @param {Uint8Array} imageBytes - Raw bytes of the screenshot
 * @returns {Promise<Array|null>} - List of matches with episode, timestamp, similarity, video clip
 */
export async function searchSauce(imageBytes) {
  try {
    const res = await fetch(TRACEMOE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
      },
      body: imageBytes,
    });

    if (!res.ok) {
      console.error('Trace.moe HTTP error:', res.status, await res.text().catch(() => ''));
      return null;
    }

    const data = await res.json();
    if (data.error) {
      console.error('Trace.moe error message:', data.error);
      return null;
    }

    return data.result || [];
  } catch (err) {
    console.error('Trace.moe request error:', err);
    return null;
  }
}

/**
 * Format timestamp in seconds (e.g. 125.4) to MM:SS format (e.g. "02:05").
 */
export function formatTimestamp(seconds) {
  if (seconds === undefined || seconds === null) return '00:00';
  const sec = Math.floor(seconds);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

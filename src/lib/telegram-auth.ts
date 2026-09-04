/**
 * Telegram Login Verification
 *
 * Implements Telegram's official HMAC-SHA256 authorization verification:
 * https://core.telegram.org/widgets/login#checking-authorization
 */

export interface TelegramAuthData {
  id: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string;
  hash: string;
}

/**
 * Verify that the received Telegram login payload was signed by Telegram
 * and matches the configured bot token.
 */
export async function verifyTelegramAuth(
  data: Record<string, string>,
  botToken: string,
  maxAgeSeconds = 86400,
): Promise<{ valid: boolean; reason?: string }> {
  if (!botToken) {
    return { valid: false, reason: 'bot_token_missing' };
  }

  const hash = data.hash;
  if (!hash) {
    return { valid: false, reason: 'missing_hash' };
  }

  // 1. Check expiration (within 24h by default)
  const authDate = Number(data.auth_date);
  if (!Number.isFinite(authDate)) {
    return { valid: false, reason: 'invalid_auth_date' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > maxAgeSeconds) {
    return { valid: false, reason: 'auth_expired' };
  }

  // 2. Build data_check_string (all keys sorted alphabetically, excluding 'hash')
  const checkKeys = Object.keys(data)
    .filter((k) => k !== 'hash')
    .sort();

  const dataCheckString = checkKeys.map((k) => `${k}=${data[k]}`).join('\n');

  // 3. Compute secret_key = SHA-256(botToken)
  const encoder = new TextEncoder();
  const botTokenBuffer = encoder.encode(botToken);
  const secretKeyBuffer = await crypto.subtle.digest('SHA-256', botTokenBuffer);

  // 4. Import secret_key for HMAC-SHA256
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    secretKeyBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  // 5. Calculate HMAC-SHA256 signature
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    encoder.encode(dataCheckString),
  );

  // Convert to hex string
  const signatureHex = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // 6. Timing-safe comparison if available, or strict equality
  const isValid = signatureHex.toLowerCase() === hash.toLowerCase();

  return {
    valid: isValid,
    reason: isValid ? undefined : 'invalid_hash',
  };
}

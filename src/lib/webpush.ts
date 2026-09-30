import crypto from 'crypto';
import { db } from './db/client';
import { pushSubscriptions } from './db/schema';
import { eq, sql } from 'drizzle-orm';

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

// Convert base64url or base64 to Buffer
function toBuffer(base64: string): Buffer {
  let b64 = base64.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64');
}

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Encrypt a text payload using RFC 8291 aes128gcm for Web Push.
 */
export function encryptPayload(
  payloadText: string,
  clientP256dhBase64: string,
  clientAuthBase64: string,
): Buffer {
  const userPublicKey = toBuffer(clientP256dhBase64);
  const userAuth = toBuffer(clientAuthBase64);

  // 1. Generate local ephemeral ECDH key pair
  const localEcdh = crypto.createECDH('prime256v1');
  localEcdh.generateKeys();
  const localPublicKey = localEcdh.getPublicKey(); // 65 bytes uncompressed

  // 2. Shared secret
  const sharedSecret = localEcdh.computeSecret(userPublicKey);

  // 3. Salt (16 bytes random)
  const salt = crypto.randomBytes(16);

  // 4. Derive pseudo-random key (PRK) using auth secret as salt
  // auth_info = "WebPush: info" || 0x00 || userPublicKey || localPublicKey
  const authInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    userPublicKey,
    localPublicKey,
  ]);
  const prkKey = crypto.hkdfSync('sha256', sharedSecret, userAuth, authInfo, 32);

  // 5. Derive Content Encryption Key (CEK) and nonce from PRK and salt
  const cekInfo = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8');
  const cek = crypto.hkdfSync('sha256', Buffer.from(prkKey), salt, cekInfo, 16);

  const nonceInfo = Buffer.from('Content-Encoding: nonce\0', 'utf8');
  const nonce = crypto.hkdfSync('sha256', Buffer.from(prkKey), salt, nonceInfo, 12);

  // 6. Plaintext padding: append delimiter 0x02 (record boundary)
  const payloadBuf = Buffer.from(payloadText, 'utf8');
  const record = Buffer.concat([payloadBuf, Buffer.from([2])]);

  // 7. AES-128-GCM encrypt
  const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
  const encrypted = Buffer.concat([cipher.update(record), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes

  // 8. Build message body:
  // [16-byte salt] + [4-byte rs (4096)] + [1-byte idlen (65)] + [65-byte local public key] + [ciphertext + tag]
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);

  const idLen = Buffer.from([localPublicKey.length]);

  return Buffer.concat([salt, rs, idLen, localPublicKey, encrypted, tag]);
}

/**
 * Create a signed VAPID JWT (RFC 8292) using Web Crypto / Node crypto.
 */
export function createVapidJwt(
  audience: string,
  subject: string,
  publicKeyBase64Url: string,
  privateKeyBase64Url: string,
): string {
  const header = { alg: 'ES256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    aud: audience,
    exp: now + 12 * 3600, // 12 hours
    sub: subject,
  };

  const headerB64 = toBase64Url(Buffer.from(JSON.stringify(header)));
  const claimsB64 = toBase64Url(Buffer.from(JSON.stringify(claims)));
  const unsignedToken = `${headerB64}.${claimsB64}`;

  // Import EC private key in PKCS8 or raw form
  const rawPrivate = toBuffer(privateKeyBase64Url);
  const rawPublic = toBuffer(publicKeyBase64Url);

  // Construct PKCS8 EC private key DER wrapper:
  // SEQUENCE (30) {
  //   version INTEGER 0 (02 01 00)
  //   privateKeyAlgorithm SEQUENCE (30 13) {
  //     algorithm OID ecPublicKey 1.2.840.10045.2.1 (06 07 2A 86 48 CE 3D 02 01)
  //     namedCurve OID secp256r1 1.2.840.10045.3.1.7 (06 08 2A 86 48 CE 3D 03 01 07)
  //   }
  //   privateKey OCTET STRING (04 ...) {
  //     ECPrivateKey SEQUENCE (30 ...) {
  //       version INTEGER 1 (02 01 01)
  //       privateKey OCTET STRING (04 20 [32-byte key])
  //       parameters [0] (A0 ...) omitted
  //       publicKey [1] BIT STRING (A1 44 03 42 00 [65-byte public key])
  //     }
  //   }
  // }
  const ecPrivSeq = Buffer.concat([
    Buffer.from('30770201010420', 'hex'),
    rawPrivate,
    Buffer.from('a144034200', 'hex'),
    rawPublic,
  ]);
  const pkcs8Der = Buffer.concat([
    Buffer.from('308187020100301306072a8648ce3d020106082a8648ce3d030107046d', 'hex'),
    ecPrivSeq,
  ]);

  const keyObject = crypto.createPrivateKey({
    key: pkcs8Der,
    format: 'der',
    type: 'pkcs8',
  });

  const sign = crypto.createSign('SHA256');
  sign.update(unsignedToken);
  const derSignature = sign.sign(keyObject);

  // Convert DER ECDSA signature (SEQUENCE of two INTEGERs r and s) to 64-byte raw (r || s)
  const rawSig = derToRawSignature(derSignature);
  const sigB64 = toBase64Url(rawSig);

  return `${unsignedToken}.${sigB64}`;
}

function derToRawSignature(der: Buffer): Buffer {
  let offset = 2; // Skip 0x30, length
  // First integer: r
  offset += 1; // skip 0x02
  const rLen = der[offset++];
  let r = der.subarray(offset, offset + rLen);
  offset += rLen;
  if (r.length > 32) r = r.subarray(r.length - 32);
  else if (r.length < 32) {
    const pad = Buffer.alloc(32 - r.length);
    r = Buffer.concat([pad, r]);
  }

  // Second integer: s
  offset += 1; // skip 0x02
  const sLen = der[offset++];
  let s = der.subarray(offset, offset + sLen);
  if (s.length > 32) s = s.subarray(s.length - 32);
  else if (s.length < 32) {
    const pad = Buffer.alloc(32 - s.length);
    s = Buffer.concat([pad, s]);
  }

  return Buffer.concat([r, s]);
}

/** Default VAPID keys for development (can be overridden via env vars / secrets) */
export const DEFAULT_VAPID_PUBLIC =
  'BLENhxPqJ7xBikMN1c3B9LqNK8_llSmBAbsRVHopZBe-Lh5Lbu9xpRqFMrnZoYIobp73KWR05O7tS0B6k9HmgAc';
export const DEFAULT_VAPID_PRIVATE =
  'MWAdMd1USsQyk5XM0Uxbx2xoKokm8XrAeUkunj3Z7N4';
export const DEFAULT_VAPID_SUBJECT = 'mailto:admin@anymex.app';

/**
 * Dispatch a Web Push notification to a single push subscription.
 */
export async function sendWebPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
  env?: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string },
): Promise<{ ok: boolean; status: number; expired?: boolean }> {
  try {
    const pubKey = env?.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC;
    const privKey = env?.VAPID_PRIVATE_KEY || DEFAULT_VAPID_PRIVATE;
    const subject = env?.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;

    const endpointUrl = new URL(subscription.endpoint);
    const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;

    const encryptedBody = encryptPayload(
      JSON.stringify(payload),
      subscription.p256dh,
      subscription.auth,
    );

    const jwt = createVapidJwt(audience, subject, pubKey, privKey);

    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'TTL': '86400',
        'Urgency': 'normal',
        'Authorization': `vapid t=${jwt}, k=${pubKey}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
      },
      body: encryptedBody,
    });

    const isExpired = response.status === 404 || response.status === 410;
    return { ok: response.ok, status: response.status, expired: isExpired };
  } catch (err) {
    console.error('sendWebPush error:', err);
    return { ok: false, status: 500 };
  }
}

/**
 * Send push notification to all active browser subscriptions for a user.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  env?: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string },
): Promise<void> {
  try {
    const subs = await db()
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));

    if (!subs.length) return;

    for (const sub of subs) {
      const res = await sendWebPush(sub, payload, env);
      if (res.expired) {
        // Automatically cleanup expired/revoked browser subscriptions
        await db()
          .delete(pushSubscriptions)
          .where(eq(pushSubscriptions.endpoint, sub.endpoint));
      } else if (res.ok) {
        await db()
          .update(pushSubscriptions)
          .set({ lastUsedAt: sql`(unixepoch())` })
          .where(eq(pushSubscriptions.id, sub.id));
      }
    }
  } catch (err) {
    console.error('Failed to send push to user', userId, err);
  }
}

/**
 * Send push notifications to all users invested in a report (reporter + voters).
 */
export async function sendPushToReportWatchers(
  reportId: number,
  payload: PushPayload,
  skipUserId?: string | null,
  env?: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string },
): Promise<void> {
  try {
    const skip = skipUserId ?? '\0';
    const rows = await db().all<{ who: string }>(sql`
      SELECT DISTINCT who FROM (
        SELECT reporter_id AS who FROM reports WHERE id = ${reportId}
        UNION
        SELECT discord_id AS who FROM votes WHERE report_id = ${reportId}
      ) WHERE who <> ${skip}
    `);

    for (const r of rows) {
      await sendPushToUser(r.who, payload, env);
    }
  } catch (err) {
    console.error('Failed sendPushToReportWatchers', err);
  }
}

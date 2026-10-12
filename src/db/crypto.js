import crypto from 'node:crypto';

/**
 * AES-256-GCM helpers for provider_credentials at rest.
 * ENCRYPTION_KEY must be a 64-char hex string (32 bytes).
 * Storage layout: value_encrypted = authTag(16B) || ciphertext ; iv = 12B nonce.
 */

function key() {
  const k = process.env.ENCRYPTION_KEY;
  if (!k || k.length !== 64) throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  return Buffer.from(k, 'hex');
}

export function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { value: Buffer.concat([tag, encrypted]), iv };
}

export function decrypt(valueEncrypted, iv) {
  const tag = valueEncrypted.subarray(0, 16);
  const data = valueEncrypted.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Generate a fresh key once: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" */

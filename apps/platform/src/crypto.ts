import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

export function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, (err, key) => (err ? reject(err) : resolve(`scrypt$${salt.toString('hex')}$${key.toString('hex')}`))),
  );
}

export function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [alg, saltHex, keyHex] = (stored ?? '').split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return Promise.resolve(false);
  const expected = Buffer.from(keyHex, 'hex');
  return new Promise((resolve) =>
    scrypt(password, Buffer.from(saltHex, 'hex'), KEYLEN, (err, key) => resolve(!err && key.length === expected.length && timingSafeEqual(key, expected))),
  );
}

export const newToken = () => randomBytes(32).toString('base64url');
/** Nel database restano solo gli hash: un database trapelato non contiene sessioni valide */
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

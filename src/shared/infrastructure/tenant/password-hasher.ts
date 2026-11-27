import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const saltLength = 16;
const keyLength = 64;
const dummyHash = `scrypt$${Buffer.alloc(saltLength).toString('base64url')}$${Buffer.alloc(keyLength).toString('base64url')}`;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(saltLength);
  const key = await scrypt(password, salt, keyLength) as Buffer;
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string | undefined): Promise<boolean> {
  const [algorithm, saltText, keyText] = (encoded ?? dummyHash).split('$');
  if (algorithm !== 'scrypt' || !saltText || !keyText) return false;
  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(keyText, 'base64url');
  if (!salt.length || expected.length !== keyLength) return false;
  const actual = await scrypt(password, salt, expected.length) as Buffer;
  return timingSafeEqual(actual, expected) && encoded !== undefined;
}

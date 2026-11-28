import { hashPassword, verifyPassword } from './password-hasher.js';

describe('password hasher', () => {
  it('hashes passwords and verifies matching and nonmatching values', async () => {
    const encoded = await hashPassword('correct horse battery staple');

    expect(encoded).toMatch(/^scrypt\$[\w-]+\$[\w-]+$/);
    await expect(verifyPassword('correct horse battery staple', encoded)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', encoded)).resolves.toBe(false);
  });

  it('rejects absent, malformed, and unsupported hashes', async () => {
    await expect(verifyPassword('password', undefined)).resolves.toBe(false);
    await expect(verifyPassword('password', 'bcrypt$salt$hash')).resolves.toBe(false);
    await expect(verifyPassword('password', 'scrypt$$hash')).resolves.toBe(false);
    await expect(verifyPassword('password', 'scrypt$c2FsdA$short')).resolves.toBe(false);
  });
});

import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import { createInitialAdministrator, InitialAdminAlreadyExistsError, initialAdminSchema } from './admin-bootstrap.js';

function testDatabase() {
  let users = 0;
  type CreateInput = { data: { name: string; email: string; passwordHash: string; role: 'ADMIN'; active: true; approvedAt: Date }; select: { id: true } };
  const create = vi.fn(async (_input: CreateInput) => { users += 1; return { id: 'test-only-id' }; });
  return {
    create,
    count: () => users,
    database: {
      $transaction: async <T>(callback: (transaction: { user: { count: () => Promise<number>; create: typeof create } }) => Promise<T>) => callback({
        user: { count: async () => users, create },
      }),
    },
  };
}

describe('secure initial administrator bootstrap', () => {
  it('requires a valid e-mail and a password with at least 12 characters', () => {
    expect(initialAdminSchema.safeParse({ name: 'Admin', email: 'invalid', password: 'LongPassword123' }).success).toBe(false);
    expect(initialAdminSchema.safeParse({ name: 'Admin', email: 'admin@example.com', password: 'short' }).success).toBe(false);
  });

  it('normalizes e-mail, hashes the password and creates the ADMIN account active and approved', async () => {
    const fixture = testDatabase();
    await createInitialAdministrator({ name: ' Admin ', email: 'ADMIN@EXAMPLE.COM', password: 'LongPassword123' }, fixture.database);
    const data = fixture.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ name: 'Admin', email: 'admin@example.com', role: 'ADMIN', active: true });
    expect(data.passwordHash).not.toBe('LongPassword123');
    expect(await bcrypt.compare('LongPassword123', data.passwordHash)).toBe(true);
  });

  it('blocks a second execution without changing the existing user', async () => {
    const fixture = testDatabase();
    const input = { name: 'Admin', email: 'admin@example.com', password: 'LongPassword123' };
    await createInitialAdministrator(input, fixture.database);
    await expect(createInitialAdministrator(input, fixture.database)).rejects.toBeInstanceOf(InitialAdminAlreadyExistsError);
    expect(fixture.count()).toBe(1);
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });
});

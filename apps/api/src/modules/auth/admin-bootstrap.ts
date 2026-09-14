import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';

export const initialAdminSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome do administrador.').max(120),
  email: z.email('Informe um e-mail válido.').transform(value => value.toLowerCase()),
  password: z.string().min(12, 'A senha deve ter pelo menos 12 caracteres.').max(128),
});

type AdminData = {
  name: string;
  email: string;
  passwordHash: string;
  role: 'ADMIN';
  active: true;
  approvedAt: Date;
};

type AdminTransaction = {
  user: {
    count: () => Promise<number>;
    create: (input: { data: AdminData; select: { id: true } }) => Promise<{ id: string }>;
  };
};

type AdminDatabase = {
  $transaction: <T>(callback: (transaction: AdminTransaction) => Promise<T>, options: { isolationLevel: 'Serializable' }) => Promise<T>;
};

export class InitialAdminAlreadyExistsError extends Error {
  constructor() { super('A criação inicial foi bloqueada porque já existe um usuário.'); }
}

export async function createInitialAdministrator(
  input: unknown,
  database: AdminDatabase = prisma as unknown as AdminDatabase,
) {
  const admin = initialAdminSchema.parse(input);
  const passwordHash = await bcrypt.hash(admin.password, 12);

  return database.$transaction(async transaction => {
    if (await transaction.user.count() !== 0) throw new InitialAdminAlreadyExistsError();
    return transaction.user.create({
      data: {
        name: admin.name,
        email: admin.email,
        passwordHash,
        role: 'ADMIN',
        active: true,
        approvedAt: new Date(),
      },
      select: { id: true },
    });
  }, { isolationLevel: 'Serializable' });
}

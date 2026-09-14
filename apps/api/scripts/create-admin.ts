import '../src/config.js';
import { prisma } from '../src/lib/prisma.js';
import { createInitialAdministrator } from '../src/modules/auth/admin-bootstrap.js';

const name = process.env.INITIAL_ADMIN_NAME;
const email = process.env.INITIAL_ADMIN_EMAIL;
const password = process.env.INITIAL_ADMIN_PASSWORD;

try {
  await createInitialAdministrator({ name, email, password });
  console.log('Administrador inicial criado com sucesso.');
} catch (error) {
  const message = error instanceof Error ? error.message : 'Não foi possível criar o administrador inicial.';
  console.error(message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

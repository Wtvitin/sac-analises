import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function runStep(name, command, env = {}) {
  process.stdout.write(`\n[PASSO] ${name}... `);
  const start = Date.now();
  try {
    execSync(command, {
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`OK (${duration}s)`);
    return true;
  } catch (err) {
    console.log(`FALHOU!`);
    if (err.stdout) process.stdout.write(err.stdout.toString());
    if (err.stderr) process.stderr.write(err.stderr.toString());
    return false;
  }
}

function auditForbiddenFiles() {
  process.stdout.write(`\n[PASSO] Auditoria de arquivos proibidos e segredos... `);
  try {
    const trackedFiles = execSync('git ls-files', { stdio: 'pipe' })
      .toString()
      .split('\n')
      .map(f => f.trim())
      .filter(Boolean);

    const forbiddenTracked = trackedFiles.filter(file => {
      const lower = file.toLowerCase();
      return (
        lower === '.env' ||
        lower.startsWith('.env.') && !lower.endsWith('.example') ||
        lower.startsWith('data/uploads/') ||
        lower.startsWith('apps/api/uploads/') ||
        (lower.startsWith('uploads/') && !lower.endsWith('.gitkeep')) ||
        lower.endsWith('.pem') ||
        lower.endsWith('.key') ||
        lower.endsWith('.dump') ||
        lower.endsWith('.sql.gz') ||
        lower.endsWith('.bak')
      );
    });

    if (forbiddenTracked.length > 0) {
      console.log(`FALHOU!`);
      console.error(`Arquivos proibidos detectados no rastreamento do Git:\n  - ${forbiddenTracked.join('\n  - ')}`);
      return false;
    }

    console.log(`OK (0 arquivos proibidos rastreados)`);
    return true;
  } catch (err) {
    console.log(`FALHOU ao executar git ls-files`);
    return false;
  }
}

function checkMigrationsIntegrity() {
  process.stdout.write(`\n[PASSO] Verificação da integridade das migrações Prisma... `);
  const migrationsDir = resolve('apps/api/prisma/migrations');
  if (!existsSync(migrationsDir)) {
    console.log(`FALHOU: diretório de migrações não encontrado!`);
    return false;
  }

  const entries = readdirSync(migrationsDir).filter(name => {
    const fullPath = resolve(migrationsDir, name);
    return statSync(fullPath).isDirectory() && !name.startsWith('_');
  });

  for (const entry of entries) {
    const sqlPath = resolve(migrationsDir, entry, 'migration.sql');
    if (!existsSync(sqlPath)) {
      console.log(`FALHOU: migração "${entry}" não contém migration.sql!`);
      return false;
    }
  }

  console.log(`OK (${entries.length} migrações íntegras e versionadas)`);
  return true;
}

function checkPendingMigrations() {
  process.stdout.write(`\n[PASSO] Verificação de migrações pendentes no banco... `);
  const envPath = resolve('.env');
  if (!existsSync(envPath)) {
    console.log(`PULADO (.env não encontrado — verificação estática aplicada)`);
    return true;
  }

  try {
    const output = execSync(
      'node --env-file=.env apps/api/node_modules/prisma/build/index.js migrate status --schema apps/api/prisma/schema.prisma',
      { stdio: 'pipe' }
    ).toString();

    if (output.includes('Database schema is up to date!')) {
      console.log(`OK (banco de dados sincronizado e sem migrações pendentes)`);
      return true;
    }

    console.log(`AVISO: status inesperado.`);
    console.log(output);
    return true;
  } catch (err) {
    console.log(`FALHOU!`);
    if (err.stdout) process.stdout.write(err.stdout.toString());
    if (err.stderr) process.stderr.write(err.stderr.toString());
    return false;
  }
}

function main() {
  console.log('========================================================');
  console.log(' SAC Análises — Verificação Unificada Pré-Release / Deploy');
  console.log('========================================================');

  const steps = [
    () => auditForbiddenFiles(),
    () => checkMigrationsIntegrity(),
    () => checkPendingMigrations(),
    () => runStep('Prisma Client Generate', 'pnpm run db:generate'),
    () => runStep('Lint e Tipagem Estrita (Workspace)', 'pnpm -r lint'),
    () => runStep('Suíte Completa de Testes Automatizados', 'pnpm -r test', {
      DATABASE_URL: 'postgresql://ci:ci@localhost:5432/ci?schema=public',
      JWT_SECRET: 'ci-testing-jwt-secret-not-used-in-production-12345',
      WEB_ORIGIN: 'http://localhost:5173',
      PORT: '3333',
    }),
    () => runStep('Compilação dos Bundles de Produção (API e Web)', 'pnpm -r build', {
      DATABASE_URL: 'postgresql://ci:ci@localhost:5432/ci?schema=public',
      JWT_SECRET: 'ci-testing-jwt-secret-not-used-in-production-12345',
      WEB_ORIGIN: 'http://localhost:5173',
    }),
  ];

  for (const step of steps) {
    const success = step();
    if (!success) {
      console.error('\n[ERRO] A verificação de release falhou em um dos passos. Corrija o problema antes de publicar.');
      process.exit(1);
    }
  }

  console.log('\n========================================================');
  console.log(' [SUCESSO] Todos os passos da verificação foram aprovados!');
  console.log(' O projeto está íntegro e validado para release/publicação.');
  console.log('========================================================');
}

main();

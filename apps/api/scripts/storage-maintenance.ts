import '../src/config.js';
import { reconcileStorage } from '../src/modules/attachments/orphan-reconciliation.js';

async function main() {
  const args = process.argv.slice(2);
  const applyFix = args.includes('--apply');
  const dryRun = !applyFix;

  console.log('='.repeat(60));
  console.log('SAC Análises — Manutenção e Reconciliação de Armazenamento');
  console.log(`Modo: ${dryRun ? 'DRY-RUN (Somente relatório - nenhuma alteração)' : 'APLICAR (Limpeza de temporários expirados)'}`);
  console.log('='.repeat(60));

  const report = await reconcileStorage({ dryRun });

  console.log(`Data da auditoria: ${report.timestamp}`);
  console.log(`\n1. Arquivos físicos sem registro no banco (${report.physicalWithoutRecord.length}):`);
  for (const item of report.physicalWithoutRecord) {
    console.log(`   - [ÓRFÃO FÍSICO] ${item}`);
  }
  if (!report.physicalWithoutRecord.length) console.log('   Nenhum arquivo físico órfão detectado.');

  console.log(`\n2. Registros no banco sem arquivo físico (${report.recordWithoutPhysical.length}):`);
  for (const id of report.recordWithoutPhysical) {
    console.log(`   - [REGISTRO AUSENTE] ID: ${id}`);
  }
  if (!report.recordWithoutPhysical.length) console.log('   Nenhum registro órfão detectado.');

  console.log(`\n3. Arquivos temporários expirados (${report.expiredTemporaries.length}):`);
  for (const item of report.expiredTemporaries) {
    console.log(`   - [TEMPORÁRIO EXPIRADO] ${item}`);
  }
  if (!report.expiredTemporaries.length) console.log('   Nenhum temporário expirado detectado.');

  console.log(`\n4. Arquivos marcados para remoção/quarentena (${report.pendingRemoval.length}):`);
  for (const id of report.pendingRemoval) {
    console.log(`   - [PENDENTE] ID: ${id}`);
  }
  if (!report.pendingRemoval.length) console.log('   Nenhum arquivo pendente de remoção.');

  if (report.actionsTaken.length) {
    console.log('\nAções executadas:');
    for (const action of report.actionsTaken) {
      console.log(`   * ${action}`);
    }
  }

  console.log('='.repeat(60));
  process.exit(0);
}

main().catch(err => {
  console.error('Falha na manutenção de armazenamento:', err);
  process.exit(1);
});

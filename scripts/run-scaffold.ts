/**
 * Run scaffold engine for Cash POS Phase 1: PaymentTypes + Payments
 *
 * Usage: npx tsx scripts/run-scaffold.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  ScaffoldConfig,
  ScaffoldField,
  defaultCrudRoutes,
  generateScaffold,
  patchServicesEnum,
  patchDbTypes,
  patchIndexTs,
  SHOP_DIARY_TEMPLATE,
} from '../src/scaffold-engine';

const WORKSPACE = process.env.WORKSPACE || 'C:\\Users\\dinga\\Projects\\shop-diary-v3';

// ── Entity 1: PaymentTypes ──

const paymentTypesConfig: ScaffoldConfig = {
  entity: 'payment-types',
  entityCamel: 'paymentTypes',
  entityPascal: 'PaymentTypes',
  entitySingular: 'paymentType',
  table: 'PaymentTypes',
  idField: 'paymentTypeId',
  fields: [
    { name: 'name', type: 'text', zodType: 'z.string()', tsType: 'string', notNull: true },
    { name: 'description', type: 'text', zodType: 'z.string()', tsType: 'string', notNull: false },
    { name: 'isActive', type: 'integer', zodType: 'z.number()', tsType: 'number', notNull: true },
    { name: 'shopId', type: 'text', zodType: 'z.string()', tsType: 'string', notNull: true },
  ],
  routes: defaultCrudRoutes('payment-types', 'paymentTypeId'),
  middleware: { auth: true, mutation: true },
};

// ── Entity 2: Payments ──

const paymentsConfig: ScaffoldConfig = {
  entity: 'payments',
  entityCamel: 'payments',
  entityPascal: 'Payments',
  entitySingular: 'payment',
  table: 'Payments',
  idField: 'paymentId',
  fields: [
    { name: 'orderId', type: 'text', zodType: 'z.string()', tsType: 'string', notNull: true },
    { name: 'paymentTypeId', type: 'text', zodType: 'z.string()', tsType: 'string', notNull: true },
    { name: 'amount', type: 'real', zodType: 'z.number()', tsType: 'number', notNull: true },
    { name: 'tendered', type: 'real', zodType: 'z.number()', tsType: 'number', notNull: false },
    { name: 'change', type: 'real', zodType: 'z.number()', tsType: 'number', notNull: false },
    { name: 'shopId', type: 'text', zodType: 'z.string()', tsType: 'string', notNull: true },
  ],
  routes: defaultCrudRoutes('payments', 'paymentId'),
  middleware: { auth: true, mutation: true },
};

// ── Execute ──

function writeScaffoldFiles(config: ScaffoldConfig) {
  const output = generateScaffold(config, SHOP_DIARY_TEMPLATE);

  console.log(`\n=== Scaffolding: ${config.entityPascal} ===\n`);

  // Write new files
  for (const file of output.files) {
    const fullPath = join(WORKSPACE, file.path);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, file.content, 'utf-8');
    console.log(`  CREATED: ${file.path}`);
  }

  // Patch shared files
  // 1. services.enum.ts
  const enumPath = join(WORKSPACE, SHOP_DIARY_TEMPLATE.paths.servicesEnum);
  const enumContent = readFileSync(enumPath, 'utf-8');
  writeFileSync(enumPath, patchServicesEnum(enumContent, config.table), 'utf-8');
  console.log(`  PATCHED: ${SHOP_DIARY_TEMPLATE.paths.servicesEnum}`);

  // 2. db.types.ts
  const dbPath = join(WORKSPACE, SHOP_DIARY_TEMPLATE.paths.dbTypes);
  const dbContent = readFileSync(dbPath, 'utf-8');
  writeFileSync(dbPath, patchDbTypes(dbContent, config.entityPascal, config.table, `${config.entity}.schema`), 'utf-8');
  console.log(`  PATCHED: ${SHOP_DIARY_TEMPLATE.paths.dbTypes}`);

  // 3. index.ts
  const indexPath = join(WORKSPACE, SHOP_DIARY_TEMPLATE.paths.entrypoint);
  const indexContent = readFileSync(indexPath, 'utf-8');
  writeFileSync(indexPath, patchIndexTs(indexContent, config.entityCamel, config.entity, SHOP_DIARY_TEMPLATE.patterns.registrationInsertBefore), 'utf-8');
  console.log(`  PATCHED: ${SHOP_DIARY_TEMPLATE.paths.entrypoint}`);
}

// Run both entities sequentially (order matters — they patch the same shared files)
writeScaffoldFiles(paymentTypesConfig);
writeScaffoldFiles(paymentsConfig);

console.log('\n✓ Scaffold complete. Run build to verify.');

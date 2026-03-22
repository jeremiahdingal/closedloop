import { describe, it, expect } from 'vitest';
import {
  defaultCrudRoutes,
  detectScaffoldConfig,
  parseArchitectOutput,
  patchServicesEnum,
  patchDbTypes,
  patchIndexTs,
} from './scaffold-engine';

describe('defaultCrudRoutes', () => {
  it('generates 5 standard CRUD routes', () => {
    const routes = defaultCrudRoutes('payments', 'paymentId');
    expect(routes).toHaveLength(5);
    expect(routes.map(r => r.method)).toEqual(['get', 'get', 'post', 'put', 'delete']);
  });

  it('uses entity for path prefix', () => {
    const routes = defaultCrudRoutes('cash-shifts', 'cashShiftId');
    expect(routes[0].path).toBe('/cash-shifts');
    expect(routes[1].path).toBe('/cash-shifts/:id');
  });

  it('marks POST/PUT as needing body', () => {
    const routes = defaultCrudRoutes('items', 'itemId');
    expect(routes.find(r => r.method === 'post')!.needsBody).toBe(true);
    expect(routes.find(r => r.method === 'put')!.needsBody).toBe(true);
    expect(routes.find(r => r.method === 'get')!.needsBody).toBeUndefined();
  });
});

describe('detectScaffoldConfig', () => {
  it('detects a structured CRUD ticket', () => {
    const config = detectScaffoldConfig(
      'Build a CRUD API for Payment Types',
      `entity: payment-types
table: PaymentTypes
fields:
- name: text
- active: integer
- sortOrder: integer
- description: text
routes: full CRUD`
    );
    expect(config).not.toBeNull();
    expect(config!.entity).toBe('payment-types');
    expect(config!.entityPascal).toBe('PaymentTypes');
    expect(config!.fields).toHaveLength(4);
    expect(config!.fields[0].name).toBe('name');
  });

  it('returns null for non-CRUD tickets', () => {
    const config = detectScaffoldConfig(
      'Fix the login button',
      'The login button is broken. Fix the bug.'
    );
    expect(config).toBeNull();
  });

  it('returns null when no entity is detected', () => {
    const config = detectScaffoldConfig(
      'Build a CRUD API',
      'Create endpoints for creating, reading, updating, and deleting.'
    );
    expect(config).toBeNull();
  });

  it('returns null when no fields are detected', () => {
    const config = detectScaffoldConfig(
      'Build a CRUD API for items',
      'entity: items\ntable: Items\nNeeds full CRUD'
    );
    expect(config).toBeNull();
  });

  it('generates correct idField from entity', () => {
    const config = detectScaffoldConfig(
      'Build a CRUD API service for cash adjustments',
      `entity: cash-adjustments
table: CashAdjustments
fields:
- amount: real
- reason: text
routes: full CRUD create read update delete`
    );
    expect(config).not.toBeNull();
    expect(config!.idField).toBe('cashAdjustmentId');
  });
});

describe('parseArchitectOutput', () => {
  it('converts simplified JSON to full ScaffoldConfig', () => {
    const config = parseArchitectOutput({
      entity: 'payment-types',
      table: 'PaymentTypes',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'active', type: 'integer', required: true },
        { name: 'description', type: 'text', required: false },
      ],
    });

    expect(config.entity).toBe('payment-types');
    expect(config.entityPascal).toBe('PaymentTypes');
    expect(config.entityCamel).toBe('paymentTypes');
    expect(config.idField).toBe('paymentTypeId');
    expect(config.fields).toHaveLength(3);
    expect(config.routes).toHaveLength(5);
    expect(config.middleware).toEqual({ auth: true, mutation: true });
  });

  it('handles nullable fields', () => {
    const config = parseArchitectOutput({
      entity: 'payments',
      table: 'Payments',
      fields: [
        { name: 'notes', type: 'text', required: false },
      ],
    });

    expect(config.fields[0].zodType).toContain('.nullable()');
    expect(config.fields[0].tsType).toBe('string | null');
  });

  it('handles enum fields', () => {
    const config = parseArchitectOutput({
      entity: 'cash-shifts',
      table: 'CashShifts',
      fields: [
        { name: 'status', type: 'text', required: true, enum: ['open', 'closed', 'reconciled'] },
      ],
    });

    expect(config.fields[0].zodType).toContain("z.enum([");
    expect(config.fields[0].zodType).toContain("'open'");
    expect(config.fields[0].zodType).toContain("'closed'");
  });

  it('defaults auth and mutation to true', () => {
    const config = parseArchitectOutput({
      entity: 'items',
      table: 'Items',
      fields: [{ name: 'name', type: 'text', required: true }],
    });

    expect(config.middleware?.auth).toBe(true);
    expect(config.middleware?.mutation).toBe(true);
  });

  it('respects explicit auth=false', () => {
    const config = parseArchitectOutput({
      entity: 'items',
      table: 'Items',
      fields: [{ name: 'name', type: 'text', required: true }],
      auth: false,
    });

    expect(config.middleware?.auth).toBe(false);
  });
});

describe('patchServicesEnum', () => {
  const existing = `export enum DatabaseTables {
\tOrders = 'Orders',
\tItems = 'Items'
}`;

  it('adds new entry before closing brace', () => {
    const result = patchServicesEnum(existing, 'Payments');
    expect(result).toContain("Payments = 'Payments'");
    expect(result).toMatch(/Items.*,\n\tPayments/s);
  });

  it('does not duplicate existing entries', () => {
    const result = patchServicesEnum(existing, 'Items');
    expect(result).toBe(existing);
  });

  it('handles empty enum', () => {
    const empty = `export enum DatabaseTables {\n}`;
    const result = patchServicesEnum(empty, 'NewTable');
    expect(result).toContain("NewTable = 'NewTable'");
  });
});

describe('patchDbTypes', () => {
  const existing = `import { TOrdersTable } from './schemas/orders.schema'

export interface IDatabase {
  Orders: TOrdersTable
}

export type TOrders = Selectable<TOrdersTable>
`;

  it('adds import, interface entry, and type exports', () => {
    const result = patchDbTypes(existing, 'Payments', 'Payments', 'payments.schema');
    expect(result).toContain("import { TPaymentsTable } from './schemas/payments.schema'");
    expect(result).toContain('  Payments: TPaymentsTable');
    expect(result).toContain('export type TPayments = Selectable<TPaymentsTable>');
    expect(result).toContain('export type TNewPayments = Insertable<TPaymentsTable>');
    expect(result).toContain('export type TPaymentsUpdate = Updateable<TPaymentsTable>');
  });

  it('does not duplicate existing entries', () => {
    const result = patchDbTypes(existing, 'Orders', 'Orders', 'orders.schema');
    // Should not add more than what's already there
    // Original has: 1 import + 1 interface entry + 1 type export = 3 occurrences of TOrdersTable
    // patchDbTypes adds TNewOrders + TOrdersUpdate which also reference TOrdersTable
    const importLines = (result.match(/import.*TOrdersTable/g) || []).length;
    expect(importLines).toBe(1); // no duplicate imports
  });
});

describe('patchIndexTs', () => {
  const existing = `import { ordersRouter } from './services/orders/orders.routes';

ordersRouter(router);
route404(router);

export default router;`;

  it('adds import and registration before route404', () => {
    const result = patchIndexTs(existing, 'paymentTypes', 'payment-types');
    expect(result).toContain("import { paymentTypesRouter } from './services/payment-types/payment-types.routes';");
    expect(result).toContain('paymentTypesRouter(router);');
    // Registration should be before route404
    const regIdx = result.indexOf('paymentTypesRouter(router);');
    const r404Idx = result.indexOf('route404(router)');
    expect(regIdx).toBeLessThan(r404Idx);
  });

  it('does not duplicate existing registrations', () => {
    const result = patchIndexTs(existing, 'orders', 'orders');
    const count = (result.match(/ordersRouter\(router\)/g) || []).length;
    expect(count).toBe(1);
  });
});

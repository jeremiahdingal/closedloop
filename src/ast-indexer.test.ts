import { describe, it, expect } from 'vitest';
import {
  extractFunctions,
  extractInterfaces,
  extractEnums,
  extractImports,
  extractASTMetadata,
  formatASTSummary,
} from './ast-indexer';

describe('extractFunctions', () => {
  it('extracts named function declarations', () => {
    const content = `export function createOrder(orderId: string, amount: number): Order {
  return { orderId, amount };
}`;
    const fns = extractFunctions(content);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('createOrder');
    expect(fns[0].params).toBe('orderId: string, amount: number');
    expect(fns[0].returnType).toBe('Order');
    expect(fns[0].exported).toBe(true);
    expect(fns[0].async).toBe(false);
  });

  it('extracts async functions', () => {
    const content = `export async function fetchItems(): Promise<Item[]> {
  return await db.selectFrom('Items').selectAll().execute();
}`;
    const fns = extractFunctions(content);
    expect(fns).toHaveLength(1);
    expect(fns[0].async).toBe(true);
    expect(fns[0].returnType).toBe('Promise<Item[]>');
  });

  it('extracts arrow functions', () => {
    const content = `export const handlePayment = async (req: Request, env: Env): Promise<Response> => {
  // ...
};`;
    const fns = extractFunctions(content);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('handlePayment');
    expect(fns[0].async).toBe(true);
    expect(fns[0].exported).toBe(true);
  });

  it('extracts non-exported functions', () => {
    const content = `function helper(x: number): string {
  return String(x);
}`;
    const fns = extractFunctions(content);
    expect(fns).toHaveLength(1);
    expect(fns[0].exported).toBe(false);
  });

  it('extracts multiple functions', () => {
    const content = `export function getOrder(id: string): Order { return {} as Order; }
function validate(data: unknown): boolean { return true; }
export const createOrder = (input: NewOrder): Order => ({} as Order);`;
    const fns = extractFunctions(content);
    expect(fns).toHaveLength(3);
  });
});

describe('extractInterfaces', () => {
  it('extracts interface with fields', () => {
    const content = `export interface Order {
  id: string;
  amount: number;
  status: string;
  notes?: string;
}`;
    const ifaces = extractInterfaces(content);
    expect(ifaces).toHaveLength(1);
    expect(ifaces[0].name).toBe('Order');
    expect(ifaces[0].exported).toBe(true);
    expect(ifaces[0].fields).toHaveLength(4);
    expect(ifaces[0].fields[3].optional).toBe(true);
    expect(ifaces[0].fields[3].name).toBe('notes');
  });

  it('extracts type alias objects', () => {
    const content = `export type Config = {
  port: number;
  host: string;
}`;
    const ifaces = extractInterfaces(content);
    expect(ifaces).toHaveLength(1);
    expect(ifaces[0].name).toBe('Config');
    expect(ifaces[0].fields).toHaveLength(2);
  });

  it('extracts interface with extends', () => {
    const content = `export interface NewOrder extends BaseEntity {
  amount: number;
  customerId: string;
}`;
    const ifaces = extractInterfaces(content);
    expect(ifaces).toHaveLength(1);
    expect(ifaces[0].name).toBe('NewOrder');
  });

  it('handles multiple interfaces', () => {
    const content = `interface A { x: number; }
export interface B { y: string; z: boolean; }`;
    const ifaces = extractInterfaces(content);
    expect(ifaces).toHaveLength(2);
    expect(ifaces[0].exported).toBe(false);
    expect(ifaces[1].exported).toBe(true);
  });
});

describe('extractEnums', () => {
  it('extracts enum with string values', () => {
    const content = `export enum DatabaseTables {
  Orders = 'Orders',
  Items = 'Items',
  Payments = 'Payments'
}`;
    const enums = extractEnums(content);
    expect(enums).toHaveLength(1);
    expect(enums[0].name).toBe('DatabaseTables');
    expect(enums[0].values).toEqual(['Orders', 'Items', 'Payments']);
    expect(enums[0].exported).toBe(true);
  });

  it('extracts enum with numeric values', () => {
    const content = `enum Priority {
  Low = 0,
  Medium = 1,
  High = 2
}`;
    const enums = extractEnums(content);
    expect(enums).toHaveLength(1);
    expect(enums[0].values).toEqual(['Low', 'Medium', 'High']);
  });
});

describe('extractImports', () => {
  it('extracts named imports', () => {
    const content = `import { Router, json, error } from 'itty-router';
import { Env } from 'app/types/env.types';`;
    const imports = extractImports(content);
    expect(imports).toHaveLength(2);
    expect(imports[0].names).toEqual(['Router', 'json', 'error']);
    expect(imports[0].source).toBe('itty-router');
  });

  it('extracts default imports', () => {
    const content = `import React from 'react';`;
    const imports = extractImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].names).toEqual(['React']);
  });
});

describe('extractASTMetadata', () => {
  it('extracts all metadata from a real-ish service file', () => {
    const content = `import { Router, json, error } from 'itty-router';
import { Env } from 'app/types/env.types';
import { DatabaseTables } from 'app/types/services.enum';

export interface CreateOrderInput {
  amount: number;
  customerId: string;
  notes?: string;
}

export async function createOrder(input: CreateOrderInput, env: Env): Promise<Order> {
  const db = getDb(env);
  return await db.insertInto(DatabaseTables.Orders).values(input).executeTakeFirstOrThrow();
}

export const getOrders = async (env: Env): Promise<Order[]> => {
  return [];
};`;

    const meta = extractASTMetadata(content);
    expect(meta.functions).toHaveLength(2);
    expect(meta.interfaces).toHaveLength(1);
    expect(meta.imports).toHaveLength(3);
    expect(meta.searchText).toContain('fn:createOrder');
    expect(meta.searchText).toContain('interface:CreateOrderInput');
  });

  it('produces searchable text with field names', () => {
    const content = `export interface Payment {
  paymentId: string;
  amount: number;
  orderId: string;
}`;
    const meta = extractASTMetadata(content);
    expect(meta.searchText).toContain('paymentId');
    expect(meta.searchText).toContain('orderId');
  });
});

describe('formatASTSummary', () => {
  it('formats functions and interfaces into readable summary', () => {
    const meta = extractASTMetadata(`
export async function fetchOrder(orderId: string): Promise<Order> { return {} as Order; }
export interface Order { id: string; amount: number; }
export enum Status { Active, Inactive }
`);
    const summary = formatASTSummary(meta);
    expect(summary).toContain('export async fetchOrder(orderId: string): Promise<Order>');
    expect(summary).toContain('export Order { id: string, amount: number }');
    expect(summary).toContain('export Status: Active, Inactive');
  });
});

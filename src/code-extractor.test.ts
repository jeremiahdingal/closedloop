import { describe, it, expect, vi } from 'vitest';

// Mock config and fs before importing
vi.mock('./config', () => ({
  getWorkspace: () => '/tmp/test-workspace',
  loadConfig: () => ({
    project: { name: 'Test', workspace: '/tmp/test-workspace' },
  }),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    mkdirSync: vi.fn(),
  };
});

import { validateFileContent, validateCriticalFileChanges } from './code-extractor';

describe('validateFileContent', () => {
  it('accepts normal TypeScript files', () => {
    const result = validateFileContent('src/index.ts', 'export const foo = 1;');
    expect(result.valid).toBe(true);
  });

  it('rejects invalid JSON in package.json', () => {
    const result = validateFileContent('package.json', 'not json');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Invalid JSON');
  });

  it('rejects package.json without name field', () => {
    const result = validateFileContent('package.json', '{"version":"1.0.0","scripts":{"build":"tsc"}}');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('missing "name"');
  });

  it('rejects package.json with no scripts or dependencies', () => {
    const result = validateFileContent('package.json', '{"name":"test"}');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('no scripts or dependencies');
  });

  it('accepts valid package.json', () => {
    const result = validateFileContent(
      'package.json',
      '{"name":"my-app","scripts":{"build":"tsc"}}'
    );
    expect(result.valid).toBe(true);
  });
});

describe('validateCriticalFileChanges', () => {
  it('accepts changes that preserve store methods', () => {
    const old = `
      const useStore = create(() => ({
        fetchItems: () => {},
        addItem: (item) => {},
      }));
    `;
    const updated = `
      const useStore = create(() => ({
        fetchItems: () => {},
        addItem: (item) => {},
        removeItem: (id) => {},
      }));
    `;
    const result = validateCriticalFileChanges('src/store/items.ts', old, updated);
    expect(result.valid).toBe(true);
  });

  it('rejects store changes that remove methods', () => {
    const old = `
      fetchItems: () => {},
      addItem: (item) => {},
      removeItem: (id) => {},
    `;
    const updated = `
      fetchItems: () => {},
    `;
    const result = validateCriticalFileChanges('src/store/items.ts', old, updated);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('removing required methods');
  });

  it('rejects type file changes that remove exports', () => {
    const old = `
      export interface Order { id: string }
      export type OrderList = Order[]
    `;
    const updated = `
      export interface Order { id: string }
    `;
    const result = validateCriticalFileChanges('src/types/order.ts', old, updated);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('removing exported types');
  });

  it('accepts type file additions', () => {
    const old = `export interface Order { id: string }`;
    const updated = `
      export interface Order { id: string }
      export interface NewOrder { name: string }
    `;
    const result = validateCriticalFileChanges('src/types/order.ts', old, updated);
    expect(result.valid).toBe(true);
  });

  it('rejects auth files that remove essential exports', () => {
    const old = `
      export function useLogin() {}
      export function useRegister() {}
    `;
    const updated = `
      export function useLogin() {}
    `;
    const result = validateCriticalFileChanges('src/auth/hooks.ts', old, updated);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('removing essential exports');
  });

  it('passes for non-critical files', () => {
    const result = validateCriticalFileChanges(
      'src/components/Button.tsx',
      'export const Button = () => <button>old</button>',
      'export const Button = () => <button>new</button>'
    );
    expect(result.valid).toBe(true);
  });
});

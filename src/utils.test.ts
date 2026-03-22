import { describe, it, expect } from 'vitest';
import { slugify, truncate, safeJsonParse, normalizeRoute, extractIssueId, extractAgentId } from './utils';

describe('slugify', () => {
  it('converts text to lowercase kebab-case', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('strips leading/trailing hyphens', () => {
    expect(slugify('--hello--')).toBe('hello');
  });

  it('collapses consecutive non-alphanum chars', () => {
    expect(slugify('foo   bar!!!baz')).toBe('foo-bar-baz');
  });

  it('truncates to 80 chars', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });

  it('returns "item" for empty/null input', () => {
    expect(slugify('')).toBe('item');
    expect(slugify(null as any)).toBe('item');
    expect(slugify(undefined as any)).toBe('item');
  });
});

describe('truncate', () => {
  it('returns original string if under limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and adds suffix when over limit', () => {
    const result = truncate('a'.repeat(100), 50);
    expect(result.length).toBeGreaterThan(50);
    expect(result).toContain('... (truncated)');
  });

  it('returns empty string for null/undefined', () => {
    expect(truncate(null, 10)).toBe('');
    expect(truncate(undefined, 10)).toBe('');
  });

  it('returns original at exact limit', () => {
    expect(truncate('12345', 5)).toBe('12345');
  });
});

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null for invalid JSON', () => {
    expect(safeJsonParse('not json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(safeJsonParse('')).toBeNull();
  });
});

describe('normalizeRoute', () => {
  it('returns / for empty/undefined', () => {
    expect(normalizeRoute()).toBe('/');
    expect(normalizeRoute('')).toBe('/');
  });

  it('keeps absolute URLs unchanged', () => {
    expect(normalizeRoute('http://foo.com/bar')).toBe('http://foo.com/bar');
    expect(normalizeRoute('https://foo.com')).toBe('https://foo.com');
  });

  it('prepends / if missing', () => {
    expect(normalizeRoute('dashboard')).toBe('/dashboard');
  });

  it('keeps existing leading /', () => {
    expect(normalizeRoute('/dashboard')).toBe('/dashboard');
  });
});

describe('extractIssueId', () => {
  it('extracts top-level issueId', () => {
    expect(extractIssueId({ issueId: 'abc-123' })).toBe('abc-123');
  });

  it('extracts from context.issueId', () => {
    expect(extractIssueId({ context: { issueId: 'ctx-456' } })).toBe('ctx-456');
  });

  it('extracts from context.taskId', () => {
    expect(extractIssueId({ context: { taskId: 'task-789' } })).toBe('task-789');
  });

  it('prefers top-level over context', () => {
    expect(extractIssueId({ issueId: 'top', context: { issueId: 'nested' } })).toBe('top');
  });

  it('returns null when absent', () => {
    expect(extractIssueId({})).toBeNull();
    expect(extractIssueId({ context: {} })).toBeNull();
  });
});

describe('extractAgentId', () => {
  it('extracts agentId', () => {
    expect(extractAgentId({ agentId: 'agent-1' })).toBe('agent-1');
  });

  it('returns null when absent', () => {
    expect(extractAgentId({})).toBeNull();
  });
});

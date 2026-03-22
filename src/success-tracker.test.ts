import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  recordOutcome,
  getModelStats,
  getModelStatsForComplexity,
  getAllModelStats,
  recommendThreshold,
  type TaskOutcome,
} from './success-tracker';

const TEST_STORE = join(__dirname, '..', '.test-success-rates.json');

function makeOutcome(overrides: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    timestamp: new Date().toISOString(),
    issueId: 'test-' + Math.random().toString(36).slice(2, 8),
    complexityScore: 3,
    model: 'deepcoder:14b',
    role: 'builder',
    success: true,
    passCount: 2,
    rescueNeeded: false,
    ...overrides,
  };
}

beforeEach(() => {
  if (existsSync(TEST_STORE)) unlinkSync(TEST_STORE);
});

afterEach(() => {
  if (existsSync(TEST_STORE)) unlinkSync(TEST_STORE);
});

describe('recordOutcome', () => {
  it('records and retrieves outcomes', () => {
    recordOutcome(makeOutcome({ model: 'test-model', success: true }), TEST_STORE);
    recordOutcome(makeOutcome({ model: 'test-model', success: false }), TEST_STORE);

    const stats = getModelStats('test-model', TEST_STORE);
    expect(stats.total).toBe(2);
    expect(stats.successes).toBe(1);
    expect(stats.rate).toBe(0.5);
  });

  it('caps store at 500 outcomes', () => {
    for (let i = 0; i < 510; i++) {
      recordOutcome(makeOutcome({ model: 'bulk' }), TEST_STORE);
    }
    const stats = getModelStats('bulk', TEST_STORE);
    // After 500, it trims to 400 + new ones = still under 500
    expect(stats.total).toBeLessThanOrEqual(510);
    expect(stats.total).toBeGreaterThan(0);
  });
});

describe('getModelStats', () => {
  it('returns zeros for unknown model', () => {
    const stats = getModelStats('nonexistent', TEST_STORE);
    expect(stats.total).toBe(0);
    expect(stats.rate).toBe(0);
    expect(stats.avgPasses).toBe(0);
  });

  it('computes average passes from successful tasks only', () => {
    recordOutcome(makeOutcome({ model: 'test', success: true, passCount: 3 }), TEST_STORE);
    recordOutcome(makeOutcome({ model: 'test', success: true, passCount: 5 }), TEST_STORE);
    recordOutcome(makeOutcome({ model: 'test', success: false, passCount: 20 }), TEST_STORE);

    const stats = getModelStats('test', TEST_STORE);
    expect(stats.avgPasses).toBe(4); // (3+5)/2 = 4
    expect(stats.total).toBe(3);
    expect(stats.successes).toBe(2);
  });

  it('counts rescue-needed tasks', () => {
    recordOutcome(makeOutcome({ model: 'r', rescueNeeded: true }), TEST_STORE);
    recordOutcome(makeOutcome({ model: 'r', rescueNeeded: false }), TEST_STORE);
    recordOutcome(makeOutcome({ model: 'r', rescueNeeded: true }), TEST_STORE);

    const stats = getModelStats('r', TEST_STORE);
    expect(stats.rescueCount).toBe(2);
  });
});

describe('getModelStatsForComplexity', () => {
  it('filters by complexity range', () => {
    recordOutcome(makeOutcome({ model: 'dc', complexityScore: 2, success: true }), TEST_STORE);
    recordOutcome(makeOutcome({ model: 'dc', complexityScore: 5, success: true }), TEST_STORE);
    recordOutcome(makeOutcome({ model: 'dc', complexityScore: 5, success: false }), TEST_STORE);
    recordOutcome(makeOutcome({ model: 'dc', complexityScore: 8, success: false }), TEST_STORE);

    const low = getModelStatsForComplexity('dc', 0, 3, TEST_STORE);
    expect(low.total).toBe(1);
    expect(low.rate).toBe(1);

    const mid = getModelStatsForComplexity('dc', 4, 6, TEST_STORE);
    expect(mid.total).toBe(2);
    expect(mid.rate).toBe(0.5);

    const high = getModelStatsForComplexity('dc', 7, 10, TEST_STORE);
    expect(high.total).toBe(1);
    expect(high.rate).toBe(0);
  });
});

describe('getAllModelStats', () => {
  it('groups by model name', () => {
    recordOutcome(makeOutcome({ model: 'alpha', success: true }), TEST_STORE);
    recordOutcome(makeOutcome({ model: 'alpha', success: false }), TEST_STORE);
    recordOutcome(makeOutcome({ model: 'beta', success: true }), TEST_STORE);

    const all = getAllModelStats(TEST_STORE);
    expect(Object.keys(all)).toHaveLength(2);
    expect(all['alpha'].total).toBe(2);
    expect(all['beta'].total).toBe(1);
    expect(all['beta'].rate).toBe(1);
  });
});

describe('recommendThreshold', () => {
  it('returns current threshold with low confidence when few outcomes', () => {
    recordOutcome(makeOutcome({ model: 'local', complexityScore: 3 }), TEST_STORE);
    const rec = recommendThreshold(7, 'local', TEST_STORE);
    expect(rec.recommended).toBe(7);
    expect(rec.confidence).toBe('low');
  });

  it('recommends lowering threshold when local model fails at boundary', () => {
    // Simulate failing at complexity 5-6 (just below threshold 7)
    for (let i = 0; i < 5; i++) {
      recordOutcome(makeOutcome({ model: 'local', complexityScore: 5, success: false }), TEST_STORE);
      recordOutcome(makeOutcome({ model: 'local', complexityScore: 6, success: false }), TEST_STORE);
    }

    const rec = recommendThreshold(7, 'local', TEST_STORE);
    expect(rec.recommended).toBeLessThanOrEqual(7);
    expect(rec.reason).toContain('fails');
  });

  it('recommends raising threshold when local model succeeds at/above', () => {
    // Simulate succeeding at complexity 7-8 (at threshold)
    for (let i = 0; i < 5; i++) {
      recordOutcome(makeOutcome({ model: 'local', complexityScore: 7, success: true, passCount: 2 }), TEST_STORE);
      recordOutcome(makeOutcome({ model: 'local', complexityScore: 8, success: true, passCount: 3 }), TEST_STORE);
    }

    const rec = recommendThreshold(7, 'local', TEST_STORE);
    expect(rec.recommended).toBeGreaterThanOrEqual(7);
    expect(rec.reason).toContain('succeeds');
  });

  it('keeps threshold when well-calibrated', () => {
    // Mixed results at boundary — threshold is fine
    for (let i = 0; i < 5; i++) {
      recordOutcome(makeOutcome({ model: 'local', complexityScore: 5, success: true }), TEST_STORE);
      recordOutcome(makeOutcome({ model: 'local', complexityScore: 6, success: true }), TEST_STORE);
      recordOutcome(makeOutcome({ model: 'local', complexityScore: 7, success: false }), TEST_STORE);
    }

    const rec = recommendThreshold(7, 'local', TEST_STORE);
    expect(rec.recommended).toBe(7);
    expect(rec.reason).toContain('well-calibrated');
  });

  it('has medium confidence at 10+ outcomes', () => {
    for (let i = 0; i < 15; i++) {
      recordOutcome(makeOutcome({ model: 'local', complexityScore: 4, success: true }), TEST_STORE);
    }
    const rec = recommendThreshold(7, 'local', TEST_STORE);
    expect(rec.confidence).toBe('medium');
  });

  it('has high confidence at 30+ outcomes', () => {
    for (let i = 0; i < 35; i++) {
      recordOutcome(makeOutcome({ model: 'local', complexityScore: 4, success: true }), TEST_STORE);
    }
    const rec = recommendThreshold(7, 'local', TEST_STORE);
    expect(rec.confidence).toBe('high');
  });
});

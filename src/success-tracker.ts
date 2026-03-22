/**
 * Success Rate Tracking for Model Routing
 *
 * Tracks which model succeeded/failed for which task complexity level.
 * Auto-adjusts the complexity routing threshold over time based on real data.
 *
 * Data is persisted to .paperclip/success-rates.json so it survives restarts.
 * The Complexity Router currently uses a static threshold (score >= 7).
 * This module provides data-driven threshold adjustment.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// ─── Types ───────────────────────────────────────────────────────

export interface TaskOutcome {
  /** Timestamp */
  timestamp: string;
  /** Issue ID */
  issueId: string;
  /** Complexity score (0-10) */
  complexityScore: number;
  /** Model used */
  model: string;
  /** Agent role */
  role: string;
  /** Whether the task completed successfully */
  success: boolean;
  /** Number of build passes needed (lower = better) */
  passCount: number;
  /** Whether remote rescue was needed */
  rescueNeeded: boolean;
}

export interface ModelStats {
  /** Total tasks attempted */
  total: number;
  /** Tasks completed successfully */
  successes: number;
  /** Success rate (0.0 - 1.0) */
  rate: number;
  /** Average pass count for successful tasks */
  avgPasses: number;
  /** How many tasks needed rescue */
  rescueCount: number;
}

export interface ThresholdRecommendation {
  /** Current threshold */
  current: number;
  /** Recommended threshold based on data */
  recommended: number;
  /** Confidence level: 'low' (< 10 samples), 'medium' (10-30), 'high' (30+) */
  confidence: 'low' | 'medium' | 'high';
  /** Reasoning */
  reason: string;
}

interface SuccessRateStore {
  outcomes: TaskOutcome[];
  lastUpdated: string;
}

// ─── Persistence ─────────────────────────────────────────────────

const DEFAULT_STORE_PATH = join(__dirname, '..', '.paperclip', 'success-rates.json');

function loadStore(storePath?: string): SuccessRateStore {
  const path = storePath || DEFAULT_STORE_PATH;
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf8'));
    }
  } catch { /* corrupted file — start fresh */ }
  return { outcomes: [], lastUpdated: new Date().toISOString() };
}

function saveStore(store: SuccessRateStore, storePath?: string): void {
  const path = storePath || DEFAULT_STORE_PATH;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2), 'utf8');
  } catch (err: any) {
    console.error(`[success-tracker] Failed to save: ${err.message}`);
  }
}

// ─── Core API ────────────────────────────────────────────────────

/**
 * Record a task outcome for tracking.
 */
export function recordOutcome(outcome: TaskOutcome, storePath?: string): void {
  const store = loadStore(storePath);

  // Cap at 500 recent outcomes to keep the file small
  if (store.outcomes.length >= 500) {
    store.outcomes = store.outcomes.slice(-400);
  }

  store.outcomes.push(outcome);
  store.lastUpdated = new Date().toISOString();
  saveStore(store, storePath);
}

/**
 * Get success stats for a specific model.
 */
export function getModelStats(model: string, storePath?: string): ModelStats {
  const store = loadStore(storePath);
  const outcomes = store.outcomes.filter(o => o.model === model);
  return computeStats(outcomes);
}

/**
 * Get success stats for a model at a specific complexity range.
 */
export function getModelStatsForComplexity(
  model: string,
  minScore: number,
  maxScore: number,
  storePath?: string
): ModelStats {
  const store = loadStore(storePath);
  const outcomes = store.outcomes.filter(
    o => o.model === model && o.complexityScore >= minScore && o.complexityScore <= maxScore
  );
  return computeStats(outcomes);
}

/**
 * Get all model stats grouped by model name.
 */
export function getAllModelStats(storePath?: string): Record<string, ModelStats> {
  const store = loadStore(storePath);
  const byModel = new Map<string, TaskOutcome[]>();

  for (const outcome of store.outcomes) {
    const existing = byModel.get(outcome.model) || [];
    existing.push(outcome);
    byModel.set(outcome.model, existing);
  }

  const result: Record<string, ModelStats> = {};
  for (const [model, outcomes] of byModel) {
    result[model] = computeStats(outcomes);
  }
  return result;
}

/**
 * Recommend an adjusted complexity threshold based on accumulated data.
 *
 * Logic:
 * - Look at local model success rates at different complexity levels
 * - If the local model fails > 50% of tasks in the 5-7 range, recommend raising threshold
 * - If the local model succeeds > 80% of tasks in the 7-8 range, recommend lowering threshold
 * - Requires at least 10 outcomes for a medium-confidence recommendation
 */
export function recommendThreshold(
  currentThreshold: number,
  localModel: string,
  storePath?: string
): ThresholdRecommendation {
  const store = loadStore(storePath);
  const localOutcomes = store.outcomes.filter(o => o.model === localModel);

  if (localOutcomes.length < 5) {
    return {
      current: currentThreshold,
      recommended: currentThreshold,
      confidence: 'low',
      reason: `Only ${localOutcomes.length} outcomes recorded. Need at least 5 for any recommendation.`,
    };
  }

  const confidence = localOutcomes.length >= 30 ? 'high' : localOutcomes.length >= 10 ? 'medium' : 'low';

  // Check success rates at boundary zones
  const belowThreshold = localOutcomes.filter(o => o.complexityScore >= currentThreshold - 2 && o.complexityScore < currentThreshold);
  const atThreshold = localOutcomes.filter(o => o.complexityScore >= currentThreshold && o.complexityScore <= currentThreshold + 1);

  const belowStats = computeStats(belowThreshold);
  const atStats = computeStats(atThreshold);

  // If failing a lot just below threshold → raise it
  if (belowStats.total >= 3 && belowStats.rate < 0.5) {
    const newThreshold = Math.max(3, currentThreshold - 1);
    return {
      current: currentThreshold,
      recommended: newThreshold,
      confidence,
      reason: `Local model fails ${((1 - belowStats.rate) * 100).toFixed(0)}% of tasks at score ${currentThreshold - 2}–${currentThreshold - 1}. Recommend lowering threshold to ${newThreshold} to route more to remote.`,
    };
  }

  // If succeeding at/above threshold → lower it
  if (atStats.total >= 3 && atStats.rate > 0.8) {
    const newThreshold = Math.min(10, currentThreshold + 1);
    return {
      current: currentThreshold,
      recommended: newThreshold,
      confidence,
      reason: `Local model succeeds ${(atStats.rate * 100).toFixed(0)}% of tasks at score ${currentThreshold}–${currentThreshold + 1}. Recommend raising threshold to ${newThreshold} to keep more local.`,
    };
  }

  return {
    current: currentThreshold,
    recommended: currentThreshold,
    confidence,
    reason: `Current threshold ${currentThreshold} appears well-calibrated based on ${localOutcomes.length} outcomes.`,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

function computeStats(outcomes: TaskOutcome[]): ModelStats {
  if (outcomes.length === 0) {
    return { total: 0, successes: 0, rate: 0, avgPasses: 0, rescueCount: 0 };
  }

  const successes = outcomes.filter(o => o.success).length;
  const successfulPasses = outcomes.filter(o => o.success).map(o => o.passCount);
  const avgPasses = successfulPasses.length > 0
    ? successfulPasses.reduce((a, b) => a + b, 0) / successfulPasses.length
    : 0;
  const rescueCount = outcomes.filter(o => o.rescueNeeded).length;

  return {
    total: outcomes.length,
    successes,
    rate: successes / outcomes.length,
    avgPasses: Math.round(avgPasses * 10) / 10,
    rescueCount,
  };
}

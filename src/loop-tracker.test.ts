import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Tests for the Reviewer ↔ Local Builder loop tracking logic
 * 
 * This tests the fix for the infinite loop bug where the counter
 * was incrementing on every agent call instead of tracking
 * state transitions (full cycles).
 */

// Mock the AGENTS object
const mockAgents = {
  reviewer: 'reviewer-uuid',
  'local builder': 'builder-uuid',
  'diff guardian': 'diff-uuid',
};

// Simulate the loop tracking state
interface LoopData {
  count: number;
  lastReset: number;
  lastAgent: string;
}

const MAX_LOOP_PASSES = 5;
const LOOP_RESET_WINDOW_MS = 60 * 60 * 1000;

// Simulated trackLoop function (mirrors proxy-server.ts logic)
function trackLoop(
  issueId: string,
  agentId: string,
  state: Map<string, LoopData>
): { count: number; exceeded: boolean } {
  const now = Date.now();
  let loopData = state.get(issueId);

  // Initialize or reset if window expired
  if (!loopData || now - loopData.lastReset > LOOP_RESET_WINDOW_MS) {
    loopData = { count: 0, lastReset: now, lastAgent: '' };
  }

  // Count a loop pass only when Reviewer/Diff Guardian rejects and sends back to Local Builder
  const isLoopContinuation =
    (loopData.lastAgent === mockAgents.reviewer && agentId === mockAgents['local builder']) ||
    (loopData.lastAgent === mockAgents['diff guardian'] && agentId === mockAgents['local builder']);

  if (isLoopContinuation) {
    loopData.count++;
  }

  // Update last agent for next transition detection
  loopData.lastAgent = agentId;
  state.set(issueId, loopData);

  return {
    count: loopData.count,
    exceeded: loopData.count >= MAX_LOOP_PASSES,
  };
}

function getLoopStatus(
  issueId: string,
  state: Map<string, LoopData>
): { count: number; exceeded: boolean } {
  const loopData = state.get(issueId);
  if (!loopData) {
    return { count: 0, exceeded: false };
  }
  return {
    count: loopData.count,
    exceeded: loopData.count >= MAX_LOOP_PASSES,
  };
}

function resetLoopCounter(issueId: string, state: Map<string, LoopData>): void {
  state.delete(issueId);
}

describe('Loop Tracker', () => {
  let loopState: Map<string, LoopData>;

  beforeEach(() => {
    loopState = new Map();
  });

  it('should not count initial Local Builder run as a loop', () => {
    const result = trackLoop('issue-1', mockAgents['local builder'], loopState);
    expect(result.count).toBe(0);
    expect(result.exceeded).toBe(false);
  });

  it('should not count Reviewer approval as a loop', () => {
    // Initial builder run
    trackLoop('issue-1', mockAgents['local builder'], loopState);
    // Reviewer approves
    const result = trackLoop('issue-1', mockAgents.reviewer, loopState);
    expect(result.count).toBe(0);
    expect(result.exceeded).toBe(false);
  });

  it('should count one full cycle (Builder → Reviewer → Builder) as 1 loop pass', () => {
    // Initial builder run
    trackLoop('issue-1', mockAgents['local builder'], loopState);
    // Reviewer reviews
    trackLoop('issue-1', mockAgents.reviewer, loopState);
    // Reviewer rejects, sends back to builder - THIS is loop pass #1
    const result = trackLoop('issue-1', mockAgents['local builder'], loopState);
    expect(result.count).toBe(1);
    expect(result.exceeded).toBe(false);
  });

  it('should count 5 full cycles as exceeded', () => {
    // Simulate 5 full cycles
    for (let i = 0; i < 5; i++) {
      trackLoop('issue-1', mockAgents['local builder'], loopState);
      trackLoop('issue-1', mockAgents.reviewer, loopState);
      trackLoop('issue-1', mockAgents['local builder'], loopState);
    }
    
    const result = getLoopStatus('issue-1', loopState);
    expect(result.count).toBe(5);
    expect(result.exceeded).toBe(true);
  });

  it('should not double-count when same agent runs consecutively', () => {
    // Builder runs twice in a row (e.g., build fix loop)
    trackLoop('issue-1', mockAgents['local builder'], loopState);
    const result1 = trackLoop('issue-1', mockAgents['local builder'], loopState);
    expect(result1.count).toBe(0);
    
    const result2 = trackLoop('issue-1', mockAgents['local builder'], loopState);
    expect(result2.count).toBe(0);
  });

  it('should count Diff Guardian → Builder transition as a loop pass', () => {
    // Builder → Diff Guardian → Builder (rejected)
    trackLoop('issue-1', mockAgents['local builder'], loopState);
    trackLoop('issue-1', mockAgents['diff guardian'], loopState);
    const result = trackLoop('issue-1', mockAgents['local builder'], loopState);
    expect(result.count).toBe(1);
    expect(result.exceeded).toBe(false);
  });

  it('should reset counter after successful PR', () => {
    // Simulate 3 loop passes
    for (let i = 0; i < 3; i++) {
      trackLoop('issue-1', mockAgents['local builder'], loopState);
      trackLoop('issue-1', mockAgents.reviewer, loopState);
      trackLoop('issue-1', mockAgents['local builder'], loopState);
    }
    
    let status = getLoopStatus('issue-1', loopState);
    expect(status.count).toBe(3);
    
    // Reset after successful PR
    resetLoopCounter('issue-1', loopState);
    status = getLoopStatus('issue-1', loopState);
    expect(status.count).toBe(0);
    expect(status.exceeded).toBe(false);
  });

  it('should handle multiple issues independently', () => {
    // Issue 1: 2 loop passes
    for (let i = 0; i < 2; i++) {
      trackLoop('issue-1', mockAgents['local builder'], loopState);
      trackLoop('issue-1', mockAgents.reviewer, loopState);
      trackLoop('issue-1', mockAgents['local builder'], loopState);
    }
    
    // Issue 2: 1 loop pass
    for (let i = 0; i < 1; i++) {
      trackLoop('issue-2', mockAgents['local builder'], loopState);
      trackLoop('issue-2', mockAgents.reviewer, loopState);
      trackLoop('issue-2', mockAgents['local builder'], loopState);
    }
    
    const status1 = getLoopStatus('issue-1', loopState);
    const status2 = getLoopStatus('issue-2', loopState);
    
    expect(status1.count).toBe(2);
    expect(status2.count).toBe(1);
  });

  it('should get status without modifying state', () => {
    // Create some loop history
    trackLoop('issue-1', mockAgents['local builder'], loopState);
    trackLoop('issue-1', mockAgents.reviewer, loopState);
    trackLoop('issue-1', mockAgents['local builder'], loopState);
    
    // Get status multiple times - should not change count
    const status1 = getLoopStatus('issue-1', loopState);
    const status2 = getLoopStatus('issue-1', loopState);
    const status3 = getLoopStatus('issue-1', loopState);
    
    expect(status1.count).toBe(1);
    expect(status2.count).toBe(1);
    expect(status3.count).toBe(1);
  });

  it('should handle old bug: counting every agent call', () => {
    // This test demonstrates the OLD BUG where every agent call incremented the counter
    // Old behavior would count: Builder(1) + Reviewer(2) + Builder(3) = 3
    // New behavior should count: Builder→Reviewer→Builder = 1
    
    // Simulate old buggy behavior for comparison
    let oldBugCount = 0;
    const agents = [
      mockAgents['local builder'],
      mockAgents.reviewer,
      mockAgents['local builder'],
    ];
    
    for (const agent of agents) {
      if (agent === mockAgents.reviewer || agent === mockAgents['local builder']) {
        oldBugCount++; // Old bug: count every reviewer/builder call
      }
    }
    
    // New correct behavior
    trackLoop('issue-1', mockAgents['local builder'], loopState);
    trackLoop('issue-1', mockAgents.reviewer, loopState);
    const newResult = trackLoop('issue-1', mockAgents['local builder'], loopState);
    
    expect(oldBugCount).toBe(3); // Old bug would count 3
    expect(newResult.count).toBe(1); // New behavior correctly counts 1
  });
});

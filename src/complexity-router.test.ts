import { describe, it, expect } from 'vitest';
import { scoreComplexity } from './complexity-router';

describe('scoreComplexity', () => {
  it('scores a simple bug fix low', () => {
    const score = scoreComplexity(
      'Fix login button not working',
      'The login button on the sign-in screen does not respond to taps. Fix the bug.'
    );
    expect(score).toBeLessThan(3);
  });

  it('scores cosmetic changes low', () => {
    const score = scoreComplexity(
      'Update text color on dashboard',
      'Change the title color from blue to green. Cosmetic fix.'
    );
    expect(score).toBeLessThan(4);
  });

  it('scores a simple CRUD API as medium', () => {
    const score = scoreComplexity(
      'Build a CRUD API for Payment Types',
      'Create a simple API with crud endpoints for managing payment types.'
    );
    expect(score).toBeLessThanOrEqual(5);
  });

  it('scores a greenfield full-stack system high', () => {
    const score = scoreComplexity(
      'Build a complete real-time inventory sync system from scratch',
      'Design and implement a full-stack real-time inventory synchronization system. Multi-module architecture with websocket pub-sub, authentication, and multiple services.'
    );
    expect(score).toBeGreaterThanOrEqual(7);
  });

  it('scores [Epic] tagged issues high', () => {
    const score = scoreComplexity(
      '[Epic] Cash POS Module - Complete CRUD APIs',
      'Build all CRUD APIs for the Cash POS module.'
    );
    expect(score).toBeGreaterThanOrEqual(4); // +2 for [Epic] tag
  });

  it('scores [Goal] tagged issues high', () => {
    const score = scoreComplexity(
      '[Goal] Rebuild the entire auth system',
      'Authentication overhaul from scratch with OAuth and JWT session management.'
    );
    expect(score).toBeGreaterThanOrEqual(7);
  });

  it('clamps to 0 minimum', () => {
    const score = scoreComplexity(
      'Fix typo bug error crash',
      'Fix the broken cosmetic text rename padding. Simple bug fix.'
    );
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('clamps to 10 maximum', () => {
    const score = scoreComplexity(
      '[Goal] Build a whole app from scratch with real-time websocket authentication',
      'Greenfield full-stack end-to-end system design infrastructure with multi-module architecture and multiple services.'
    );
    expect(score).toBeLessThanOrEqual(10);
  });

  it('handles empty inputs', () => {
    const score = scoreComplexity('', '');
    expect(score).toBe(3); // baseline
  });

  it('treats single-field additions as simple', () => {
    const score = scoreComplexity(
      'Add a button to the settings screen',
      'Add a dark mode toggle button to the app settings.'
    );
    expect(score).toBeLessThanOrEqual(3);
  });
});

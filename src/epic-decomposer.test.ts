import { describe, it, expect } from 'vitest';
import { parseSubTickets } from './epic-decomposer';

describe('parseSubTickets', () => {
  it('parses TICKET: block format', () => {
    const content = `TICKET:
Title: Build a CRUD API for Payment Types
Description: Create a service for managing payment types. Each type has a name (required, text) and active flag (required, boolean).
Priority: medium

TICKET:
Title: Build a CRUD API for Payments
Description: Create a service for recording payments against orders.
Priority: high`;

    const tickets = parseSubTickets(content);
    expect(tickets).toHaveLength(2);
    expect(tickets[0].title).toBe('Build a CRUD API for Payment Types');
    expect(tickets[0].priority).toBe('medium');
    expect(tickets[1].title).toBe('Build a CRUD API for Payments');
    expect(tickets[1].priority).toBe('high');
  });

  it('parses numbered list format as fallback', () => {
    const content = `1. **Build Payment Types API**
Create a service for managing payment types with full CRUD operations.

2. **Build Payments API**
Create a service for recording payments.`;

    const tickets = parseSubTickets(content);
    expect(tickets).toHaveLength(2);
    expect(tickets[0].title).toBe('Build Payment Types API');
    expect(tickets[1].title).toBe('Build Payments API');
  });

  it('parses ## heading format as fallback', () => {
    const content = `## Build Payment Types API
Create a service for managing payment types.

## Build Payments API
Create a service for recording payments.`;

    const tickets = parseSubTickets(content);
    expect(tickets).toHaveLength(2);
    expect(tickets[0].title).toBe('Build Payment Types API');
  });

  it('parses ## Ticket N: heading format', () => {
    const content = `## Ticket 1: Build Payment Types
Service for payment types with CRUD.

## Ticket 2: Build Payments
Service for payments with CRUD.`;

    const tickets = parseSubTickets(content);
    expect(tickets).toHaveLength(2);
    expect(tickets[0].title).toBe('Build Payment Types');
  });

  it('returns empty array for unparseable content', () => {
    const tickets = parseSubTickets('Just some random text with no structure.');
    expect(tickets).toHaveLength(0);
  });

  it('defaults priority to medium when not specified', () => {
    const content = `TICKET:
Title: Some task
Description: Do something`;

    const tickets = parseSubTickets(content);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].priority).toBe('medium');
  });

  it('handles multi-line descriptions in TICKET format', () => {
    const content = `TICKET:
Title: Build Cash Shifts API
Description: Create a service for managing cash shifts.
Each shift tracks the user who opened it (userId, required).
Opening amount is required, closing amount optional.
Priority: high`;

    const tickets = parseSubTickets(content);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].description).toContain('cash shifts');
    expect(tickets[0].priority).toBe('high');
  });
});

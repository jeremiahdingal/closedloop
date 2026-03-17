/**
 * Utility functions
 */

import * as fs from 'fs';
import * as path from 'path';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function slugify(value: string): string {
  return String(value || 'item')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

export function truncate(str: string | null | undefined, max: number): string {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max) + '\n\n... (truncated)';
}

export function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeJson(filePath: string, data: any): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function appendNdjson(filePath: string, data: any): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(data) + '\n');
}

export function listPngFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listPngFilesRecursive(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
      results.push(full);
    }
  }
  return results.sort();
}

export function normalizeRoute(route?: string): string {
  if (!route) return '/';
  if (route.startsWith('http://') || route.startsWith('https://')) return route;
  return route.startsWith('/') ? route : `/${route}`;
}

export function extractIssueId(body: any): string | null {
  const ctx = body.context;
  if (!ctx) return null;
  return ctx.issueId || ctx.taskId || ctx.taskKey || null;
}

export function extractAgentId(body: any): string | null {
  return body.agentId || null;
}

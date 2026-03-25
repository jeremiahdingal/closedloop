/**
 * Tried-Approaches Memory
 * 
 * Tracks failed build attempts per issue to prevent the Local Builder
 * from repeating the same mistakes.
 * 
 * Each attempt records:
 * - Error fingerprint (normalized error message)
 * - Files that were changed
 * - The build error output
 * 
 * This context is injected into subsequent builder prompts with:
 * "You already tried X and it failed with error Y. Do NOT repeat this approach."
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace } from './config';
import { getIssueDetails } from './paperclip-api';

const WORKSPACE = getWorkspace();
const TRIED_APPROACHES_DIR = '.paperclip/tried-approaches';

export interface TriedApproach {
  attemptNumber: number;
  timestamp: number;
  filesChanged: string[];
  errorFingerprint: string;
  buildError: string;
}

/**
 * Get the tried approaches file path for an issue
 */
function getApproachesFilePath(issueId: string): string {
  return path.join(WORKSPACE, TRIED_APPROACHES_DIR, `${issueId}.json`);
}

/**
 * Load tried approaches for an issue
 */
export async function loadTriedApproaches(issueId: string): Promise<TriedApproach[]> {
  const filePath = getApproachesFilePath(issueId);
  
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const approaches = JSON.parse(content) as TriedApproach[];
    return approaches;
  } catch (err: any) {
    console.log(`[tried-approaches] Could not load approaches for ${issueId}: ${err.message}`);
    return [];
  }
}

/**
 * Save a tried approach for an issue
 */
export async function saveTriedApproach(
  issueId: string,
  filesChanged: string[],
  buildError: string
): Promise<void> {
  const approaches = await loadTriedApproaches(issueId);
  
  // Create error fingerprint (normalized error message)
  const errorFingerprint = fingerprintError(buildError);
  
  const newApproach: TriedApproach = {
    attemptNumber: approaches.length + 1,
    timestamp: Date.now(),
    filesChanged,
    errorFingerprint,
    buildError: truncate(buildError, 2000),
  };
  
  approaches.push(newApproach);
  
  // Ensure directory exists
  const dir = path.join(WORKSPACE, TRIED_APPROACHES_DIR);
  fs.mkdirSync(dir, { recursive: true });
  
  // Save to file
  const filePath = getApproachesFilePath(issueId);
  fs.writeFileSync(filePath, JSON.stringify(approaches, null, 2), 'utf8');
  
  console.log(`[tried-approaches] Saved attempt #${newApproach.attemptNumber} for ${issueId.slice(0, 8)}`);
}

/**
 * Build tried-approaches context for Local Builder prompt
 * 
 * Returns a formatted string listing previous failed attempts with warnings
 * not to repeat them.
 */
export async function buildTriedApproachesContext(issueId: string): Promise<string> {
  const approaches = await loadTriedApproaches(issueId);
  
  if (approaches.length === 0) {
    return '';
  }
  
  let context = '\n\n== ⚠️ PREVIOUS FAILED ATTEMPTS (DO NOT REPEAT) ==\n';
  context += `You have already tried ${approaches.length} approach${approaches.length === 1 ? '' : 'es'} that failed the build.\n`;
  context += 'Review these carefully and ensure your NEW approach does NOT repeat these mistakes.\n\n';
  
  for (const approach of approaches) {
    context += `--- Attempt #${approach.attemptNumber} (failed) ---\n`;
    context += `Files changed: ${approach.filesChanged.join(', ')}\n`;
    context += `Error: ${approach.errorFingerprint}\n`;
    context += `Build output:\n\`\`\`\n${truncate(approach.buildError, 500)}\n\`\`\`\n\n`;
  }
  
  context += '**CRITICAL:** Do NOT make the same changes that caused these errors.\n';
  context += 'If you are unsure, try a different approach or ask for clarification.\n';
  
  return context;
}

/**
 * Create a fingerprint for an error message (normalized for comparison)
 */
function fingerprintError(buildError: string): string {
  // Normalize whitespace and line numbers
  let normalized = buildError
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/:\d+:\d+/g, ':LINE:COL') // Normalize line/col numbers
    .replace(/at line \d+/g, 'at line X')
    .replace(/\b[a-f0-9]{8,}\b/g, 'HASH'); // Normalize hashes
  
  // Extract the main error message (first few lines)
  const lines = normalized.split('\n').slice(0, 5);
  const fingerprint = lines.join('\n').trim();
  
  return truncate(fingerprint, 300);
}

/**
 * Check if a similar error has occurred before
 */
export async function hasSimilarError(
  issueId: string,
  currentError: string
): Promise<{ found: boolean; approach?: TriedApproach }> {
  const approaches = await loadTriedApproaches(issueId);
  const currentFingerprint = fingerprintError(currentError);
  
  for (const approach of approaches) {
    // Simple string matching - could be enhanced with similarity scoring
    if (approach.errorFingerprint === currentFingerprint) {
      return { found: true, approach };
    }
    
    // Check if key error terms match
    const currentTerms = extractErrorTerms(currentFingerprint);
    const approachTerms = extractErrorTerms(approach.errorFingerprint);
    
    const overlap = Array.from(currentTerms).filter(t => approachTerms.has(t));
    if (overlap.length >= 2) {
      return { found: true, approach };
    }
  }
  
  return { found: false };
}

/**
 * Extract key terms from an error message for comparison
 */
function extractErrorTerms(fingerprint: string): Set<string> {
  const terms = new Set<string>();
  
  // Extract error codes (e.g., TS2345)
  const codeMatches = fingerprint.match(/TS\d+/g);
  if (codeMatches) {
    codeMatches.forEach(code => terms.add(code));
  }
  
  // Extract key error types
  const errorTypes = [
    /cannot find (?:module|name|type)/i,
    /property .* does not exist/i,
    /type .* is not assignable/i,
    /import .* could not be found/i,
    /duplicate identifier/i,
    /missing .* property/i,
  ];
  
  for (const re of errorTypes) {
    const match = fingerprint.match(re);
    if (match) {
      terms.add(match[0].toLowerCase());
    }
  }
  
  return terms;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + '... (truncated)';
}

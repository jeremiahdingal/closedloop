/**
 * Tried-Approaches Memory
 * 
 * Tracks failed build attempts GLOBALLY (across all issues) to prevent
 * the Local Builder from repeating the same mistakes in different tickets.
 * 
 * This is critical for epics with multiple tickets running in parallel
 * on different branches - learnings from one ticket's failures are
 * immediately available to all other tickets.
 * 
 * Stored in `.paperclip/tried-approaches/global.json` keyed by error fingerprint.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace } from './config';

const WORKSPACE = getWorkspace();
const GLOBAL_APPROACHES_FILE = '.paperclip/tried-approaches/global.json';

export interface TriedApproach {
  issueId: string;
  issueIdentifier: string;
  timestamp: number;
  filesChanged: string[];
  errorFingerprint: string;
  buildError: string;
  lesson?: string; // Extracted lesson for quick reference
}

/**
 * Get the global tried approaches file path
 */
function getGlobalApproachesPath(): string {
  return path.join(WORKSPACE, GLOBAL_APPROACHES_FILE);
}

/**
 * Load all tried approaches (global across all issues)
 */
export async function loadTriedApproaches(issueId?: string): Promise<TriedApproach[]> {
  const filePath = getGlobalApproachesPath();
  
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const approaches = JSON.parse(content) as TriedApproach[];
    
    // Return all approaches, or filter by issue if specified
    if (issueId) {
      return approaches.filter(a => a.issueId === issueId);
    }
    
    return approaches;
  } catch (err: any) {
    console.log(`[tried-approaches] Could not load approaches: ${err.message}`);
    return [];
  }
}

/**
 * Save a tried approach to the global memory
 */
export async function saveTriedApproach(
  issueId: string,
  issueIdentifier: string,
  filesChanged: string[],
  buildError: string
): Promise<void> {
  const allApproaches = await loadTriedApproaches();
  
  // Create error fingerprint (normalized error message)
  const errorFingerprint = fingerprintError(buildError);
  
  // Extract a lesson from the error
  const lesson = extractLessonFromError(buildError);
  
  const newApproach: TriedApproach = {
    issueId,
    issueIdentifier,
    timestamp: Date.now(),
    filesChanged,
    errorFingerprint,
    buildError: truncate(buildError, 2000),
    lesson,
  };
  
  allApproaches.push(newApproach);
  
  // Ensure directory exists
  const dir = path.join(WORKSPACE, '.paperclip/tried-approaches');
  fs.mkdirSync(dir, { recursive: true });
  
  // Save to global file
  const filePath = getGlobalApproachesPath();
  fs.writeFileSync(filePath, JSON.stringify(allApproaches, null, 2), 'utf8');
  
  console.log(`[tried-approaches] Saved attempt for ${issueIdentifier} (global memory, ${allApproaches.length} total)`);
}

/**
 * Build tried-approaches context for Local Builder prompt
 * 
 * Returns a formatted string listing previous failed attempts with warnings
 * not to repeat them. Shows GLOBAL failures (all issues) filtered to
 * files relevant to this task.
 */
export async function buildTriedApproachesContext(
  issueId: string,
  filesToModify?: string[]
): Promise<string> {
  const allApproaches = await loadTriedApproaches();
  
  if (allApproaches.length === 0) {
    return '';
  }
  
  // Filter to approaches relevant to files we're modifying
  let relevantApproaches = allApproaches;
  if (filesToModify && filesToModify.length > 0) {
    relevantApproaches = allApproaches.filter(approach => 
      filesToModify.some(file => 
        approach.filesChanged.some(changedFile => 
          changedFile.includes(file) || file.includes(changedFile)
        )
      )
    );
  }
  
  // If no file-specific matches, show recent global failures (last 5)
  if (relevantApproaches.length === 0 && allApproaches.length > 0) {
    relevantApproaches = allApproaches.slice(-5);
  }
  
  let context = '\n\n== ⚠️ GLOBAL FAILED ATTEMPTS (LEARN FROM OTHER TICKETS) ==\n';
  context += `The following build failures occurred in other tickets. Review to avoid repeating them.\n\n`;
  
  for (const approach of relevantApproaches.slice(0, 5)) { // Limit to 5 most recent
    context += `--- ${approach.issueIdentifier} ---\n`;
    context += `Files: ${approach.filesChanged.join(', ')}\n`;
    context += `Error: ${approach.errorFingerprint}\n`;
    if (approach.lesson) {
      context += `**Lesson:** ${approach.lesson}\n`;
    }
    context += `\n`;
  }
  
  context += '**CRITICAL:** Do NOT make changes that caused these errors in other tickets.\n';
  
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

/**
 * Extract a lesson from a build error
 */
function extractLessonFromError(buildError: string): string {
  const error = buildError.toLowerCase();
  
  // Common TypeScript errors and their lessons
  const lessons: Array<{ pattern: RegExp; lesson: string }> = [
    { pattern: /TS2305.*module.*not found/i, lesson: 'Check import path - module does not exist at that location' },
    { pattern: /TS2307.*cannot find module/i, lesson: 'Verify import path is correct and module is installed' },
    { pattern: /TS2339.*property.*does not exist/i, lesson: 'Property does not exist on type - check interface definition' },
    { pattern: /TS2322.*not assignable/i, lesson: 'Type mismatch - ensure value matches expected type' },
    { pattern: /TS7006.*parameter.*implicitly has any type/i, lesson: 'Add explicit type annotation to parameter' },
    { pattern: /TS2304.*cannot find name/i, lesson: 'Variable/function is not defined - check imports and declarations' },
    { pattern: /TS2345.*argument.*not assignable/i, lesson: 'Function argument type mismatch - check parameter types' },
    { pattern: /TS2344.*does not satisfy.*constraint/i, lesson: 'Generic type constraint not satisfied - check type parameters' },
    { pattern: /TS18046.*is of type unknown/i, lesson: 'Add type guard or type assertion before accessing properties' },
    { pattern: /TS2532.*object.*possibly undefined/i, lesson: 'Add undefined check or optional chaining before accessing' },
    { pattern: /TS2531.*object.*possibly null/i, lesson: 'Add null check before accessing properties' },
    { pattern: /duplicate identifier/i, lesson: 'Remove duplicate declaration or rename one of the identifiers' },
    { pattern: /module.*was not found/i, lesson: 'Check that the module exists and path is correct' },
  ];
  
  for (const { pattern, lesson } of lessons) {
    if (pattern.test(error)) {
      return lesson;
    }
  }
  
  // Default lesson
  return 'Review build error carefully and fix the reported issue';
}

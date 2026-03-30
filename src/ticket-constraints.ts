import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Issue } from './types';

const SHARED_CANONICAL_PATTERNS = [
  /^packages\/app\/types\/schemas\//i,
  /^packages\/app\/apiHooks\//i,
  /^packages\/app\/utils\//i,
  /^api\/src\/(routes|services|types|schema|schemas)\//i,
];

const DRIFT_PATH_FAMILY = /(components|hooks|apihooks|schemas|routes|services|screens|dialogs)\//i;
const COMMON_BASENAMES = new Set([
  'index',
  'types',
  'utils',
  'constants',
  'schema',
  'route',
  'routes',
  'screen',
]);

let trackedFilesCache: string[] | null = null;
let trackedFilesCacheWorkspace = '';

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.?\//, '').trim();
}

function uniqueNormalized(filePaths: string[]): string[] {
  return Array.from(new Set(filePaths.map(normalizeFilePath).filter(Boolean)));
}

function parseLikelyFilePaths(text: string): string[] {
  const matches = text.match(/[\w./-]+\.(tsx?|jsx?|json|md|css|scss|sql|yaml|yml)/gi) || [];
  return uniqueNormalized(matches);
}

function extractAllowedPathsFromIssue(issue: Issue): string[] {
  const description = String(issue.description || '');
  const lines = description.split('\n');
  const paths: string[] = [];

  // Prefer explicit "Files:" sections when present.
  const filesSectionStart = lines.findIndex(line => /^\s*\*{0,2}files\*{0,2}\s*:/i.test(line));
  if (filesSectionStart >= 0) {
    const filesLine = lines[filesSectionStart];
    paths.push(...parseLikelyFilePaths(filesLine));
    for (let i = filesSectionStart + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*$/.test(line)) break;
      if (/^\s*[\-*]\s+/.test(line) || /^\s{2,}/.test(line)) {
        paths.push(...parseLikelyFilePaths(line));
      } else {
        break;
      }
    }
  }

  // Fallback: parse all path-like tokens from description.
  if (paths.length === 0) {
    paths.push(...parseLikelyFilePaths(description));
  }

  return uniqueNormalized(paths);
}

function getTrackedFiles(workspace: string): string[] {
  if (trackedFilesCache && trackedFilesCacheWorkspace === workspace) {
    return trackedFilesCache;
  }

  try {
    const out = execSync('git ls-files', {
      cwd: workspace,
      stdio: 'pipe',
      timeout: 30000,
      encoding: 'utf8',
    }).toString();
    trackedFilesCache = uniqueNormalized(out.split('\n').filter(Boolean));
    trackedFilesCacheWorkspace = workspace;
    return trackedFilesCache;
  } catch {
    return [];
  }
}

function isSharedCanonicalPath(filePath: string): boolean {
  return SHARED_CANONICAL_PATTERNS.some(pattern => pattern.test(filePath));
}

export interface TicketScopeResult {
  ok: boolean;
  allowedPaths: string[];
  violations: string[];
}

export function validateTicketWriteScope(issue: Issue, writtenFiles: string[]): TicketScopeResult {
  const allowedPaths = extractAllowedPathsFromIssue(issue);
  if (allowedPaths.length === 0) {
    return { ok: true, allowedPaths: [], violations: [] };
  }

  const normalizedWritten = uniqueNormalized(writtenFiles);
  const violations = normalizedWritten.filter(filePath => {
    if (isSharedCanonicalPath(filePath)) return false;
    return !allowedPaths.some(allowed =>
      filePath === allowed ||
      filePath.startsWith(`${allowed}/`) ||
      allowed.startsWith(`${filePath}/`)
    );
  });

  return {
    ok: violations.length === 0,
    allowedPaths,
    violations,
  };
}

export interface DriftPrecommitResult {
  ok: boolean;
  code?: 'DRIFT_SCOPE_VIOLATION' | 'DRIFT_PRECOMMIT_DUPLICATE';
  details: string[];
}

export function runDriftPrecommit(issue: Issue, writtenFiles: string[], workspace: string): DriftPrecommitResult {
  const scope = validateTicketWriteScope(issue, writtenFiles);
  if (!scope.ok) {
    return {
      ok: false,
      code: 'DRIFT_SCOPE_VIOLATION',
      details: scope.violations,
    };
  }

  const normalizedWritten = uniqueNormalized(writtenFiles);
  const writtenByBasename = new Map<string, string[]>();
  for (const filePath of normalizedWritten) {
    if (!DRIFT_PATH_FAMILY.test(filePath)) continue;
    const basename = path.basename(filePath, path.extname(filePath)).toLowerCase();
    if (COMMON_BASENAMES.has(basename)) continue;
    const list = writtenByBasename.get(basename) || [];
    list.push(filePath);
    writtenByBasename.set(basename, list);
  }

  const duplicates: string[] = [];

  // Intra-write duplicates (same concept in multiple directories in one response).
  for (const [basename, files] of writtenByBasename.entries()) {
    const unique = Array.from(new Set(files));
    if (unique.length > 1) {
      duplicates.push(`${basename}: ${unique.join(', ')}`);
    }
  }

  // Repo-level duplicate basename collisions in path families.
  const tracked = getTrackedFiles(workspace);
  const trackedByBasename = new Map<string, string[]>();
  for (const trackedPath of tracked) {
    if (!DRIFT_PATH_FAMILY.test(trackedPath)) continue;
    const basename = path.basename(trackedPath, path.extname(trackedPath)).toLowerCase();
    if (COMMON_BASENAMES.has(basename)) continue;
    const list = trackedByBasename.get(basename) || [];
    list.push(trackedPath);
    trackedByBasename.set(basename, list);
  }

  for (const [basename, files] of writtenByBasename.entries()) {
    const existing = trackedByBasename.get(basename) || [];
    for (const filePath of files) {
      const abs = path.join(workspace, filePath);
      const existedBefore = fs.existsSync(abs);
      if (existedBefore) continue; // modifying existing file is allowed
      const otherExisting = existing.filter(existingPath => normalizeFilePath(existingPath) !== normalizeFilePath(filePath));
      if (otherExisting.length > 0 && !isSharedCanonicalPath(filePath)) {
        duplicates.push(`${basename}: new ${filePath} duplicates existing ${otherExisting.join(', ')}`);
      }
    }
  }

  if (duplicates.length > 0) {
    return {
      ok: false,
      code: 'DRIFT_PRECOMMIT_DUPLICATE',
      details: Array.from(new Set(duplicates)),
    };
  }

  return { ok: true, details: [] };
}

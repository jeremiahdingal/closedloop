import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace } from './config';

const WORKSPACE = getWorkspace();

export interface DriftIssue {
  type: 'duplicate_basename' | 'parallel_path' | 'similar_name';
  files: string[];
  description: string;
}

export async function detectDriftIssues(): Promise<DriftIssue[]> {
  const issues: DriftIssue[] = [];
  
  try {
    // Get all changed/new files in the workspace
    const changedFiles = getChangedFiles();
    if (changedFiles.length === 0) return [];
    
    // Check for duplicate basenames
    const basenameGroups = groupByBasename(changedFiles);
    for (const [basename, files] of Object.entries(basenameGroups)) {
      if (files.length > 1) {
        issues.push({
          type: 'duplicate_basename',
          files,
          description: `Duplicate file basename: ${basename} exists in multiple locations: ${files.join(', ')}`,
        });
      }
    }
    
    // Check for parallel paths (e.g., hooks/ and apiHooks/)
    const parallelPatterns = findParallelPaths(changedFiles);
    for (const pattern of parallelPatterns) {
      issues.push({
        type: 'parallel_path',
        files: pattern.files,
        description: `Parallel paths detected: ${pattern.name} has implementations in ${pattern.files.length} locations`,
      });
    }
    
    // Check for similar names (e.g., Auth.tsx and Authentication.tsx)
    const similarNames = findSimilarNames(changedFiles);
    for (const group of similarNames) {
      issues.push({
        type: 'similar_name',
        files: group.files,
        description: `Similar file names detected: ${group.files.join(', ')}`,
      });
    }
    
  } catch (err) {
    console.log(`[drift-detector] Error detecting drift: ${err}`);
  }
  
  return issues;
}

function getChangedFiles(): string[] {
  try {
    const diff = execSync('git diff --name-only HEAD', { cwd: WORKSPACE, encoding: 'utf8', timeout: 10000 }).trim();
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: WORKSPACE, encoding: 'utf8', timeout: 10000 }).trim();
    
    return [...diff.split('\n'), ...untracked]
      .map(f => f.trim())
      .filter(Boolean)
      .filter(f => !f.includes('node_modules') && !f.includes('.git'));
  } catch {
    return [];
  }
}

function groupByBasename(files: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  
  for (const file of files) {
    const basename = path.basename(file);
    if (!groups[basename]) groups[basename] = [];
    groups[basename].push(file);
  }
  
  return groups;
}

function findParallelPaths(files: string[]): Array<{ name: string; files: string[] }> {
  const patterns: Array<{ regex: RegExp; name: string }> = [
    { regex: /\/hooks\//, name: 'hooks' },
    { regex: /\/api(?!ro)/, name: 'api' },
    { regex: /\/services\//, name: 'services' },
    { regex: /\/components\//, name: 'components' },
    { regex: /\/utils\//, name: 'utils' },
    { regex: /\/lib\//, name: 'lib' },
    { regex: /\/store\//, name: 'store' },
    { regex: /\/context\//, name: 'context' },
  ];
  
  const pathGroups: Record<string, string[]> = {};
  
  for (const file of files) {
    for (const pattern of patterns) {
      if (pattern.regex.test(file)) {
        if (!pathGroups[pattern.name]) pathGroups[pattern.name] = [];
        pathGroups[pattern.name].push(file);
      }
    }
  }
  
  return Object.entries(pathGroups)
    .filter(([_, files]) => files.length > 1)
    .map(([name, files]) => ({ name, files }));
}

function findSimilarNames(files: string[]): Array<{ files: string[] }> {
  const groups: string[][] = [];
  const extensions = ['.ts', '.tsx', '.js', '.jsx'];
  
  // Get just the source files
  const sourceFiles = files.filter(f => extensions.some(ext => f.endsWith(ext)));
  
  for (let i = 0; i < sourceFiles.length; i++) {
    for (let j = i + 1; j < sourceFiles.length; j++) {
      const name1 = path.basename(sourceFiles[i], path.extname(sourceFiles[i]));
      const name2 = path.basename(sourceFiles[j], path.extname(sourceFiles[j]));
      
      // Check for similar names (e.g., Auth and Authentication)
      if (name1 !== name2 && (name1.includes(name2) || name2.includes(name1) || levenshtein(name1, name2) <= 3)) {
        // Check if this pair already exists in a group
        let found = false;
        for (const group of groups) {
          if (group.includes(sourceFiles[i]) || group.includes(sourceFiles[j])) {
            if (!group.includes(sourceFiles[i])) group.push(sourceFiles[i]);
            if (!group.includes(sourceFiles[j])) group.push(sourceFiles[j]);
            found = true;
            break;
          }
        }
        if (!found) {
          groups.push([sourceFiles[i], sourceFiles[j]]);
        }
      }
    }
  }
  
  return groups.filter(g => g.length > 1).map(files => ({ files }));
}

function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  return matrix[b.length][a.length];
}

export function formatDriftReport(issues: DriftIssue[]): string {
  if (issues.length === 0) return '';
  
  let report = '\n## 🚨 DRIFT ISSUES DETECTED\n\n';
  
  for (const issue of issues) {
    report += `### ${issue.type.replace('_', ' ').toUpperCase()}\n`;
    report += `${issue.description}\n`;
    report += `Files: ${issue.files.join(', ')}\n\n`;
  }
  
  return report;
}

export async function writeDriftContext(): Promise<void> {
  const issues = await detectDriftIssues();
  const report = formatDriftReport(issues);
  
  if (report) {
    // Write to workspace root so agent sees it
    const driftFile = path.join(WORKSPACE, 'DRIFT_ISSUES.md');
    fs.writeFileSync(driftFile, report);
    console.log(`[drift-detector] Wrote drift report: ${issues.length} issues`);
  }
}

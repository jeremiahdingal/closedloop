/**
 * Diff Guardian - Mechanical enforcement layer for code changes
 *
 * Runs after Reviewer approval, before PR creation.
 * Detects destructive patterns with deterministic checks only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getWorkspace } from './config';
import { getIssueLabel, postComment } from './paperclip-api';
import { getDefaultBranch, getBranchName } from './git-ops';

const WORKSPACE = getWorkspace();

export interface DiffIssue {
  type: 'PARALLEL_FILE' | 'EXPORT_REMOVAL' | 'EXCESSIVE_DELETION' | 'DUPLICATE_STORE' | 'DUPLICATE_TYPE' | 'RUNTIME_ERROR';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  files?: string[];
  newFile?: string;
  existingFile?: string;
  removedExports?: string[];
  autoFixable?: boolean;
  autoFix?: {
    type: 'REMOVE_FILE' | 'RESTORE_EXPORT' | 'MERGE_FILES';
    description: string;
  };
}

export interface DiffGuardianResult {
  approved: boolean;
  issues: DiffIssue[];
}

/**
 * Run Diff Guardian to validate changes before PR creation.
 */
export async function runDiffGuardian(issueId: string): Promise<DiffGuardianResult> {
  const opts = { cwd: WORKSPACE, encoding: 'utf8' as const, timeout: 30000 };
  const issueLabel = await getIssueLabel(issueId);

  try {
    const defaultBranch = getDefaultBranch();
    const featureBranch = await getBranchName(issueId);
    const changedFiles = execSync(`git diff ${defaultBranch}...${featureBranch} --name-only`, opts)
      .split('\n')
      .filter(f => f.trim());

    if (changedFiles.length === 0) {
      console.log(`[DiffGuardian] No changes detected for ${issueLabel} (ref: ${featureBranch})`);
      return { approved: true, issues: [] };
    }

    const diffStats = execSync(`git diff ${defaultBranch}...${featureBranch} --numstat`, opts);
    const lines = diffStats.split('\n').filter(l => l.trim());

    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const line of lines) {
      const [adds, dels] = line.split('\t');
      if (adds !== '-') totalAdditions += parseInt(adds, 10);
      if (dels !== '-') totalDeletions += parseInt(dels, 10);
    }

    const issues: DiffIssue[] = [];

    const parallelFiles = detectParallelFiles(changedFiles);
    if (parallelFiles.length > 0) {
      issues.push({
        type: 'PARALLEL_FILE',
        severity: 'HIGH',
        description: `New files may duplicate existing functionality: ${parallelFiles.join(', ')}`,
        files: parallelFiles,
        autoFixable: true,
        autoFix: {
          type: 'REMOVE_FILE',
          description: 'Remove duplicate files and modify existing files instead',
        },
      });
    }

    const deletionRatio = totalDeletions / (totalAdditions + totalDeletions || 1);
    if (deletionRatio > 0.7 && totalDeletions > 100) {
      issues.push({
        type: 'EXCESSIVE_DELETION',
        severity: 'HIGH',
        description: `Changes delete ${totalDeletions} lines (${Math.round(deletionRatio * 100)}% of changes)`,
        autoFixable: false,
      });
    }

    const removedExports = detectRemovedExports(changedFiles, defaultBranch);
    if (removedExports.length > 0) {
      issues.push({
        type: 'EXPORT_REMOVAL',
        severity: 'CRITICAL',
        description: 'Removed exports may break existing code',
        removedExports,
        autoFixable: true,
        autoFix: {
          type: 'RESTORE_EXPORT',
          description: 'Restore removed exports or provide migration path',
        },
      });
    }

    const duplicateStores = detectDuplicateStores(changedFiles);
    if (duplicateStores.length > 0) {
      issues.push({
        type: 'DUPLICATE_STORE',
        severity: 'CRITICAL',
        description: 'New store files duplicate existing stores',
        files: duplicateStores.map(d => d.newFile),
        autoFixable: true,
        autoFix: {
          type: 'MERGE_FILES',
          description: 'Merge new functionality into existing store files',
        },
      });
    }

    if (issues.length === 0) {
      console.log(`[DiffGuardian] Approved for ${issueLabel}`);
      return { approved: true, issues: [] };
    }

    console.log(`[DiffGuardian] Found ${issues.length} issues for ${issueLabel}`);
    const fixesApplied = await applyAutoFixes(issues);
    await postComment(issueId, null, buildDiffGuardianReport(issues, fixesApplied, false));
    return { approved: false, issues };
  } catch (err: any) {
    console.error('[DiffGuardian] Error:', err.message);
    const issue: DiffIssue = {
      type: 'RUNTIME_ERROR',
      severity: 'CRITICAL',
      description: `Diff Guardian runtime error: ${String(err.message || 'unknown')}`,
      autoFixable: false,
    };
    await postComment(
      issueId,
      null,
      `[DIFF_GUARDIAN_RUNTIME_ERROR] Diff Guardian failed closed and rejected this run.\n\n${String(err.message || 'unknown error')}`
    );
    return { approved: false, issues: [issue] };
  }
}

function detectParallelFiles(changedFiles: string[]): string[] {
  const parallelFiles: string[] = [];
  const familyRegex = /(components|hooks|apihooks|schemas|routes|services|screens|dialogs)\//i;
  const common = new Set(['index', 'types', 'utils', 'constants', 'schema', 'route', 'routes', 'screen']);
  const changedByBasename = new Map<string, string[]>();
  for (const changed of changedFiles) {
    const normalized = changed.replace(/\\/g, '/');
    if (!familyRegex.test(normalized)) continue;
    const basename = path.basename(normalized, path.extname(normalized)).toLowerCase();
    if (common.has(basename)) continue;
    const list = changedByBasename.get(basename) || [];
    list.push(normalized);
    changedByBasename.set(basename, list);
  }

  for (const files of changedByBasename.values()) {
    if (files.length > 1) {
      parallelFiles.push(...files);
    }
  }

  try {
    const tracked = execSync('git ls-files', {
      cwd: WORKSPACE,
      encoding: 'utf8',
      timeout: 10000,
    })
      .split('\n')
      .map(f => f.trim())
      .filter(Boolean);

    const trackedByBasename = new Map<string, string[]>();
    for (const trackedFile of tracked) {
      const normalized = trackedFile.replace(/\\/g, '/');
      if (!familyRegex.test(normalized)) continue;
      const basename = path.basename(normalized, path.extname(normalized)).toLowerCase();
      if (common.has(basename)) continue;
      const list = trackedByBasename.get(basename) || [];
      list.push(normalized);
      trackedByBasename.set(basename, list);
    }

    for (const [basename, files] of changedByBasename.entries()) {
      const existing = trackedByBasename.get(basename) || [];
      for (const file of files) {
        const isExistingPath = fs.existsSync(path.join(WORKSPACE, file));
        if (isExistingPath) continue;
        if (existing.some(existingFile => existingFile !== file)) {
          parallelFiles.push(file);
        }
      }
    }
  } catch {
    // best effort only
  }

  const patterns = [
    { new: /\.store\.ts$/, existing: /store.*\.ts$/ },
    { new: /\.types\.ts$/, existing: /types.*\.ts$/ },
    { new: /\.schema\.ts$/, existing: /schema.*\.ts$/ },
  ];

  for (const file of changedFiles) {
    for (const pattern of patterns) {
      if (!pattern.new.test(file)) continue;

      const baseName = path.basename(file, path.extname(file));
      const dir = path.dirname(file);
      const existingPattern = new RegExp(`${baseName}.*\\.(ts|tsx)$`);
      const dirPath = path.join(WORKSPACE, dir);
      if (!fs.existsSync(dirPath)) continue;

      const existingFiles = fs.readdirSync(dirPath)
        .filter(f => existingPattern.test(f) && f !== path.basename(file));

      if (existingFiles.length > 0) {
        parallelFiles.push(file);
      }
    }
  }

  return Array.from(new Set(parallelFiles));
}

function detectRemovedExports(changedFiles: string[], defaultBranch: string): string[] {
  const removedExports: string[] = [];

  for (const file of changedFiles) {
    const fullPath = path.join(WORKSPACE, file);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const oldContent = execSync(`git show ${defaultBranch}:${file}`, {
        cwd: WORKSPACE,
        encoding: 'utf8',
      }).toString();
      const newContent = fs.readFileSync(fullPath, 'utf8');

      const exportRegex = /export\s+(?:const|function|class|interface|type|enum)\s+(\w+)/g;
      const oldExports = new Set(Array.from(oldContent.matchAll(exportRegex), match => match[1]));
      const newExports = new Set(Array.from(newContent.matchAll(exportRegex), match => match[1]));

      for (const oldExport of oldExports) {
        if (!newExports.has(oldExport)) {
          removedExports.push(`${file}: ${oldExport}`);
        }
      }
    } catch {}
  }

  return removedExports;
}

function detectDuplicateStores(changedFiles: string[]): Array<{ newFile: string; existingFile: string }> {
  const duplicates: Array<{ newFile: string; existingFile: string }> = [];
  const existingStores = [
    'useUserStore',
    'useShopStore',
    'useCartStore',
    'useAuthStore',
  ];

  for (const file of changedFiles) {
    if (!file.includes('/store/') || !file.endsWith('.ts')) continue;

    const basename = path.basename(file, '.ts').replace('.store', '');
    for (const existingStore of existingStores) {
      if (!basename.toLowerCase().includes(existingStore.replace('use', '').replace('Store', '').toLowerCase())) {
        continue;
      }

      const existingPath = path.join(path.dirname(file), `${existingStore}.ts`);
      if (fs.existsSync(path.join(WORKSPACE, existingPath))) {
        duplicates.push({
          newFile: file,
          existingFile: existingPath.replace(WORKSPACE + '\\', ''),
        });
      }
    }
  }

  return duplicates;
}

async function applyAutoFixes(
  issues: DiffIssue[]
): Promise<Array<{ issue: DiffIssue; action: string; result: string }>> {
  const fixesApplied: Array<{ issue: DiffIssue; action: string; result: string }> = [];

  for (const issue of issues) {
    if (!issue.autoFixable || !issue.autoFix) continue;

    try {
      switch (issue.autoFix.type) {
        case 'REMOVE_FILE':
          if (issue.files) {
            for (const file of issue.files) {
              const fullPath = path.join(WORKSPACE, file);
              if (!fs.existsSync(fullPath)) continue;

              const backupPath = `${fullPath}.backup`;
              fs.copyFileSync(fullPath, backupPath);
              fs.unlinkSync(fullPath);
              execSync(`git add "${file}"`, { cwd: WORKSPACE });
              fixesApplied.push({
                issue,
                action: `Removed duplicate file: ${file}`,
                result: `File backed up to ${backupPath}`,
              });
            }
          }
          break;

        case 'RESTORE_EXPORT':
          fixesApplied.push({
            issue,
            action: 'Removed exports detected',
            result: 'Manual restoration required',
          });
          break;

        case 'MERGE_FILES':
          fixesApplied.push({
            issue,
            action: 'Duplicate store detected',
            result: 'Manual merge required',
          });
          break;
      }
    } catch (err: any) {
      fixesApplied.push({
        issue,
        action: `Failed to apply fix: ${err.message}`,
        result: 'Manual intervention required',
      });
    }
  }

  return fixesApplied;
}

function buildDiffGuardianReport(
  issues: DiffIssue[],
  fixesApplied: Array<{ issue: DiffIssue; action: string; result: string }>,
  approved: boolean
): string {
  const driftTypes: DiffIssue['type'][] = ['PARALLEL_FILE', 'DUPLICATE_STORE', 'DUPLICATE_TYPE'];
  const hasDrift = issues.some(i => driftTypes.includes(i.type));
  let report = hasDrift
    ? '## [DRIFT] Diff Guardian Report\n\n'
    : '## Diff Guardian Report\n\n';

  if (issues.length === 0) {
    report += 'No destructive changes detected. Changes approved.\n';
    return report;
  }

  if (hasDrift) {
    const driftIssues = issues.filter(i => driftTypes.includes(i.type));
    report += `**[DRIFT:${driftIssues.map(i => i.type).join(',')}]** `;
    report += `Duplicate/parallel file drift detected. Epic Reviewer should prioritize deletion-focused review for this ticket.\n\n`;
  }

  report += `Detected ${issues.length} destructive pattern(s).\n\n`;
  for (const issue of issues) {
    report += `- ${issue.type} (${issue.severity}): ${issue.description}\n`;
  }

  if (fixesApplied.length > 0) {
    report += '\n### Mechanical Actions\n';
    for (const fix of fixesApplied) {
      report += `- ${fix.action}: ${fix.result}\n`;
    }
  }

  report += approved
    ? '\nStatus: approved.\n'
    : '\nAction required: sent back to Local Builder for follow-up.\n';

  return report;
}

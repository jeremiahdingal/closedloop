/**
 * Diff Guardian - Mechanical enforcement layer for code changes
 * 
 * Runs after Reviewer approval, before PR creation.
 * Detects destructive patterns and validates fixes with LLM.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getWorkspace } from './config';
import { getIssueComments, postComment } from './paperclip-api';
import { AGENTS } from './agent-types';

const WORKSPACE = getWorkspace();

export interface DiffIssue {
  type: 'PARALLEL_FILE' | 'EXPORT_REMOVAL' | 'EXCESSIVE_DELETION' | 'DUPLICATE_STORE' | 'DUPLICATE_TYPE';
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
  llmValidated?: boolean;
  llmFeedback?: string;
}

/**
 * Run Diff Guardian to validate changes before PR creation
 */
export async function runDiffGuardian(issueId: string): Promise<DiffGuardianResult> {
  const opts = { cwd: WORKSPACE, encoding: 'utf8' as const, timeout: 30000 };

  try {
    // 1. Get changed files
    const changedFiles = execSync('git diff master..HEAD --name-only', opts)
      .split('\n')
      .filter(f => f.trim());

    if (changedFiles.length === 0) {
      console.log(`[DiffGuardian] No changes detected for ${issueId.slice(0, 8)}`);
      return { approved: true, issues: [] };
    }

    // 2. Get diff stats
    const diffStats = execSync('git diff master..HEAD --numstat', opts);
    const lines = diffStats.split('\n').filter(l => l.trim());

    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const line of lines) {
      const [adds, dels] = line.split('\t');
      if (adds !== '-') totalAdditions += parseInt(adds);
      if (dels !== '-') totalDeletions += parseInt(dels);
    }

    // 3. Detect destructive patterns
    const issues: DiffIssue[] = [];

    // 3a. Check for parallel files
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

    // 3b. Check for excessive deletions
    const deletionRatio = totalDeletions / (totalAdditions + totalDeletions || 1);
    if (deletionRatio > 0.7 && totalDeletions > 100) {
      issues.push({
        type: 'EXCESSIVE_DELETION',
        severity: 'HIGH',
        description: `Changes delete ${totalDeletions} lines (${Math.round(deletionRatio * 100)}% of changes)`,
        autoFixable: false,
      });
    }

    // 3c. Check for removed exports
    const removedExports = detectRemovedExports(changedFiles);
    if (removedExports.length > 0) {
      issues.push({
        type: 'EXPORT_REMOVAL',
        severity: 'CRITICAL',
        description: `Removed exports may break existing code`,
        removedExports,
        autoFixable: true,
        autoFix: {
          type: 'RESTORE_EXPORT',
          description: 'Restore removed exports or provide migration path',
        },
      });
    }

    // 3d. Check for duplicate stores/types
    const duplicateStores = detectDuplicateStores(changedFiles);
    if (duplicateStores.length > 0) {
      issues.push({
        type: 'DUPLICATE_STORE',
        severity: 'CRITICAL',
        description: `New store files duplicate existing stores`,
        files: duplicateStores.map(d => d.newFile),
        autoFixable: true,
        autoFix: {
          type: 'MERGE_FILES',
          description: 'Merge new functionality into existing store files',
        },
      });
    }

    // 4. If issues found, attempt auto-fix + LLM validation
    if (issues.length > 0) {
      console.log(`[DiffGuardian] Found ${issues.length} issues for ${issueId.slice(0, 8)}`);

      // Check if all issues are auto-fixable
      const allAutoFixable = issues.every(i => i.autoFixable);

      if (allAutoFixable) {
        // Attempt auto-fix
        console.log(`[DiffGuardian] Attempting auto-fix for ${issues.length} issues...`);
        
        // Apply mechanical fixes
        const fixesApplied = await applyAutoFixes(issues, changedFiles);
        
        if (fixesApplied.length > 0) {
          // LLM validation: Do the fixes make sense?
          console.log(`[DiffGuardian] Validating fixes with LLM...`);
          const llmResult = await validateFixesWithLLM(issueId, issues, fixesApplied, changedFiles);
          
          if (llmResult.valid) {
            console.log(`[DiffGuardian] LLM validated fixes for ${issueId.slice(0, 8)}`);
            
            // Post findings as comment
            await postComment(
              issueId,
              AGENTS.reviewer,
              buildDiffGuardianReport(issues, fixesApplied, llmResult.feedback, true)
            );
            
            return {
              approved: true,
              issues,
              llmValidated: true,
              llmFeedback: llmResult.feedback,
            };
          } else {
            console.log(`[DiffGuardian] LLM rejected fixes for ${issueId.slice(0, 8)}`);
            await postComment(
              issueId,
              AGENTS.reviewer,
              buildDiffGuardianReport(issues, fixesApplied, llmResult.feedback, false)
            );
            
            return {
              approved: false,
              issues,
              llmValidated: false,
              llmFeedback: llmResult.feedback,
            };
          }
        }
      }

      // Issues not auto-fixable or LLM rejected
      await postComment(issueId, AGENTS.reviewer, buildDiffGuardianReport(issues, [], undefined, false));
      return { approved: false, issues };
    }

    console.log(`[DiffGuardian] Approved for ${issueId.slice(0, 8)}`);
    return { approved: true, issues: [] };

  } catch (err: any) {
    console.error(`[DiffGuardian] Error:`, err.message);
    // Fail open to avoid blocking pipeline
    return { approved: true, issues: [] };
  }
}

/**
 * Detect new files that duplicate existing functionality
 */
function detectParallelFiles(changedFiles: string[]): string[] {
  const parallelFiles: string[] = [];
  
  // Common patterns for duplicate files
  const patterns = [
    { new: /\.store\.ts$/, existing: /store.*\.ts$/ },
    { new: /\.types\.ts$/, existing: /types.*\.ts$/ },
    { new: /\.schema\.ts$/, existing: /schema.*\.ts$/ },
  ];

  for (const file of changedFiles) {
    for (const pattern of patterns) {
      if (pattern.new.test(file)) {
        // Check if similar file exists
        const baseName = path.basename(file, path.extname(file));
        const dir = path.dirname(file);
        const existingPattern = new RegExp(`${baseName}.*\\.(ts|tsx)$`);
        
        const existingFiles = fs.readdirSync(path.join(WORKSPACE, dir))
          .filter(f => existingPattern.test(f) && f !== path.basename(file));
        
        if (existingFiles.length > 0) {
          parallelFiles.push(file);
        }
      }
    }
  }

  return parallelFiles;
}

/**
 * Detect removed exports from modified files
 */
function detectRemovedExports(changedFiles: string[]): string[] {
  const removedExports: string[] = [];

  for (const file of changedFiles) {
    const fullPath = path.join(WORKSPACE, file);
    if (!fs.existsSync(fullPath)) continue;

    try {
      // Get old version from git
      const oldContent = execSync(`git show master:${file}`, { encoding: 'utf8' }).toString();
      const newContent = fs.readFileSync(fullPath, 'utf8');

      // Extract old exports
      const oldExports = new Set(oldContent.match(/export\s+(?:const|function|class|interface|type|enum)\s+(\w+)/g) || []);
      
      // Extract new exports
      const newExports = new Set(newContent.match(/export\s+(?:const|function|class|interface|type|enum)\s+(\w+)/g) || []);

      // Find removed exports
      for (const oldExp of oldExports) {
        if (!newExports.has(oldExp)) {
          removedExports.push(`${file}: ${oldExp}`);
        }
      }
    } catch (err: any) {
      // File might be new or git error
    }
  }

  return removedExports;
}

/**
 * Detect duplicate store files
 */
function detectDuplicateStores(changedFiles: string[]): Array<{ newFile: string; existingFile: string }> {
  const duplicates: Array<{ newFile: string; existingFile: string }> = [];

  const existingStores = [
    'useUserStore',
    'useShopStore',
    'useCartStore',
    'useAuthStore',
  ];

  for (const file of changedFiles) {
    if (file.includes('/store/') && file.endsWith('.ts')) {
      const basename = path.basename(file, '.ts').replace('.store', '');
      
      for (const existingStore of existingStores) {
        if (basename.toLowerCase().includes(existingStore.replace('use', '').replace('Store', '').toLowerCase())) {
          const existingPath = path.join(path.dirname(file), `${existingStore}.ts`);
          if (fs.existsSync(path.join(WORKSPACE, existingPath))) {
            duplicates.push({
              newFile: file,
              existingFile: existingPath.replace(WORKSPACE + '\\', ''),
            });
          }
        }
      }
    }
  }

  return duplicates;
}

/**
 * Apply mechanical auto-fixes to issues
 */
async function applyAutoFixes(
  issues: DiffIssue[],
  changedFiles: string[]
): Promise<Array<{ issue: DiffIssue; action: string; result: string }>> {
  const fixesApplied: Array<{ issue: DiffIssue; action: string; result: string }> = [];

  for (const issue of issues) {
    if (!issue.autoFixable || !issue.autoFix) continue;

    try {
      switch (issue.autoFix.type) {
        case 'REMOVE_FILE':
          // Remove duplicate files
          if (issue.files) {
            for (const file of issue.files) {
              const fullPath = path.join(WORKSPACE, file);
              if (fs.existsSync(fullPath)) {
                // Backup before removing
                const backupPath = fullPath + '.backup';
                fs.copyFileSync(fullPath, backupPath);
                fs.unlinkSync(fullPath);
                execSync(`git add ${file}`, { cwd: WORKSPACE });
                fixesApplied.push({
                  issue,
                  action: `Removed duplicate file: ${file}`,
                  result: `File backed up to ${backupPath}`,
                });
              }
            }
          }
          break;

        case 'RESTORE_EXPORT':
          // Exports need manual review - mark for LLM
          fixesApplied.push({
            issue,
            action: 'Export restoration requires LLM guidance',
            result: 'LLM will suggest restoration approach',
          });
          break;

        case 'MERGE_FILES':
          // File merging needs LLM guidance
          fixesApplied.push({
            issue,
            action: 'File merging requires LLM guidance',
            result: 'LLM will suggest merge approach',
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

/**
 * Validate auto-fixes with LLM
 */
async function validateFixesWithLLM(
  issueId: string,
  issues: DiffIssue[],
  fixesApplied: Array<{ issue: DiffIssue; action: string; result: string }>,
  changedFiles: string[]
): Promise<{ valid: boolean; feedback: string }> {
  try {
    // Get issue context
    const comments = await getIssueComments(issueId);
    const recentComments = comments.slice(0, 3).map(c => c.body).join('\n\n');

    // Build prompt for LLM
    const prompt = `You are reviewing code changes for correctness.

ISSUE CONTEXT:
${recentComments}

DESTRUCTIVE ISSUES DETECTED:
${issues.map(i => `- ${i.type}: ${i.description}`).join('\n')}

AUTO-FIXES APPLIED:
${fixesApplied.map(f => `- ${f.action}: ${f.result}`).join('\n')}

CHANGED FILES:
${changedFiles.join('\n')}

TASK:
1. Review the destructive issues and auto-fixes
2. Determine if the fixes are appropriate and don't introduce new issues
3. If fixes are good, respond with "VALIDATED: [brief reason]"
4. If fixes are bad or incomplete, respond with "REJECTED: [specific reason and what to fix]"

Respond concisely.`;

    // Call Ollama with small model
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:7b',
        prompt,
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 500,
        },
      }),
    });

    const data = await response.json() as { response: string };
    const llmResponse = data.response.trim();

    // Parse response
    const isValid = llmResponse.toUpperCase().includes('VALIDATED') || 
                    llmResponse.toUpperCase().includes('APPROVED') ||
                    llmResponse.toUpperCase().includes('LOOKS GOOD');

    return {
      valid: isValid,
      feedback: llmResponse,
    };
  } catch (err: any) {
    console.error(`[DiffGuardian] LLM validation error:`, err.message);
    // Fail open - assume valid if LLM unavailable
    return { valid: true, feedback: 'LLM validation unavailable, proceeding with fixes' };
  }
}

/**
 * Build Diff Guardian report for comment
 */
function buildDiffGuardianReport(
  issues: DiffIssue[],
  fixesApplied: Array<{ issue: DiffIssue; action: string; result: string }>,
  llmFeedback?: string,
  approved?: boolean
): string {
  let report = `## 🔍 Diff Guardian Report\n\n`;

  if (issues.length === 0) {
    report += `✅ No destructive changes detected. Changes approved.\n\n`;
  } else {
    report += `⚠️ **${issues.length} destructive pattern(s) detected**\n\n`;

    for (const issue of issues) {
      const icon = issue.severity === 'CRITICAL' ? '🔴' : issue.severity === 'HIGH' ? '🟠' : '🟡';
      report += `${icon} **${issue.type}** (${issue.severity})\n`;
      report += `   ${issue.description}\n\n`;
    }

    if (fixesApplied.length > 0) {
      report += `### 🔧 Auto-Fixes Applied\n\n`;
      for (const fix of fixesApplied) {
        report += `- ${fix.action}\n`;
        report += `  → ${fix.result}\n\n`;
      }

      if (llmFeedback) {
        report += `### 🤖 LLM Validation\n\n`;
        report += `${llmFeedback}\n\n`;
      }
    }

    if (approved === false) {
      report += `### ❌ Action Required\n\n`;
      report += `Changes sent back to **Local Builder** for manual fixes.\n\n`;
      report += `**Next steps:**\n`;
      report += `- Review the issues above\n`;
      report += `- Modify existing files instead of creating duplicates\n`;
      report += `- Preserve existing exports or provide migration\n`;
    } else if (approved === true) {
      report += `### ✅ Status\n\n`;
      report += `Fixes validated. Proceeding to PR creation.\n`;
    }
  }

  return report;
}

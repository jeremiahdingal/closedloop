/**
 * Git worktree operations for parallel exploration.
 * Creates isolated workspaces so multiple builder approaches
 * can run without contaminating each other.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getWorkspace } from './config';
import { WorktreeInfo } from './types';
import { getBranchName } from './git-ops';

const WORKTREE_DIR = '.worktrees';

/**
 * Get the worktree root directory inside the workspace.
 */
export function getWorktreeRoot(workspace?: string): string {
  const ws = workspace || getWorkspace();
  return path.join(ws, WORKTREE_DIR);
}

/**
 * Create a git worktree for an exploration approach.
 * Each worktree gets its own branch based on the issue branch + approach label.
 */
export async function createWorktree(
  issueId: string,
  label: string,
  workspace?: string
): Promise<WorktreeInfo> {
  const ws = workspace || getWorkspace();
  const baseBranch = await getBranchName(issueId);
  const branch = `${baseBranch}-explore-${label.toLowerCase()}`;
  const worktreeRoot = getWorktreeRoot(ws);
  const worktreePath = path.join(worktreeRoot, branch);
  const opts = { cwd: ws, stdio: 'pipe' as const, timeout: 30000 };

  // Ensure worktree root exists
  fs.mkdirSync(worktreeRoot, { recursive: true });

  // Clean up if worktree already exists (stale from previous run)
  if (fs.existsSync(worktreePath)) {
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, opts);
    } catch {
      // If git worktree remove fails, try manual cleanup
      fs.rmSync(worktreePath, { recursive: true, force: true });
      try {
        execSync(`git worktree prune`, opts);
      } catch {}
    }
  }

  // Delete the branch if it exists (stale)
  try {
    execSync(`git branch -D "${branch}"`, opts);
  } catch {}

  // Create worktree from master
  execSync(`git worktree add "${worktreePath}" -b "${branch}" master`, opts);
  console.log(`[worktree] Created: ${worktreePath} (branch: ${branch})`);

  // Symlink node_modules via Windows junction (avoids multi-GB copy)
  const srcNodeModules = path.join(ws, 'node_modules');
  const dstNodeModules = path.join(worktreePath, 'node_modules');
  if (fs.existsSync(srcNodeModules) && !fs.existsSync(dstNodeModules)) {
    try {
      execSync(`mklink /J "${dstNodeModules}" "${srcNodeModules}"`, {
        ...opts,
        shell: 'cmd.exe',
      });
      console.log(`[worktree] Symlinked node_modules`);
    } catch (err: any) {
      console.warn(`[worktree] node_modules symlink failed: ${err.message}`);
    }
  }

  // Also symlink .turbo, .next, dist to avoid rebuild overhead
  for (const dir of ['.turbo']) {
    const srcDir = path.join(ws, dir);
    const dstDir = path.join(worktreePath, dir);
    if (fs.existsSync(srcDir) && !fs.existsSync(dstDir)) {
      try {
        execSync(`mklink /J "${dstDir}" "${srcDir}"`, {
          ...opts,
          shell: 'cmd.exe',
        });
      } catch {}
    }
  }

  return {
    path: worktreePath,
    branch,
    label,
    issueId,
  };
}

/**
 * Remove a worktree and its branch.
 */
export function removeWorktree(worktreeInfo: WorktreeInfo, workspace?: string): void {
  const ws = workspace || getWorkspace();
  const opts = { cwd: ws, stdio: 'pipe' as const, timeout: 30000 };

  try {
    // Remove symlinked dirs first to avoid git worktree remove deleting them
    for (const dir of ['node_modules', '.turbo']) {
      const symlinkPath = path.join(worktreeInfo.path, dir);
      if (fs.existsSync(symlinkPath)) {
        try {
          // Check if it's a junction/symlink
          const stat = fs.lstatSync(symlinkPath);
          if (stat.isSymbolicLink() || stat.isDirectory()) {
            // Use rmdir for junctions on Windows
            execSync(`rmdir "${symlinkPath}"`, { ...opts, shell: 'cmd.exe' });
          }
        } catch {}
      }
    }

    execSync(`git worktree remove "${worktreeInfo.path}" --force`, opts);
    console.log(`[worktree] Removed: ${worktreeInfo.path}`);
  } catch (err: any) {
    console.warn(`[worktree] Remove failed: ${err.message}`);
    // Manual cleanup
    try {
      fs.rmSync(worktreeInfo.path, { recursive: true, force: true });
      execSync('git worktree prune', opts);
    } catch {}
  }

  // Delete the branch
  try {
    execSync(`git branch -D "${worktreeInfo.branch}"`, opts);
    console.log(`[worktree] Deleted branch: ${worktreeInfo.branch}`);
  } catch {}
}

/**
 * List active worktrees for an issue.
 */
export function listWorktrees(issueId: string, workspace?: string): WorktreeInfo[] {
  const ws = workspace || getWorkspace();
  const opts = { cwd: ws, stdio: 'pipe' as const, timeout: 10000 };

  try {
    const output = execSync('git worktree list --porcelain', opts).toString();
    const worktrees: WorktreeInfo[] = [];
    const blocks = output.split('\n\n').filter(Boolean);

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      const wtPath = lines.find(l => l.startsWith('worktree '))?.replace('worktree ', '');
      const branch = lines.find(l => l.startsWith('branch '))?.replace('branch refs/heads/', '');

      if (wtPath && branch && branch.includes('-explore-')) {
        // Extract the label from branch name (e.g. "SHO-50-foo-explore-a" -> "a")
        const labelMatch = branch.match(/-explore-(\w+)$/);
        if (labelMatch) {
          worktrees.push({
            path: wtPath,
            branch,
            label: labelMatch[1],
            issueId,
          });
        }
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Remove all worktrees for an issue.
 */
export function cleanupWorktrees(issueId: string, workspace?: string): void {
  const worktrees = listWorktrees(issueId, workspace);
  for (const wt of worktrees) {
    removeWorktree(wt, workspace);
  }
  console.log(`[worktree] Cleaned up ${worktrees.length} worktrees for ${issueId.slice(0, 8)}`);
}

/**
 * Get the diff stats for a worktree branch vs master.
 */
export function getWorktreeDiffStats(worktreeInfo: WorktreeInfo, workspace?: string): string {
  const ws = workspace || getWorkspace();
  const opts = { cwd: ws, stdio: 'pipe' as const, timeout: 15000 };

  try {
    return execSync(`git diff --stat master..${worktreeInfo.branch}`, opts).toString().trim();
  } catch {
    return '(diff stats unavailable)';
  }
}

/**
 * Get the full diff for a worktree branch vs master (truncated).
 */
export function getWorktreeDiff(worktreeInfo: WorktreeInfo, maxLines: number = 200, workspace?: string): string {
  const ws = workspace || getWorkspace();
  const opts = { cwd: ws, stdio: 'pipe' as const, timeout: 15000 };

  try {
    const diff = execSync(`git diff master..${worktreeInfo.branch}`, opts).toString();
    const lines = diff.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines truncated)`;
    }
    return diff;
  } catch {
    return '(diff unavailable)';
  }
}

/**
 * Merge the winning approach branch onto the canonical issue branch.
 * Cherry-picks the worktree commits onto the issue branch.
 */
export async function mergeWinningApproach(
  issueId: string,
  winningWorktree: WorktreeInfo,
  workspace?: string
): Promise<void> {
  const ws = workspace || getWorkspace();
  const canonicalBranch = await getBranchName(issueId);
  const opts = { cwd: ws, stdio: 'pipe' as const, timeout: 30000 };

  // Create or checkout canonical branch
  try {
    execSync(`git checkout -b ${canonicalBranch} master`, opts);
  } catch {
    execSync(`git checkout ${canonicalBranch}`, opts);
    // Reset to master to get a clean state
    try {
      execSync(`git reset --hard master`, opts);
    } catch {}
  }

  // Merge the winning branch
  try {
    execSync(`git merge ${winningWorktree.branch} --no-edit -m "Merge exploration approach ${winningWorktree.label}"`, opts);
    console.log(`[worktree] Merged approach ${winningWorktree.label} onto ${canonicalBranch}`);
  } catch (err: any) {
    // If merge conflicts, take the winning branch version
    console.warn(`[worktree] Merge conflict, taking winning branch: ${err.message}`);
    execSync(`git checkout --theirs .`, opts);
    execSync(`git add .`, opts);
    execSync(`git commit --no-edit -m "Merge exploration approach ${winningWorktree.label} (theirs)"`, opts);
  }

  // Push
  try {
    execSync(`git push -u origin ${canonicalBranch}`, { ...opts, timeout: 60000 });
    console.log(`[worktree] Pushed ${canonicalBranch}`);
  } catch (err: any) {
    console.warn(`[worktree] Push failed: ${err.message}`);
  }

  // Switch back to master
  execSync('git checkout master', opts);
}

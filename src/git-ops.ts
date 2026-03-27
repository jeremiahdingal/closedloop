/**
 * Git operations (branch, commit, push, PR creation)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getWorkspace } from './config';
import { getIssueDetails, postComment } from './paperclip-api';
import { issueBuilderPasses } from './agent-types';
import { listPngFilesRecursive } from './utils';

const WORKSPACE = getWorkspace();
const GH_CLI = 'C:\\Program Files\\GitHub CLI\\gh';
const SCREENSHOT_BASE = path.join(__dirname, '..', '.screenshots');

/** Detect default branch name (main vs master) */
export function getDefaultBranch(): string {
  try {
    const result = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: WORKSPACE, stdio: 'pipe', timeout: 5000,
    }).toString().trim();
    return result.split('/').pop() || 'main';
  } catch {
    try {
      execSync('git rev-parse --verify main', { cwd: WORKSPACE, stdio: 'pipe', timeout: 5000 });
      return 'main';
    } catch {
      return 'master';
    }
  }
}

export async function getBranchName(issueId: string): Promise<string> {
  let issue;
  try {
    issue = await getIssueDetails(issueId);
  } catch {}

  const identifier = (issue?.identifier || issueId.slice(0, 8)).toLowerCase();
  const title = issue?.title || 'Code changes';
  return `${identifier}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`.replace(/-+$/, '');
}

export interface CommitResult {
  success: boolean;
  output?: string;
}

/**
 * Commit changed files to a branch and push them.
 */
export async function commitAndPush(
  issueId: string,
  files: string[],
  fileContents: Record<string, string>
): Promise<CommitResult> {
  if (files.length === 0) return { success: true };

  const branchName = await getBranchName(issueId);
  const defaultBranch = getDefaultBranch();
  let issue;
  try {
    issue = await getIssueDetails(issueId);
  } catch {}

  const identifier = issue?.identifier || issueId.slice(0, 8);
  const title = issue?.title || 'Code changes';
  const opts = { cwd: WORKSPACE, stdio: 'pipe' as const, timeout: 30000 };

  try {
    try {
      execSync('git checkout -- .', opts);
    } catch {}

    try {
      execSync(`git checkout -b ${branchName} ${defaultBranch}`, opts);
    } catch {
      execSync(`git checkout ${branchName}`, opts);
    }

    for (const f of files) {
      const fullPath = path.join(WORKSPACE, f);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, fileContents[f]);
    }

    for (const f of files) {
      execSync(`git add "${f}"`, opts);
    }

    const pass = issueBuilderPasses[issueId] || 1;
    const commitMsg = `${identifier}: ${title} (pass ${pass})`;
    try {
      execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, opts);
      console.log(`[git] Committed: ${commitMsg}`);
    } catch (commitErr: any) {
      const commitStdout = commitErr.stdout?.toString() || '';
      const commitStderr = commitErr.stderr?.toString() || '';
      const commitOutput = commitStdout + commitStderr;

      if (commitOutput.includes('nothing to commit') || commitOutput.includes('nothing added to commit')) {
        console.log('[git] No changes to commit (files unchanged)');
      } else {
        console.error('[git] Git commit FAILED:');
        console.error(`[git] ${commitOutput.slice(0, 500)}`);
        throw new Error(`Git commit failed: ${commitStderr || commitStdout || 'unknown error'}`);
      }
    }

    try {
      execSync(`git push -u origin ${branchName}`, { ...opts, timeout: 60000 });
      console.log(`[git] Pushed branch: ${branchName}`);
    } catch (err: any) {
      console.error('[git] Push failed (no remote?):', err.message);
      await postComment(
        issueId,
        null,
        `_Code committed to branch \`${branchName}\` (${files.length} files). Push failed: ${err.message}_`
      );
      execSync(`git checkout ${defaultBranch}`, opts);
      return { success: false, output: err.message };
    }

    await postComment(
      issueId,
      null,
      `_Code committed to branch \`${branchName}\` (pass ${pass})_\n\nFiles:\n${files.map((f) => '- `' + f + '`').join('\n')}`
    );

    execSync(`git checkout ${defaultBranch}`, opts);
    return { success: true };
  } catch (err: any) {
    console.error('[git] Git workflow error:', err.message);
    try {
      execSync(`git checkout ${defaultBranch}`, opts);
    } catch {}
    await postComment(issueId, null, `_Git workflow error: ${err.message}_`);
    return { success: false, output: err.message };
  }
}

export async function createPullRequest(issueId: string): Promise<void> {
  const branchName = await getBranchName(issueId);
  const defaultBranch = getDefaultBranch();
  let issue;
  try {
    issue = await getIssueDetails(issueId);
  } catch {}

  const identifier = issue?.identifier || issueId.slice(0, 8);
  const title = issue?.title || 'Code changes';
  const commitMsg = `${identifier}: ${title}`;
  const opts = { cwd: WORKSPACE, stdio: 'pipe' as const, timeout: 30000 };

  try {
    let existingPr = '';
    try {
      const prState = execSync(
        `"${GH_CLI}" pr view ${branchName} --json url,state --jq "select(.state==\\"OPEN\\") | .url"`,
        { ...opts, timeout: 30000 }
      )
        .toString()
        .trim();
      existingPr = prState;
    } catch {}

    if (existingPr) {
      console.log(`[git] PR already exists (open): ${existingPr}`);
      await postComment(issueId, null, `_PR already exists: ${existingPr}_`);
      return;
    }

    try {
      execSync(`git checkout ${branchName}`, opts);
    } catch {
      console.error(`[git] Could not checkout ${branchName} to add screenshots`);
    }

    const screenshotFiles: string[] = [];
    const screenshotDir = path.join(SCREENSHOT_BASE, issueId.slice(0, 8));
    const pngs = listPngFilesRecursive(screenshotDir);

    if (pngs.length > 0) {
      const prScreenshotDir = path.join(
        WORKSPACE,
        'docs',
        'screenshots',
        identifier.toLowerCase()
      );
      fs.mkdirSync(prScreenshotDir, { recursive: true });

      for (const pngPath of pngs) {
        const png = path.basename(pngPath);
        fs.copyFileSync(pngPath, path.join(prScreenshotDir, png));
        screenshotFiles.push(`docs/screenshots/${identifier.toLowerCase()}/${png}`);
      }

      for (const f of screenshotFiles) {
        execSync(`git add "${f}"`, opts);
      }
      try {
        execSync(`git commit -m "${identifier}: add Artist screenshots"`, opts);
        execSync(`git push origin ${branchName}`, { ...opts, timeout: 60000 });
        console.log(`[git] Committed ${screenshotFiles.length} screenshots to ${branchName}`);
      } catch (err: any) {
        console.log(`[git] Screenshot commit/push note: ${err.message}`);
      }
    }

    try {
      execSync(`git checkout ${defaultBranch}`, opts);
    } catch {}

    const GITHUB_REPO = 'jeremiahdingal/shop-diary-v3';
    let prBody = `Auto-generated from issue ${identifier}\n\n`;
    prBody += '## Changes\n(see commits on branch)\n\n';

    try {
      const diffStat = execSync(`git diff --stat ${defaultBranch}..${branchName}`, {
        ...opts,
        timeout: 30000,
      })
        .toString()
        .trim();

      if (diffStat) {
        prBody += `## Files Changed\n\n\`\`\`\n${diffStat}\n\`\`\`\n\n`;
        prBody += '**Warning:** Review the changes carefully before merging. Check that package.json files retain all necessary dependencies.\n\n';
      }
    } catch (e: any) {
      console.log(`[git] Could not generate diff summary: ${e.message}`);
    }

    if (screenshotFiles.length > 0) {
      prBody += '## Screenshots (Artist Feature Recording)\n\n';
      for (const f of screenshotFiles) {
        const routeName = path.basename(f, '.png');
        const rawUrl = `https://github.com/${GITHUB_REPO}/blob/${branchName}/${f}?raw=true`;
        prBody += `### \`${routeName}\`\n![${routeName}](${rawUrl})\n\n`;
      }
    }

    const prOutput = execSync(
      `"${GH_CLI}" pr create --head "${branchName}" --title "${commitMsg.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}"`,
      { ...opts, timeout: 60000 }
    )
      .toString()
      .trim();

    console.log(`[git] PR created: ${prOutput}`);
    await postComment(
      issueId,
      null,
      `_PR created (with ${screenshotFiles.length} screenshots): ${prOutput}_`
    );
  } catch (err: any) {
    console.error(`[git] PR creation failed:`, err.message);
    await postComment(
      issueId,
      null,
      `_Branch \`${branchName}\` pushed. PR creation failed: ${err.message}_`
    );
    try {
      execSync(`git checkout ${defaultBranch}`, { cwd: WORKSPACE, stdio: 'pipe' });
    } catch {}
    throw err;
  }
}

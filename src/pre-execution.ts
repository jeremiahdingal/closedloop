import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace, getPaperclipApiUrl, getCompanyId } from './config';
import { getIssueDetails } from './paperclip-api';
import { detectDriftIssues, formatDriftReport } from './drift-detector';

const WORKSPACE = getWorkspace();
const PAPERCLIP_API = getPaperclipApiUrl();
const COMPANY_ID = getCompanyId();
const CONTEXT_DIR = path.join(WORKSPACE, '.closedloop');
const CONTEXT_FILE = path.join(CONTEXT_DIR, 'context.json');

interface IssueContext {
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string;
    status: string;
  };
  existingFiles: string[];
  recentChanges: string[];
  architecture: string;
  constraints: string[];
}

export async function writeIssueContext(issueId: string): Promise<void> {
  // Ensure .closedloop directory exists
  if (!fs.existsSync(CONTEXT_DIR)) {
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  }

  // Get issue details
  let issueDetails: any = null;
  try {
    issueDetails = await getIssueDetails(issueId);
  } catch (err) {
    console.log(`[pre-execution] Could not get issue details for ${issueId}: ${err}`);
  }

  // Get existing source files
  const existingFiles = getSourceFiles();

  // Get recent git changes
  const recentChanges = getRecentChanges();

  // Build context
  const context: IssueContext = {
    issue: {
      id: issueId,
      identifier: issueDetails?.identifier || issueId,
      title: issueDetails?.title || 'Unknown',
      description: issueDetails?.description || '',
      status: issueDetails?.status || 'unknown',
    },
    existingFiles: existingFiles.slice(0, 50), // Limit to 50 files
    recentChanges,
    architecture: 'React + Tamagui + Expo',
    constraints: [
      'Use existing auth patterns',
      'No external APIs without config',
      'Follow project naming conventions',
      'AVOID duplicate files - check existing files before creating new ones',
    ],
  };

  // Write context file
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(context, null, 2));
  console.log(`[pre-execution] Wrote context file for ${issueId} (${existingFiles.length} source files)`);
  
  // Detect and write drift issues
  const driftIssues = await detectDriftIssues();
  if (driftIssues.length > 0) {
    const driftFile = path.join(CONTEXT_DIR, 'drift.md');
    fs.writeFileSync(driftFile, formatDriftReport(driftIssues));
    console.log(`[pre-execution] Wrote drift report: ${driftIssues.length} issues`);
  }
}

function getSourceFiles(): string[] {
  const sourcePatterns = ['src/**/*.ts', 'src/**/*.tsx', 'app/**/*.ts', 'app/**/*.tsx'];
  const files: string[] = [];

  for (const pattern of sourcePatterns) {
    try {
      const result = require('child_process').execSync(
        `ls -la "${WORKSPACE}/${pattern}" 2>/dev/null || dir /b /s "${WORKSPACE}\\${pattern.replace(/\//g, '\\')}" 2>nul`,
        { encoding: 'utf8', timeout: 5000 }
      );
      const lines = result.split('\n').filter(Boolean);
      for (const line of lines) {
        const match = line.match(/[\\/](src|app)[\\/][^\\/\n]+$/);
        if (match) {
          const filePath = line.trim();
          if (filePath && !filePath.includes('node_modules')) {
            files.push(filePath);
          }
        }
      }
    } catch {
      // Pattern not found, skip
    }
  }

  return [...new Set(files)];
}

function getRecentChanges(): string[] {
  try {
    const result = require('child_process').execSync(
      'git log --oneline -10',
      { cwd: WORKSPACE, encoding: 'utf8', timeout: 5000 }
    );
    return result.split('\n').filter(Boolean).slice(0, 10);
  } catch {
    return [];
  }
}

export function getContextFilePath(): string {
  return CONTEXT_FILE;
}

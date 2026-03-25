/**
 * Reflection Memory
 * 
 * Stores lessons learned from code reviews and rejections.
 * When the Builder works on files that have associated reflections,
 * the past feedback is injected into the prompt to prevent repeating mistakes.
 * 
 * Reflections are stored in `.reflections/{component}.md` files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace } from './config';
import { getIssueComments } from './paperclip-api';

const WORKSPACE = getWorkspace();
const REFLECTIONS_DIR = '.reflections';

export interface Reflection {
  filePath: string;
  createdAt: number;
  issueId: string;
  feedback: string;
  lesson: string;
}

/**
 * Get the reflections directory path
 */
function getReflectionsDir(): string {
  return path.join(WORKSPACE, REFLECTIONS_DIR);
}

/**
 * Save a reflection for a file or component
 */
export async function saveReflection(
  filePath: string,
  feedback: string,
  issueId: string
): Promise<void> {
  // Normalize file path to a safe filename
  const safeName = filePath
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_');
  
  const reflectionPath = path.join(getReflectionsDir(), `${safeName}.md`);
  
  // Ensure directory exists
  fs.mkdirSync(getReflectionsDir(), { recursive: true });
  
  // Extract lesson from feedback (first paragraph or first 200 chars)
  const lesson = extractLesson(feedback);
  
  const reflection: Reflection = {
    filePath,
    createdAt: Date.now(),
    issueId,
    feedback,
    lesson,
  };
  
  // Append to existing file or create new
  let existingContent = '';
  if (fs.existsSync(reflectionPath)) {
    existingContent = fs.readFileSync(reflectionPath, 'utf8');
  }
  
  const timestamp = new Date(reflection.createdAt).toISOString();
  const newEntry = `
---
Date: ${timestamp}
Issue: ${issueId}
File: ${filePath}

## Feedback
${feedback}

## Lesson Learned
${lesson}
---

`;
  
  fs.writeFileSync(reflectionPath, existingContent + newEntry, 'utf8');
  
  console.log(`[reflection] Saved reflection for ${filePath} (issue ${issueId.slice(0, 8)})`);
}

/**
 * Load reflections for files that will be modified
 */
export async function loadRelevantReflections(filesToModify: string[]): Promise<Reflection[]> {
  const reflections: Reflection[] = [];
  const reflectionsDir = getReflectionsDir();
  
  if (!fs.existsSync(reflectionsDir)) {
    return reflections;
  }
  
  // Read all reflection files
  const files = fs.readdirSync(reflectionsDir);
  
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    
    const reflectionPath = path.join(reflectionsDir, file);
    const content = fs.readFileSync(reflectionPath, 'utf8');
    
    // Parse markdown entries
    const entries = parseReflections(content);
    
    // Check if any entry is relevant to files we'll modify
    for (const entry of entries) {
      if (isRelevantToFile(entry.filePath, filesToModify)) {
        reflections.push(entry);
      }
    }
  }
  
  // Sort by date (most recent first)
  reflections.sort((a, b) => b.createdAt - a.createdAt);
  
  return reflections;
}

/**
 * Build reflection context for Local Builder prompt
 */
export async function buildReflectionsContext(
  issueId: string,
  filesToModify: string[]
): Promise<string> {
  const reflections = await loadRelevantReflections(filesToModify);
  
  if (reflections.length === 0) {
    return '';
  }
  
  let context = '\n\n== 📚 PAST LESSONS FOR THESE FILES ==\n';
  context += `The following files have reflection notes from previous code reviews.\n`;
  context += 'Review these lessons to avoid repeating past mistakes.\n\n';
  
  for (const reflection of reflections.slice(0, 5)) { // Limit to 5 most recent
    context += `--- ${reflection.filePath} ---\n`;
    context += `From issue ${reflection.issueId}:\n`;
    context += `**Lesson:** ${reflection.lesson}\n\n`;
  }
  
  context += '**IMPORTANT:** Apply these lessons to your current implementation.\n';
  
  return context;
}

/**
 * Extract reviewer feedback from comments and save reflections
 */
export async function extractAndSaveReflections(
  issueId: string,
  filesChanged: string[]
): Promise<void> {
  const comments = await getIssueComments(issueId);
  
  // Look for reviewer comments that indicate rejection
  const rejectionKeywords = [
    'rejected',
    'not approved',
    'needs fixes',
    'please fix',
    'this is wrong',
    'incorrect',
    'build failed',
    'error:',
  ];
  
  for (const comment of comments) {
    const body = comment.body.toLowerCase();
    
    // Check if this is a rejection comment
    const isRejection = rejectionKeywords.some(keyword => body.includes(keyword));
    
    if (!isRejection) continue;
    
    // Extract feedback for each file
    for (const file of filesChanged) {
      // Look for file-specific feedback
      const fileFeedback = extractFileFeedback(comment.body, file);
      
      if (fileFeedback) {
        await saveReflection(file, fileFeedback, issueId);
      }
    }
  }
}

/**
 * Parse reflection entries from markdown content
 */
function parseReflections(content: string): Reflection[] {
  const reflections: Reflection[] = [];
  
  // Split by --- separators
  const entries = content.split(/---\s*\n/).filter(Boolean);
  
  for (const entry of entries) {
    const dateMatch = entry.match(/Date:\s*(.+)/);
    const issueMatch = entry.match(/Issue:\s*(.+)/);
    const fileMatch = entry.match(/File:\s*(.+)/);
    const feedbackMatch = entry.match(/## Feedback\s*\n([\s\S]*?)(?=## |$)/);
    const lessonMatch = entry.match(/## Lesson Learned\s*\n([\s\S]*?)(?=---|$)/);
    
    if (fileMatch && lessonMatch) {
      reflections.push({
        filePath: fileMatch[1].trim(),
        createdAt: dateMatch ? new Date(dateMatch[1].trim()).getTime() : Date.now(),
        issueId: issueMatch ? issueMatch[1].trim() : 'unknown',
        feedback: feedbackMatch ? feedbackMatch[1].trim() : '',
        lesson: lessonMatch[1].trim(),
      });
    }
  }
  
  return reflections;
}

/**
 * Check if a reflection is relevant to files being modified
 */
function isRelevantToFile(reflectionFile: string, filesToModify: string[]): boolean {
  // Normalize paths for comparison
  const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  
  const reflectionFileNorm = normalize(reflectionFile);
  
  for (const file of filesToModify) {
    const fileNorm = normalize(file);
    
    // Exact match
    if (reflectionFileNorm === fileNorm) {
      return true;
    }
    
    // Same base file (e.g., Button.tsx matches Button.tsx)
    const reflectionBase = path.basename(reflectionFileNorm);
    const fileBase = path.basename(fileNorm);
    if (reflectionBase === fileBase) {
      return true;
    }
    
    // Same directory (e.g., components/Button.tsx matches components/)
    const reflectionDir = path.dirname(reflectionFileNorm);
    const fileDir = path.dirname(fileNorm);
    if (reflectionDir === fileDir || reflectionDir.startsWith(fileDir)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Extract feedback specific to a file from a comment
 */
function extractFileFeedback(comment: string, filePath: string): string | null {
  const fileName = path.basename(filePath);
  const lines = comment.split('\n');
  
  // Look for lines mentioning the file
  const relevantLines: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(fileName) || line.includes(filePath)) {
      // Include this line and next 2 lines for context
      relevantLines.push(line);
      if (i + 1 < lines.length) relevantLines.push(lines[i + 1]);
      if (i + 2 < lines.length) relevantLines.push(lines[i + 2]);
    }
  }
  
  if (relevantLines.length === 0) {
    // If no file-specific feedback, check if comment is general feedback
    if (comment.toLowerCase().includes('build') || comment.toLowerCase().includes('error')) {
      return comment.trim();
    }
    return null;
  }
  
  return relevantLines.join('\n').trim();
}

/**
 * Extract the key lesson from feedback (first meaningful sentence)
 */
function extractLesson(feedback: string): string {
  // Split into sentences
  const sentences = feedback.split(/[.!?]+/).filter(s => s.trim().length > 0);
  
  if (sentences.length === 0) {
    return feedback.slice(0, 200);
  }
  
  // Find the first sentence that contains actionable advice
  const actionWords = ['should', 'must', 'need', 'use', 'avoid', 'do not', "don't", 'always', 'never'];
  
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    for (const word of actionWords) {
      if (lower.includes(word)) {
        return sentence.trim() + '.';
      }
    }
  }
  
  // Fallback: return first sentence
  return sentences[0].trim() + '.';
}

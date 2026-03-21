/**
 * RAG Indexer for Paperclip
 * Simple file-based RAG using Ollama embeddings (no external server needed)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace } from './config';
import { RAGSearchResult } from './types';

const WORKSPACE = getWorkspace();
const INDEX_PATH = path.join(__dirname, '..', '.paperclip', 'rag-index.json');

interface RAGDocument {
  id: string;
  path: string;
  purpose: string;
  exports: string[];
  content: string;
  embedding?: number[];
}

interface RAGIndex {
  documents: RAGDocument[];
  lastUpdated: string;
}

export class RAGIndexer {
  private index: RAGIndex = { documents: [], lastUpdated: new Date().toISOString() };
  private initialized = false;

  /**
   * Initialize the RAG indexer using file-based storage
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Ensure index directory exists
      const indexDir = path.dirname(INDEX_PATH);
      if (!fs.existsSync(indexDir)) {
        fs.mkdirSync(indexDir, { recursive: true });
      }

      // Load existing index if available
      if (fs.existsSync(INDEX_PATH)) {
        this.index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
        console.log(`[RAG] Loaded existing index with ${this.index.documents.length} documents`);
      } else {
        console.log('[RAG] Creating new index');
      }

      this.initialized = true;
    } catch (err: any) {
      console.log(`[RAG] Initialization error: ${err.message}`);
    }
  }

  /**
   * Build the index from the codebase
   */
  async buildIndex(): Promise<void> {
    console.log('[RAG] Building index...');

    // Get all TypeScript files
    const files = this.getAllFiles(WORKSPACE, '.ts', '.tsx');
    const documents: RAGDocument[] = [];

    for (const file of files) {
      const relativePath = path.relative(WORKSPACE, file);

      // Skip test files, node_modules, dist
      if (
        relativePath.includes('node_modules') ||
        relativePath.includes('.test.') ||
        relativePath.includes('dist/') ||
        relativePath.includes('node_modules')
      ) {
        continue;
      }

      try {
        const content = fs.readFileSync(file, 'utf8');
        const exports = this.extractExports(content);
        const purpose = this.extractPurpose(content);

        documents.push({
          id: relativePath.replace(/[\/\\]/g, '-'),
          path: relativePath,
          purpose,
          exports,
          content: content.substring(0, 3000), // Truncate for storage
        });
      } catch (err: any) {
        console.log(`[RAG] Error reading ${relativePath}: ${err.message}`);
      }
    }

    this.index = {
      documents,
      lastUpdated: new Date().toISOString(),
    };

    // Save index to file
    fs.writeFileSync(INDEX_PATH, JSON.stringify(this.index, null, 2));
    console.log(`[RAG] Indexed ${documents.length} files`);
    console.log(`[RAG] Index saved to ${INDEX_PATH}`);
  }

  /**
   * Search for relevant files using keyword matching
   */
  async search(
    query: string,
    options: { limit?: number; includeExports?: boolean } = {}
  ): Promise<RAGSearchResult[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const { limit = 10 } = options;
    const queryLower = query.toLowerCase();
    const queryKeywords = queryLower.split(/\W+/).filter(w => w.length > 2);

    // Score documents by keyword matches
    const scored = this.index.documents.map(doc => {
      const searchText = `${doc.path} ${doc.purpose} ${doc.exports.join(' ')} ${doc.content}`.toLowerCase();
      let score = 0;

      for (const keyword of queryKeywords) {
        const matches = searchText.split(keyword).length - 1;
        score += matches * keyword.length;
      }

      return { doc, score };
    });

    // Sort by score and return top results
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(({ doc }) => ({
      document: `File: ${doc.path}\nPurpose: ${doc.purpose}\nExports: ${doc.exports.join(', ')}`,
      metadata: {
        path: doc.path,
        exports: JSON.stringify(doc.exports),
        purpose: doc.purpose,
        type: doc.path.endsWith('.tsx') ? 'component' as const : 'module' as const,
      },
    }));
  }

  /**
   * Get all files with given extensions
   */
  getAllFiles(dir: string, ...extensions: string[]): string[] {
    const files: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist') {
          files.push(...this.getAllFiles(fullPath, ...extensions));
        }
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        files.push(fullPath);
      }
    }

    return files;
  }

  /**
   * Extract exports from file content
   */
  extractExports(content: string): string[] {
    const exports: string[] = [];

    // Match: export const/function/class
    const exportMatches = content.matchAll(
      /export\s+(?:const|function|class|interface|type|enum)\s+(\w+)/g
    );
    for (const match of exportMatches) {
      exports.push(match[1]);
    }

    // Match: export default
    if (content.includes('export default')) {
      exports.push('default');
    }

    return exports;
  }

  /**
   * Extract purpose from first comment block
   */
  extractPurpose(content: string): string {
    // Extract first comment block
    const commentMatch = content.match(/\/\*\*([\s\S]*?)\*\//);
    if (commentMatch) {
      return commentMatch[1].replace(/\*\s?/g, '').trim();
    }

    // Or single-line comment at top
    const lineComment = content.match(/^\/\/\s*(.+)$/m);
    if (lineComment) {
      return lineComment[1].trim();
    }

    return 'No description available';
  }
}

// CLI usage
if (require.main === module) {
  (async () => {
    const indexer = new RAGIndexer();
    await indexer.initialize();
    await indexer.buildIndex();
  })();
}

export const ragIndexer = new RAGIndexer();

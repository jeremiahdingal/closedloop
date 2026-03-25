/**
 * RAG Indexer for Paperclip
 * Simple file-based RAG using Ollama embeddings (no external server needed)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace } from './config';
import { RAGSearchResult } from './types';
import { extractASTMetadata, formatASTSummary, type ASTMetadata } from './ast-indexer';

const WORKSPACE = getWorkspace();
const INDEX_PATH = path.join(__dirname, '..', '.paperclip', 'rag-index.json');

interface RAGDocument {
  id: string;
  path: string;
  purpose: string;
  exports: string[];
  content: string;
  /** AST-extracted structural metadata (function sigs, interfaces, enums) */
  astSummary?: string;
  /** Compact AST search text for keyword matching */
  astSearchText?: string;
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

        // AST-based structural extraction
        const astMeta = extractASTMetadata(content);
        const astSummary = formatASTSummary(astMeta);

        documents.push({
          id: relativePath.replace(/[\/\\]/g, '-'),
          path: relativePath,
          purpose,
          exports,
          content: content.substring(0, 3000), // Truncate for storage
          astSummary: astSummary || undefined,
          astSearchText: astMeta.searchText || undefined,
        });
      } catch (err: any) {
        console.log(`[RAG] Error reading ${relativePath}: ${err.message}`);
      }
    }

    // Add COMMON_PATTERNS.md as a special document (high priority for Builder)
    const patternsPath = path.join(WORKSPACE, 'COMMON_PATTERNS.md');
    if (fs.existsSync(patternsPath)) {
      const patternsContent = fs.readFileSync(patternsPath, 'utf8');
      documents.push({
        id: 'COMMON_PATTERNS',
        path: 'COMMON_PATTERNS.md',
        purpose: 'Common patterns, gotchas, and build error fixes — CRITICAL reference for Local Builder',
        exports: ['import patterns', 'file structure', 'build errors', 'React Native patterns', 'API patterns'],
        content: patternsContent.substring(0, 8000), // Full content for RAG
        astSummary: undefined,
        astSearchText: 'common patterns import paths build errors react native typescript',
      });
      console.log('[RAG] Added COMMON_PATTERNS.md to index');
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

    // Score documents by keyword matches (includes AST search text for structural queries)
    const scored = this.index.documents.map(doc => {
      const searchText = `${doc.path} ${doc.purpose} ${doc.exports.join(' ')} ${doc.astSearchText || ''} ${doc.content}`.toLowerCase();
      let score = 0;

      for (const keyword of queryKeywords) {
        const matches = searchText.split(keyword).length - 1;
        score += matches * keyword.length;
      }

      // Boost score for AST matches (structural queries are higher signal)
      if (doc.astSearchText) {
        const astText = doc.astSearchText.toLowerCase();
        for (const keyword of queryKeywords) {
          if (astText.includes(keyword)) {
            score += keyword.length * 2; // 2x boost for AST matches
          }
        }
      }

      // MASSIVE BOOST for COMMON_PATTERNS on error-related queries
      if (doc.path === 'COMMON_PATTERNS.md') {
        const errorKeywords = ['import', 'error', 'build', 'fail', 'module', 'not found', 'ts2307', 'ts2305', 'wrong', 'correct', 'pattern'];
        for (const keyword of queryKeywords) {
          if (errorKeywords.some(e => keyword.includes(e) || e.includes(keyword))) {
            score += 100; // Ensure COMMON_PATTERNS appears first for error queries
          }
        }
      }

      return { doc, score };
    });

    // Sort by score and return top results
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(({ doc }) => ({
      document: `File: ${doc.path}\nPurpose: ${doc.purpose}\nExports: ${doc.exports.join(', ')}${doc.astSummary ? '\n' + doc.astSummary : ''}`,
      metadata: {
        path: doc.path,
        exports: JSON.stringify(doc.exports),
        purpose: doc.purpose,
        type: doc.path.endsWith('.tsx') ? 'component' as const : 'module' as const,
      },
    }));
  }

  /**
   * Find the best matching service domain and return all its files with full contents.
   * e.g., query "cash-shifts" might match "orders" domain as pattern exemplar.
   */
  findDomainExemplar(
    targetDomain: string,
    options: { maxContentPerFile?: number } = {}
  ): { domain: string; files: Array<{ path: string; content: string }> } | null {
    if (!this.initialized || this.index.documents.length === 0) return null;

    const maxContent = options.maxContentPerFile || 3000;
    const targetLower = targetDomain.toLowerCase();

    // Extract all unique service domains from api/src/services/*/
    const domainFiles = new Map<string, RAGDocument[]>();
    for (const doc of this.index.documents) {
      const match = doc.path.match(/api[\/\\]src[\/\\]services[\/\\]([^\/\\]+)[\/\\]/);
      if (match) {
        const domain = match[1];
        // Skip the target domain itself — we want a DIFFERENT domain as exemplar
        if (domain.toLowerCase() === targetLower) continue;
        if (!domainFiles.has(domain)) domainFiles.set(domain, []);
        domainFiles.get(domain)!.push(doc);
      }
    }

    if (domainFiles.size === 0) return null;

    // Score each domain by how many file types it has (routes, service, schema, migration)
    // Prefer complete domains with all 4 file types
    let bestDomain = '';
    let bestScore = 0;
    for (const [domain, files] of domainFiles) {
      let score = files.length;
      const fileTypes = files.map(f => path.basename(f.path).toLowerCase());
      if (fileTypes.some(f => f.includes('routes'))) score += 3;
      if (fileTypes.some(f => f.includes('service'))) score += 3;
      if (fileTypes.some(f => f.includes('schema'))) score += 3;
      if (fileTypes.some(f => f.includes('migration'))) score += 2;
      if (score > bestScore) {
        bestScore = score;
        bestDomain = domain;
      }
    }

    if (!bestDomain) return null;

    const exemplarFiles = domainFiles.get(bestDomain)!.map(doc => ({
      path: doc.path,
      content: doc.content.substring(0, maxContent),
    }));

    return { domain: bestDomain, files: exemplarFiles };
  }

  /**
   * Get a document by its file path (for direct content retrieval)
   */
  getByPath(filePath: string): RAGDocument | undefined {
    const normalized = filePath.replace(/\\/g, '/');
    return this.index.documents.find(
      doc => doc.path.replace(/\\/g, '/') === normalized
    );
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

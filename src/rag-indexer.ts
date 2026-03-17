/**
 * RAG Indexer for Paperclip
 * Builds and maintains vector index of codebase using ChromaDB
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspace } from './config';
import { RAGSearchResult } from './types';

const WORKSPACE = getWorkspace();
const INDEX_PATH = path.join(__dirname, '..', '.paperclip', 'rag-index');

interface RAGDocument {
  id: string;
  document: string;
  metadata: {
    path: string;
    exports: string;
    purpose: string;
    type: 'component' | 'module';
  };
}

export class RAGIndexer {
  private collection: any = null;
  private initialized = false;

  /**
   * Initialize the RAG indexer and ChromaDB connection
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const { ChromaClient } = await import('chromadb');
      const client = new ChromaClient({ path: 'http://localhost:8000' });

      // Create or get collection
      try {
        this.collection = await client.getOrCreateCollection({ name: 'shop-diary-codebase' });
        console.log('[RAG] Connected to existing index');
      } catch {
        this.collection = await client.createCollection({ name: 'shop-diary-codebase' });
        console.log('[RAG] Created new index');
      }

      this.initialized = true;
    } catch (err: any) {
      console.log(`[RAG] Initialization error (will retry on demand): ${err.message}`);
    }
  }

  /**
   * Build the index from the codebase
   */
  async buildIndex(): Promise<void> {
    console.log('[RAG] Building index...');

    if (!this.collection) {
      await this.initialize();
      if (!this.collection) {
        console.log('[RAG] Could not initialize ChromaDB, skipping index build');
        return;
      }
    }

    // Get all TypeScript files
    const files = this.getAllFiles(WORKSPACE, '.ts', '.tsx');

    // Extract metadata for each file
    const documents: RAGDocument[] = [];

    for (const file of files) {
      const relativePath = path.relative(WORKSPACE, file);
      const content = fs.readFileSync(file, 'utf8');

      // Skip test files, node_modules, dist
      if (
        relativePath.includes('node_modules') ||
        relativePath.includes('.test.') ||
        relativePath.includes('dist/')
      ) {
        continue;
      }

      // Extract exports
      const exports = this.extractExports(content);

      // Extract purpose summary (first comment block)
      const purpose = this.extractPurpose(content);

      // Build document for embedding
      const doc = `File: ${relativePath}
Purpose: ${purpose}
Exports: ${exports.join(', ')}
Content: ${content.substring(0, 2000)}`; // Truncate for context window

      documents.push({
        id: relativePath.replace(/[\/\\]/g, '-'),
        document: doc,
        metadata: {
          path: relativePath,
          exports: JSON.stringify(exports),
          purpose,
          type: relativePath.endsWith('.tsx') ? 'component' : 'module',
        },
      });
    }

    // Add to ChromaDB in batches
    const batchSize = 100;
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      await this.collection.add({
        ids: batch.map((d) => d.id),
        documents: batch.map((d) => d.document),
        metadatas: batch.map((d) => d.metadata),
      });
      console.log(`[RAG] Indexed ${Math.min(i + batchSize, documents.length)}/${documents.length} files`);
    }

    console.log(`[RAG] Indexed ${documents.length} files total`);
  }

  /**
   * Search for relevant files
   */
  async search(
    query: string,
    options: { limit?: number; includeExports?: boolean; includePatterns?: boolean } = {}
  ): Promise<RAGSearchResult[]> {
    if (!this.collection) {
      await this.initialize();
      if (!this.collection) {
        console.log('[RAG] Cannot search - index not available');
        return [];
      }
    }

    const { limit = 10 } = options;

    try {
      const results = await this.collection.query({
        queryTexts: [query],
        nResults: limit,
        include: ['documents', 'metadatas'],
      });

      return results.documents[0].map((doc: string, i: number) => ({
        document: doc,
        metadata: results.metadatas[0][i],
        distance: results.distances?.[0]?.[i],
      }));
    } catch (err: any) {
      console.log(`[RAG] Search error: ${err.message}`);
      return [];
    }
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
      /export\s+(?:const|function|class|interface|type)\s+(\w+)/g
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

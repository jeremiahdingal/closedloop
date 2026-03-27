/**
 * Configuration loading and management
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProjectConfig } from './types';

const CONFIG_PATH = path.join(__dirname, '..', '.paperclip', 'project.json');
const ENV_PATH = path.join(__dirname, '..', '.env');

// Load .env file if it exists
if (fs.existsSync(ENV_PATH)) {
  const envContent = fs.readFileSync(ENV_PATH, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      const value = valueParts.join('=').trim();
      if (key.trim() && !key.trim().startsWith('#')) {
        process.env[key.trim()] = value;
      }
    }
  });
  console.log('[config] Loaded .env file');
}

let cachedConfig: ProjectConfig | null = null;

export function loadConfig(): ProjectConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    const configData = fs.readFileSync(CONFIG_PATH, 'utf8');
    cachedConfig = JSON.parse(configData);
    console.log(`[config] Loaded project config: ${cachedConfig!.project.name}`);
    return cachedConfig!;
  } catch (err) {
    console.log(`[config] No project config found, using hardcoded values`);
    cachedConfig = createDefaultConfig();
    return cachedConfig;
  }
}

function createDefaultConfig(): ProjectConfig {
  return {
    project: {
      name: 'Shop Diary V3',
      slug: 'shop-diary-v3',
      description: 'Cross-platform POS (point-of-sale) and shop management app',
      githubRepo: 'jeremiahdingal/shop-diary-v3',
      workspace: 'C:\\Users\\dinga\\Projects\\shop-diary-v3',
    },
    techStack: {
      monorepo: 'Turborepo + Yarn workspaces',
      web: 'Next.js 14 + React 18',
      mobile: 'React Native 0.76 + Expo 52',
      api: 'Cloudflare Workers + itty-router + Kysely + D1',
      state: 'Zustand + TanStack React Query',
      forms: 'React Hook Form + Zod',
      styling: 'Tamagui - NO Tailwind, NO CSS modules, NO StyleSheet.create',
      theme: 'Custom theme using @radix-ui/colors (28 built-in themes)',
      icons: 'lucide-react-native',
      testing: 'Vitest (API), Jest (apps)',
      language: 'TypeScript strict mode - ALL files .ts/.tsx',
    },
    structure: {
      monorepo: 'Turborepo + Yarn workspaces',
      apps: {
        'dashboard-web': 'Next.js web dashboard',
        'cashier-web': 'Next.js web cashier',
        'dashboard-mobile': 'Expo mobile dashboard',
        'cashier-mobile': 'Expo mobile cashier',
      },
      packages: {
        app: 'Shared screens, hooks, stores, types',
        ui: 'Shared UI components and theme',
      },
      api: 'api/src/services - Cloudflare Workers',
      screens: 'packages/app/{feature}/screen.tsx',
      hooks: 'packages/app/apiHooks/',
      stores: 'packages/app/store/',
      components: 'packages/ui/src/',
    },
    packages: {
      scope: '@shop-diary',
      names: ['app', 'ui'],
    },
    imports: {
      ui: '@shop-diary/ui',
      app: '@shop-diary/app',
    },
    commands: {
      build: 'yarn build',
      'build:web': 'yarn build --filter=*-web',
      'build:mobile': 'yarn build --filter=*-mobile',
      test: 'yarn test',
      'test:api': 'cd api && npx vitest run',
      dev: 'yarn dev',
      'dev:web': 'yarn dev:web',
      'dev:mobile': 'yarn dev:mobile',
      'dev:api': 'cd api && npx wrangler dev',
    },
    patterns: {
      screens: 'packages/app/{feature}/screen.tsx - shared cross-platform',
      pages: 'apps/*/pages/ - thin wrappers importing screens',
      hooks: 'packages/app/apiHooks/ - TanStack Query hooks',
      apiRoutes: 'api/src/services/{domain}/{domain}.routes.ts - itty-router',
      validation: 'api/src/services/{domain}/{domain}.schema.ts - Zod',
      components: 'React Native (View, Text, Pressable) - NO HTML',
      styling: 'Tamagui primitives/tokens with the existing theme system',
    },
    paperclip: {
      companyId: 'ac5c469b-1f81-4f1f-9061-1dd9033ec831',
      agents: {
        'complexity router': '093ee390-cfbf-4129-81d6-aeeb638c7d71',
        strategist: 'a90b07a4-f18c-4509-9d7b-b9f16eb098d6',
        'tech lead': 'dad994d7-5d3e-4101-ae57-82c7be9b778b',
        'local builder': 'caf931bf-516a-409f-813e-a29e14decb10',
        'coder remote': '954ce225-6dc8-4df7-8917-b597afbae60b',
        reviewer: 'eace3a19-bded-4b90-827e-cfc00f3900bd',
        'diff guardian': '79641900-921d-400f-8eba-63373f5c0e17',
        'visual reviewer': '787cbd9e-d10b-4bca-b486-e7f5fd99d184',
        sentinel: 'c7fb4dae-8ac3-4795-b1f6-d14db2021035',
        deployer: '5e234916-47ef-41a2-8c07-e9376ee6aa9c',
        'scaffold architect': 'f5366415-528e-4323-a029-8867cd47ffca',
        'epic reviewer': '3fe38460-5697-4da1-acb6-22d027f75288',
        'epic decoder': 'a0e455a9-7e4b-4fcf-a7d7-cba5e1e97c9b',
      },
      agentKeys: {
        'a90b07a4-f18c-4509-9d7b-b9f16eb098d6': 'pcp_48d784f6edd3a907e7700cda9f93e36fc0d1030f4a6b6d04',
        'dad994d7-5d3e-4101-ae57-82c7be9b778b': 'pcp_ef721504b998e79742f272ad196be3952c28d5921dc4ba9a',
        'caf931bf-516a-409f-813e-a29e14decb10': 'pcp_0fbcdff3e8a50df48ab7c94cd3f4409cd492b6eb84c683d8',
        '954ce225-6dc8-4df7-8917-b597afbae60b': 'pcp_1f6cb1a1f3ed1fe95aa69f675c1c7f0663cc7a6f2f070c88',
        'eace3a19-bded-4b90-827e-cfc00f3900bd': 'pcp_650990c0932107838084b2adaf47fdbfb9407c649243211e',
        'c7fb4dae-8ac3-4795-b1f6-d14db2021035': 'pcp_268a568963f01698e27a232c9b911d96fa3504b214232b97',
        '5e234916-47ef-41a2-8c07-e9376ee6aa9c': 'pcp_ad33d0ec65c082f7b46feef3233872548ac64b606e0e7541',
        '787cbd9e-d10b-4bca-b486-e7f5fd99d184': 'pcp_6b6711a3a014c59c92416ec479077557a021087ba08bc280',
        '3fe38460-5697-4da1-acb6-22d027f75288': 'pcp_epic_reviewer_agent_key_placeholder',
        'a0e455a9-7e4b-4fcf-a7d7-cba5e1e97c9b': 'pcp_epic_decoder_agent_key_placeholder',
      },
      blockedAgents: [],
      apiUrl: 'http://127.0.0.1:3100',
    },
    ollama: {
      proxyPort: 3201,
      ollamaPort: 11434,
      models: {
        'complexity router': 'qwen3:4b',
        strategist: 'qwen3.5:9b',
        'tech lead': 'deepcoder:14b',
        'local builder': 'deepcoder:14b',
        'local builder burst': 'qwen3-coder:30b',
        reviewer: 'deepcoder:latest',
        'diff guardian': 'qwen3:4b',
        'visual reviewer': 'qwen3-vl:8b',
        sentinel: 'deepseek-r1:8b',
        deployer: 'qwen3:8b',
        'coder remote': 'glm-5',
      },
      timeouts: {
        'complexity router': 60,
        strategist: 900,
        'tech lead': 900,
        'local builder': 3600,
        'coder remote': 3600,
        reviewer: 900,
        'diff guardian': 60,
        'visual reviewer': 900,
        sentinel: 600,
        deployer: 600,
      },
    },
    artist: {
      devServerPort: 3000,
      viewport: { width: 1280, height: 800 },
      stepTimeoutMs: 15000,
      screenshotDir: '.screenshots',
    },
    delegationRules: {
      'complexity router': ['strategist', 'epic decoder'],
      strategist: ['tech lead', 'reviewer', 'sentinel', 'visual reviewer', 'epic decoder'],
      'epic decoder': ['tech lead'],
      'tech lead': ['local builder', 'coder remote'],
      reviewer: ['diff guardian'],
      'diff guardian': ['visual reviewer'],
      sentinel: ['deployer'],
    },
    remote: {
      appArchitect: {
        model: 'glm-5',
        apiBase: 'https://open.bigmodel.cn/api/paas/v4',
      },
      rescue: {
        model: 'glm-5',
        threshold: 3,
      },
    },
  };
}

export function getConfig(): ProjectConfig {
  return loadConfig();
}

export function getWorkspace(): string {
  return loadConfig().project.workspace;
}

export function getPaperclipApiUrl(): string {
  return loadConfig().paperclip.apiUrl;
}

export function getCompanyId(): string {
  return loadConfig().paperclip.companyId;
}

export function getAgents(): Record<string, string> {
  return loadConfig().paperclip.agents;
}

export function getAgentKeys(): Record<string, string> {
  return loadConfig().paperclip.agentKeys;
}

export function getBlockedAgents(): string[] {
  return loadConfig().paperclip.blockedAgents;
}

export function getDelegationRules(): Record<string, string[]> {
  return loadConfig().delegationRules;
}

export function getOllamaPorts(): { proxyPort: number; ollamaPort: number } {
  const config = loadConfig();
  return {
    proxyPort: config.ollama.proxyPort,
    ollamaPort: config.ollama.ollamaPort,
  };
}

export function getArtistConfig() {
  const config = loadConfig();
  return {
    devServerPort: config.artist.devServerPort,
    viewport: config.artist.viewport,
    stepTimeoutMs: config.artist.stepTimeoutMs,
    screenshotDir: config.artist.screenshotDir,
  };
}

export function getRemoteConfig() {
  return loadConfig().remote || null;
}

export function getAgentModel(agentName: string): string | undefined {
  return loadConfig().ollama.models[agentName];
}

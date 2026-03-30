export type AgentType = 'builder' | 'reviewer' | 'epicReviewer';

export interface RunResult {
  state: 'done' | 'in_review' | 'blocked' | 'todo' | 'approved' | 'rejected' | 'unknown';
  summary: string;
  files: string[];
  reason?: string;
  recommendation?: string;
  error?: string;
  usedFallback?: boolean;
}

const STATE_PATTERN = /\[STATE:\s*(done|in_review|blocked|todo)\]/i;
const SUMMARY_PATTERN = /\[SUMMARY:\s*(.+?)\]/i;
const FILES_PATTERN = /\[FILES:\s*(.+?)\]/i;
const REASON_PATTERN = /\[REASON:\s*(.+?)\]/i;
const RECOMMENDATION_PATTERN = /\[RECOMMENDATION:\s*(.+?)\]/i;
const ERROR_PATTERN = /(?:ERROR|FAILED|Exception|SyntaxError):/i;

export function parseRunOutput(output: string): RunResult {
  const stateMatch = output.match(STATE_PATTERN);
  
  if (!stateMatch) {
    return {
      state: 'unknown',
      summary: '',
      files: [],
      error: 'No [STATE:] block found in output',
    };
  }

  const state = stateMatch[1].toLowerCase() as RunResult['state'];

  const summaryMatch = output.match(SUMMARY_PATTERN);
  const filesMatch = output.match(FILES_PATTERN);
  const reasonMatch = output.match(REASON_PATTERN);
  const recommendationMatch = output.match(RECOMMENDATION_PATTERN);

  return {
    state,
    summary: summaryMatch?.[1]?.trim() || '',
    files: filesMatch?.[1]?.split(',').map(f => f.trim()).filter(Boolean) || [],
    reason: reasonMatch?.[1]?.trim(),
    recommendation: recommendationMatch?.[1]?.trim(),
  };
}

export async function applyFallbackWithLLM(result: RunResult, agentType: AgentType, output: string): Promise<RunResult> {
  if (result.state !== 'unknown') return result;
  
  console.log(`[output-parser] No [STATE:] block found, using LLM to classify output for ${agentType}`);
  
  const llmResult = await classifyOutputWithLLM(output, agentType);
  
  return {
    ...llmResult,
    usedFallback: true,
    reason: llmResult.reason || `LLM classified as ${llmResult.state}`,
  };
}

export function applyFallback(result: RunResult, agentType: AgentType): RunResult {
  if (result.state !== 'unknown') return result;
  
  // Fallback based on agent type
  if (agentType === 'builder') {
    // Builder without state → assume needs review (in_review)
    return {
      ...result,
      state: 'in_review',
      reason: 'No [STATE:] block in output - defaulting to in_review for safety',
      usedFallback: true,
    };
  } else if (agentType === 'reviewer' || agentType === 'epicReviewer') {
    // Reviewer without state → reject for safety (don't approve unknown)
    return {
      ...result,
      state: 'rejected',
      reason: 'No [STATE:] block in output - defaulting to rejected for safety',
      usedFallback: true,
    };
  }
  
  return result;
}

export function hasErrors(output: string): boolean {
  return ERROR_PATTERN.test(output);
}

export async function diagnoseStuckAgent(
  output: string,
  issueTitle: string,
  issueDescription: string,
  agentType: AgentType
): Promise<{
  diagnosis: string;
  recommendedAction: 'retry' | 'blocked' | 'todo' | 'escalate';
}> {
  const { callModelCLI } = await import('./remote-ai');
  
  const prompt = `You are an agent doctor. Diagnose why this agent is stuck and recommend an action.

Issue Title: ${issueTitle}
Issue Description: ${issueDescription?.slice(0, 500) || 'N/A'}

Agent Output (last 3000 chars):
---
${output.slice(-3000)}
---

Respond with EXACTLY this format:
- [DIAGNOSIS: <brief description of what's wrong>]
- [ACTION: retry|blocked|todo|escalate]

Where:
- retry: Agent made progress but needs another attempt
- blocked: Agent is blocked by external dependency (needs human help)
- todo: Agent can't complete this task (wrong agent, needs different one)
- escalate: Something is fundamentally broken (needs human investigation)`;

  try {
    const result = await callModelCLI(prompt, 'You are an agent doctor. Diagnose stuck agents and recommend actions.', 'qwen3:8b', 30000);
    
    const diagnosisMatch = result.match(/\[DIAGNOSIS:\s*(.+?)\]/i);
    const actionMatch = result.match(/\[ACTION:\s*(retry|blocked|todo|escalate)\]/i);
    
    return {
      diagnosis: diagnosisMatch?.[1]?.trim() || 'Unknown',
      recommendedAction: (actionMatch?.[1] as any) || 'escalate',
    };
  } catch (err) {
    console.log('[output-parser] LLM diagnosis failed, defaulting to retry');
    return {
      diagnosis: 'LLM diagnosis failed',
      recommendedAction: 'retry',
    };
  }
}

export async function classifyOutputWithLLM(output: string, agentType: AgentType): Promise<RunResult> {
  const { callModelCLI } = await import('./remote-ai');
  
  const builderPrompt = `Analyze the following builder agent output and determine the state. 
Output:
---
${output.slice(0, 3000)}
---

Respond with EXACTLY one of these formats:
- [STATE: done] - if the work appears complete and ready for review
- [STATE: in_review] - if the work is partially done and needs review
- [STATE: blocked] - if the agent is stuck or needs something to proceed
- [STATE: todo] - if the work was not completed

Also provide a brief summary: [SUMMARY: <1 sentence>]
And list any files mentioned: [FILES: file1.ts, file2.ts]`;

  const reviewerPrompt = `Analyze the following reviewer agent output and determine the decision.
Output:
---
${output.slice(0, 3000)}
---

Respond with EXACTLY one of these formats:
- [STATE: approved] - if the code looks good and can be merged
- [STATE: rejected] - if there are issues that need fixing

Also provide feedback: [FEEDBACK: <brief explanation>]
And list any files that need attention: [FILES: file1.ts, file2.ts]`;

  const prompt = agentType === 'builder' ? builderPrompt : reviewerPrompt;
  
  try {
    const classification = await callModelCLI(prompt, 'You are a state classifier. Respond only with the format specified.', 'qwen3:8b', 30000);
    return parseRunOutput(classification);
  } catch (err) {
    // If LLM call fails, fall back to default behavior
    console.log('[output-parser] LLM classification failed, using default fallback');
    return applyFallback({ state: 'unknown', summary: '', files: [], error: 'LLM classification failed' }, agentType);
  }
}

export function extractErrors(output: string): string[] {
  const lines = output.split('\n');
  return lines
    .filter(line => ERROR_PATTERN.test(line))
    .map(line => line.trim())
    .filter(Boolean);
}

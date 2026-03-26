/**
 * Cleanup script - Cancel all child tickets of a goal and reset decomposer cache
 */

const { execSync } = require('child_process');

const GOAL_ID = 'dc687190-a7f7-4f52-8cbf-b6959c67f232';
const PAPERCLIP_API = 'http://localhost:3100';
const COMPANY_ID = 'ac5c469b-1f81-4f1f-9061-1dd9033ec831';

async function cleanup() {
  console.log('Fetching all issues...');
  const res = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/issues`);
  const data = await res.json();
  const issues = data.issues || data.data || [];

  const children = issues.filter(i => i.goalId === GOAL_ID && i.identifier !== 'SHO-154');
  console.log(`Found ${children.length} child tickets to cancel`);

  for (const child of children) {
    console.log(`Cancelling ${child.identifier}...`);
    await fetch(`${PAPERCLIP_API}/api/issues/${child.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    });
  }

  console.log('Cleanup complete!');
  console.log('Now you can reassign SHO-154 to Complexity Router for fresh decomposition');
}

cleanup().catch(console.error);

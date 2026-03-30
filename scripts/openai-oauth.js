#!/usr/bin/env node
/**
 * OpenAI OAuth Login — device code flow (same as Codex CLI)
 * Authenticate with your ChatGPT Plus/Pro account to get an API access token.
 *
 * Usage: node scripts/openai-oauth.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ENV_PATH = path.join(__dirname, '..', '.env');

// OpenAI Codex CLI OAuth configuration (from github.com/openai/codex)
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEVICE_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const TOKEN_POLL_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const VERIFICATION_URL = 'https://auth.openai.com/codex/device';
const SCOPE = 'openid profile email offline_access';

// Open URL in browser
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      execSync(`start "" "${url}"`, { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    }
  } catch {}
}

// Save token to .env
function saveToken(accessToken) {
  let content = '';
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, 'utf8');
  }

  if (/^OPENAI_AUTH_TOKEN=/m.test(content)) {
    content = content.replace(/^OPENAI_AUTH_TOKEN=.*$/m, `OPENAI_AUTH_TOKEN=${accessToken}`);
  } else {
    const marker = '# OpenAI Codex adapter';
    if (content.includes(marker)) {
      content = content.replace(marker, `${marker}\nOPENAI_AUTH_TOKEN=${accessToken}`);
    } else {
      content += `\nOPENAI_AUTH_TOKEN=${accessToken}\n`;
    }
  }

  content = content.replace(/^REMOTE_LLM_PROVIDER=\w+/m, 'REMOTE_LLM_PROVIDER=openai');
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('\n  ========================================');
  console.log('    OpenAI OAuth Login (Device Flow)');
  console.log('  ========================================\n');

  // Step 1: Request device code
  console.log('  Requesting device code...');
  const dcRes = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: SCOPE,
    }),
  });

  if (!dcRes.ok) {
    const text = await dcRes.text();
    console.error(`\n  [ERROR] Device code request failed (${dcRes.status}):`);
    console.error(`  ${text.slice(0, 500)}`);
    process.exit(1);
  }

  const dcData = await dcRes.json();
  // OpenAI returns device_auth_id (not device_code) and user_code
  const deviceAuthId = dcData.device_auth_id || dcData.device_code;
  const userCode = dcData.user_code;
  const verificationUri = dcData.verification_uri || VERIFICATION_URL;
  const pollSeconds = dcData.interval || 5;
  const expiresIn = dcData.expires_in || 600;

  console.log('\n  ----------------------------------------');
  console.log(`  Your code:  ${userCode}`);
  console.log(`  Go to:      ${verificationUri}`);
  console.log('  ----------------------------------------\n');
  console.log('  Opening browser...');

  openBrowser(verificationUri);

  console.log('  Enter the code above, sign in, and authorize.\n');
  console.log('  Waiting for authorization...');

  // Step 2: Poll for token
  const pollInterval = Math.max(pollSeconds, 7) * 1000; // min 7s to avoid Cloudflare blocks
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const tokenRes = await fetch(TOKEN_POLL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_auth_id: deviceAuthId,
        user_code: userCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    let tokenData;
    try {
      tokenData = await tokenRes.json();
    } catch {
      // Non-JSON response (Cloudflare block, etc.) — retry
      process.stdout.write('x');
      continue;
    }

    // Step 2b: PKCE code exchange — OpenAI returns an authorization_code
    // that must be exchanged for an access_token using the code_verifier.
    if (tokenData.authorization_code) {
      console.log('\n  Device authorized! Exchanging code for access token...');

      const codeExchangeRes = await fetch('https://auth.openai.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          code: tokenData.authorization_code,
          code_verifier: tokenData.code_verifier,
          redirect_uri: 'https://auth.openai.com/codex/device/callback',
        }),
      });

      if (!codeExchangeRes.ok) {
        const errText = await codeExchangeRes.text();
        console.error(`\n  [ERROR] Code exchange failed (${codeExchangeRes.status}):`);
        console.error(`  ${errText.slice(0, 500)}`);
        process.exit(1);
      }

      const exchangeData = await codeExchangeRes.json();
      if (!exchangeData.access_token) {
        console.error('\n  [ERROR] No access_token in code exchange response:');
        console.error(`  ${JSON.stringify(exchangeData).slice(0, 500)}`);
        process.exit(1);
      }

      tokenData = exchangeData;
      // Fall through to the access_token handler below
    }

    if (tokenData.access_token) {
      console.log('\n  Authorization successful!');

      // Test the token
      console.log('  Testing token against OpenAI API...');
      try {
        const testRes = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
        });
        if (testRes.ok) {
          const models = await testRes.json();
          const relevant = (models.data || []).filter(m =>
            m.id.includes('codex') || m.id.includes('gpt-5') || m.id.includes('gpt-4')
          );
          console.log(`  Token valid! ${relevant.length} models accessible.`);
          if (relevant.length > 0) {
            console.log('  Sample models:');
            relevant.slice(0, 8).forEach(m => console.log(`    - ${m.id}`));
          }
        } else {
          const errText = await testRes.text();
          console.log(`  API test: ${testRes.status} — ${errText.slice(0, 200)}`);
          console.log('  Saving token anyway.');
        }
      } catch (err) {
        console.log(`  API test error: ${err.message}`);
        console.log('  Saving token anyway.');
      }

      saveToken(tokenData.access_token);
      console.log('\n  Saved OPENAI_AUTH_TOKEN to .env');
      console.log('  Set REMOTE_LLM_PROVIDER=openai');
      console.log('\n  [OK] Restart ClosedLoop to use OpenAI.\n');
      return;
    }

    // OpenAI uses nested error: { error: { code, message } }
    const errCode = tokenData.error?.code || tokenData.error;
    const errMsg = tokenData.error?.message || tokenData.error_description || '';

    if (errCode === 'authorization_pending' || errCode === 'deviceauth_authorization_unknown') {
      process.stdout.write('.');
      continue;
    }

    if (errCode === 'slow_down') {
      await sleep(5000);
      continue;
    }

    if (errCode === 'expired_token' || errCode === 'deviceauth_expired') {
      console.error('\n  [EXPIRED] Device code expired. Run again.');
      process.exit(1);
    }

    if (errCode === 'access_denied') {
      console.error('\n  [DENIED] Authorization was denied.');
      process.exit(1);
    }

    console.error(`\n  [ERROR] ${errCode}: ${errMsg || JSON.stringify(tokenData)}`);
    process.exit(1);
  }

  console.error('\n  [TIMEOUT] Polling expired.');
  process.exit(1);
}

main().catch(err => {
  console.error(`\n  [FATAL] ${err.message}`);
  process.exit(1);
});

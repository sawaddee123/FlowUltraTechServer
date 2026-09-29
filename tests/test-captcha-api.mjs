#!/usr/bin/env node

/**
 * Full Test Suite for Captcha API
 * Tests all captcha types and edge cases
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_URL = 'http://localhost:3006';
const CAPTCHA_URL = 'http://localhost:3005';
const TEST_IMAGES_DIR = path.join(__dirname, '../images/slide');
const TEST_IMAGE_PATH = path.join(TEST_IMAGES_DIR, 'img1747823620913_png.rf.3092601dcb6f3e0540eb1e817559f3fc.jpg');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

let testsPassed = 0;
let testsFailed = 0;

function log(msg, color = colors.reset) {
  console.log(`${color}${msg}${colors.reset}`);
}

async function test(name, fn) {
  try {
    log(`\n📋 ${name}`, colors.cyan);
    await fn();
    log(`✅ PASSED`, colors.green);
    testsPassed++;
  } catch (error) {
    log(`❌ FAILED: ${error.message}`, colors.red);
    testsFailed++;
  }
}

let accessToken = null;
let testImage = null;

async function main() {
  console.log('\n' + '='.repeat(60));
  log('🧪 Captcha API Test Suite', colors.cyan);
  console.log('='.repeat(60));

  // Setup: Login and load image
  try {
    log('\n🔧 Setup: Logging in...', colors.yellow);
    const response = await fetch(`${AUTH_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test', password: 'test' }),
    });
    const data = await response.json();
    accessToken = data.accessToken;
    log('✅ Login successful', colors.green);

    log('\n🔧 Setup: Loading test image...', colors.yellow);
    if (fs.existsSync(TEST_IMAGE_PATH)) {
      const buffer = fs.readFileSync(TEST_IMAGE_PATH);
      testImage = `data:image/png;base64,${buffer.toString('base64')}`;
      log('✅ Image loaded', colors.green);
    } else {
      log('⚠️  Test image not found, using mock data', colors.yellow);
      // Create a small 1x1 PNG
      const mockPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      testImage = `data:image/png;base64,${mockPng.toString('base64')}`;
    }
  } catch (error) {
    log(`❌ Setup failed: ${error.message}`, colors.red);
    process.exit(1);
  }

  // Test 1: Authentication
  await test('Test 1: Authentication required', async () => {
    const response = await fetch(`${CAPTCHA_URL}/captcha/slide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: testImage }),
    });
    if (response.ok) {
      throw new Error('Expected authentication error');
    }
  });

  // Test 2: Missing image
  await test('Test 2: Missing image validation', async () => {
    const response = await fetch(`${CAPTCHA_URL}/captcha/slide`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({}),
    });
    if (response.ok) {
      throw new Error('Expected validation error');
    }
  });

  // Test 3: Slide captcha
  await test('Test 3: Solve slide captcha', async () => {
    const response = await fetch(`${CAPTCHA_URL}/captcha/slide`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ image: testImage }),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Request failed: ${error}`);
    }
    const result = await response.json();
    if (!result.position || !Array.isArray(result.position)) {
      throw new Error('Invalid response format');
    }
    log(`   Position: [${result.position[0]}, ${result.position[1]}]`, colors.reset);
  });

  // Test 4: Symbol captcha
  await test('Test 4: Solve symbol captcha', async () => {
    const response = await fetch(`${CAPTCHA_URL}/captcha/symbol`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ image: testImage }),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Request failed: ${error}`);
    }
    const result = await response.json();
    if (!result.symbol_positions || !Array.isArray(result.symbol_positions)) {
      throw new Error('Invalid response format');
    }
    log(`   Positions: ${JSON.stringify(result.symbol_positions)}`, colors.reset);
  });

  // Test 6: Rate limiting (optional - commented out to avoid slowing down tests)
  // await test('Test 6: Rate limiting', async () => {
  //   const requests = [];
  //   for (let i = 0; i < 55; i++) {
  //     requests.push(
  //       fetch(`${CAPTCHA_URL}/captcha/slide`, {
  //         method: 'POST',
  //         headers: {
  //           'Content-Type': 'application/json',
  //           'Authorization': `Bearer ${accessToken}`,
  //         },
  //         body: JSON.stringify({ image: testImage }),
  //       })
  //     );
  //   }
  //   const responses = await Promise.all(requests);
  //   const rateLimited = responses.some(r => r.status === 429);
  //   if (!rateLimited) {
  //     throw new Error('Expected rate limit error');
  //   }
  // });

  // Summary
  console.log('\n' + '='.repeat(60));
  log(`📊 Test Results`, colors.cyan);
  console.log('='.repeat(60));
  log(`✅ Passed: ${testsPassed}`, colors.green);
  if (testsFailed > 0) {
    log(`❌ Failed: ${testsFailed}`, colors.red);
  }
  log(`📈 Total: ${testsPassed + testsFailed}`, colors.cyan);
  console.log('='.repeat(60) + '\n');

  if (testsFailed > 0) {
    process.exit(1);
  }
}

main();

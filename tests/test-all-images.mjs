#!/usr/bin/env node

/**
 * Batch Test Script
 * Tests all images in _archive/python/output_folder/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_URL = 'http://localhost:3006';
const CAPTCHA_URL = 'http://localhost:3005';
const IMAGES_DIR = path.join(__dirname, '../images/slide');
const DELAY_MS = 200; // Delay between requests to avoid rate limiting

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(msg, color = colors.reset) {
  console.log(`${color}${msg}${colors.reset}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function login() {
  const response = await fetch(`${AUTH_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test', password: 'test' }),
  });

  if (!response.ok) {
    throw new Error('Login failed');
  }

  const data = await response.json();
  return data.accessToken;
}

async function testImage(token, imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const base64 = buffer.toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;

  const response = await fetch(`${CAPTCHA_URL}/captcha/slide`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ image: dataUrl }),
  });

  return {
    ok: response.ok,
    status: response.status,
    result: response.ok ? await response.json() : null,
  };
}

async function main() {
  console.log('\n' + '='.repeat(60));
  log('🖼️  Batch Image Test', colors.cyan);
  console.log('='.repeat(60));

  // Check if images directory exists
  if (!fs.existsSync(IMAGES_DIR)) {
    log(`\n❌ Images directory not found: ${IMAGES_DIR}`, colors.red);
    log('\nCreate some test images first or use a different directory.', colors.yellow);
    process.exit(1);
  }

  // Get all image files
  const files = fs.readdirSync(IMAGES_DIR)
    .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
    .map(f => path.join(IMAGES_DIR, f));

  if (files.length === 0) {
    log(`\n❌ No image files found in ${IMAGES_DIR}`, colors.red);
    process.exit(1);
  }

  log(`\n📁 Found ${files.length} images`, colors.cyan);

  // Login
  log('\n🔐 Logging in...', colors.cyan);
  const token = await login();
  log('✅ Login successful', colors.green);

  // Test each image
  let success = 0;
  let failed = 0;

  log('\n🧪 Testing images...\n', colors.cyan);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filename = path.basename(file);
    
    process.stdout.write(`[${i + 1}/${files.length}] ${filename.padEnd(30)} ... `);

    try {
      const result = await testImage(token, file);
      
      if (result.ok) {
        log(`✅ [${result.result.position[0].toFixed(1)}, ${result.result.position[1].toFixed(1)}] (${result.result.time.toFixed(3)}s)`, colors.green);
        success++;
      } else {
        log(`❌ Status ${result.status}`, colors.red);
        failed++;
      }
    } catch (error) {
      log(`❌ ${error.message}`, colors.red);
      failed++;
    }

    // Delay to avoid rate limiting
    if (i < files.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  log('📊 Results', colors.cyan);
  console.log('='.repeat(60));
  log(`✅ Success: ${success}/${files.length} (${(success / files.length * 100).toFixed(1)}%)`, colors.green);
  if (failed > 0) {
    log(`❌ Failed: ${failed}/${files.length}`, colors.red);
  }
  console.log('='.repeat(60) + '\n');
}

main().catch(error => {
  log(`\n❌ Error: ${error.message}`, colors.red);
  process.exit(1);
});

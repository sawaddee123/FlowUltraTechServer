#!/usr/bin/env node

/**
 * Simple Test Script for Captcha Service
 * Tests basic functionality: login + load image + solve captcha
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
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(msg, color = colors.reset) {
  console.log(`${color}${msg}${colors.reset}`);
}

async function login() {
  log('\n📝 Logging in...', colors.cyan);
  const response = await fetch(`${AUTH_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test', password: 'test' }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Login failed: ${error}`);
  }

  const data = await response.json();
  log('✅ Login successful', colors.green);
  log(`   User ID: ${data.userId}`, colors.reset);
  return data.accessToken;
}

function loadImage() {
  log('\n📁 Loading test image...', colors.cyan);
  
  // Try to load real test image first
  if (fs.existsSync(TEST_IMAGE_PATH)) {
    const buffer = fs.readFileSync(TEST_IMAGE_PATH);
    const base64 = buffer.toString('base64');
    const dataUrl = `data:image/png;base64,${base64}`;
    
    log('✅ Real image loaded', colors.green);
    log(`   Size: ${(buffer.length / 1024).toFixed(2)} KB`, colors.reset);
    
    return dataUrl;
  }
  
  // Use mock image if real image not found
  log('⚠️  Test image not found, using mock image', colors.yellow);
  log(`   Missing: ${TEST_IMAGE_PATH}`, colors.yellow);
  
  // Create a small 1x1 PNG image
  const mockPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  const dataUrl = `data:image/png;base64,${mockPng.toString('base64')}`;
  
  log('✅ Mock image created (1x1 pixel)', colors.green);
  
  return dataUrl;
}

async function solveCaptcha(token, image) {
  log('\n🧩 Solving slide captcha...', colors.cyan);
  
  const response = await fetch(`${CAPTCHA_URL}/captcha/slide`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ image }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Captcha solve failed: ${error}`);
  }

  const result = await response.json();
  log('✅ Captcha solved', colors.green);
  log(`   Position: [${result.position[0].toFixed(2)}, ${result.position[1].toFixed(2)}]`, colors.reset);
  log(`   Time: ${result.time.toFixed(3)}s`, colors.reset);
  
  return result;
}

async function main() {
  console.log('\n' + '='.repeat(60));
  log('🚀 Simple Captcha Test', colors.cyan);
  console.log('='.repeat(60));

  try {
    // Step 1: Login
    const token = await login();

    // Step 2: Load image
    const image = loadImage();

    // Step 3: Solve captcha
    const result = await solveCaptcha(token, image);

    // Summary
    console.log('\n' + '='.repeat(60));
    log('✅ Test completed successfully!', colors.green);
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.log('\n' + '='.repeat(60));
    log('❌ Test failed:', colors.red);
    log(error.message, colors.red);
    console.log('='.repeat(60) + '\n');
    process.exit(1);
  }
}

main();

#!/usr/bin/env node

/**
 * Symbol Captcha Test Script
 * Tests symbol detection and matching
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_URL = process.env.AUTH_URL || 'http://localhost:3005';
const CAPTCHA_URL = process.env.CAPTCHA_URL || 'http://localhost:3005';
const TEST_IMAGES_DIR = path.join(__dirname, '../images/symbol');

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

function loadImage(imagePath) {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}`);
  }
  
  const buffer = fs.readFileSync(imagePath);
  const base64 = buffer.toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;
  
  return { dataUrl, size: buffer.length };
}

async function solveSymbolCaptcha(token, image) {
  log('\n🔍 Solving symbol captcha...', colors.cyan);
  
  const response = await fetch(`${CAPTCHA_URL}/captcha/symbol`, {
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
  return result;
}

async function testSingleImage(token, imagePath) {
  const filename = path.basename(imagePath);
  log(`\n${'='.repeat(60)}`, colors.cyan);
  log(`📸 Testing: ${filename}`, colors.cyan);
  log('='.repeat(60), colors.cyan);
  
  try {
    // Load image
    log('\n📁 Loading image...', colors.cyan);
    const { dataUrl, size } = loadImage(imagePath);
    log('✅ Image loaded', colors.green);
    log(`   Size: ${(size / 1024).toFixed(2)} KB`, colors.reset);
    
    // Solve
    const result = await solveSymbolCaptcha(token, dataUrl);
    
    log('✅ Captcha solved', colors.green);
    log(`   Position 1: [${result.symbol_positions[0][0].toFixed(2)}, ${result.symbol_positions[0][1].toFixed(2)}]`, colors.reset);
    log(`   Position 2: [${result.symbol_positions[1][0].toFixed(2)}, ${result.symbol_positions[1][1].toFixed(2)}]`, colors.reset);
    log(`   Time: ${result.time.toFixed(3)}s`, colors.reset);
    
    // Check if positions are valid (not [0, 0])
    const isValid = !(result.symbol_positions[0][0] === 0 && 
                     result.symbol_positions[0][1] === 0 &&
                     result.symbol_positions[1][0] === 0 && 
                     result.symbol_positions[1][1] === 0);
    
    if (!isValid) {
      log('⚠️  Warning: Returned [0,0] positions (detection failed)', colors.yellow);
    }
    
    return { success: true, result, isValid };
    
  } catch (error) {
    log(`❌ Failed: ${error.message}`, colors.red);
    return { success: false, error: error.message };
  }
}

async function main() {
  console.log('\n' + '='.repeat(60));
  log('🔍 Symbol Captcha Test', colors.cyan);
  console.log('='.repeat(60));

  try {
    // Login
    const token = await login();

    // Get all symbol images
    log('\n📂 Scanning for test images...', colors.cyan);
    const files = fs.readdirSync(TEST_IMAGES_DIR)
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
      .slice(0, 5); // Test first 5 images
    
    if (files.length === 0) {
      log('❌ No images found in images/symbol/', colors.red);
      process.exit(1);
    }
    
    log(`✅ Found ${files.length} images (testing first 5)`, colors.green);

    // Test each image
    let totalSuccess = 0;
    let totalValid = 0;
    
    for (const file of files) {
      const imagePath = path.join(TEST_IMAGES_DIR, file);
      const result = await testSingleImage(token, imagePath);
      
      if (result.success) {
        totalSuccess++;
        if (result.isValid) totalValid++;
      }
      
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    log('📊 Test Summary', colors.cyan);
    console.log('='.repeat(60));
    log(`✅ Successful requests: ${totalSuccess}/${files.length}`, colors.green);
    log(`🎯 Valid detections: ${totalValid}/${files.length}`, totalValid === files.length ? colors.green : colors.yellow);
    
    if (totalValid < files.length) {
      log('\n⚠️  Some detections returned [0,0] positions', colors.yellow);
      log('   This might indicate:', colors.yellow);
      log('   - YOLO model not detecting symbols properly', colors.yellow);
      log('   - Image format/size issues', colors.yellow);
      log('   - Model needs retraining', colors.yellow);
    }
    
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

#!/usr/bin/env node

/**
 * Inspect ONNX model structure
 */

import onnx from 'onnxruntime-node';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
};

function log(msg, color = colors.reset) {
  console.log(`${color}${msg}${colors.reset}`);
}

async function inspectModel(modelPath, modelName) {
  try {
    log(`\n${'='.repeat(60)}`, colors.cyan);
    log(`📦 ${modelName}`, colors.cyan);
    log('='.repeat(60), colors.cyan);
    
    const session = await onnx.InferenceSession.create(modelPath);
    
    log('\n🔹 Inputs:', colors.green);
    session.inputNames.forEach((name, i) => {
      log(`   [${i}] ${name}`, colors.reset);
    });
    
    log('\n🔹 Outputs:', colors.green);
    session.outputNames.forEach((name, i) => {
      log(`   [${i}] ${name}`, colors.reset);
    });
    
    // Try to infer shape by running with dummy input
    log('\n🔹 Testing with dummy input...', colors.yellow);
    try {
      const dummyInput = new Float32Array(3 * 640 * 640);
      const tensor = new onnx.Tensor('float32', dummyInput, [1, 3, 640, 640]);
      const result = await session.run({ [session.inputNames[0]]: tensor });
      
      log('   Input accepted: [1, 3, 640, 640]', colors.green);
      session.outputNames.forEach((name) => {
        const output = result[name];
        log(`   Output "${name}": [${output.dims.join(', ')}]`, colors.green);
      });
    } catch (e) {
      log(`   640x640 failed, trying 320x320...`, colors.yellow);
      try {
        const dummyInput = new Float32Array(3 * 320 * 320);
        const tensor = new onnx.Tensor('float32', dummyInput, [1, 3, 320, 320]);
        const result = await session.run({ [session.inputNames[0]]: tensor });
        
        log('   Input accepted: [1, 3, 320, 320]', colors.green);
        session.outputNames.forEach((name) => {
          const output = result[name];
          log(`   Output "${name}": [${output.dims.join(', ')}]`, colors.green);
        });
      } catch (e2) {
        log(`   Could not determine shape: ${e2.message}`, colors.yellow);
      }
    }
    
    return { inputs: session.inputNames.length, outputs: session.outputNames.length };
    
  } catch (error) {
    log(`❌ Error: ${error.message}`, colors.yellow);
    return null;
  }
}

async function main() {
  const modelsDir = path.join(__dirname, 'models');
  
  log('\n🔍 ONNX Model Inspector', colors.cyan);
  
  const models = [
    { path: path.join(modelsDir, 'jigsaw-model.onnx'), name: 'Jigsaw (Slide Captcha)' },
    { path: path.join(modelsDir, 'detect-symbol-model.onnx'), name: 'Symbol Detection' },
    { path: path.join(modelsDir, 'siamese-model.onnx'), name: 'Siamese Comparison' },
  ];
  
  for (const model of models) {
    await inspectModel(model.path, model.name);
  }
  
  log('\n' + '='.repeat(60), colors.cyan);
  log('✅ Inspection complete', colors.green);
  log('='.repeat(60) + '\n', colors.cyan);
}

main().catch(console.error);

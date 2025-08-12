#!/usr/bin/env node

/**
 * Test script to verify yt-dlp progress tracking works
 * Run with: node server/src/test-progress-tracking.js
 */

const { downloadVideoWithYtDlp } = require('./services/yt-dlp-downloader');

// Test progress tracking
async function testProgressTracking() {
  console.log('🧪 Testing yt-dlp progress tracking...\n');
  
  // Use a short public video for testing
  const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // Rick Roll
  
  const options = {
    quality: 'worst[ext=mp4]', // Download worst quality to make it faster
    outputTemplate: 'test_progress_%(id)s.%(ext)s'
  };

  let progressUpdates = [];
  let lastProgress = 0;

  const progressCallback = (progress) => {
    progressUpdates.push(progress);
    
    if (progress.progress > lastProgress) {
      console.log(`📊 Progress: ${progress.progress.toFixed(1)}% - Speed: ${progress.speed} - ETA: ${progress.eta} - Status: ${progress.status}`);
      lastProgress = progress.progress;
    }
  };

  try {
    console.log('🚀 Starting download with progress tracking...');
    const result = await downloadVideoWithYtDlp(testUrl, options, progressCallback);
    
    console.log('\n✅ Download completed successfully!');
    console.log(`📁 File: ${result.filePath}`);
    console.log(`📊 Total progress updates received: ${progressUpdates.length}`);
    
    // Analyze progress updates
    if (progressUpdates.length > 0) {
      const firstUpdate = progressUpdates[0];
      const lastUpdate = progressUpdates[progressUpdates.length - 1];
      
      console.log(`📈 Progress range: ${firstUpdate.progress}% → ${lastUpdate.progress}%`);
      console.log(`⏱️  Status progression: ${firstUpdate.status} → ${lastUpdate.status}`);
      
      // Check if we got meaningful progress updates
      const meaningfulUpdates = progressUpdates.filter(update => update.progress > 0);
      console.log(`🎯 Meaningful progress updates: ${meaningfulUpdates.length}/${progressUpdates.length}`);
      
      if (meaningfulUpdates.length > 0) {
        console.log('✅ Progress tracking is working correctly!');
      } else {
        console.log('⚠️ Progress tracking received updates but no meaningful progress values');
      }
    } else {
      console.log('❌ No progress updates received - progress tracking may not be working');
    }
    
    // Clean up test file
    const fs = require('fs');
    const path = require('path');
    try {
      if (fs.existsSync(result.filePath)) {
        fs.unlinkSync(result.filePath);
        console.log('🧹 Cleaned up test download file');
      }
    } catch (error) {
      console.log('⚠️ Could not clean up test file:', error.message);
    }
    
  } catch (error) {
    console.error('❌ Download failed:', error.message);
    
    console.log(`📊 Progress updates received before failure: ${progressUpdates.length}`);
    if (progressUpdates.length > 0) {
      const lastUpdate = progressUpdates[progressUpdates.length - 1];
      console.log(`📈 Last progress: ${lastUpdate.progress}% - Status: ${lastUpdate.status}`);
    }
  }
}

// Test just the progress parsing without actual download
async function testProgressParsing() {
  console.log('\n🧪 Testing progress parsing patterns...\n');
  
  const testOutputs = [
    '[download]   0.0% of   11.21MiB at  Unknown B/s ETA Unknown',
    '[download]   0.1% of   11.21MiB at    2.17MiB/s ETA 00:05',
    '[download]  17.8% of   11.21MiB at    4.06MiB/s ETA 00:02',
    '[download]  86.7% of   11.21MiB at    4.88MiB/s ETA 00:00',
    '[download] 100.0% of   11.21MiB at    4.10MiB/s ETA 00:00',
    '[download] 100% of   11.21MiB in 00:00:02 at 4.59MiB/s'
  ];

  const progressPatterns = [
    // Full pattern: [download]  17.8% of   11.21MiB at    4.06MiB/s ETA 00:02
    /\[download\]\s+(\d+\.?\d*)%\s+of\s+~?\s*(\d+\.?\d*\w+)\s+at\s+(\S+)\s+ETA\s+(\S+)/,
    // Simpler pattern: [download]  17.8% of   11.21MiB at    4.06MiB/s
    /\[download\]\s+(\d+\.?\d*)%\s+of\s+(\S+)\s+at\s+(\S+)/,
    // Basic pattern: [download]  17.8%
    /\[download\]\s+(\d+\.?\d*)%/
  ];

  testOutputs.forEach((output, index) => {
    console.log(`Testing output ${index + 1}: ${output}`);
    
    let matched = false;
    for (let i = 0; i < progressPatterns.length; i++) {
      const match = output.match(progressPatterns[i]);
      if (match) {
        console.log(`  ✅ Matched pattern ${i}: Progress = ${match[1]}%`);
        if (match[2]) console.log(`     Size = ${match[2]}`);
        if (match[3]) console.log(`     Speed = ${match[3]}`);
        if (match[4]) console.log(`     ETA = ${match[4]}`);
        matched = true;
        break;
      }
    }
    
    if (!matched) {
      console.log('  ❌ No pattern matched');
    }
    console.log('');
  });
}

// Run tests
async function runTests() {
  await testProgressParsing();
  await testProgressTracking();
}

runTests().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});

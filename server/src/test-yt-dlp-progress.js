#!/usr/bin/env node

/**
 * Test script to see actual yt-dlp progress output format
 * Run with: node server/src/test-yt-dlp-progress.js
 */

const { spawn } = require('child_process');

// Test yt-dlp progress output format
async function testProgressOutput() {
  console.log('🔍 Testing yt-dlp progress output format...');
  
  // Use a short public video for testing
  const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // Rick Roll
  
  const args = [
    '--newline',
    '--progress',
    '--no-download', // Don't actually download, just show what would happen
    '--simulate',    // Simulate the download
    testUrl
  ];
  
  console.log('Running: yt-dlp', args.join(' '));
  
  const ytdlp = spawn('yt-dlp', args);
  
  ytdlp.stdout.on('data', (data) => {
    const output = data.toString();
    console.log('STDOUT:', JSON.stringify(output));
    
    // Test our current regex
    const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+~?\s*(\d+\.?\d*\w+)\s+at\s+(\S+)\s+ETA\s+(\S+)/);
    if (progressMatch) {
      console.log('✅ Current regex matched:', progressMatch);
    }
    
    // Test alternative regex patterns
    const altRegex1 = output.match(/\[download\]\s+(\d+\.?\d*)%/);
    if (altRegex1) {
      console.log('✅ Simple percentage regex matched:', altRegex1);
    }
    
    const altRegex2 = output.match(/\[download\].*?(\d+\.?\d*)%/);
    if (altRegex2) {
      console.log('✅ Flexible percentage regex matched:', altRegex2);
    }
  });
  
  ytdlp.stderr.on('data', (data) => {
    const output = data.toString();
    console.log('STDERR:', JSON.stringify(output));
  });
  
  ytdlp.on('close', (code) => {
    console.log(`yt-dlp process exited with code ${code}`);
  });
  
  ytdlp.on('error', (error) => {
    console.error('Error running yt-dlp:', error);
  });
}

// Also test with actual download to see real progress
async function testRealProgress() {
  console.log('\n🔍 Testing real download progress (will download a small file)...');
  
  // Use a very short video for testing
  const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  
  const args = [
    '--newline',
    '--progress',
    '-f', 'worst[ext=mp4]', // Download worst quality to make it faster
    '-o', 'test_download.%(ext)s',
    testUrl
  ];
  
  console.log('Running: yt-dlp', args.join(' '));
  
  const ytdlp = spawn('yt-dlp', args);
  
  ytdlp.stdout.on('data', (data) => {
    const output = data.toString();
    console.log('REAL PROGRESS:', JSON.stringify(output));
    
    // Test all our regex patterns
    const patterns = [
      { name: 'Current', regex: /\[download\]\s+(\d+\.?\d*)%\s+of\s+~?\s*(\d+\.?\d*\w+)\s+at\s+(\S+)\s+ETA\s+(\S+)/ },
      { name: 'Simple %', regex: /\[download\]\s+(\d+\.?\d*)%/ },
      { name: 'Flexible %', regex: /\[download\].*?(\d+\.?\d*)%/ },
      { name: 'With size', regex: /\[download\]\s+(\d+\.?\d*)%\s+of\s+(\S+)/ },
      { name: 'With speed', regex: /\[download\].*?(\d+\.?\d*)%.*?at\s+(\S+)/ },
      { name: 'Full info', regex: /\[download\]\s+(\d+\.?\d*)%\s+of\s+(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/ }
    ];
    
    patterns.forEach(pattern => {
      const match = output.match(pattern.regex);
      if (match) {
        console.log(`✅ ${pattern.name} regex matched:`, match);
      }
    });
  });
  
  ytdlp.stderr.on('data', (data) => {
    const output = data.toString();
    console.log('REAL STDERR:', JSON.stringify(output));
  });
  
  ytdlp.on('close', (code) => {
    console.log(`Real download process exited with code ${code}`);
    
    // Clean up test file
    const fs = require('fs');
    try {
      if (fs.existsSync('test_download.mp4')) {
        fs.unlinkSync('test_download.mp4');
        console.log('Cleaned up test download file');
      }
    } catch (error) {
      console.log('Could not clean up test file:', error.message);
    }
  });
  
  ytdlp.on('error', (error) => {
    console.error('Error running real download test:', error);
  });
}

// Run tests
console.log('🧪 Testing yt-dlp progress output patterns...\n');

testProgressOutput();

// Wait a bit then test real progress
setTimeout(() => {
  testRealProgress();
}, 3000);

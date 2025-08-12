#!/usr/bin/env node

/**
 * Simple test script to verify yt-dlp integration works
 * Run with: node server/src/test-yt-dlp.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Test yt-dlp installation
async function testYtDlpInstallation() {
  console.log('🔍 Testing yt-dlp installation...');
  
  return new Promise((resolve) => {
    const ytdlp = spawn('yt-dlp', ['--version']);
    
    let output = '';
    ytdlp.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ytdlp.on('close', (code) => {
      if (code === 0) {
        console.log('✅ yt-dlp is installed, version:', output.trim());
        resolve(true);
      } else {
        console.log('❌ yt-dlp is not installed or not working');
        resolve(false);
      }
    });
    
    ytdlp.on('error', () => {
      console.log('❌ yt-dlp is not installed');
      resolve(false);
    });
  });
}

// Test getting video info for a public video
async function testVideoInfo() {
  console.log('\n🔍 Testing video info retrieval...');
  
  // Use a known public video (YouTube's own video about YouTube)
  const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // Rick Roll - always available
  
  return new Promise((resolve) => {
    const args = [
      '--dump-json',
      '--no-download',
      testUrl
    ];
    
    const ytdlp = spawn('yt-dlp', args);
    let output = '';
    let errorOutput = '';
    
    ytdlp.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ytdlp.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    ytdlp.on('close', (code) => {
      if (code === 0) {
        try {
          const info = JSON.parse(output);
          console.log('✅ Video info retrieved successfully:');
          console.log(`   Title: ${info.title}`);
          console.log(`   Uploader: ${info.uploader}`);
          console.log(`   Duration: ${info.duration} seconds`);
          console.log(`   Availability: ${info.availability || 'public'}`);
          resolve(true);
        } catch (error) {
          console.log('❌ Failed to parse video info JSON');
          resolve(false);
        }
      } else {
        console.log('❌ Failed to get video info:', errorOutput);
        resolve(false);
      }
    });
  });
}

// Test directory creation
function testDirectories() {
  console.log('\n🔍 Testing required directories...');
  
  const dirs = ['downloads', 'cookies', 'temp'];
  let allExist = true;
  
  dirs.forEach(dir => {
    if (fs.existsSync(dir)) {
      console.log(`✅ ${dir}/ directory exists`);
    } else {
      console.log(`❌ ${dir}/ directory missing - creating...`);
      try {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ ${dir}/ directory created`);
      } catch (error) {
        console.log(`❌ Failed to create ${dir}/ directory:`, error.message);
        allExist = false;
      }
    }
  });
  
  return allExist;
}

// Test cookies directory permissions
function testCookiesDirectory() {
  console.log('\n🔍 Testing cookies directory permissions...');
  
  const cookiesDir = 'cookies';
  const testFile = path.join(cookiesDir, 'test.txt');
  
  try {
    // Try to write a test file
    fs.writeFileSync(testFile, 'test content');
    
    // Try to read it back
    const content = fs.readFileSync(testFile, 'utf8');
    
    // Clean up
    fs.unlinkSync(testFile);
    
    if (content === 'test content') {
      console.log('✅ Cookies directory is writable');
      return true;
    } else {
      console.log('❌ Cookies directory read/write test failed');
      return false;
    }
  } catch (error) {
    console.log('❌ Cookies directory is not writable:', error.message);
    return false;
  }
}

// Main test function
async function runTests() {
  console.log('🧪 Running yt-dlp integration tests...\n');
  
  const results = {
    installation: await testYtDlpInstallation(),
    directories: testDirectories(),
    cookiesPermissions: testCookiesDirectory(),
    videoInfo: false
  };
  
  // Only test video info if yt-dlp is installed
  if (results.installation) {
    results.videoInfo = await testVideoInfo();
  }
  
  console.log('\n📊 Test Results Summary:');
  console.log('========================');
  console.log(`yt-dlp Installation: ${results.installation ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Required Directories: ${results.directories ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Cookies Permissions: ${results.cookiesPermissions ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Video Info Retrieval: ${results.videoInfo ? '✅ PASS' : '❌ FAIL'}`);
  
  const allPassed = Object.values(results).every(result => result === true);
  
  console.log('\n' + '='.repeat(50));
  if (allPassed) {
    console.log('🎉 All tests passed! yt-dlp integration is ready to use.');
    console.log('\nNext steps:');
    console.log('1. Start your server: npm run dev');
    console.log('2. Export browser cookies from YouTube');
    console.log('3. Upload cookies through the web interface');
    console.log('4. Try downloading a member-only video');
  } else {
    console.log('⚠️  Some tests failed. Please fix the issues above before using yt-dlp integration.');
    
    if (!results.installation) {
      console.log('\n💡 To install yt-dlp:');
      console.log('   brew install yt-dlp  (macOS)');
      console.log('   pip install yt-dlp   (Python)');
    }
  }
  
  process.exit(allPassed ? 0 : 1);
}

// Run the tests
runTests().catch(error => {
  console.error('❌ Test runner failed:', error);
  process.exit(1);
});

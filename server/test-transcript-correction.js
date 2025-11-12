/**
 * Test script for transcript correction functionality
 * 
 * This script demonstrates how to use the transcript correction API
 * to fix spelling mistakes in YouTube transcripts stored in the vector database.
 */

const API_BASE_URL = 'http://localhost:3001/api/youtube';

/**
 * Test 1: Get default correction rules
 */
async function testGetCorrectionRules() {
  console.log('\n=== Test 1: Get Default Correction Rules ===');
  
  try {
    const response = await fetch(`${API_BASE_URL}/correction-rules`);
    const result = await response.json();
    
    console.log('Success:', result.success);
    console.log('Description:', result.description);
    console.log('Rules:');
    result.rules.forEach(rule => {
      console.log(`  - "${rule.incorrect}" → "${rule.correct}"`);
    });
  } catch (error) {
    console.error('Error:', error.message);
  }
}

/**
 * Test 2: Preview corrections on sample text
 */
async function testPreviewCorrections() {
  console.log('\n=== Test 2: Preview Corrections ===');
  
  const sampleText = 'Trong thiền định, chúng ta cần rộng lặng tâm và không dính mắt vào bất cứ điều gì.';
  
  try {
    const response = await fetch(`${API_BASE_URL}/preview-corrections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: sampleText })
    });
    
    const result = await response.json();
    
    console.log('Original text:', result.originalText);
    console.log('Corrected text:', result.correctedText);
    console.log('Has changes:', result.hasChanges);
    console.log('Replacements:');
    result.replacements.forEach(r => {
      console.log(`  - ${r.rule}: ${r.count} occurrence(s)`);
    });
  } catch (error) {
    console.error('Error:', error.message);
  }
}

/**
 * Test 3: Dry run correction on all YouTube transcripts
 */
async function testDryRunCorrection() {
  console.log('\n=== Test 3: Dry Run Correction (All YouTube Transcripts) ===');
  
  try {
    const response = await fetch(`${API_BASE_URL}/correct-youtube-transcripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: true })
    });
    
    const result = await response.json();
    
    console.log('Success:', result.success);
    console.log('Message:', result.message);
    console.log('Dry run:', result.dryRun);
    console.log('\nStatistics:');
    console.log('  - Total chunks processed:', result.stats.totalChunksProcessed);
    console.log('  - Chunks modified:', result.stats.chunksModified);
    console.log('  - Total replacements:', result.stats.totalReplacements);
    console.log('  - Processing time:', result.stats.processingTimeMs, 'ms');
    
    if (result.stats.replacementDetails && result.stats.replacementDetails.length > 0) {
      console.log('\nReplacement details:');
      result.stats.replacementDetails.forEach(detail => {
        console.log(`  - ${detail.rule}: ${detail.count} occurrence(s)`);
      });
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

/**
 * Test 4: Actual correction on a specific video (COMMENTED OUT FOR SAFETY)
 */
async function testActualCorrection(videoId) {
  console.log('\n=== Test 4: Actual Correction (Specific Video) ===');
  console.log('⚠️  This will modify the database!');
  
  if (!videoId) {
    console.log('❌ Please provide a video ID to test actual correction');
    console.log('Example: node test-transcript-correction.js <videoId>');
    return;
  }
  
  try {
    // First, do a dry run for this specific video
    console.log(`\nDry run for video: ${videoId}`);
    const dryRunResponse = await fetch(`${API_BASE_URL}/correct-youtube-transcripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        videoId: videoId,
        dryRun: true 
      })
    });
    
    const dryRunResult = await dryRunResponse.json();
    console.log('Dry run result:');
    console.log('  - Chunks to be modified:', dryRunResult.stats.chunksModified);
    console.log('  - Total replacements:', dryRunResult.stats.totalReplacements);
    
    if (dryRunResult.stats.chunksModified === 0) {
      console.log('✅ No corrections needed for this video');
      return;
    }
    
    // Uncomment the following code to actually perform the correction
    /*
    console.log('\n⚠️  Proceeding with actual correction...');
    const actualResponse = await fetch(`${API_BASE_URL}/correct-youtube-transcripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        videoId: videoId,
        dryRun: false 
      })
    });
    
    const actualResult = await actualResponse.json();
    console.log('Actual correction result:');
    console.log('  - Success:', actualResult.success);
    console.log('  - Chunks modified:', actualResult.stats.chunksModified);
    console.log('  - Total replacements:', actualResult.stats.totalReplacements);
    console.log('  - Processing time:', actualResult.stats.processingTimeMs, 'ms');
    */
    
    console.log('\n⚠️  Actual correction is commented out for safety.');
    console.log('Uncomment the code in testActualCorrection() to enable it.');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

/**
 * Main function to run all tests
 */
async function main() {
  console.log('='.repeat(60));
  console.log('Transcript Correction API Test Suite');
  console.log('='.repeat(60));
  
  // Get video ID from command line argument if provided
  const videoId = process.argv[2];
  
  // Run tests
  await testGetCorrectionRules();
  await testPreviewCorrections();
  await testDryRunCorrection();
  
  if (videoId) {
    await testActualCorrection(videoId);
  } else {
    console.log('\n💡 Tip: Run with a video ID to test correction on a specific video:');
    console.log('   node test-transcript-correction.js <videoId>');
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Tests completed!');
  console.log('='.repeat(60));
}

// Run the tests
main().catch(console.error);


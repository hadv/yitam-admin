/**
 * Test script to verify YouTube transcript scraping improvements
 * This script tests the enhanced scraping functionality with retry logic
 */

const { scrapeTranscriptFromYouTube, getScrapingMetrics } = require('./dist/services/youtube-transcript');

// Test video IDs (use videos that are known to have captions)
const testVideoIds = [
  'dQw4w9WgXcQ', // Rick Astley - Never Gonna Give You Up
  'jNQXAC9IVRw', // Me at the zoo (first YouTube video)
  'kJQP7kiw5Fk'  // Luis Fonsi - Despacito
];

async function testScrapingWithRetries() {
  console.log('🧪 Testing YouTube transcript scraping with enhanced retry logic...\n');
  
  for (const videoId of testVideoIds) {
    console.log(`\n📹 Testing video: ${videoId}`);
    console.log('=' .repeat(50));
    
    try {
      const startTime = Date.now();
      
      // Test the scraping function
      const transcript = await scrapeTranscriptFromYouTube(videoId);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      console.log(`✅ Success! Retrieved transcript in ${duration}ms`);
      console.log(`📝 Transcript length: ${transcript.length} characters`);
      console.log(`📄 First 200 characters: ${transcript.substring(0, 200)}...`);
      
    } catch (error) {
      console.log(`❌ Failed to scrape transcript: ${error.message}`);
    }
    
    // Show current metrics
    const metrics = getScrapingMetrics();
    console.log(`📊 Current metrics: Success rate: ${metrics.successRate}, Total attempts: ${metrics.totalAttempts}`);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('📈 Final Scraping Metrics:');
  const finalMetrics = getScrapingMetrics();
  console.log(JSON.stringify(finalMetrics, null, 2));
}

// Run the test
if (require.main === module) {
  testScrapingWithRetries()
    .then(() => {
      console.log('\n✨ Test completed!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Test failed:', error);
      process.exit(1);
    });
}

module.exports = { testScrapingWithRetries };

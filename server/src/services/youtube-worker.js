
const { parentPort, workerData } = require('worker_threads');
const { processYoutubeTranscript, getVideoDetails } = require('./youtube-transcript');
const { DatabaseService } = require('../core/database-service');

// Create database service instance
const dbService = new DatabaseService();

async function processVideo() {
  const {
    videoId,
    domains,
    chunkSize,
    chunkOverlap,
    userId,
    accessToken
  } = workerData;
  
  try {
    // Initialize database
    await dbService.initialize();
    
    // Send progress updates to main thread
    const progressCallback = (stage, message, progress) => {
      parentPort.postMessage({
        type: 'progress',
        data: { stage, message, progress }
      });
    };
    
    // Get video details
    const videoDetails = await getVideoDetails(videoId);
    parentPort.postMessage({
      type: 'progress',
      data: { 
        stage: 'transcript_fetch', 
        message: `Processing YouTube video: "${videoDetails.title}"`, 
        progress: 30 
      }
    });
    
    // Process transcript and create chunks
    const chunks = await processYoutubeTranscript(
      videoId,
      domains,
      chunkSize,
      chunkOverlap,
      userId,
      accessToken,
      progressCallback
    );
    
    // Store chunks in database
    parentPort.postMessage({
      type: 'progress',
      data: { 
        stage: 'chunk_storage', 
        message: `Storing ${chunks.length} chunks`, 
        progress: 90 
      }
    });
    
    await dbService.addDocumentChunks(chunks);
    
    // Complete successfully
    parentPort.postMessage({
      type: 'complete',
      data: {
        totalChunks: chunks.length,
        videoId,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        videoTitle: videoDetails.title,
        videoDescription: videoDetails.description || ''
      }
    });
  } catch (error) {
    console.error('Error in worker thread:', error);
    parentPort.postMessage({
      type: 'error',
      data: {
        message: error.message,
        stack: error.stack
      }
    });
  }
}

// Initialize and run
dbService.initialize()
  .then(() => {
    parentPort.postMessage({ type: 'initialized' });
    return processVideo();
  })
  .catch(error => {
    parentPort.postMessage({
      type: 'error',
      data: {
        message: error.message,
        stack: error.stack
      }
    });
  });
      
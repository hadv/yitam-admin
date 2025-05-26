import { Router } from 'express';
import { processYoutubeVideo, checkTranscriptAccess, checkTranscriptExists, countYoutubeVideoChunks, deleteYoutubeVideoChunks } from '../controllers/youtube';
import { getJobStatus } from '../services/job-queue';

const router = Router();

// Route for processing YouTube video transcripts
router.post('/process', processYoutubeVideo);

// Route for checking authentication status for transcripts
router.get('/access', checkTranscriptAccess);

// Route for checking if a transcript exists for a videoId
router.get('/exists/:videoId', checkTranscriptExists);

// Route for getting the count of chunks for a videoId
router.get('/count/:videoId', countYoutubeVideoChunks);

// Route for deleting all chunks for a specific videoId to enable re-extraction
router.delete('/:videoId', deleteYoutubeVideoChunks);

// Get job status by job ID
router.get('/job/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const status = await getJobStatus(jobId);
    
    if (!status.exists) {
      return res.status(404).json({ message: 'Job not found' });
    }
    
    res.status(200).json({
      jobId,
      status: status.state,
      progress: status.progress,
      videoId: status.data?.videoId
    });
  } catch (error) {
    console.error('Error checking job status:', error);
    res.status(500).json({ 
      message: 'Failed to check job status',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router; 
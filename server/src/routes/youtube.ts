import { Router } from 'express';
import {
  processYoutubeVideo,
  checkTranscriptAccess,
  checkTranscriptExists,
  countYoutubeVideoChunks,
  deleteYoutubeVideoChunks,
  getYoutubeVideoChunks,
  downloadYoutubeVideo,
  getYoutubeVideoInfo,
  getDownloadedVideosList,
  deleteDownloadedVideoFile,
  serveDownloadedVideo,
  checkYtDlpStatus,
  downloadYoutubeVideoWithYtDlp,
  downloadYoutubeVideoWithEnhancedMetadata,
  generateEnhancedMetadata,
  getYoutubeVideoInfoWithYtDlp,
  uploadCookiesFile,
  getCookiesFilesList,
  deleteCookiesFileController
} from '../controllers/youtube';
import { getJobStatus } from '../services/job-queue';
import { getScrapingMetrics, resetScrapingMetrics } from '../services/youtube-transcript';

const router = Router();

// Route for processing YouTube video transcripts
router.post('/process', processYoutubeVideo);

// Route for checking authentication status for transcripts
router.get('/access', checkTranscriptAccess);

// Route for checking if a transcript exists for a videoId
router.get('/exists/:videoId', checkTranscriptExists);

// Route for getting the count of chunks for a videoId
router.get('/count/:videoId', countYoutubeVideoChunks);

// Route for getting all chunks for a specific videoId
router.get('/chunks/:videoId', getYoutubeVideoChunks);

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

// Get scraping metrics for monitoring
router.get('/metrics', (req, res) => {
  try {
    const metrics = getScrapingMetrics();
    res.status(200).json({
      message: 'YouTube scraping metrics',
      metrics,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting scraping metrics:', error);
    res.status(500).json({
      message: 'Failed to get scraping metrics',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Reset scraping metrics (admin endpoint)
router.post('/metrics/reset', (req, res) => {
  try {
    resetScrapingMetrics();
    res.status(200).json({
      message: 'Scraping metrics reset successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error resetting scraping metrics:', error);
    res.status(500).json({
      message: 'Failed to reset scraping metrics',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Video download routes
// Route for downloading YouTube video to server
router.post('/download', downloadYoutubeVideo);

// Route for getting video information without downloading
router.post('/info', getYoutubeVideoInfo);

// Route for getting list of downloaded videos
router.get('/downloads', getDownloadedVideosList);

// Route for serving downloaded video files
router.get('/downloads/:fileName', serveDownloadedVideo);

// Route for deleting downloaded video files
router.delete('/downloads/:fileName', deleteDownloadedVideoFile);

// yt-dlp routes for member-only content

// Route for checking yt-dlp installation status
router.get('/yt-dlp/status', checkYtDlpStatus);

// Route for downloading YouTube video with yt-dlp (member-only support)
router.post('/yt-dlp/download', downloadYoutubeVideoWithYtDlp);

// Route for downloading YouTube video with enhanced metadata using yt-dlp
router.post('/yt-dlp/download-enhanced', downloadYoutubeVideoWithEnhancedMetadata);

// Route for generating enhanced metadata for existing video info
router.post('/yt-dlp/enhance-metadata', generateEnhancedMetadata);

// Route for getting video information with yt-dlp (member-only support)
router.post('/yt-dlp/info', getYoutubeVideoInfoWithYtDlp);

// Cookies management routes

// Route for uploading browser cookies file
router.post('/cookies/upload', uploadCookiesFile);

// Route for getting list of cookies files
router.get('/cookies', getCookiesFilesList);

// Route for deleting cookies file
router.delete('/cookies/:fileName', deleteCookiesFileController);

export default router;
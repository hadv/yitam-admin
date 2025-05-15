import express from 'express';
import * as youtubeController from '../controllers/youtube';

const router = express.Router();

// Route for processing YouTube video transcripts
router.post('/process', youtubeController.processYoutubeVideo);

// Route for checking authentication status for transcripts
router.get('/auth-status', youtubeController.checkTranscriptAccess);

// Route for checking if a transcript exists for a videoId
router.get('/check-transcript/:videoId', youtubeController.checkTranscriptExists);

// Route for getting the count of chunks for a videoId
router.get('/count-chunks/:videoId', youtubeController.countYoutubeVideoChunks);

// Route for deleting all chunks for a specific videoId to enable re-extraction
router.delete('/delete-transcript/:videoId', youtubeController.deleteYoutubeVideoChunks);

export default router; 
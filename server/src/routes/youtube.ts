import express from 'express';
import * as youtubeController from '../controllers/youtube';

const router = express.Router();

// Route for processing YouTube video transcripts
router.post('/process', youtubeController.processYoutubeVideo);

// Route for checking authentication status for transcripts
router.get('/auth-status', youtubeController.checkTranscriptAccess);

// Route for checking if a transcript exists for a videoId
router.get('/check-transcript/:videoId', youtubeController.checkTranscriptExists);

export default router; 
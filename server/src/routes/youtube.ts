import express from 'express';
import * as youtubeController from '../controllers/youtube';

const router = express.Router();

// Route for processing YouTube video transcripts
router.post('/process', youtubeController.processYoutubeVideo);

// Route for checking authentication status for transcripts
router.get('/auth-status', youtubeController.checkTranscriptAccess);

export default router; 
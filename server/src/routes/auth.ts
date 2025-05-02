import express from 'express';
import { startGoogleAuth, handleGoogleCallback, handleGoogleToken, checkAuthStatus, logout } from '../controllers/auth';

const router = express.Router();

/**
 * @route   GET /api/auth/google
 * @desc    Start Google OAuth authentication
 * @access  Public
 */
router.get('/google', startGoogleAuth);

/**
 * @route   GET /api/auth/google/callback
 * @desc    Handle Google OAuth callback
 * @access  Public
 */
router.get('/google/callback', handleGoogleCallback);

/**
 * @route   POST /api/auth/google/token
 * @desc    Verify and process Google ID token from client-side sign-in
 * @access  Public
 */
router.post('/google/token', handleGoogleToken);

/**
 * @route   GET /api/auth/status
 * @desc    Check authentication status
 * @access  Public
 */
router.get('/status', checkAuthStatus);

/**
 * @route   POST /api/auth/logout
 * @desc    Logout and revoke token
 * @access  Public
 */
router.post('/logout', logout);

export default router; 
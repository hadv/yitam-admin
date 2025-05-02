import { Request, Response } from 'express';
import { getAuthUrl, exchangeCodeForTokens, isAuthenticated, revokeAuthentication, tokenStore, validateClientToken } from '../services/youtube-auth';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import axios from 'axios';

// Extend Express Request with session
declare module 'express-serve-static-core' {
  interface Request {
    session: {
      userId?: string;
      authenticated?: boolean;
      returnUrl?: string;
      destroy: (callback: (err: Error | null) => void) => void;
    } & Record<string, any>;
  }
}

/**
 * Initiates Google OAuth2 authentication process
 */
export const startGoogleAuth = (req: Request, res: Response) => {
  try {
    // Log authentication configuration for debugging
    console.log('Starting OAuth process with configuration:', {
      redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback',
      clientIdConfigured: !!process.env.GOOGLE_CLIENT_ID,
      clientSecretConfigured: !!process.env.GOOGLE_CLIENT_SECRET
    });
    
    // Generate authentication URL for Google OAuth2
    const authUrl = getAuthUrl();
    
    // Store the return URL in session if provided
    if (req.query.returnUrl) {
      req.session.returnUrl = req.query.returnUrl as string;
    }
    
    // Redirect user to Google's authorization page
    res.redirect(authUrl);
  } catch (error) {
    console.error('Error starting Google authentication:', error);
    res.status(500).json({ 
      error: 'Failed to initiate Google authentication', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
};

/**
 * Handles Google OAuth2 callback
 */
export const handleGoogleCallback = async (req: Request, res: Response) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).json({ error: 'Authorization code is missing' });
  }
  
  try {
    console.log('Received callback with code, attempting to exchange for tokens');
    
    // Exchange authorization code for tokens
    const { tokens, userId } = await exchangeCodeForTokens(code as string);
    
    console.log('Token exchange successful, user authenticated:', { 
      userId,
      tokenReceived: !!tokens.access_token,
      refreshTokenReceived: !!tokens.refresh_token,
      tokenExpirySet: !!tokens.expiry_date
    });
    
    // Store user info in session
    req.session.userId = userId;
    req.session.authenticated = true;
    
    // Get return URL from session or use default
    const returnUrl = req.session.returnUrl || '/';
    delete req.session.returnUrl;
    
    res.redirect(returnUrl);
  } catch (error) {
    console.error('Error handling Google callback:', error);
    
    // More detailed error logging
    if (error instanceof Error) {
      console.error('Error name:', error.name);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    
    res.status(500).json({ 
      error: 'Failed to complete Google authentication', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
};

/**
 * Handles Google ID token or access token verification from client-side sign-in
 */
export const handleGoogleToken = async (req: Request, res: Response) => {
  const { id_token, access_token } = req.body;
  
  if (!id_token && !access_token) {
    return res.status(400).json({ error: 'Token is missing. Please provide either id_token or access_token' });
  }
  
  try {
    let userId = '';
    
    if (id_token) {
      // ID token verification flow
      console.log('Received ID token, verifying...');
      
      // Create client for token verification
      const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
      
      // Verify the token
      const ticket = await client.verifyIdToken({
        idToken: id_token,
        audience: process.env.GOOGLE_CLIENT_ID
      });
      
      // Get payload from ticket
      const payload = ticket.getPayload();
      
      if (!payload) {
        throw new Error('Token payload is missing');
      }
      
      userId = payload.sub; // Google's unique user ID
      
      console.log('ID token verified successfully:', {
        userId,
        email: payload.email,
        emailVerified: payload.email_verified
      });
    } else if (access_token) {
      // Access token flow - validate using our YouTube auth service
      console.log('Received access token, validating...');
      
      try {
        // Use our specialized validator that also saves the token
        const userInfo = await validateClientToken(access_token);
        
        if (!userInfo) {
          throw new Error('Failed to validate access token');
        }
        
        userId = userInfo.userId;
        
        console.log('Access token validated successfully:', {
          userId,
          email: userInfo.email
        });
      } catch (error) {
        console.error('Error validating access token:', error);
        throw new Error('Failed to validate access token');
      }
    }
    
    // Store user info in session
    req.session.userId = userId;
    req.session.authenticated = true;
    
    res.json({
      success: true,
      userId,
      message: 'Successfully authenticated with YouTube'
    });
  } catch (error) {
    console.error('Error verifying Google token:', error);
    
    if (error instanceof Error) {
      console.error('Error name:', error.name);
      console.error('Error message:', error.message);
    }
    
    res.status(401).json({
      error: 'Failed to verify Google token',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Checks authentication status
 */
export const checkAuthStatus = (req: Request, res: Response) => {
  const userId = req.session.userId;
  const isLoggedIn = !!userId && isAuthenticated(userId);
  
  res.json({
    authenticated: isLoggedIn,
    userId: isLoggedIn ? userId : null
  });
};

/**
 * Logout and revoke authentication
 */
export const logout = async (req: Request, res: Response) => {
  const userId = req.session.userId;
  
  if (userId) {
    try {
      // Revoke Google access
      await revokeAuthentication(userId);
    } catch (error) {
      console.error('Error revoking authentication:', error);
    }
  }
  
  // Clear session
  req.session.destroy((err: Error | null) => {
    if (err) {
      console.error('Error destroying session:', err);
    }
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logged out successfully' });
  });
}; 
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Environment variables required for OAuth2
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback';

// Scopes required for YouTube captions
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube.readonly'
];

// In-memory token storage (replace with database in production)
interface TokenData {
  access_token: string;
  refresh_token?: string;
  expiry_date: number;
}

export let tokenStore: { [key: string]: TokenData } = {};

/**
 * Creates an OAuth2 client for YouTube API authentication
 */
export const createOAuth2Client = (): OAuth2Client => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Google OAuth credentials not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env file');
  }
  
  return new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );
};

/**
 * Generates the authorization URL for user authentication
 */
export const getAuthUrl = (): string => {
  const oauth2Client = createOAuth2Client();
  
  return oauth2Client.generateAuthUrl({
    access_type: 'offline', // This will return a refresh token
    scope: SCOPES,
    prompt: 'consent',      // Forces the consent screen every time
    include_granted_scopes: true
  });
};

/**
 * Exchanges authorization code for tokens
 * 
 * @param code Authorization code from callback
 * @returns Token data and user ID
 */
export const exchangeCodeForTokens = async (code: string): Promise<{ tokens: TokenData, userId: string }> => {
  const oauth2Client = createOAuth2Client();
  
  try {
    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    
    // Set tokens in client for immediate use
    oauth2Client.setCredentials(tokens);
    
    // Get user info to identify the token
    const userInfo = await getUserInfo(oauth2Client);
    const userId = userInfo.id;
    
    // Store tokens for this user
    if (tokens.access_token && tokens.expiry_date) {
      tokenStore[userId] = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || undefined, // Convert null to undefined
        expiry_date: tokens.expiry_date
      };
    }
    
    return { 
      tokens: {
        access_token: tokens.access_token || '',
        refresh_token: tokens.refresh_token || undefined,
        expiry_date: tokens.expiry_date || 0
      }, 
      userId 
    };
  } catch (error) {
    console.error('Error exchanging code for tokens:', error);
    throw error;
  }
};

/**
 * Gets user information from Google
 */
const getUserInfo = async (oauth2Client: OAuth2Client) => {
  const oauth2 = google.oauth2({
    auth: oauth2Client,
    version: 'v2'
  });
  
  const { data } = await oauth2.userinfo.get();
  return {
    id: data.id || 'unknown',
    email: data.email,
    name: data.name
  };
};

/**
 * Gets a valid OAuth2 client for a user
 * 
 * @param userId User ID
 * @returns Authenticated OAuth2 client
 */
export const getAuthenticatedClient = async (userId: string): Promise<OAuth2Client | null> => {
  const tokens = tokenStore[userId];
  
  if (!tokens) {
    console.log(`No tokens found for user ${userId}`);
    return null;
  }
  
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date
  });
  
  // Check if token needs refreshing
  if (tokens.expiry_date < Date.now()) {
    try {
      console.log(`Refreshing expired token for user ${userId}`);
      const { credentials } = await oauth2Client.refreshAccessToken();
      
      // Update stored tokens
      tokenStore[userId] = {
        access_token: credentials.access_token || '',
        refresh_token: credentials.refresh_token || tokens.refresh_token || undefined, // Handle null and preserve existing token
        expiry_date: credentials.expiry_date || 0
      };
      
      // Update client credentials
      oauth2Client.setCredentials(credentials);
    } catch (error) {
      console.error('Error refreshing token:', error);
      delete tokenStore[userId];
      return null;
    }
  }
  
  return oauth2Client;
};

/**
 * Validates an access token received from the client
 * 
 * @param accessToken Access token from client
 * @returns User information if valid, null if invalid
 */
export const validateClientToken = async (accessToken: string): Promise<{ userId: string; email?: string; } | null> => {
  try {
    // Create a client with the token
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });
    
    // Try to get user info to verify the token works
    const userInfo = await getUserInfo(oauth2Client);
    
    if (userInfo && userInfo.id) {
      // Save this token for future use
      tokenStore[userInfo.id] = {
        access_token: accessToken,
        expiry_date: Date.now() + 3600000 // Assume 1 hour validity
      };
      
      return {
        userId: userInfo.id,
        email: userInfo.email || undefined
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error validating client token:', error);
    return null;
  }
};

/**
 * Creates an authenticated client using a direct access token
 * 
 * @param accessToken Access token
 * @returns Authenticated OAuth2 client or null if invalid
 */
export const getClientWithAccessToken = async (accessToken: string): Promise<OAuth2Client | null> => {
  try {
    // Create client with token
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });
    
    // Try to get user info to verify the token works
    const userInfo = await getUserInfo(oauth2Client);
    
    if (!userInfo || !userInfo.id) {
      console.error('Invalid access token - failed to get user info');
      return null;
    }
    
    return oauth2Client;
  } catch (error) {
    console.error('Error creating client with access token:', error);
    return null;
  }
};

/**
 * Checks if a user is authenticated
 * 
 * @param userId User ID
 * @returns Whether the user has valid tokens
 */
export const isAuthenticated = (userId: string): boolean => {
  const token = tokenStore[userId];
  if (!token) return false;
  
  // Check if token has expired
  if (token.expiry_date < Date.now()) {
    // Try to use refresh token later, for now report as not authenticated
    return false;
  }
  
  return true;
};

/**
 * Revokes authentication for a user
 * 
 * @param userId User ID
 */
export const revokeAuthentication = async (userId: string): Promise<void> => {
  const tokens = tokenStore[userId];
  
  if (tokens && tokens.access_token) {
    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials({
      access_token: tokens.access_token
    });
    
    try {
      await oauth2Client.revokeToken(tokens.access_token);
    } catch (error) {
      console.error('Error revoking token:', error);
    }
  }
  
  // Remove from token store
  delete tokenStore[userId];
}; 
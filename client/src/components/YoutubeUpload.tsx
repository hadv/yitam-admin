import { useState, useEffect, useRef } from 'react';
import axios, { AxiosError } from 'axios';
import { FiYoutube } from 'react-icons/fi';
import { availableDomains } from '../constants/domains';

// Extend AxiosError with our custom properties
interface CustomAxiosError extends AxiosError {
  isNetworkError?: boolean;
  isTimeout?: boolean;
  customMessage?: string;
}

// Configure axios to include credentials with every request
axios.defaults.withCredentials = true;

// Add type declaration for Google Identity Services
declare global {
  interface Window {
    google: {
      accounts: {
        id: {
          initialize: (config: any) => void;
          renderButton: (element: HTMLElement, options: any) => void;
          prompt: (callback?: () => void) => void;
        };
        oauth2: {
          initTokenClient: (config: any) => any;
        };
      };
    };
  }
}

interface YoutubeUploadProps {
  onUploadSuccess: () => void;
}

interface ProcessingResult {
  videoTitle: string;
  totalChunks: number;
  videoId: string;
}

const YoutubeUpload = ({ onUploadSuccess }: YoutubeUploadProps) => {
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingMessage, setProcessingMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  const [processingResult, setProcessingResult] = useState<ProcessingResult | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [checkingAuth, setCheckingAuth] = useState<boolean>(true);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const tokenClientRef = useRef<any>(null);
  
  // Initialize Google Identity Services 
  useEffect(() => {
    const CLIENT_ID = '1027650180838-6ora2sdrjre213ujv9hjah4m8mu3v8ju.apps.googleusercontent.com';
    // YouTube-specific scopes needed for transcript access
    const SCOPES = 'email profile https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/youtube.readonly';
    
    const initializeGoogleAuth = () => {
      if (!window.google) {
        setTimeout(initializeGoogleAuth, 100);
        return;
      }
      
      try {
        // Check if we have a saved token in local storage (for persistence)
        const savedToken = localStorage.getItem('youtube_access_token');
        const tokenExpiry = localStorage.getItem('youtube_token_expiry');
        const currentTime = new Date().getTime();
        
        // Check if token exists and hasn't expired
        if (savedToken && tokenExpiry && parseInt(tokenExpiry) > currentTime) {
          setAccessToken(savedToken);
          setIsAuthenticated(true);
          setCheckingAuth(false);
          
          // Verify token with server immediately
          verifyTokenWithServer(savedToken);
        } else if (savedToken) {
          // Token exists but might be expired, clear it
          localStorage.removeItem('youtube_access_token');
          localStorage.removeItem('youtube_token_expiry');
          setCheckingAuth(false);
        } else {
          setCheckingAuth(false);
        }
        
        // Initialize token client
        tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: SCOPES,
          callback: (response: any) => {
            if (response.error) {
              console.error('Token error:', response.error);
              setError('Failed to authenticate with Google. Please try again.');
              setIsAuthenticated(false);
              return;
            }
            
            if (response.access_token) {
              console.log('Received access token successfully');
              
              // Calculate expiry (typically 1 hour from now)
              const expiryTime = new Date().getTime() + (response.expires_in || 3600) * 1000;
              
              // Save the token with expiry
              setAccessToken(response.access_token);
              localStorage.setItem('youtube_access_token', response.access_token);
              localStorage.setItem('youtube_token_expiry', expiryTime.toString());
              setIsAuthenticated(true);
              setError(null);
              
              // Verify token with server
              verifyTokenWithServer(response.access_token);
            }
          }
        });
      } catch (err) {
        console.error('Error initializing Google auth:', err);
        setCheckingAuth(false);
      }
    };
    
    // Verify token with server
    const verifyTokenWithServer = (token: string) => {
      axios.post('/api/auth/google/token', { 
        access_token: token 
      })
      .then(response => {
        console.log('Token verification successful:', response.data);
        // Ensure we update state to indicate successful authentication
        setIsAuthenticated(true);
      })
      .catch(err => {
        console.error('Error sending token to server:', err);
        if (err.response) {
          console.error('Server response:', err.response.data);
        }
        // If server validation fails, reset the state
        setIsAuthenticated(false);
        localStorage.removeItem('youtube_access_token');
        localStorage.removeItem('youtube_token_expiry');
        setError('Server failed to validate your authentication. Please try again.');
      });
    };
    
    initializeGoogleAuth();
  }, []);
  
  const handleAuthenticate = () => {
    if (tokenClientRef.current) {
      // Request a token with prompt
      tokenClientRef.current.requestAccessToken({ prompt: 'consent' });
    } else {
      setError('Google authentication is not initialized yet. Please try again in a moment.');
    }
  };
  
  const handleSignOut = () => {
    // Clear token and state
    setAccessToken(null);
    setIsAuthenticated(false);
    localStorage.removeItem('youtube_access_token');
    localStorage.removeItem('youtube_token_expiry');
    
    // Sign out from server
    axios.post('/api/auth/logout').catch(err => {
      console.error('Error signing out from server:', err);
    });
  };
  
  const handleDomainChange = (domain: string) => {
    setSelectedDomains(prev => 
      prev.includes(domain) 
        ? prev.filter(d => d !== domain) 
        : [...prev, domain]
    );
  };
  
  const isValidYoutubeUrl = (url: string): boolean => {
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})(\S*)?$/;
    return youtubeRegex.test(url);
  };
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!youtubeUrl) {
      setError('Please enter a YouTube URL');
      return;
    }
    
    if (!isValidYoutubeUrl(youtubeUrl)) {
      setError('Please enter a valid YouTube URL');
      return;
    }
    
    setIsProcessing(true);
    setError(null);
    setProcessingResult(null);
    setProcessingMessage('Processing YouTube transcript. This might take a few minutes for longer videos...');
    
    try {
      // Add token to the request if authenticated
      const headers = accessToken ? { 
        Authorization: `Bearer ${accessToken}` 
      } : undefined;
      
      const response = await axios.post('/api/youtube/process', {
        youtubeUrl,
        domains: selectedDomains
      }, { headers });
      
      // Clear the processing message
      setProcessingMessage(null);
      
      // Store the processing result
      setProcessingResult({
        videoTitle: response.data.videoTitle,
        totalChunks: response.data.totalChunks,
        videoId: response.data.videoId
      });
      
      onUploadSuccess();
      setYoutubeUrl('');
      setSelectedDomains([]);
    } catch (err) {
      setProcessingMessage(null);
      if (axios.isAxiosError(err) && err.response) {
        // Check if the error is due to authentication
        if (err.response.status === 401) {
          setError('Authentication required to access YouTube transcripts. Please sign in with Google.');
          setIsAuthenticated(false);
          localStorage.removeItem('youtube_access_token');
          localStorage.removeItem('youtube_token_expiry');
        } else {
          // More detailed error message including the server response
          const serverErrorMsg = err.response.data.error || err.response.data.message || 'Unknown server error';
          setError(`Failed to process YouTube transcript: ${serverErrorMsg}`);
        }
        console.error('Response error:', err.response.data);
      } else if (axios.isAxiosError(err) && err.request) {
        // Network error handling
        const networkErr = err as CustomAxiosError;
        if (networkErr.isTimeout) {
          setError(networkErr.customMessage || 'The request timed out. YouTube transcript extraction can take longer for some videos. Please try again or try with a shorter video.');
        } else if (networkErr.isNetworkError) {
          setError(networkErr.customMessage || 'Network connection error. Please check your internet connection and try again.');
        } else {
          setError('Server not responding. Please check your connection or try again later.');
        }
        console.error('Request error:', err.request);
      } else {
        setError('An unexpected error occurred while processing the video');
        console.error('Error:', err);
      }
    } finally {
      setIsProcessing(false);
    }
  };
  
  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="p-4">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Process YouTube Video</h3>
        
        <div className="mb-4 bg-blue-50 border border-blue-400 text-blue-700 px-4 py-3 rounded text-sm">
          <p className="font-medium">About YouTube Transcripts</p>
          <p className="mt-1">While authentication helps access some YouTube captions, certain videos may have restricted transcripts. The system will attempt multiple methods to extract content, including direct webpage extraction if the API fails.</p>
          <p className="mt-1 font-medium">Note: Extracting transcripts via web scraping can take several minutes for longer videos.</p>
        </div>
        
        {processingMessage && (
          <div className="mb-4 bg-yellow-50 border border-yellow-400 text-yellow-700 px-4 py-3 rounded">
            <div className="flex items-center">
              <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-yellow-700" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <p>{processingMessage}</p>
            </div>
            <p className="mt-2 text-sm">Please don't close this window. This operation can take longer for videos with web-based extraction.</p>
          </div>
        )}
        
        {error && (
          <div className="mb-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
            {error}
            {error.includes('connection') && (
              <div className="mt-2 text-sm">
                <p><strong>Troubleshooting:</strong></p>
                <ul className="list-disc pl-5">
                  <li>Verify your internet connection is working properly</li>
                  <li>Check if the server is running (typically on port 3001)</li>
                  <li>Try refreshing the page and attempting again</li>
                </ul>
              </div>
            )}
            {error.includes('timed out') && (
              <div className="mt-2 text-sm">
                <p><strong>Troubleshooting:</strong></p>
                <ul className="list-disc pl-5">
                  <li>Try processing a shorter video</li>
                  <li>Ensure the video has captions available</li>
                  <li>Try authenticating with Google for better access</li>
                  <li>Wait a few minutes and try again</li>
                </ul>
              </div>
            )}
          </div>
        )}
        
        {processingResult && (
          <div className="mb-4 bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded">
            <p><strong>Successfully processed:</strong> {processingResult.videoTitle}</p>
            <p className="text-sm">Created {processingResult.totalChunks} chunks for vector embedding</p>
            <a 
              href={`https://www.youtube.com/watch?v=${processingResult.videoId}`} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline text-sm"
            >
              View on YouTube
            </a>
          </div>
        )}
        
        {/* YouTube Authentication Button */}
        {!checkingAuth && !isAuthenticated && (
          <div className="mb-4 bg-yellow-50 border border-yellow-400 text-yellow-700 px-4 py-3 rounded">
            <p className="mb-2">Sign in with Google for better YouTube transcript access (recommended but optional).</p>
            <button
              type="button"
              onClick={handleAuthenticate}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
            >
              <FiYoutube className="mr-2" /> Sign in with Google
            </button>
          </div>
        )}
        
        {!checkingAuth && isAuthenticated && (
          <div className="mb-4 bg-green-50 border border-green-400 text-green-700 px-4 py-3 rounded flex justify-between items-center">
            <p>✓ YouTube authenticated (improved transcript access)</p>
            <button
              type="button"
              onClick={handleSignOut}
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              Sign out
            </button>
          </div>
        )}
        
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="youtubeUrl" className="block text-sm font-medium text-gray-700 mb-1">
              YouTube URL
            </label>
            <div className="flex items-center">
              <div className="relative flex-grow">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <FiYoutube className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  type="text"
                  id="youtubeUrl"
                  className="focus:ring-blue-500 focus:border-blue-500 block w-full pl-10 pr-12 sm:text-sm border-gray-300 rounded-md"
                  placeholder="https://www.youtube.com/watch?v=..."
                  value={youtubeUrl}
                  onChange={(e) => setYoutubeUrl(e.target.value)}
                  disabled={isProcessing}
                />
              </div>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Enter a YouTube video URL to extract and process its transcript
            </p>
          </div>
          
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Select Knowledge Domains
            </label>
            <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {availableDomains.map((domain) => (
                <div key={domain} className="flex items-center">
                  <input
                    id={`domain-${domain}`}
                    name="domains"
                    type="checkbox"
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    checked={selectedDomains.includes(domain)}
                    onChange={() => handleDomainChange(domain)}
                    disabled={isProcessing}
                  />
                  <label
                    htmlFor={`domain-${domain}`}
                    className="ml-2 block text-sm text-gray-700"
                  >
                    {domain}
                  </label>
                </div>
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Select relevant knowledge domains for better embedding
            </p>
          </div>
          
          <div className="flex justify-end">
            <button
              type="submit"
              className={`inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 ${
                isProcessing ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              disabled={isProcessing}
            >
              {isProcessing ? 'Processing...' : 'Process Video'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default YoutubeUpload; 
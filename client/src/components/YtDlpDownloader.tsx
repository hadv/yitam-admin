import { useState, useEffect } from 'react';
import axios from 'axios';
import { FiDownload, FiTrash2, FiInfo, FiAlertCircle, FiCheckCircle } from 'react-icons/fi';
import { socketService } from '../services/socketService';
import { ProgressStage, ProgressUpdate } from '../types/progress';
import { availableDomains } from '../constants/domains';

interface YtDlpVideoInfo {
  videoId: string;
  title: string;
  description: string;
  duration: number;
  thumbnail: string;
  uploader: string;
  viewCount: number;
  uploadDate: string;
  isLive: boolean;
  isMemberOnly: boolean;
  availability: string;
}

interface CookiesFile {
  fileName: string;
}

interface EnhancedVideoMetadata {
  originalMetadata: YtDlpVideoInfo;
  enhancedTitle: string;
  enhancedSummary: string;
  contentBasedTitle?: string;
  contentBasedSummary?: string;
  keyTopics: string[];
  contentTags: string[];
  keyQuotes?: string[];
  enhancementSource: 'transcript' | 'metadata' | 'combined';
  language: string;
  confidence: number;
  processingTime: number;
  audioTranscript?: string; // Raw audio transcript text
  enhancedTranscript?: string; // LLM-enhanced transcript
  transcriptWordCount?: number; // Word count for quality assessment
}

interface DownloadResult {
  fileName: string;
  filePath: string;
  videoInfo: YtDlpVideoInfo;
  enhancedMetadata?: EnhancedVideoMetadata;
}

const YtDlpDownloader = ({ onUploadSuccess }: { onUploadSuccess: () => void }) => {
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [isYtDlpInstalled, setIsYtDlpInstalled] = useState<boolean | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadMessage, setDownloadMessage] = useState('');
  const [downloadResult, setDownloadResult] = useState<DownloadResult | null>(null);
  const [videoInfo, setVideoInfo] = useState<YtDlpVideoInfo | null>(null);
  const [isLoadingInfo, setIsLoadingInfo] = useState(false);
  const [useEnhancedMetadata, setUseEnhancedMetadata] = useState(true);
  const [useAudioTranscription, setUseAudioTranscription] = useState(true);
  const [forceAudioTranscription, setForceAudioTranscription] = useState(false);
  const [useAudioOnly, setUseAudioOnly] = useState(false);
  const [embedAudioTranscript, setEmbedAudioTranscript] = useState(true);
  const [selectedDomains, setSelectedDomains] = useState<string[]>(['youtube', 'audio']);
  const [transcriptCopied, setTranscriptCopied] = useState(false);
  const [activeTranscriptTab, setActiveTranscriptTab] = useState<'raw' | 'enhanced'>('enhanced');
  const [transcriptCleaningLevel, setTranscriptCleaningLevel] = useState<'basic' | 'aggressive'>('aggressive');

  // Copy transcript to clipboard
  const copyTranscriptToClipboard = async (transcript: string) => {
    try {
      await navigator.clipboard.writeText(transcript);
      setTranscriptCopied(true);
      setTimeout(() => setTranscriptCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy transcript:', err);
    }
  };

  // Handle domain selection
  const handleDomainChange = (domain: string) => {
    setSelectedDomains(prev =>
      prev.includes(domain)
        ? prev.filter(d => d !== domain)
        : [...prev, domain]
    );
  };

  // Cookies management
  const [cookiesFiles, setCookiesFiles] = useState<CookiesFile[]>([]);
  const [selectedCookiesFile, setSelectedCookiesFile] = useState<string>('');
  const [isUploadingCookies, setIsUploadingCookies] = useState(false);
  const [cookiesUploadMessage, setCookiesUploadMessage] = useState('');
  const [cookiesFromBrowser, setCookiesFromBrowser] = useState('chrome');
  const [cookieMethod, setCookieMethod] = useState<'file' | 'browser'>('browser');
  const [browserProfiles, setBrowserProfiles] = useState<{ name: string, email: string }[]>([]);
  const [selectedBrowserProfile, setSelectedBrowserProfile] = useState<string>('');
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);

  // Download options
  const [downloadOptions, setDownloadOptions] = useState({
    quality: 'auto', // Default to yt-dlp's automatic format selection (usually MKV)
    audioOnly: false,
    extractAudio: false,
    audioFormat: 'mp3' as 'mp3' | 'aac' | 'flac' | 'wav'
  });

  useEffect(() => {
    checkYtDlpStatus();
    loadCookiesFiles();
  }, []);

  useEffect(() => {
    if (cookieMethod === 'browser' && cookiesFromBrowser) {
      loadBrowserProfiles();
    }
  }, [cookieMethod, cookiesFromBrowser]);

  const loadBrowserProfiles = async () => {
    setIsLoadingProfiles(true);
    try {
      const response = await axios.get(`/api/youtube/yt-dlp/profiles?browser=${cookiesFromBrowser}`);
      setBrowserProfiles(response.data.profiles);
      // Automatically select Profile 9 if it exists as it's often the desired one
      if (response.data.profiles.some((p: any) => p.name === 'Profile 9')) {
        setSelectedBrowserProfile('Profile 9');
      } else if (response.data.profiles.length > 0) {
        setSelectedBrowserProfile(response.data.profiles[0].name);
      } else {
        setSelectedBrowserProfile('');
      }
    } catch (error) {
      console.error('Error loading browser profiles:', error);
      setBrowserProfiles([]);
    } finally {
      setIsLoadingProfiles(false);
    }
  };

  const checkYtDlpStatus = async () => {
    try {
      const response = await axios.get('/api/youtube/yt-dlp/status');
      setIsYtDlpInstalled(response.data.installed);
    } catch (error) {
      console.error('Error checking yt-dlp status:', error);
      setIsYtDlpInstalled(false);
    }
  };

  const loadCookiesFiles = async () => {
    try {
      const response = await axios.get('/api/youtube/cookies');
      setCookiesFiles(response.data.files.map((fileName: string) => ({ fileName })));
    } catch (error) {
      console.error('Error loading cookies files:', error);
    }
  };

  const handleCookiesUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.txt')) {
      setCookiesUploadMessage('Please select a .txt file');
      return;
    }

    setIsUploadingCookies(true);
    setCookiesUploadMessage('');

    try {
      const formData = new FormData();
      formData.append('cookiesFile', file);

      const response = await axios.post('/api/youtube/cookies/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      setCookiesUploadMessage('Cookies file uploaded successfully!');
      setSelectedCookiesFile(response.data.fileName);
      await loadCookiesFiles();

      // Clear the file input
      event.target.value = '';
    } catch (error: any) {
      console.error('Error uploading cookies file:', error);
      setCookiesUploadMessage(error.response?.data?.message || 'Failed to upload cookies file');
    } finally {
      setIsUploadingCookies(false);
    }
  };

  const deleteCookiesFile = async (fileName: string) => {
    try {
      await axios.delete(`/api/youtube/cookies/${fileName}`);
      await loadCookiesFiles();
      if (selectedCookiesFile === fileName) {
        setSelectedCookiesFile('');
      }
    } catch (error) {
      console.error('Error deleting cookies file:', error);
    }
  };

  const getVideoInfo = async () => {
    if (!youtubeUrl.trim()) {
      alert('Please enter a YouTube URL');
      return;
    }

    setIsLoadingInfo(true);
    setVideoInfo(null);

    try {
      const response = await axios.post('/api/youtube/yt-dlp/info', {
        youtubeUrl,
        cookiesFileName: cookieMethod === 'file' ? selectedCookiesFile || undefined : undefined,
        cookiesFromBrowser: cookieMethod === 'browser' ? cookiesFromBrowser : undefined,
        browserProfile: cookieMethod === 'browser' ? selectedBrowserProfile || undefined : undefined
      });

      setVideoInfo(response.data.videoInfo);
    } catch (error: any) {
      console.error('Error getting video info:', error);
      alert(error.response?.data?.message || 'Failed to get video information');
    } finally {
      setIsLoadingInfo(false);
    }
  };

  const downloadVideo = async () => {
    if (!youtubeUrl.trim()) {
      alert('Please enter a YouTube URL');
      return;
    }

    if (!isYtDlpInstalled) {
      alert('yt-dlp is not installed. Please install yt-dlp first.');
      return;
    }

    // Extract video ID for progress tracking
    const extractYouTubeId = (url: string): string | null => {
      const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
      const match = url.match(regex);
      return match ? match[1] : null;
    };

    const videoId = extractYouTubeId(youtubeUrl);
    if (!videoId) {
      alert('Invalid YouTube URL');
      return;
    }

    setIsDownloading(true);
    setDownloadProgress(0);
    setDownloadMessage('Preparing download...');
    setDownloadResult(null);

    // Declare progress interval variable
    let progressInterval: NodeJS.Timeout | null = null;

    try {
      // Connect to socket and set up progress tracking
      const socketConnected = await socketService.connect();
      if (!socketConnected) {
        console.warn('Could not establish socket connection for progress tracking');
      }

      const socketId = socketService.getSocketId();
      console.log('Using socket ID for yt-dlp download tracking:', socketId);

      // Register progress listener for this video
      if (socketConnected) {
        console.log(`📡 Registering progress listener for video ${videoId}`);
        socketService.registerProgressListener(videoId, (update: ProgressUpdate) => {
          console.log(`🔄 yt-dlp progress update received for ${videoId}:`, update);

          // Handle yt-dlp download progress
          if (update.stage === ProgressStage.TRANSCRIPT_FETCH) {
            console.log(`📊 Updating progress: ${update.progress}% - ${update.message}`);
            setDownloadMessage(update.message);
            setDownloadProgress(update.progress || 0);
          } else if (update.stage === ProgressStage.COMPLETED) {
            console.log('🎉 Download completed via socket');
            setDownloadMessage('Download completed successfully!');
            setDownloadProgress(100);
            setIsDownloading(false);
          } else if (update.stage === ProgressStage.ERROR) {
            console.log('❌ Download error via socket:', update.message);
            setDownloadMessage(`Error: ${update.message}`);
            setIsDownloading(false);
          }
        });
      } else {
        console.log('⚠️ Socket not connected, progress tracking may be limited');
      }

      // Start a fallback progress simulation if socket fails
      if (!socketConnected) {
        console.log('🔄 Starting fallback progress simulation');
        let simulatedProgress = 0;
        progressInterval = setInterval(() => {
          simulatedProgress += Math.random() * 5; // Random progress increment
          if (simulatedProgress > 95) {
            simulatedProgress = 95; // Cap at 95% until real completion
          }
          setDownloadProgress(simulatedProgress);
          setDownloadMessage(`Downloading... ${simulatedProgress.toFixed(1)}%`);
        }, 1000);
      }

      const endpoint = useEnhancedMetadata ? '/api/youtube/yt-dlp/download-enhanced' : '/api/youtube/yt-dlp/download';
      const requestBody: any = {
        youtubeUrl,
        socketId,
        cookiesFileName: cookieMethod === 'file' ? selectedCookiesFile || undefined : undefined,
        cookiesFromBrowser: cookieMethod === 'browser' ? cookiesFromBrowser : undefined,
        browserProfile: cookieMethod === 'browser' ? selectedBrowserProfile || undefined : undefined,
        options: downloadOptions,
        useAudioOnly: useAudioOnly
      };

      // Add enhancement options if using enhanced endpoint
      if (useEnhancedMetadata) {
        requestBody.enhancementOptions = {
          includeChapters: true,
          includeKeyQuotes: true,
          maxKeyTopics: 8,
          maxContentTags: 12,
          temperature: 0.3,
          languagePreference: 'auto',
          useAudioTranscription: useAudioTranscription,
          forceAudioTranscription: forceAudioTranscription,
          transcriptCleaningLevel: transcriptCleaningLevel,
          embedAudioTranscript: embedAudioTranscript,
          domains: embedAudioTranscript ? selectedDomains : undefined,
          audioTranscriptionOptions: {
            languageCode: 'vi-VN',
            enableAutomaticPunctuation: true,
            useEnhancedModel: true
          }
        };
      }

      const response = await axios.post(endpoint, requestBody);

      console.log('yt-dlp download completed:', response.data);

      // Clear fallback interval if it exists
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }

      setDownloadMessage('Download completed successfully!');
      setDownloadProgress(100);
      setIsDownloading(false);

      setDownloadResult({
        fileName: response.data.fileName,
        filePath: response.data.filePath,
        videoInfo: response.data.videoInfo,
        enhancedMetadata: response.data.enhancedMetadata
      });

      setYoutubeUrl('');
      setVideoInfo(null);
      onUploadSuccess();

    } catch (error: any) {
      console.error('Error downloading video with yt-dlp:', error);

      // Clear fallback interval if it exists
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }

      setDownloadMessage(error.response?.data?.message || 'Download failed');
      setIsDownloading(false);
    } finally {
      // Clean up progress listener
      if (videoId) {
        socketService.unregisterProgressListener(videoId);
      }

      // Ensure fallback interval is cleared
      if (progressInterval) {
        clearInterval(progressInterval);
      }
    }
  };

  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const formatNumber = (num: number): string => {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  };

  if (isYtDlpInstalled === null) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-2">Checking yt-dlp status...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* yt-dlp Status */}
      <div className={`p-4 rounded-lg border ${isYtDlpInstalled ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
        <div className="flex items-center">
          {isYtDlpInstalled ? (
            <FiCheckCircle className="h-5 w-5 text-green-600 mr-2" />
          ) : (
            <FiAlertCircle className="h-5 w-5 text-red-600 mr-2" />
          )}
          <span className={`font-medium ${isYtDlpInstalled ? 'text-green-800' : 'text-red-800'}`}>
            {isYtDlpInstalled ? 'yt-dlp is available' : 'yt-dlp is not installed'}
          </span>
        </div>
        {!isYtDlpInstalled && (
          <p className="mt-2 text-sm text-red-700">
            Please install yt-dlp to download member-only videos: <code>pip install yt-dlp</code>
          </p>
        )}
      </div>

      {/* Cookies Management */}
      <div className="border border-gray-200 rounded-lg p-4">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Browser Cookies (for Member-Only Videos)</h3>

        {/* Cookie Method Selection */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Cookie Method
          </label>
          <div className="flex space-x-4">
            <label className="flex items-center">
              <input
                type="radio"
                value="browser"
                checked={cookieMethod === 'browser'}
                onChange={(e) => setCookieMethod(e.target.value as 'file' | 'browser')}
                className="mr-2"
              />
              <span className="text-sm text-gray-700">Use Live Browser Cookies (Recommended)</span>
            </label>
            <label className="flex items-center">
              <input
                type="radio"
                value="file"
                checked={cookieMethod === 'file'}
                onChange={(e) => setCookieMethod(e.target.value as 'file' | 'browser')}
                className="mr-2"
              />
              <span className="text-sm text-gray-700">Upload Cookie File</span>
            </label>
          </div>
        </div>

        {/* Browser Selection (when using live cookies) */}
        {cookieMethod === 'browser' && (
          <>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Select Browser
              </label>
              <select
                value={cookiesFromBrowser}
                onChange={(e) => setCookiesFromBrowser(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="chrome">Google Chrome</option>
                <option value="firefox">Mozilla Firefox</option>
                <option value="safari">Safari</option>
                <option value="edge">Microsoft Edge</option>
              </select>
            </div>

            {/* Profile Selection */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Select Browser Profile
              </label>
              <div className="flex items-center space-x-2">
                <select
                  value={selectedBrowserProfile}
                  onChange={(e) => setSelectedBrowserProfile(e.target.value)}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  disabled={isLoadingProfiles}
                >
                  <option value="">Default Profile</option>
                  {browserProfiles.map((profile) => (
                    <option key={profile.name} value={profile.name}>
                      {profile.name} {profile.email ? `(${profile.email})` : ''}
                    </option>
                  ))}
                </select>
                {isLoadingProfiles && (
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                )}
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Logged in as: <strong>{browserProfiles.find(p => p.name === selectedBrowserProfile)?.email || 'Unknown'}</strong>
              </p>
            </div>

            <p className="mb-4 text-xs text-gray-500">
              Make sure you're logged into YouTube in the selected browser and profile
            </p>
          </>
        )}

        {/* Upload Cookies (when using file method) */}
        {cookieMethod === 'file' && (
          <>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Upload Browser Cookies File (.txt)
              </label>
              <div className="flex items-center space-x-2">
                <input
                  type="file"
                  accept=".txt"
                  onChange={handleCookiesUpload}
                  disabled={isUploadingCookies}
                  className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                />
                {isUploadingCookies && (
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                )}
              </div>
              {cookiesUploadMessage && (
                <p className={`mt-2 text-sm ${cookiesUploadMessage.includes('successfully') ? 'text-green-600' : 'text-red-600'}`}>
                  {cookiesUploadMessage}
                </p>
              )}
            </div>

            {/* Select Cookies File */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Select Cookies File
              </label>
              <select
                value={selectedCookiesFile}
                onChange={(e) => setSelectedCookiesFile(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">No cookies (public videos only)</option>
                {cookiesFiles.map((file) => (
                  <option key={file.fileName} value={file.fileName}>
                    {file.fileName}
                  </option>
                ))}
              </select>
            </div>

            {/* Cookies Files List */}
            {cookiesFiles.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-2">Available Cookies Files</h4>
                <div className="space-y-2">
                  {cookiesFiles.map((file) => (
                    <div key={file.fileName} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                      <span className="text-sm text-gray-700">{file.fileName}</span>
                      <button
                        onClick={() => deleteCookiesFile(file.fileName)}
                        className="text-red-600 hover:text-red-800"
                        title="Delete cookies file"
                      >
                        <FiTrash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Download Options */}
      <div className="border border-gray-200 rounded-lg p-4">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Download Options</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Quality */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Quality
            </label>
            <select
              value={downloadOptions.quality}
              onChange={(e) => setDownloadOptions(prev => ({ ...prev, quality: e.target.value }))}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="auto">🎯 Auto (Highest Quality) - Usually MKV/WebM</option>
              <option value="best[ext=mkv]">🏆 Best Quality (MKV Only) - Force MKV</option>
              <option value="best[ext=mkv]/best">🥇 Best Quality (MKV Preferred)</option>
              <option value="bestvideo[ext=mp4]+bestaudio[ext=m4a]">📱 Best MP4 Quality (Separate Streams)</option>
              <option value="best[ext=mp4]/best">📱 Best MP4 (May be lower quality)</option>
              <option value="best[ext=mkv][height<=1440]">🎬 1440p MKV Only</option>
              <option value="best[ext=mkv][height<=1080]">📺 1080p MKV Only</option>
              <option value="best[ext=mkv][height<=720]">📱 720p MKV Only</option>
              <option value="best[ext=mp4][height<=1080]">📱 1080p MP4 Only</option>
              <option value="best[ext=mp4][height<=720]">📱 720p MP4 Only</option>
              <option value="worst[ext=mp4]/worst">⚡ Smallest File (MP4)</option>
              <option value="best[height<=720]">📱 720p or lower (Any format)</option>
              <option value="best[height<=480]">📱 480p or lower (Any format)</option>
              <option value="best[height<=360]">📱 360p or lower (Any format)</option>
            </select>
            <div className="mt-2 text-sm text-gray-600">
              <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
                <div className="flex items-start">
                  <div className="flex-shrink-0">
                    <svg className="h-5 w-5 text-blue-400" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div className="ml-3">
                    <h4 className="text-sm font-medium text-blue-800">Quality Guide</h4>
                    <div className="mt-1 text-sm text-blue-700">
                      <p><strong>Highest Quality:</strong> Auto or MKV options (may use VP9/AV1 codecs)</p>
                      <p><strong>MP4 Compatibility:</strong> MP4 options prioritize compatibility but may have lower quality than MKV/WebM</p>
                      <p><strong>Best MP4:</strong> "Separate Streams" option provides highest quality MP4 by merging best video + audio</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Audio Options */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Audio Options
            </label>
            <div className="space-y-2">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={downloadOptions.audioOnly}
                  onChange={(e) => setDownloadOptions(prev => ({
                    ...prev,
                    audioOnly: e.target.checked,
                    extractAudio: e.target.checked ? false : prev.extractAudio
                  }))}
                  className="rounded border-gray-300 text-blue-600 shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50"
                />
                <span className="ml-2 text-sm text-gray-700">Audio Only</span>
              </label>

              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={downloadOptions.extractAudio}
                  onChange={(e) => setDownloadOptions(prev => ({
                    ...prev,
                    extractAudio: e.target.checked,
                    audioOnly: e.target.checked ? false : prev.audioOnly
                  }))}
                  className="rounded border-gray-300 text-blue-600 shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50"
                />
                <span className="ml-2 text-sm text-gray-700">Extract Audio from Video</span>
              </label>
            </div>
          </div>

          {/* Audio Format */}
          {(downloadOptions.audioOnly || downloadOptions.extractAudio) && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Audio Format
              </label>
              <select
                value={downloadOptions.audioFormat}
                onChange={(e) => setDownloadOptions(prev => ({
                  ...prev,
                  audioFormat: e.target.value as 'mp3' | 'aac' | 'flac' | 'wav'
                }))}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="mp3">MP3</option>
                <option value="aac">AAC</option>
                <option value="flac">FLAC</option>
                <option value="wav">WAV</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* URL Input and Actions */}
      <div className="border border-gray-200 rounded-lg p-4">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Download Video</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              YouTube URL
            </label>
            <input
              type="url"
              value={youtubeUrl}
              onChange={(e) => setYoutubeUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              disabled={isDownloading}
            />
          </div>

          {/* Enhanced Metadata Toggle */}
          <div className="space-y-2">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={useEnhancedMetadata}
                onChange={(e) => setUseEnhancedMetadata(e.target.checked)}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                disabled={isDownloading}
              />
              <span className="ml-2 text-sm text-gray-700">
                Generate enhanced metadata with AI
              </span>
            </label>

            {/* Audio-Only Option */}
            {useEnhancedMetadata && (
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={useAudioOnly}
                  onChange={(e) => {
                    setUseAudioOnly(e.target.checked);
                    if (e.target.checked) {
                      // Auto-enable audio transcription when audio-only is selected
                      setUseAudioTranscription(true);
                      setForceAudioTranscription(true);
                    }
                  }}
                  className="h-4 w-4 text-red-600 focus:ring-red-500 border-gray-300 rounded"
                  disabled={isDownloading}
                />
                <span className="ml-2 text-sm font-medium text-red-700">
                  🔥 AUDIO-ONLY MODE (no transcript fallback)
                </span>
              </label>
            )}

            {useEnhancedMetadata && !useAudioOnly && (
              <div className="ml-6 space-y-2">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={useAudioTranscription}
                    onChange={(e) => setUseAudioTranscription(e.target.checked)}
                    className="h-4 w-4 text-green-600 focus:ring-green-500 border-gray-300 rounded"
                    disabled={isDownloading}
                  />
                  <span className="ml-2 text-sm text-gray-600">
                    🎵 Use audio transcription (higher accuracy)
                  </span>
                </label>

                {useAudioTranscription && (
                  <div className="ml-6 space-y-2">
                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={forceAudioTranscription}
                        onChange={(e) => setForceAudioTranscription(e.target.checked)}
                        className="h-4 w-4 text-red-600 focus:ring-red-500 border-gray-300 rounded"
                        disabled={isDownloading}
                      />
                      <span className="ml-2 text-sm text-gray-600">
                        🔥 Force audio transcription (skip YouTube transcript)
                      </span>
                    </label>

                    {/* Transcript Cleaning Level */}
                    <div className="ml-6">
                      <label className="block text-xs text-gray-600 mb-1">
                        🧹 Transcript cleaning level:
                      </label>
                      <select
                        value={transcriptCleaningLevel}
                        onChange={(e) => setTranscriptCleaningLevel(e.target.value as 'basic' | 'aggressive')}
                        className="text-xs border border-gray-300 rounded px-2 py-1 bg-white"
                        disabled={isDownloading}
                      >
                        <option value="aggressive">🔥 Aggressive (Remove all irrelevant content)</option>
                        <option value="basic">📝 Basic (Fix grammar only)</option>
                      </select>
                    </div>

                    {/* Embed Audio Transcript Option */}
                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={embedAudioTranscript}
                        onChange={(e) => setEmbedAudioTranscript(e.target.checked)}
                        className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        disabled={isDownloading}
                      />
                      <span className="ml-2 text-sm text-gray-600">
                        🔗 Embed audio transcript for search (store in vector database)
                      </span>
                    </label>

                    {/* Knowledge Domains Selection */}
                    {embedAudioTranscript && (
                      <div className="ml-6 mt-2">
                        <label className="block text-xs text-gray-600 mb-2">
                          🎯 Select Knowledge Domains:
                        </label>
                        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4 max-h-32 overflow-y-auto">
                          {availableDomains.map((domain) => (
                            <div key={domain} className="flex items-center">
                              <input
                                id={`domain-${domain}`}
                                name="domains"
                                type="checkbox"
                                className="h-3 w-3 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                                checked={selectedDomains.includes(domain)}
                                onChange={() => handleDomainChange(domain)}
                                disabled={isDownloading}
                              />
                              <label
                                htmlFor={`domain-${domain}`}
                                className="ml-1 block text-xs text-gray-600"
                              >
                                {domain}
                              </label>
                            </div>
                          ))}
                        </div>
                        {selectedDomains.length === 0 && (
                          <p className="mt-1 text-xs text-red-500">
                            Select at least one domain to categorize your content
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Audio-Only Cleaning Level */}
            {useEnhancedMetadata && useAudioOnly && (
              <div className="ml-6 space-y-2">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">
                    🧹 Transcript cleaning level:
                  </label>
                  <select
                    value={transcriptCleaningLevel}
                    onChange={(e) => setTranscriptCleaningLevel(e.target.value as 'basic' | 'aggressive')}
                    className="text-xs border border-gray-300 rounded px-2 py-1 bg-white"
                    disabled={isDownloading}
                  >
                    <option value="aggressive">🔥 Aggressive (Remove all irrelevant content)</option>
                    <option value="basic">📝 Basic (Fix grammar only)</option>
                  </select>
                </div>

                {/* Embed Audio Transcript Option for Audio-Only Mode */}
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={embedAudioTranscript}
                    onChange={(e) => setEmbedAudioTranscript(e.target.checked)}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    disabled={isDownloading}
                  />
                  <span className="ml-2 text-sm text-gray-600">
                    🔗 Embed audio transcript for search (store in vector database)
                  </span>
                </label>

                {/* Knowledge Domains Selection for Audio-Only Mode */}
                {embedAudioTranscript && (
                  <div className="ml-6 mt-2">
                    <label className="block text-xs text-gray-600 mb-2">
                      🎯 Select Knowledge Domains:
                    </label>
                    <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4 max-h-32 overflow-y-auto">
                      {availableDomains.map((domain) => (
                        <div key={domain} className="flex items-center">
                          <input
                            id={`audio-domain-${domain}`}
                            name="audio-domains"
                            type="checkbox"
                            className="h-3 w-3 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                            checked={selectedDomains.includes(domain)}
                            onChange={() => handleDomainChange(domain)}
                            disabled={isDownloading}
                          />
                          <label
                            htmlFor={`audio-domain-${domain}`}
                            className="ml-1 block text-xs text-gray-600"
                          >
                            {domain}
                          </label>
                        </div>
                      ))}
                    </div>
                    {selectedDomains.length === 0 && (
                      <p className="mt-1 text-xs text-red-500">
                        Select at least one domain to categorize your content
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex space-x-3">
            <button
              onClick={getVideoInfo}
              disabled={isLoadingInfo || isDownloading || !youtubeUrl.trim() || !isYtDlpInstalled}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-blue-700 bg-blue-100 hover:bg-blue-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoadingInfo ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600 mr-2"></div>
              ) : (
                <FiInfo className="h-4 w-4 mr-2" />
              )}
              Get Info
            </button>

            <button
              onClick={downloadVideo}
              disabled={isDownloading || !youtubeUrl.trim() || !isYtDlpInstalled}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isDownloading ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
              ) : (
                <FiDownload className="h-4 w-4 mr-2" />
              )}
              {useEnhancedMetadata
                ? (useAudioOnly
                  ? 'Download with AUDIO-ONLY Enhancement'
                  : (forceAudioTranscription
                    ? 'Download with Force Audio Transcription'
                    : (useAudioTranscription
                      ? 'Download with Enhanced Metadata + Audio'
                      : 'Download with Enhanced Metadata')))
                : 'Download with yt-dlp'}
            </button>
          </div>
        </div>
      </div>

      {/* Video Info Display */}
      {videoInfo && (
        <div className="border border-gray-200 rounded-lg p-4">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Video Information</h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              {videoInfo.thumbnail && (
                <img
                  src={videoInfo.thumbnail}
                  alt={videoInfo.title}
                  className="w-full h-48 object-cover rounded-lg mb-4"
                />
              )}
            </div>

            <div className="space-y-3">
              <div>
                <h4 className="font-medium text-gray-900">{videoInfo.title}</h4>
                <p className="text-sm text-gray-600">by {videoInfo.uploader}</p>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="font-medium">Duration:</span>
                  <span className="ml-1">{formatDuration(videoInfo.duration)}</span>
                </div>
                <div>
                  <span className="font-medium">Views:</span>
                  <span className="ml-1">{formatNumber(videoInfo.viewCount)}</span>
                </div>
                <div>
                  <span className="font-medium">Upload Date:</span>
                  <span className="ml-1">{videoInfo.uploadDate}</span>
                </div>
                <div>
                  <span className="font-medium">Availability:</span>
                  <span className={`ml-1 ${videoInfo.isMemberOnly ? 'text-red-600 font-medium' : 'text-green-600'}`}>
                    {videoInfo.isMemberOnly ? 'Member Only' : 'Public'}
                  </span>
                </div>
              </div>

              {videoInfo.isMemberOnly && cookieMethod === 'file' && !selectedCookiesFile && (
                <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-md">
                  <div className="flex">
                    <FiAlertCircle className="h-5 w-5 text-yellow-400 mr-2 mt-0.5" />
                    <div>
                      <h4 className="text-sm font-medium text-yellow-800">Member-Only Content</h4>
                      <p className="text-sm text-yellow-700 mt-1">
                        This video requires membership. Please upload browser cookies to download.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Download Progress */}
      {isDownloading && (
        <div className="border border-gray-200 rounded-lg p-4">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Download Progress</h3>

          <div className="space-y-3">
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${downloadProgress}%` }}
              ></div>
            </div>

            <div className="flex justify-between text-sm text-gray-600">
              <span>{downloadMessage}</span>
              <span>{downloadProgress.toFixed(1)}%</span>
            </div>
          </div>
        </div>
      )}

      {/* Download Result */}
      {downloadResult && (
        <div className="border border-green-200 rounded-lg p-4 bg-green-50">
          <h3 className="text-lg font-medium text-green-900 mb-4">Download Completed</h3>

          <div className="space-y-4">
            {/* Basic Info */}
            <div className="space-y-2">
              <p className="text-sm text-green-800">
                <span className="font-medium">File:</span> {downloadResult.fileName}
              </p>
              <p className="text-sm text-green-800">
                <span className="font-medium">Title:</span> {downloadResult.videoInfo.title}
              </p>
              <p className="text-sm text-green-800">
                <span className="font-medium">Uploader:</span> {downloadResult.videoInfo.uploader}
              </p>
            </div>

            {/* Enhanced Metadata */}
            {downloadResult.enhancedMetadata && (
              <div className="border-t border-green-300 pt-4">
                <h4 className="text-md font-medium text-green-900 mb-3">🤖 AI-Enhanced Metadata</h4>

                <div className="space-y-3">
                  {/* Enhancement Info */}
                  <div className="flex items-center space-x-4 text-xs text-green-700">
                    <span className="bg-green-200 px-2 py-1 rounded">
                      Source: {downloadResult.enhancedMetadata.enhancementSource}
                    </span>
                    <span className="bg-green-200 px-2 py-1 rounded">
                      Confidence: {(downloadResult.enhancedMetadata.confidence * 100).toFixed(0)}%
                    </span>
                    <span className="bg-green-200 px-2 py-1 rounded">
                      Language: {downloadResult.enhancedMetadata.language}
                    </span>
                  </div>

                  {/* Enhanced Title */}
                  <div>
                    <p className="text-sm font-medium text-green-800">Enhanced Title:</p>
                    <p className="text-sm text-green-700 italic">"{downloadResult.enhancedMetadata.enhancedTitle}"</p>
                  </div>

                  {/* Enhanced Summary */}
                  <div>
                    <p className="text-sm font-medium text-green-800">Enhanced Summary:</p>
                    <p className="text-sm text-green-700">{downloadResult.enhancedMetadata.enhancedSummary}</p>
                  </div>

                  {/* Content-Based Info (if available) */}
                  {downloadResult.enhancedMetadata.contentBasedTitle && (
                    <div>
                      <p className="text-sm font-medium text-green-800">Content-Based Title:</p>
                      <p className="text-sm text-green-700 italic">"{downloadResult.enhancedMetadata.contentBasedTitle}"</p>
                    </div>
                  )}

                  {downloadResult.enhancedMetadata.contentBasedSummary && (
                    <div>
                      <p className="text-sm font-medium text-green-800">Content-Based Summary:</p>
                      <p className="text-sm text-green-700">{downloadResult.enhancedMetadata.contentBasedSummary}</p>
                    </div>
                  )}

                  {/* Key Topics */}
                  {downloadResult.enhancedMetadata.keyTopics.length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-green-800">Key Topics:</p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {downloadResult.enhancedMetadata.keyTopics.map((topic, index) => (
                          <span key={index} className="bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded">
                            {topic}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Content Tags */}
                  {downloadResult.enhancedMetadata.contentTags.length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-green-800">Content Tags:</p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {downloadResult.enhancedMetadata.contentTags.map((tag, index) => (
                          <span key={index} className="bg-purple-100 text-purple-800 text-xs px-2 py-1 rounded">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Key Quotes */}
                  {downloadResult.enhancedMetadata.keyQuotes && downloadResult.enhancedMetadata.keyQuotes.length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-green-800">Key Quotes:</p>
                      <div className="space-y-1 mt-1">
                        {downloadResult.enhancedMetadata.keyQuotes.map((quote, index) => (
                          <p key={index} className="text-sm text-green-700 italic border-l-2 border-green-300 pl-2">
                            "{quote}"
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Audio Transcript */}
                  {downloadResult.enhancedMetadata.audioTranscript && (
                    <div>
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-green-800">Audio Transcript:</p>
                        <div className="flex items-center space-x-2 text-xs text-green-600">
                          <span className="bg-green-200 px-2 py-1 rounded">
                            {downloadResult.enhancedMetadata.transcriptWordCount} words
                          </span>
                          <span className="bg-blue-200 px-2 py-1 rounded">
                            Quality: {downloadResult.enhancedMetadata.confidence > 0.8 ? 'High' :
                              downloadResult.enhancedMetadata.confidence > 0.6 ? 'Medium' : 'Low'}
                          </span>
                        </div>
                      </div>

                      {/* Transcript Tabs */}
                      <div className="mt-2 flex space-x-1 border-b border-gray-200">
                        <button
                          onClick={() => setActiveTranscriptTab('enhanced')}
                          className={`px-3 py-1 text-xs font-medium rounded-t ${activeTranscriptTab === 'enhanced'
                            ? 'bg-blue-100 text-blue-700 border-b-2 border-blue-500'
                            : 'text-gray-600 hover:text-gray-800'
                            }`}
                        >
                          🔧 Enhanced (Recommended)
                        </button>
                        <button
                          onClick={() => setActiveTranscriptTab('raw')}
                          className={`px-3 py-1 text-xs font-medium rounded-t ${activeTranscriptTab === 'raw'
                            ? 'bg-gray-100 text-gray-700 border-b-2 border-gray-500'
                            : 'text-gray-600 hover:text-gray-800'
                            }`}
                        >
                          📝 Raw (Original)
                        </button>
                      </div>

                      {/* Transcript Content */}
                      <div className="relative">
                        <div className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded max-h-64 overflow-y-auto">
                          <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                            {activeTranscriptTab === 'enhanced'
                              ? (downloadResult.enhancedMetadata.enhancedTranscript || downloadResult.enhancedMetadata.audioTranscript)
                              : downloadResult.enhancedMetadata.audioTranscript}
                          </p>
                        </div>

                        {/* Copy Button */}
                        <button
                          onClick={() => copyTranscriptToClipboard(
                            activeTranscriptTab === 'enhanced'
                              ? (downloadResult.enhancedMetadata?.enhancedTranscript || downloadResult.enhancedMetadata?.audioTranscript || '')
                              : downloadResult.enhancedMetadata?.audioTranscript || ''
                          )}
                          className="absolute top-4 right-4 bg-white hover:bg-gray-100 px-2 py-1 rounded text-xs border shadow-sm transition-colors"
                        >
                          {transcriptCopied ? '✅ Copied!' : '📋 Copy'}
                        </button>
                      </div>

                      <div className="mt-2 text-xs text-gray-500">
                        {activeTranscriptTab === 'enhanced' ? (
                          <span>
                            🔧 <strong>Enhanced transcript</strong>: Grammar fixed, slang removed, improved readability.
                            <strong> Recommended for Qdrant embedding.</strong>
                          </span>
                        ) : (
                          <span>
                            📝 <strong>Raw transcript</strong>: Direct output from Speech-to-Text API.
                            May contain errors, slang, and filler words.
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default YtDlpDownloader;

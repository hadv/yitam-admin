import { useState, useEffect } from 'react';
import axios from '@/utils/axiosConfig';
import { FiYoutube, FiSearch, FiLoader, FiAlertCircle, FiPlay, FiVideo } from 'react-icons/fi';
import { YoutubeVideoInfo, YoutubeVideoChunk } from '@/types/youtube';
import YoutubeChunkViewer from './YoutubeChunkViewer';
import VideoPlayerModal from './VideoPlayerModal';

const YoutubeVideoManager = () => {
  const [videoId, setVideoId] = useState('');
  const [videoInfo, setVideoInfo] = useState<YoutubeVideoInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedChunk, setSelectedChunk] = useState<YoutubeVideoChunk | null>(null);
  const [downloadedVideo, setDownloadedVideo] = useState<any | null>(null);
  const [isPlayerOpen, setIsPlayerOpen] = useState(false);

  // Extract video ID from YouTube URL or use direct video ID
  const extractVideoId = (input: string): string => {
    // If it's already a video ID (11 characters, alphanumeric)
    if (/^[a-zA-Z0-9_-]{11}$/.test(input.trim())) {
      return input.trim();
    }
    
    // Extract from various YouTube URL formats
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/
    ];
    
    for (const pattern of patterns) {
      const match = input.match(pattern);
      if (match) {
        return match[1];
      }
    }
    
    return input.trim(); // Return as-is if no pattern matches
  };

  const handleLoadVideo = async () => {
    if (!videoId.trim()) {
      setError('Please enter a YouTube video ID or URL');
      return;
    }

    const extractedVideoId = extractVideoId(videoId);
    if (!extractedVideoId) {
      setError('Invalid YouTube video ID or URL');
      return;
    }

    setLoading(true);
    setError(null);
    setVideoInfo(null);
    setSelectedChunk(null);

    try {
      const response = await axios.get(`/api/youtube/chunks/${extractedVideoId}`);
      setVideoInfo(response.data);

      // Also check for downloaded video
      await checkForDownloadedVideo(extractedVideoId);

      if (response.data.chunks.length === 0) {
        setError('No chunks found for this video. Make sure the video has been processed first.');
      }
    } catch (err: any) {
      console.error('Error loading video chunks:', err);
      if (err.response?.status === 404) {
        setError('No transcript found for this video ID. Please process the video first.');
      } else {
        setError(err.response?.data?.message || 'Failed to load video chunks');
      }

      // Still check for downloaded video even if chunks failed
      await checkForDownloadedVideo(extractedVideoId);
    } finally {
      setLoading(false);
    }
  };

  const handleChunkClick = (chunk: YoutubeVideoChunk) => {
    setSelectedChunk(chunk);
  };

  const handleCloseChunkViewer = () => {
    setSelectedChunk(null);
  };

  const checkForDownloadedVideo = async (videoId: string) => {
    try {
      const response = await axios.get('/api/youtube/downloads');
      const videos = response.data.videos || [];

      // Find video that starts with the video ID
      const foundVideo = videos.find((video: any) =>
        video.fileName.startsWith(`${videoId}_`)
      );

      setDownloadedVideo(foundVideo || null);
    } catch (err) {
      console.error('Error checking for downloaded video:', err);
      setDownloadedVideo(null);
    }
  };

  const openVideoPlayer = () => {
    if (downloadedVideo) {
      setIsPlayerOpen(true);
    }
  };

  const closeVideoPlayer = () => {
    setIsPlayerOpen(false);
  };

  const getVideoInfo = () => {
    if (!downloadedVideo || !videoInfo) return null;

    // Extract title from filename by removing video ID and extension
    const title = downloadedVideo.fileName
      .replace(/^[a-zA-Z0-9_-]{11}_/, '') // Remove video ID prefix
      .replace(/\.[^/.]+$/, '') // Remove file extension
      .replace(/_/g, ' '); // Replace underscores with spaces

    return {
      fileName: downloadedVideo.fileName,
      title: title || downloadedVideo.fileName,
      description: undefined,
      duration: undefined,
      author: undefined,
      uploadDate: undefined,
      viewCount: undefined,
      thumbnail: undefined
    };
  };

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="p-4">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Manage YouTube Video Chunks</h3>
        
        <div className="mb-4 bg-blue-50 border border-blue-400 text-blue-700 px-4 py-3 rounded text-sm">
          <p className="font-medium">YouTube Video Management</p>
          <p className="mt-1">Enter a YouTube video ID or URL to view and manage its chunks. The video must be processed first using the "Process YouTube Transcript" feature.</p>
        </div>

        {/* Video ID Input */}
        <div className="mb-4">
          <label htmlFor="videoId" className="block text-sm font-medium text-gray-700 mb-1">
            YouTube Video ID or URL
          </label>
          <div className="flex items-center space-x-2">
            <div className="relative flex-grow">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <FiYoutube className="h-5 w-5 text-gray-400" />
              </div>
              <input
                type="text"
                id="videoId"
                className="focus:ring-blue-500 focus:border-blue-500 block w-full pl-10 pr-12 sm:text-sm border-gray-300 rounded-md"
                placeholder="dQw4w9WgXcQ or https://www.youtube.com/watch?v=dQw4w9WgXcQ"
                value={videoId}
                onChange={(e) => setVideoId(e.target.value)}
                disabled={loading}
                onKeyPress={(e) => e.key === 'Enter' && handleLoadVideo()}
              />
            </div>
            <button
              type="button"
              onClick={handleLoadVideo}
              disabled={loading || !videoId.trim()}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <FiLoader className="animate-spin mr-2 h-4 w-4" />
                  Loading...
                </>
              ) : (
                <>
                  <FiSearch className="mr-2 h-4 w-4" />
                  Load Chunks
                </>
              )}
            </button>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            You can enter either a video ID (e.g., dQw4w9WgXcQ) or a full YouTube URL
          </p>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-4 bg-red-50 border border-red-400 text-red-700 px-4 py-3 rounded flex items-center">
            <FiAlertCircle className="mr-2 h-5 w-5" />
            {error}
          </div>
        )}

        {/* Video Info and Chunks */}
        {videoInfo && (
          <div className="mt-6">
            <div className="mb-4 p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-md font-medium text-gray-900">Video Information</h4>
                  <p className="text-sm text-gray-600">Video ID: {videoInfo.videoId}</p>
                  <p className="text-sm text-gray-600">Total Chunks: {videoInfo.totalChunks}</p>
                  <p className="text-sm text-gray-600">Domains: {videoInfo.domains.join(', ')}</p>
                </div>
                <div className="flex space-x-2">
                  {/* Local Video Player Button */}
                  {downloadedVideo && (
                    <button
                      onClick={openVideoPlayer}
                      className="inline-flex items-center px-3 py-2 border border-transparent shadow-sm text-sm leading-4 font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                    >
                      <FiVideo className="mr-2 h-4 w-4" />
                      Play Local
                    </button>
                  )}

                  {/* YouTube Link */}
                  <a
                    href={`https://www.youtube.com/watch?v=${videoInfo.videoId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm leading-4 font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    <FiPlay className="mr-2 h-4 w-4" />
                    Watch on YouTube
                  </a>
                </div>
              </div>
            </div>

            {/* Chunks List */}
            {videoInfo.chunks.length > 0 ? (
              <div>
                <h4 className="text-md font-medium text-gray-900 mb-3">Video Chunks ({videoInfo.chunks.length})</h4>
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {videoInfo.chunks.map((chunk, index) => (
                    <div
                      key={chunk.id}
                      className="p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors"
                      onClick={() => handleChunkClick(chunk)}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <h5 className="text-sm font-medium text-gray-900">{chunk.title}</h5>
                          <p className="text-xs text-gray-500 mt-1">{chunk.summary}</p>
                          <p className="text-xs text-gray-400 mt-1 truncate">
                            {chunk.content.substring(0, 100)}...
                          </p>
                        </div>
                        <span className="text-xs text-gray-400 ml-2">#{index + 1}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-gray-500">
                <FiAlertCircle className="mx-auto h-12 w-12 text-gray-400 mb-4" />
                <p>No chunks found for this video.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Chunk Viewer Modal */}
      {selectedChunk && (
        <YoutubeChunkViewer
          chunk={selectedChunk}
          onClose={handleCloseChunkViewer}
        />
      )}

      {/* Video Player Modal */}
      {downloadedVideo && (
        <VideoPlayerModal
          video={getVideoInfo()!}
          onClose={closeVideoPlayer}
          isOpen={isPlayerOpen}
        />
      )}
    </div>
  );
};

export default YoutubeVideoManager;

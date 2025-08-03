import { useState, useEffect } from 'react';
import axios from 'axios';
import { FiDownload, FiTrash2, FiPlay, FiExternalLink } from 'react-icons/fi';
import VideoPlayerModal from './VideoPlayerModal';

interface DownloadedVideo {
  fileName: string;
  filePath: string;
  size: number;
  createdAt: string;
}

const DownloadedVideos = () => {
  const [videos, setVideos] = useState<DownloadedVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<DownloadedVideo | null>(null);
  const [isPlayerOpen, setIsPlayerOpen] = useState(false);

  // Load downloaded videos on component mount
  useEffect(() => {
    loadDownloadedVideos();
  }, []);

  const loadDownloadedVideos = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await axios.get('/api/youtube/downloads');
      setVideos(response.data.videos || []);
    } catch (err) {
      console.error('Error loading downloaded videos:', err);
      if (axios.isAxiosError(err) && err.response) {
        setError(err.response.data.message || 'Failed to load downloaded videos');
      } else {
        setError('Failed to load downloaded videos');
      }
    } finally {
      setLoading(false);
    }
  };

  const deleteVideo = async (fileName: string) => {
    if (!confirm(`Are you sure you want to delete ${fileName}?`)) {
      return;
    }

    try {
      setDeleting(fileName);
      setError(null);
      
      await axios.delete(`/api/youtube/downloads/${fileName}`);
      
      // Remove from local state
      setVideos(prev => prev.filter(video => video.fileName !== fileName));
    } catch (err) {
      console.error('Error deleting video:', err);
      if (axios.isAxiosError(err) && err.response) {
        setError(err.response.data.message || 'Failed to delete video');
      } else {
        setError('Failed to delete video');
      }
    } finally {
      setDeleting(null);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (dateString: string): string => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const extractVideoId = (fileName: string): string | null => {
    // Extract video ID from filename (format: videoId_title.ext)
    const match = fileName.match(/^([a-zA-Z0-9_-]{11})_/);
    return match ? match[1] : null;
  };

  const openVideoPlayer = (video: DownloadedVideo) => {
    setSelectedVideo(video);
    setIsPlayerOpen(true);
  };

  const closeVideoPlayer = () => {
    setSelectedVideo(null);
    setIsPlayerOpen(false);
  };

  const getVideoInfo = (video: DownloadedVideo) => {
    // Extract title from filename by removing video ID and extension
    const title = video.fileName
      .replace(/^[a-zA-Z0-9_-]{11}_/, '') // Remove video ID prefix
      .replace(/\.[^/.]+$/, '') // Remove file extension
      .replace(/_/g, ' '); // Replace underscores with spaces

    return {
      fileName: video.fileName,
      title: title || video.fileName,
      description: undefined,
      duration: undefined,
      author: undefined,
      uploadDate: undefined,
      viewCount: undefined,
      thumbnail: undefined
    };
  };

  const getVideoTitle = (fileName: string): string => {
    // Extract title from filename (format: videoId_title.ext)
    const match = fileName.match(/^[a-zA-Z0-9_-]{11}_(.+)\.[^.]+$/);
    if (match) {
      return match[1].replace(/_/g, ' ');
    }
    return fileName;
  };

  if (loading) {
    return (
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Downloaded Videos</h2>
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          <span className="ml-2 text-gray-600">Loading downloaded videos...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white shadow rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium text-gray-900">Downloaded Videos</h2>
        <button
          onClick={loadDownloadedVideos}
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}

      {videos.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          <FiDownload className="mx-auto h-12 w-12 text-gray-400 mb-4" />
          <p>No downloaded videos found</p>
          <p className="text-sm">Videos you download will appear here</p>
        </div>
      ) : (
        <div className="space-y-4">
          {videos.map((video) => {
            const videoId = extractVideoId(video.fileName);
            const title = getVideoTitle(video.fileName);
            
            return (
              <div
                key={video.fileName}
                className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50"
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-medium text-gray-900 truncate">
                      {title}
                    </h3>
                    <div className="mt-1 flex items-center space-x-4 text-sm text-gray-500">
                      <span>{formatFileSize(video.size)}</span>
                      <span>{formatDate(video.createdAt)}</span>
                    </div>
                  </div>
                  
                  <div className="flex items-center space-x-2 ml-4">
                    {/* Play button */}
                    <button
                      onClick={() => openVideoPlayer(video)}
                      className="inline-flex items-center p-2 border border-transparent rounded-md text-blue-600 hover:bg-blue-50"
                      title="Play video"
                    >
                      <FiPlay className="h-4 w-4" />
                    </button>

                    {/* Download button */}
                    <a
                      href={`/api/youtube/downloads/${video.fileName}`}
                      download
                      className="inline-flex items-center p-2 border border-transparent rounded-md text-green-600 hover:bg-green-50"
                      title="Download video"
                    >
                      <FiDownload className="h-4 w-4" />
                    </a>
                    
                    {/* YouTube link */}
                    {videoId && (
                      <a
                        href={`https://www.youtube.com/watch?v=${videoId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center p-2 border border-transparent rounded-md text-red-600 hover:bg-red-50"
                        title="View on YouTube"
                      >
                        <FiExternalLink className="h-4 w-4" />
                      </a>
                    )}
                    
                    {/* Delete button */}
                    <button
                      onClick={() => deleteVideo(video.fileName)}
                      disabled={deleting === video.fileName}
                      className="inline-flex items-center p-2 border border-transparent rounded-md text-red-600 hover:bg-red-50 disabled:opacity-50"
                      title="Delete video"
                    >
                      {deleting === video.fileName ? (
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-red-600"></div>
                      ) : (
                        <FiTrash2 className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Video Player Modal */}
      {selectedVideo && (
        <VideoPlayerModal
          video={getVideoInfo(selectedVideo)}
          onClose={closeVideoPlayer}
          isOpen={isPlayerOpen}
        />
      )}
    </div>
  );
};

export default DownloadedVideos;

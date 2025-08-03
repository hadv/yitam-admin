import React, { useState, useEffect } from 'react';
import axios from '@/utils/axiosConfig';
import { FiPlay, FiDownload, FiVideo, FiList } from 'react-icons/fi';
import VideoPlayer from './VideoPlayer';
import InlineVideoPlayer from './InlineVideoPlayer';
import VideoPlayerModal from './VideoPlayerModal';

interface DownloadedVideo {
  fileName: string;
  filePath: string;
  size: number;
  createdAt: string;
}

const VideoStreamingDemo: React.FC = () => {
  const [videos, setVideos] = useState<DownloadedVideo[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<DownloadedVideo | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'inline' | 'modal'>('list');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    loadVideos();
  }, []);

  const loadVideos = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await axios.get('/api/youtube/downloads');
      setVideos(response.data.videos || []);
    } catch (err) {
      console.error('Error loading videos:', err);
      setError('Failed to load videos');
    } finally {
      setLoading(false);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getVideoInfo = (video: DownloadedVideo) => {
    const title = video.fileName
      .replace(/^[a-zA-Z0-9_-]{11}_/, '')
      .replace(/\.[^/.]+$/, '')
      .replace(/_/g, ' ');

    return {
      fileName: video.fileName,
      title: title || video.fileName,
      description: `File size: ${formatFileSize(video.size)}`,
      duration: undefined,
      author: undefined,
      uploadDate: video.createdAt,
      viewCount: undefined,
      thumbnail: undefined
    };
  };

  const openModal = (video: DownloadedVideo) => {
    setSelectedVideo(video);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setSelectedVideo(null);
    setIsModalOpen(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-2">Loading videos...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-red-800">{error}</p>
        <button
          onClick={loadVideos}
          className="mt-2 px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-gray-900">Video Streaming Demo</h2>
          
          {/* View Mode Selector */}
          <div className="flex space-x-2">
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-1 rounded text-sm ${
                viewMode === 'list' 
                  ? 'bg-blue-600 text-white' 
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              <FiList className="inline mr-1" />
              List
            </button>
            <button
              onClick={() => setViewMode('inline')}
              className={`px-3 py-1 rounded text-sm ${
                viewMode === 'inline' 
                  ? 'bg-blue-600 text-white' 
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              <FiVideo className="inline mr-1" />
              Inline
            </button>
            <button
              onClick={() => setViewMode('modal')}
              className={`px-3 py-1 rounded text-sm ${
                viewMode === 'modal' 
                  ? 'bg-blue-600 text-white' 
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              <FiPlay className="inline mr-1" />
              Modal
            </button>
          </div>
        </div>

        {videos.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <FiVideo className="mx-auto h-12 w-12 text-gray-400 mb-4" />
            <p>No videos available for streaming.</p>
            <p className="text-sm mt-2">Download some YouTube videos first to see them here.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* List View */}
            {viewMode === 'list' && (
              <div className="space-y-3">
                {videos.map((video) => (
                  <div key={video.fileName} className="border border-gray-200 rounded-lg p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-medium text-gray-900 truncate">
                          {getVideoInfo(video).title}
                        </h3>
                        <p className="text-xs text-gray-500 mt-1">
                          {formatFileSize(video.size)} • {new Date(video.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex space-x-2 ml-4">
                        <button
                          onClick={() => openModal(video)}
                          className="inline-flex items-center p-2 border border-transparent rounded-md text-blue-600 hover:bg-blue-50"
                          title="Play video"
                        >
                          <FiPlay className="h-4 w-4" />
                        </button>
                        <a
                          href={`/api/youtube/downloads/${video.fileName}`}
                          download
                          className="inline-flex items-center p-2 border border-transparent rounded-md text-green-600 hover:bg-green-50"
                          title="Download video"
                        >
                          <FiDownload className="h-4 w-4" />
                        </a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Inline View */}
            {viewMode === 'inline' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {videos.slice(0, 4).map((video) => (
                  <div key={video.fileName} className="space-y-2">
                    <h3 className="text-sm font-medium text-gray-900 truncate">
                      {getVideoInfo(video).title}
                    </h3>
                    <InlineVideoPlayer
                      src={`/api/youtube/downloads/${video.fileName}`}
                      title={getVideoInfo(video).title}
                      width="100%"
                      height="200px"
                      className="rounded-lg"
                    />
                    <p className="text-xs text-gray-500">
                      {formatFileSize(video.size)} • {new Date(video.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {/* Modal View */}
            {viewMode === 'modal' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {videos.map((video) => (
                  <div
                    key={video.fileName}
                    className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow cursor-pointer"
                    onClick={() => openModal(video)}
                  >
                    <div className="aspect-video bg-gray-100 rounded-lg mb-3 flex items-center justify-center">
                      <FiPlay className="h-8 w-8 text-gray-400" />
                    </div>
                    <h3 className="text-sm font-medium text-gray-900 truncate">
                      {getVideoInfo(video).title}
                    </h3>
                    <p className="text-xs text-gray-500 mt-1">
                      {formatFileSize(video.size)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Full-screen Video Player Example */}
        {viewMode === 'inline' && videos.length > 0 && (
          <div className="mt-8">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Full-screen Player Example</h3>
            <VideoPlayer
              src={`/api/youtube/downloads/${videos[0].fileName}`}
              title={getVideoInfo(videos[0]).title}
              className="w-full aspect-video rounded-lg"
            />
          </div>
        )}
      </div>

      {/* Video Player Modal */}
      {selectedVideo && (
        <VideoPlayerModal
          video={getVideoInfo(selectedVideo)}
          onClose={closeModal}
          isOpen={isModalOpen}
        />
      )}
    </div>
  );
};

export default VideoStreamingDemo;

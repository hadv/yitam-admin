import React, { useState, useEffect } from 'react';
import { FiX, FiExternalLink, FiInfo } from 'react-icons/fi';
import VideoPlayer from './VideoPlayer';

interface VideoInfo {
  fileName: string;
  title: string;
  description?: string;
  duration?: string;
  author?: string;
  uploadDate?: string;
  viewCount?: string;
  thumbnail?: string;
}

interface VideoPlayerModalProps {
  video: VideoInfo;
  onClose: () => void;
  isOpen: boolean;
}

const VideoPlayerModal: React.FC<VideoPlayerModalProps> = ({
  video,
  onClose,
  isOpen
}) => {
  const [showInfo, setShowInfo] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // Close modal on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const videoSrc = `/api/youtube/downloads/${video.fileName}`;
  
  const extractVideoId = (fileName: string): string => {
    // Try to extract video ID from filename pattern
    const match = fileName.match(/([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : '';
  };

  const videoId = extractVideoId(video.fileName);
  const youtubeUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;

  const handleTimeUpdate = (time: number, dur: number) => {
    setCurrentTime(time);
    setDuration(dur);
  };

  const handleLoadedMetadata = (dur: number) => {
    setDuration(dur);
    setIsLoading(false);
  };

  const formatTime = (time: number): string => {
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = Math.floor(time % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };



  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black bg-opacity-75"
        onClick={onClose}
      />
      
      {/* Modal Content */}
      <div className="relative bg-white rounded-lg shadow-xl max-w-6xl w-full mx-4 max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-gray-900 truncate">
              {video.title}
            </h2>
            {video.author && (
              <p className="text-sm text-gray-500 mt-1">by {video.author}</p>
            )}
          </div>
          
          <div className="flex items-center space-x-2 ml-4">
            {/* Info toggle */}
            <button
              onClick={() => setShowInfo(!showInfo)}
              className="p-2 text-gray-400 hover:text-gray-600 transition-colors"
              title="Toggle video info"
            >
              <FiInfo size={20} />
            </button>
            
            {/* YouTube link */}
            {youtubeUrl && (
              <a
                href={youtubeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 text-red-500 hover:text-red-700 transition-colors"
                title="View on YouTube"
              >
                <FiExternalLink size={20} />
              </a>
            )}
            
            {/* Close button */}
            <button
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-gray-600 transition-colors"
            >
              <FiX size={24} />
            </button>
          </div>
        </div>

        {/* Video Player */}
        <div className="relative">
          <VideoPlayer
            src={videoSrc}
            title={video.title}
            poster={video.thumbnail}
            className="w-full aspect-video"
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
          />
          
          {/* Loading overlay */}
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50">
              <div className="text-center text-white">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
                <p>Loading video...</p>
              </div>
            </div>
          )}
        </div>

        {/* Video Info Panel */}
        {showInfo && (
          <div className="border-t border-gray-200 bg-gray-50">
            <div className="p-4 max-h-64 overflow-y-auto">
              <h3 className="text-lg font-medium text-gray-900 mb-3">Video Information</h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Title</label>
                    <p className="text-sm text-gray-900">{video.title}</p>
                  </div>
                  
                  {video.author && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Author</label>
                      <p className="text-sm text-gray-900">{video.author}</p>
                    </div>
                  )}
                  
                  {video.duration && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Duration</label>
                      <p className="text-sm text-gray-900">{video.duration}</p>
                    </div>
                  )}
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Current Time</label>
                    <p className="text-sm text-gray-900">
                      {formatTime(currentTime)} / {formatTime(duration)}
                    </p>
                  </div>
                </div>
                
                <div className="space-y-3">
                  {video.uploadDate && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Upload Date</label>
                      <p className="text-sm text-gray-900">{video.uploadDate}</p>
                    </div>
                  )}
                  
                  {video.viewCount && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700">View Count</label>
                      <p className="text-sm text-gray-900">{video.viewCount}</p>
                    </div>
                  )}
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700">File Name</label>
                    <p className="text-sm text-gray-900 font-mono">{video.fileName}</p>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700">File Size</label>
                    <p className="text-sm text-gray-900">Unknown size</p>
                  </div>
                </div>
              </div>
              
              {video.description && (
                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
                  <div className="text-sm text-gray-900 bg-white p-3 rounded border max-h-32 overflow-y-auto">
                    {video.description.split('\n').map((line, index) => (
                      <p key={index} className="mb-1">{line}</p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 flex justify-between items-center">
          <div className="text-sm text-gray-500">
            Press ESC to close
          </div>
          <div className="flex space-x-2">
            <button
              onClick={() => setShowInfo(!showInfo)}
              className="px-3 py-1 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
            >
              {showInfo ? 'Hide Info' : 'Show Info'}
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VideoPlayerModal;

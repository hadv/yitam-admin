import { useState } from 'react';
import { FiX, FiCopy, FiExternalLink, FiTag, FiFileText, FiClock } from 'react-icons/fi';
import { YoutubeVideoChunk } from '@/types/youtube';

interface YoutubeChunkViewerProps {
  chunk: YoutubeVideoChunk;
  onClose: () => void;
}

const YoutubeChunkViewer = ({ chunk, onClose }: YoutubeChunkViewerProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopyContent = async () => {
    try {
      await navigator.clipboard.writeText(chunk.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy content:', err);
    }
  };

  const extractVideoId = (sourceFile: string): string => {
    const match = sourceFile.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : '';
  };

  const extractTimestamps = (content: string): string[] => {
    // Extract timestamps in format [MM:SS] or [HH:MM:SS]
    const timestampRegex = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
    const matches = content.match(timestampRegex);
    return matches ? matches.map(match => match.slice(1, -1)) : [];
  };

  const videoId = extractVideoId(chunk.sourceFile);
  const timestamps = extractTimestamps(chunk.content);

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
      <div className="relative top-20 mx-auto p-5 border w-11/12 max-w-4xl shadow-lg rounded-md bg-white">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Chunk Details</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <FiX className="h-6 w-6" />
          </button>
        </div>

        {/* Content */}
        <div className="mt-4 space-y-6">
          {/* Chunk Info */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <FiFileText className="inline mr-1" />
                Title
              </label>
              <p className="text-sm text-gray-900 bg-gray-50 p-2 rounded">{chunk.title}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <FiTag className="inline mr-1" />
                Domains
              </label>
              <div className="flex flex-wrap gap-1">
                {chunk.domains.map((domain, index) => (
                  <span
                    key={index}
                    className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800"
                  >
                    {domain}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Summary */}
          {chunk.summary && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Summary</label>
              <p className="text-sm text-gray-700 bg-gray-50 p-3 rounded">{chunk.summary}</p>
            </div>
          )}

          {/* Timestamps */}
          {timestamps.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                <FiClock className="inline mr-1" />
                Timestamps Found
              </label>
              <div className="flex flex-wrap gap-2">
                {timestamps.slice(0, 5).map((timestamp, index) => (
                  <span
                    key={index}
                    className="inline-flex items-center px-2 py-1 rounded text-xs font-mono bg-green-100 text-green-800"
                  >
                    {timestamp}
                  </span>
                ))}
                {timestamps.length > 5 && (
                  <span className="text-xs text-gray-500">+{timestamps.length - 5} more</span>
                )}
              </div>
            </div>
          )}

          {/* Content */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">Content</label>
              <div className="flex space-x-2">
                <button
                  onClick={handleCopyContent}
                  className="inline-flex items-center px-2 py-1 border border-gray-300 shadow-sm text-xs font-medium rounded text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  <FiCopy className="mr-1 h-3 w-3" />
                  {copied ? 'Copied!' : 'Copy'}
                </button>
                {videoId && (
                  <a
                    href={chunk.sourceFile}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center px-2 py-1 border border-gray-300 shadow-sm text-xs font-medium rounded text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    <FiExternalLink className="mr-1 h-3 w-3" />
                    Watch Video
                  </a>
                )}
              </div>
            </div>
            <div className="bg-gray-50 p-4 rounded-lg max-h-96 overflow-y-auto">
              <pre className="text-sm text-gray-800 whitespace-pre-wrap font-mono leading-relaxed">
                {chunk.content}
              </pre>
            </div>
          </div>

          {/* Enhanced Content */}
          {chunk.enhancedContent && chunk.enhancedContent !== chunk.content && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Enhanced Content</label>
              <div className="bg-blue-50 p-4 rounded-lg max-h-96 overflow-y-auto">
                <pre className="text-sm text-blue-800 whitespace-pre-wrap leading-relaxed">
                  {chunk.enhancedContent}
                </pre>
              </div>
            </div>
          )}

          {/* Metadata */}
          <div className="bg-gray-50 p-4 rounded-lg">
            <h4 className="text-sm font-medium text-gray-700 mb-2">Metadata</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-gray-600">
              <div>
                <span className="font-medium">Chunk ID:</span>
                <p className="font-mono break-all">{chunk.id}</p>
              </div>
              <div>
                <span className="font-medium">Document Name:</span>
                <p>{chunk.documentName}</p>
              </div>
              <div>
                <span className="font-medium">Source:</span>
                <p className="break-all">{chunk.sourceFile}</p>
              </div>
              <div>
                <span className="font-medium">Score:</span>
                <p>{chunk.score.toFixed(3)}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-300 text-gray-700 rounded-md hover:bg-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-500"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default YoutubeChunkViewer;

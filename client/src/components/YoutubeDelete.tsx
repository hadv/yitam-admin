import { useState } from 'react';
import axios from 'axios';
import { FiYoutube, FiTrash2 } from 'react-icons/fi';

// Configure axios to include credentials with every request
axios.defaults.withCredentials = true;

interface YoutubeDeleteProps {
  onDeleteSuccess?: () => void;
}

interface DeleteResult {
  videoId: string;
  deletedCount: number;
}

const YoutubeDelete = ({ onDeleteSuccess }: YoutubeDeleteProps) => {
  const [youtubeInput, setYoutubeInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteResult, setDeleteResult] = useState<DeleteResult | null>(null);

  const extractYouTubeId = (input: string): string | null => {
    // If input is already a video ID (11 characters)
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
      return input;
    }
    
    // Extract from URL
    const youtubeRegex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
    const match = input.match(youtubeRegex);
    return match ? match[1] : null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!youtubeInput) {
      setError('Please enter a YouTube URL or video ID');
      return;
    }
    
    const videoId = extractYouTubeId(youtubeInput);
    
    if (!videoId) {
      setError('Please enter a valid YouTube URL or video ID');
      return;
    }
    
    setIsProcessing(true);
    setError(null);
    setDeleteResult(null);
    
    try {
      console.log(`Sending delete request for video ID: ${videoId}`);
      const response = await axios.delete(`/api/youtube/delete-transcript/${videoId}`);
      
      console.log('Deletion response:', response.data);
      
      // Store the deletion result
      setDeleteResult({
        videoId: response.data.videoId,
        deletedCount: response.data.deletedCount
      });
      
      if (onDeleteSuccess) {
        onDeleteSuccess();
      }
      
      setYoutubeInput('');
    } catch (err) {
      console.error('Deletion error:', err);
      
      if (axios.isAxiosError(err) && err.response) {
        // Get detailed error message from the server response
        const serverErrorMsg = err.response.data.error || err.response.data.message || 'Unknown server error';
        
        console.error('Server response status:', err.response.status);
        console.error('Server error details:', err.response.data);
        
        if (err.response.status === 404) {
          setError(`No transcript found for this video ID: ${videoId}`);
        } else if (err.response.status === 500) {
          setError(`Server error: ${serverErrorMsg}`);
        } else {
          setError(`Failed to delete YouTube transcript chunks: ${serverErrorMsg}`);
        }
      } else if (axios.isAxiosError(err) && err.request) {
        // The request was made but no response was received
        setError('Server not responding. Please check your connection or try again later.');
        console.error('Request error:', err.request);
      } else {
        setError('An unexpected error occurred while deleting the video chunks');
        console.error('Error:', err);
      }
    } finally {
      setIsProcessing(false);
    }
  };
  
  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="p-4">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Delete YouTube Video Chunks</h3>
        
        <div className="mb-4 bg-yellow-50 border border-yellow-400 text-yellow-700 px-4 py-3 rounded text-sm">
          <p className="font-medium">About Deleting YouTube Transcripts</p>
          <p className="mt-1">
            Use this tool when a YouTube video transcript has been incorrectly extracted and you need to 
            remove all the chunks to re-extract it. After deletion, you can use the Process YouTube Video 
            tool to re-extract the transcript.
          </p>
        </div>
        
        {error && (
          <div className="mb-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
            {error}
          </div>
        )}
        
        {deleteResult && (
          <div className="mb-4 bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded">
            <p><strong>Successfully deleted:</strong> {deleteResult.deletedCount} chunks</p>
            <p className="text-sm">For video ID: {deleteResult.videoId}</p>
            <a 
              href={`https://www.youtube.com/watch?v=${deleteResult.videoId}`} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline text-sm"
            >
              View on YouTube
            </a>
          </div>
        )}
        
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="youtubeInput" className="block text-sm font-medium text-gray-700 mb-1">
              YouTube URL or Video ID
            </label>
            <div className="flex items-center">
              <div className="relative flex-grow">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <FiYoutube className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  type="text"
                  id="youtubeInput"
                  className="focus:ring-red-500 focus:border-red-500 block w-full pl-10 pr-12 sm:text-sm border-gray-300 rounded-md"
                  placeholder="https://www.youtube.com/watch?v=... or V3PvVOGCf7U"
                  value={youtubeInput}
                  onChange={(e) => setYoutubeInput(e.target.value)}
                  disabled={isProcessing}
                />
              </div>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Enter a YouTube video URL or directly paste the video ID (e.g., V3PvVOGCf7U)
            </p>
          </div>
          
          <div className="flex justify-end">
            <button
              type="submit"
              className={`inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 ${
                isProcessing ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              disabled={isProcessing}
            >
              {isProcessing ? (
                'Deleting...'
              ) : (
                <>
                  <FiTrash2 className="mr-2" /> Delete Video Chunks
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default YoutubeDelete; 
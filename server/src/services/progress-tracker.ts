import { io } from '../index';
import { ProgressStage, ProgressUpdate } from '../types/progress';

/**
 * Service for tracking and reporting progress of long-running operations
 */
class ProgressTrackerService {
  // Track updates for potential retries
  private lastUpdates: Map<string, ProgressUpdate> = new Map();
  
  /**
   * Send a progress update via WebSocket
   */
  sendProgressUpdate(update: ProgressUpdate): void {
    // Store the last update for this videoId
    this.lastUpdates.set(update.videoId, update);
    
    try {
      // Emit the progress update to all connected clients in the video's room
      const room = `video-${update.videoId}`;
      const roomClients = io.sockets.adapter.rooms.get(room);
      const clientCount = roomClients ? roomClients.size : 0;
      
      console.log(`Progress update [${update.videoId}]: ${update.stage} - ${update.message} (${clientCount} clients in room)`);
      
      io.to(room).emit('progress-update', update);
      
      // If no clients are in the room, this might be an issue - log it
      if (clientCount === 0) {
        console.warn(`No clients in room ${room} to receive progress update`);
      }
    } catch (error) {
      console.error(`Error sending progress update for ${update.videoId}:`, error);
    }
  }

  /**
   * Initialize progress tracking for a video
   */
  initializeProgressTracking(videoId: string, socketId?: string): void {
    console.log(`Initializing progress tracking for video ${videoId}, socketId: ${socketId || 'none'}`);
    
    // If a socketId is provided, join that socket to the video's room
    if (socketId) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        console.log(`Adding socket ${socketId} to room for video ${videoId}`);
        socket.join(`video-${videoId}`);
        
        // Send an immediate confirmation to the client
        socket.emit('room-joined', { 
          videoId,
          message: `Successfully joined room for video ${videoId}` 
        });
      } else {
        console.warn(`Socket ${socketId} not found for joining room video-${videoId}`);
      }
    } else {
      console.warn(`No socketId provided for video ${videoId}, progress updates may not be received`);
    }

    this.sendProgressUpdate({
      videoId,
      stage: ProgressStage.INITIALIZING,
      message: 'Initializing YouTube video processing',
      progress: 0
    });
  }

  /**
   * Update transcript fetch progress
   */
  updateTranscriptFetch(videoId: string, message: string, progress?: number): void {
    this.sendProgressUpdate({
      videoId,
      stage: ProgressStage.TRANSCRIPT_FETCH,
      message,
      progress
    });
  }

  /**
   * Update transcript processing progress
   */
  updateTranscriptProcess(videoId: string, message: string, progress?: number): void {
    this.sendProgressUpdate({
      videoId,
      stage: ProgressStage.TRANSCRIPT_PROCESS,
      message,
      progress
    });
  }

  /**
   * Update chunk creation progress
   */
  updateChunkCreation(videoId: string, currentChunk: number, totalChunks: number): void {
    const progress = Math.round((currentChunk / totalChunks) * 100);
    this.sendProgressUpdate({
      videoId,
      stage: ProgressStage.CHUNK_CREATION,
      message: `Creating chunk ${currentChunk} of ${totalChunks}`,
      progress,
      currentItem: currentChunk,
      totalItems: totalChunks
    });
  }

  /**
   * Update embedding generation progress
   */
  updateEmbeddingGeneration(videoId: string, currentChunk: number, totalChunks: number): void {
    const progress = Math.round((currentChunk / totalChunks) * 100);
    this.sendProgressUpdate({
      videoId,
      stage: ProgressStage.EMBEDDING_GENERATION,
      message: `Generating embedding for chunk ${currentChunk} of ${totalChunks}`,
      progress,
      currentItem: currentChunk,
      totalItems: totalChunks
    });
  }

  /**
   * Update chunk storage progress
   */
  updateChunkStorage(videoId: string, message: string, progress?: number): void {
    this.sendProgressUpdate({
      videoId,
      stage: ProgressStage.CHUNK_STORAGE,
      message,
      progress
    });
  }

  /**
   * Mark processing as completed
   */
  completeProcessing(videoId: string, totalChunks: number): void {
    this.sendProgressUpdate({
      videoId,
      stage: ProgressStage.COMPLETED,
      message: `Processing completed successfully. Created ${totalChunks} chunks.`,
      progress: 100,
      totalItems: totalChunks
    });
    
    // Remove this video from our tracking after completion
    setTimeout(() => this.lastUpdates.delete(videoId), 10000);
  }

  /**
   * Report an error during processing
   */
  reportError(videoId: string, message: string, error?: string): void {
    this.sendProgressUpdate({
      videoId,
      stage: ProgressStage.ERROR,
      message,
      error
    });
    
    // Remove this video from our tracking after error reporting
    setTimeout(() => this.lastUpdates.delete(videoId), 10000);
  }
  
  /**
   * Resend the latest update for a video (for new connections)
   */
  resendLatestUpdate(videoId: string): boolean {
    const lastUpdate = this.lastUpdates.get(videoId);
    if (lastUpdate) {
      console.log(`Resending latest update for ${videoId}`);
      this.sendProgressUpdate(lastUpdate);
      return true;
    }
    return false;
  }
}

// Export a singleton instance
export const progressTracker = new ProgressTrackerService(); 
import { io, Socket } from 'socket.io-client';
import { ProgressUpdate } from '../types/progress';

/**
 * Service to handle socket.io communication
 */
class SocketService {
  private socket: Socket | null = null;
  private progressListeners: Map<string, (update: ProgressUpdate) => void> = new Map();
  private connectionEstablished = false;
  private connectPromise: Promise<boolean> | null = null;

  /**
   * Initialize socket connection
   */
  connect(): Promise<boolean> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve) => {
      if (this.socket && this.connectionEstablished) {
        console.log('Socket already connected:', this.socket.id);
        resolve(true);
        return;
      }

      // Use hardcoded URL for simplicity
      const apiUrl = 'http://localhost:3001';
      console.log('Connecting to socket server at:', apiUrl);

      this.socket = io(apiUrl, {
        withCredentials: true,
        transports: ['websocket'],
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 10000
      });

      this.socket.on('connect', () => {
        console.log('Socket connected successfully:', this.socket?.id);
        this.connectionEstablished = true;
        resolve(true);
      });

      this.socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
        this.connectionEstablished = false;
        resolve(false);
      });

      this.socket.on('disconnect', (reason) => {
        console.log('Socket disconnected:', reason);
        this.connectionEstablished = false;
      });

      this.socket.on('progress-update', (data: ProgressUpdate) => {
        console.log('Progress update received:', data);
        
        // Find and call the appropriate listener for this videoId
        const listener = this.progressListeners.get(data.videoId);
        if (listener) {
          listener(data);
        } else {
          console.warn('Progress update received but no listener found for videoId:', data.videoId);
        }
      });

      // Set a timeout for the connection attempt
      setTimeout(() => {
        if (!this.connectionEstablished) {
          console.error('Socket connection timed out');
          resolve(false);
        }
      }, 5000);
    });

    return this.connectPromise;
  }

  /**
   * Get socket ID
   */
  getSocketId(): string | null {
    return this.socket?.id || null;
  }

  /**
   * Check if socket is connected
   */
  isConnected(): boolean {
    return this.connectionEstablished && this.socket?.connected === true;
  }

  /**
   * Register a progress listener for a specific videoId
   */
  registerProgressListener(videoId: string, callback: (update: ProgressUpdate) => void) {
    console.log('Registering progress listener for videoId:', videoId);
    this.progressListeners.set(videoId, callback);
    
    // Join the video room to ensure we receive updates
    this.joinVideoRoom(videoId);
  }

  /**
   * Unregister a progress listener
   */
  unregisterProgressListener(videoId: string) {
    console.log('Unregistering progress listener for videoId:', videoId);
    this.progressListeners.delete(videoId);
  }

  /**
   * Join a video room to receive updates
   */
  joinVideoRoom(videoId: string): boolean {
    if (this.socket && this.connectionEstablished) {
      console.log('Joining video room for videoId:', videoId);
      this.socket.emit('join-video-room', { videoId });
      return true;
    }
    console.warn('Cannot join video room - socket not connected');
    return false;
  }

  /**
   * Disconnect socket
   */
  disconnect() {
    if (this.socket) {
      console.log('Disconnecting socket');
      this.socket.disconnect();
      this.socket = null;
      this.progressListeners.clear();
      this.connectionEstablished = false;
      this.connectPromise = null;
    }
  }

  /**
   * Request the latest progress update for a videoId
   */
  requestLatestProgress(videoId: string): boolean {
    if (this.socket && this.connectionEstablished) {
      console.log('Requesting latest progress for videoId:', videoId);
      this.socket.emit('request-latest-progress', { videoId });
      return true;
    }
    console.warn('Cannot request latest progress - socket not connected');
    return false;
  }
}

// Create singleton instance
export const socketService = new SocketService(); 
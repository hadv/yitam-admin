/**
 * Progress event types for WebSocket communication
 */

export enum ProgressStage {
  INITIALIZING = 'initializing',
  TRANSCRIPT_FETCH = 'transcript_fetch',
  TRANSCRIPT_PROCESS = 'transcript_process',
  CHUNK_CREATION = 'chunk_creation',
  EMBEDDING_GENERATION = 'embedding_generation',
  CHUNK_STORAGE = 'chunk_storage',
  COMPLETED = 'completed',
  ERROR = 'error'
}

export interface ProgressUpdate {
  videoId: string;
  stage: ProgressStage;
  message: string;
  progress?: number; // 0-100
  currentItem?: number;
  totalItems?: number;
  error?: string;
} 
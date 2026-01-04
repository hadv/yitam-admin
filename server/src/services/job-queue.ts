import { Worker } from 'worker_threads';
import path from 'path';
import fs from 'fs';
import { extractYouTubeId, getVideoDetails } from './youtube-transcript';
import { progressTracker } from './progress-tracker';
import crypto from 'crypto';

// Job statuses
export enum JobStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

// Job data interface
interface JobData {
  id: string;
  videoId: string;
  youtubeUrl: string;
  domains: string[];
  socketId?: string;
  userId?: string;
  accessToken?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  cookiesBrowser?: string;
  status: JobStatus;
  progress: number;
  result?: any;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

// Simple in-memory job store with persistence
class JobStore {
  private jobs: Map<string, JobData> = new Map();
  private jobsDir: string;
  private persistenceFile: string;

  constructor() {
    this.jobsDir = path.join(process.cwd(), 'data', 'jobs');
    this.persistenceFile = path.join(this.jobsDir, 'jobs.json');
    this.initialize();
  }

  private initialize() {
    // Create jobs directory if it doesn't exist
    if (!fs.existsSync(this.jobsDir)) {
      fs.mkdirSync(this.jobsDir, { recursive: true });
    }

    // Load jobs from file if it exists
    if (fs.existsSync(this.persistenceFile)) {
      try {
        const jobsData = JSON.parse(fs.readFileSync(this.persistenceFile, 'utf8'));
        jobsData.forEach((job: JobData) => {
          this.jobs.set(job.id, job);
        });
        console.log(`Loaded ${this.jobs.size} jobs from persistence file`);
      } catch (error) {
        console.error('Error loading jobs from persistence file:', error);
      }
    }
  }

  private persist() {
    try {
      fs.writeFileSync(
        this.persistenceFile,
        JSON.stringify(Array.from(this.jobs.values())),
        'utf8'
      );
    } catch (error) {
      console.error('Error persisting jobs to file:', error);
    }
  }

  public addJob(jobData: Omit<JobData, 'id' | 'status' | 'progress' | 'createdAt' | 'updatedAt'>): JobData {
    const id = jobData.videoId || crypto.randomUUID();
    const job: JobData = {
      id,
      status: JobStatus.PENDING,
      progress: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...jobData
    };

    this.jobs.set(id, job);
    this.persist();
    return job;
  }

  public getJob(id: string): JobData | undefined {
    return this.jobs.get(id);
  }

  public updateJob(id: string, updates: Partial<JobData>): JobData | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;

    const updatedJob = {
      ...job,
      ...updates,
      updatedAt: new Date()
    };

    this.jobs.set(id, updatedJob);
    this.persist();
    return updatedJob;
  }

  public getAllJobs(): JobData[] {
    return Array.from(this.jobs.values());
  }

  public getPendingJobs(): JobData[] {
    return this.getAllJobs().filter(job => job.status === JobStatus.PENDING);
  }
}

// Create singleton job store
const jobStore = new JobStore();

// Class to manage YouTube processing jobs
class YoutubeJobManager {
  private activeWorkers: Map<string, Worker> = new Map();
  private workerScriptPath: string;
  private maxConcurrentJobs: number;

  constructor(maxConcurrentJobs = 2) {
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.workerScriptPath = path.join(__dirname, 'youtube-worker.js');

    // Make sure worker script exists, if not create it
    this.ensureWorkerScript();

    // Process any pending jobs on startup
    setImmediate(() => this.processNextJobs());
  }

  private ensureWorkerScript() {
    const workerDir = path.dirname(this.workerScriptPath);

    if (!fs.existsSync(workerDir)) {
      fs.mkdirSync(workerDir, { recursive: true });
    }

    // Create worker script (force overwrite to ensure latest version)
    // if (!fs.existsSync(this.workerScriptPath)) {
    const workerScript = `
const { parentPort, workerData } = require('worker_threads');
const { processYoutubeTranscript, getVideoDetails } = require('./youtube-transcript');
const { DatabaseService } = require('../core/database-service');

// Create database service instance
const dbService = new DatabaseService();

async function processVideo() {
  const {
    videoId,
    domains,
    chunkSize,
    chunkOverlap,
    userId,
    accessToken,
    cookiesBrowser
  } = workerData;
  
  try {
    // Initialize database
    await dbService.initialize();
    
    // Send progress updates to main thread
    const progressCallback = (stage, message, progress, currentChunk, totalChunks) => {
      parentPort.postMessage({
        type: 'progress',
        data: { 
          stage, 
          message, 
          progress,
          currentChunk,
          totalChunks
        }
      });
    };
    
    // Get video details
    const videoDetails = await getVideoDetails(videoId);
    parentPort.postMessage({
      type: 'progress',
      data: { 
        stage: 'transcript_fetch', 
        message: \`Processing YouTube video: "\${videoDetails.title}"\`, 
        progress: 30 
      }
    });
    
    // Process transcript and create chunks
    const chunks = await processYoutubeTranscript(
      videoId,
      domains,
      chunkSize,
      chunkOverlap,
      userId,
      accessToken,
      progressCallback,
      cookiesBrowser
    );
    
    // Store chunks in database
    parentPort.postMessage({
      type: 'progress',
      data: { 
        stage: 'chunk_storage', 
        message: \`Storing \${chunks.length} chunks\`, 
        progress: 90,
        totalChunks: chunks.length
      }
    });
    
    await dbService.addDocumentChunks(chunks);
    
    // Complete successfully
    parentPort.postMessage({
      type: 'complete',
      data: {
        totalChunks: chunks.length,
        videoId,
        videoUrl: \`https://www.youtube.com/watch?v=\${videoId}\`,
        videoTitle: videoDetails.title,
        videoDescription: videoDetails.description || ''
      }
    });
  } catch (error) {
    console.error('Error in worker thread:', error);
    parentPort.postMessage({
      type: 'error',
      data: {
        message: error.message,
        stack: error.stack
      }
    });
  }
}

// Initialize and run
dbService.initialize()
  .then(() => {
    parentPort.postMessage({ type: 'initialized' });
    return processVideo();
  })
  .catch(error => {
    parentPort.postMessage({
      type: 'error',
      data: {
        message: error.message,
        stack: error.stack
      }
    });
  });
      `;

    fs.writeFileSync(this.workerScriptPath, workerScript, 'utf8');
    console.log(`Created worker script at ${this.workerScriptPath}`);
  }

  private async processNextJobs() {
    try {
      // Get all pending jobs
      const pendingJobs = jobStore.getPendingJobs();

      // Check how many jobs we can start
      const availableSlots = this.maxConcurrentJobs - this.activeWorkers.size;

      if (availableSlots > 0 && pendingJobs.length > 0) {
        // Start as many jobs as we can
        const jobsToStart = pendingJobs.slice(0, availableSlots);

        for (const job of jobsToStart) {
          this.startJob(job);
        }
      }
    } catch (error) {
      console.error('Error processing next jobs:', error);
    }

    // Schedule next check
    setTimeout(() => this.processNextJobs(), 5000);
  }

  private startJob(job: JobData) {
    try {
      // Update job status
      console.log(`Starting job ${job.id} with cookiesBrowser: ${job.cookiesBrowser}`);
      jobStore.updateJob(job.id, {
        status: JobStatus.ACTIVE,
        startedAt: new Date()
      });

      // Initialize progress tracking
      progressTracker.initializeProgressTracking(job.videoId, job.socketId);
      progressTracker.updateTranscriptFetch(job.videoId, 'Starting YouTube video processing in worker thread', 10);

      // Create worker thread
      const worker = new Worker(this.workerScriptPath, {
        workerData: {
          videoId: job.videoId,
          domains: job.domains,
          chunkSize: job.chunkSize || 4000,
          chunkOverlap: job.chunkOverlap || 500,
          userId: job.userId,
          accessToken: job.accessToken,
          cookiesBrowser: job.cookiesBrowser // Pass cookies to worker
        }
      });

      // Store active worker
      this.activeWorkers.set(job.id, worker);

      // Handle messages from worker
      worker.on('message', (message) => {
        switch (message.type) {
          case 'initialized':
            console.log(`Worker initialized for job ${job.id}`);
            break;

          case 'progress':
            const { stage, message: progressMessage, progress } = message.data;

            // Update job progress
            jobStore.updateJob(job.id, { progress: progress || 0 });

            // Update progress tracker
            switch (stage) {
              case 'transcript_fetch':
                progressTracker.updateTranscriptFetch(job.videoId, progressMessage, progress);
                break;
              case 'transcript_process':
                progressTracker.updateTranscriptProcess(job.videoId, progressMessage, progress);
                break;
              case 'chunk_creation':
                if (typeof message.data.currentChunk === 'number' && typeof message.data.totalChunks === 'number') {
                  progressTracker.updateChunkCreation(
                    job.videoId,
                    message.data.currentChunk,
                    message.data.totalChunks
                  );
                } else if (progressMessage && progressMessage.includes('/')) {
                  // Try to extract current/total from the message (e.g., "Processing chunk 1/22")
                  const match = progressMessage.match(/Processing chunk (\d+)\/(\d+)/i);
                  if (match && match.length === 3) {
                    const currentChunk = parseInt(match[1], 10);
                    const totalChunks = parseInt(match[2], 10);
                    progressTracker.updateChunkCreation(job.videoId, currentChunk, totalChunks);
                  }
                }
                break;
              case 'embedding_generation':
                if (typeof message.data.currentChunk === 'number' && typeof message.data.totalChunks === 'number') {
                  progressTracker.updateEmbeddingGeneration(
                    job.videoId,
                    message.data.currentChunk,
                    message.data.totalChunks
                  );
                } else if (progressMessage && progressMessage.includes('/')) {
                  // Try to extract current/total from the message
                  const match = progressMessage.match(/(\d+)\/(\d+)/);
                  if (match && match.length === 3) {
                    const currentChunk = parseInt(match[1], 10);
                    const totalChunks = parseInt(match[2], 10);
                    progressTracker.updateEmbeddingGeneration(job.videoId, currentChunk, totalChunks);
                  }
                }
                break;
              case 'chunk_storage':
                progressTracker.updateChunkStorage(job.videoId, progressMessage, progress);
                break;
            }
            break;

          case 'complete':
            // Update job as completed
            jobStore.updateJob(job.id, {
              status: JobStatus.COMPLETED,
              progress: 100,
              result: message.data,
              completedAt: new Date()
            });

            // Complete progress tracking
            progressTracker.completeProcessing(job.videoId, message.data.totalChunks);

            // Remove worker from active list
            this.activeWorkers.delete(job.id);

            console.log(`Job ${job.id} completed successfully`);
            break;

          case 'error':
            // Update job as failed
            jobStore.updateJob(job.id, {
              status: JobStatus.FAILED,
              error: message.data.message,
              completedAt: new Date()
            });

            // Report error via progress tracker
            progressTracker.reportError(job.videoId, message.data.message);

            // Remove worker from active list
            this.activeWorkers.delete(job.id);

            console.error(`Job ${job.id} failed:`, message.data.message);
            break;
        }
      });

      // Handle worker errors
      worker.on('error', (error) => {
        console.error(`Worker error for job ${job.id}:`, error);

        // Update job as failed
        jobStore.updateJob(job.id, {
          status: JobStatus.FAILED,
          error: error.message,
          completedAt: new Date()
        });

        // Report error via progress tracker
        progressTracker.reportError(job.videoId, `Worker thread error: ${error.message}`);

        // Remove worker from active list
        this.activeWorkers.delete(job.id);
      });

      // Handle worker exit
      worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`Worker for job ${job.id} exited with code ${code}`);

          // If job hasn't been marked as completed or failed, mark as failed
          const currentJob = jobStore.getJob(job.id);
          if (currentJob && currentJob.status === JobStatus.ACTIVE) {
            jobStore.updateJob(job.id, {
              status: JobStatus.FAILED,
              error: `Worker exited with code ${code}`,
              completedAt: new Date()
            });

            // Report error via progress tracker
            progressTracker.reportError(job.videoId, `Worker thread exited unexpectedly with code ${code}`);
          }
        }

        // Remove worker from active list
        this.activeWorkers.delete(job.id);
      });

      console.log(`Started job ${job.id} in worker thread`);
    } catch (error: unknown) {
      console.error(`Error starting job ${job.id}:`, error);

      // Update job as failed
      jobStore.updateJob(job.id, {
        status: JobStatus.FAILED,
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date()
      });

      // Report error via progress tracker
      progressTracker.reportError(job.videoId, `Failed to start worker: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// Create job manager instance
const jobManager = new YoutubeJobManager();

// Add a job to the queue
export const addYoutubeProcessingJob = async (data: {
  youtubeUrl: string;
  domains: string[];
  videoId: string;
  socketId?: string;
  userId?: string;
  accessToken?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  cookiesBrowser?: string;
}) => {
  // Add job to store
  const job = jobStore.addJob(data);
  console.log(`Added YouTube processing job to queue: ${job.id}`);
  return job;
};

// Get job status
export const getJobStatus = async (jobId: string) => {
  const job = jobStore.getJob(jobId);

  if (!job) {
    return { exists: false };
  }

  return {
    exists: true,
    state: job.status,
    progress: job.progress,
    data: {
      videoId: job.videoId,
      youtubeUrl: job.youtubeUrl,
      domains: job.domains
    },
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt
  };
};

export default { addYoutubeProcessingJob, getJobStatus, JobStatus }; 
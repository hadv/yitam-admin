import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import session from 'express-session';
import { createServer } from 'http';
import { Server } from 'socket.io';
import documentRoutes from './routes/document';
import youtubeRoutes from './routes/youtube';
import authRoutes from './routes/auth';
import { DatabaseService } from './core/database-service';

// Load environment variables
dotenv.config();

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3001;

// Create HTTP server
const httpServer = createServer(app);

// Initialize socket.io
const io = new Server(httpServer, {
  cors: {
    origin: [
      'http://localhost:5173',
      'http://localhost:3000',
      'http://127.0.0.1:5173'
    ],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log('New client connected', socket.id);
  
  // Handle joining a specific video room for progress updates
  socket.on('join-video-room', (data: { videoId: string }) => {
    if (data.videoId) {
      socket.join(`video-${data.videoId}`);
      console.log(`Socket ${socket.id} joined room for video ${data.videoId}`);
      
      // Send an immediate connection confirmation to the client
      socket.emit('room-joined', { 
        videoId: data.videoId,
        message: `Successfully joined room for video ${data.videoId}` 
      });
      
      // Import the progress tracker when needed to avoid circular dependencies
      const { progressTracker } = require('./services/progress-tracker');
      
      // Try to resend the latest update for this video
      const resent = progressTracker.resendLatestUpdate(data.videoId);
      
      // If no updates to resend, send a test progress update to verify communication
      if (!resent) {
        io.to(`video-${data.videoId}`).emit('progress-update', {
          videoId: data.videoId,
          stage: 'initializing',
          message: 'WebSocket connection established successfully',
          progress: 1
        });
      }
    } else {
      console.error('Socket tried to join a room without providing videoId', socket.id);
    }
  });
  
  // Handle client requesting the latest progress for a video
  socket.on('request-latest-progress', (data: { videoId: string }) => {
    if (data.videoId) {
      console.log(`Socket ${socket.id} requested latest progress for video ${data.videoId}`);
      
      // Import the progress tracker when needed to avoid circular dependencies
      const { progressTracker } = require('./services/progress-tracker');
      
      // Try to resend the latest update for this video
      const resent = progressTracker.resendLatestUpdate(data.videoId);
      
      if (!resent) {
        socket.emit('progress-update', {
          videoId: data.videoId,
          stage: 'unknown',
          message: 'No recent progress updates available for this video',
          progress: 0
        });
      }
    }
  });
  
  socket.on('error', (error) => {
    console.error('Socket error:', socket.id, error);
  });
  
  socket.on('disconnect', (reason) => {
    console.log('Client disconnected', socket.id, 'Reason:', reason);
  });
});

// Export socket.io instance for use in other modules
export { io };

// Initialize database service
const dbService = new DatabaseService();
dbService.initialize().then(() => {
  // Ensure uploads directory exists
  const uploadsDir = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log(`Created uploads directory at ${uploadsDir}`);
  } else {
    console.log(`Uploads directory exists at ${uploadsDir}`);
  }

  // Middleware
  app.use(cors({
    origin: function(origin, callback) {
      // Allow requests with no origin (like mobile apps or curl requests)
      if(!origin) return callback(null, true);
      
      const allowedOrigins = [
        'http://localhost:5173',
        'http://localhost:3000',
        // Add the actual frontend URL if different
        'http://127.0.0.1:5173'
      ];
      
      console.log('CORS Request from origin:', origin);
      
      // Check if the origin is allowed
      if(allowedOrigins.indexOf(origin) !== -1 || !origin) {
        callback(null, true);
      } else {
        console.log('CORS blocked for origin:', origin);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));
  app.use(express.json());
  
  // Session middleware for auth
  app.use(session({
    secret: process.env.SESSION_SECRET || 'youtube-oauth-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
  }));

  // Serve uploaded files
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

  // Routes
  app.use('/api/documents', documentRoutes);
  app.use('/api/youtube', youtubeRoutes);
  app.use('/api/auth', authRoutes);

  // Serve static files in production
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '../../client/dist')));

    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, '../../client/dist/index.html'));
    });
  }

  // Start server
  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(error => {
  console.error('Failed to initialize database service:', error);
}); 
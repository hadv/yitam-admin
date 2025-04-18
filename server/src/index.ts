import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import documentRoutes from './routes/document';
import { DatabaseService } from './core/database-service';

// Load environment variables
dotenv.config();

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3001;

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
  app.use(cors());
  app.use(express.json());

  // Serve uploaded files
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

  // Routes
  app.use('/api/documents', documentRoutes);

  // Serve static files in production
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '../../client/dist')));

    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, '../../client/dist/index.html'));
    });
  }

  // Start server
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(error => {
  console.error('Failed to initialize database service:', error);
}); 
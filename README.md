# Document Vector Storage

A minimalist React web application that allows users to upload documents and store their vector embeddings in a Qdrant vector database.

## Project Status

This project is ready for deployment with Docker Compose. All necessary components including frontend, backend, and the Qdrant vector database are configured and integrated.

### Features

- Upload documents (PDF, TXT, DOCX)
- Automatic text extraction from documents
- Vector embedding generation using Qdrant's built-in FastEmbed API
- Semantic search using vector similarity
- Document management (view, search, delete)

## Technology Stack

- **Frontend**: React, TypeScript, Tailwind CSS, Vite
- **Backend**: Node.js, Express, TypeScript
- **Vector Database**: Qdrant with FastEmbed API
- **Embeddings**: Server-side embedding generation with Qdrant's FastEmbed
- **Deployment**: Docker, Docker Compose

## Project Structure

```
document-vector-storage/
├── client/               # Frontend React application
│   ├── src/              # React source code
│   │   ├── components/   # React components
│   │   └── pages/        # React pages
│   └── public/           # Static assets
├── server/               # Backend Node.js application
│   └── src/              # TypeScript source code
│       ├── controllers/  # Request handlers
│       ├── models/       # Data models
│       ├── routes/       # API routes
│       └── services/     # Business logic
├── uploads/              # Directory for uploaded files
└── qdrant_storage/       # Qdrant database persistence
```

## Setup and Installation

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)
- [Node.js](https://nodejs.org/) (v14 or higher) and npm (for development)

### Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/document-vector-storage.git
   cd document-vector-storage
   ```

2. Install dependencies:
   ```bash
   npm install
   cd client && npm install
   cd ../server && npm install
   ```

3. Start development servers:
   ```bash
   npm run dev
   ```
   This will start both the client and server in development mode.

### Production Deployment

1. Build and start the Docker containers:
   ```bash
   docker-compose up -d
   ```

2. The application will be available at:
   - Frontend: http://localhost
   - Backend API: http://localhost:3001
   - Qdrant API: http://localhost:6333

## Usage

1. Navigate to the web interface at http://localhost (or http://localhost:5173 in development mode)
2. Upload documents using the upload interface
3. The system will automatically extract text and generate vector embeddings
4. Use the search interface to find semantically similar documents
5. Manage your documents through the document management interface

## License

Apache License 2.0

This project is licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) file for the full license text. 
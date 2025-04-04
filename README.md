# Document Vector Storage

A minimalist React web application that allows users to upload documents and store their vector embeddings in a Qdrant vector database.

## Project Status

This repository contains the complete code structure for building a document vector storage application. It's currently in development stage with all necessary files and configuration in place.

### Features (Planned)

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
└── uploads/              # Directory for uploaded files
```

## Setup (In Progress)

The repository is currently being set up. Full installation and usage instructions will be provided soon.

## License

MIT 
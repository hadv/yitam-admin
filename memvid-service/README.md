# MemVid Service

A FastAPI-based microservice for video memory processing and management.

## Overview

The MemVid Service is a Python-based microservice built with FastAPI that handles video processing, memory extraction, and related operations within the YITAM Admin ecosystem.

## Features

- RESTful API built with FastAPI
- Automatic API documentation with Swagger/OpenAPI
- Health check endpoints
- CORS support for cross-origin requests
- Structured error handling
- Docker containerization

## Technology Stack

- **Framework**: FastAPI
- **Language**: Python 3.11+
- **API Documentation**: Swagger/OpenAPI
- **Containerization**: Docker
- **Development**: Hot reload, automatic testing

## Project Structure

```
memvid-service/
├── app/                    # Main application code
│   ├── api/               # API route handlers
│   ├── core/              # Core configuration and settings
│   ├── models/            # Pydantic models for request/response
│   └── main.py            # FastAPI application entry point
├── tests/                 # Test files
├── docs/                  # Documentation
├── scripts/               # Utility scripts
├── requirements.txt       # Production dependencies
├── requirements-dev.txt   # Development dependencies
├── Dockerfile            # Docker configuration
└── .env.template         # Environment variables template
```

## Development Setup

### Prerequisites

- Python 3.11 or higher
- pip (Python package manager)
- Docker (for containerized development)

### Local Development

1. Create and activate a virtual environment:
   ```bash
   cd memvid-service
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   pip install -r requirements-dev.txt
   ```

3. Copy environment template:
   ```bash
   cp .env.template .env
   ```

4. Run the development server:
   ```bash
   uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
   ```

### Docker Development

1. Build and run with Docker Compose (from project root):
   ```bash
   docker-compose up memvid-service
   ```

## API Documentation

Once the service is running, you can access:

- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc
- **OpenAPI JSON**: http://localhost:8000/openapi.json

## Health Check

The service provides a health check endpoint:

- **GET** `/health` - Returns service status and version information

## Environment Variables

See `.env.template` for required environment variables.

## Testing

Run tests with pytest:

```bash
pytest tests/
```

## Contributing

1. Follow PEP 8 style guidelines
2. Add tests for new features
3. Update documentation as needed
4. Use type hints for all functions

## License

This project is part of the YITAM Admin system and follows the same licensing terms.

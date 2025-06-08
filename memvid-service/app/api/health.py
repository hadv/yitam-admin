"""Health check endpoints for MemVid Service."""

from datetime import datetime
from typing import Dict, Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.config import settings


class HealthResponse(BaseModel):
    """Health check response model."""
    
    status: str
    service: str
    version: str
    timestamp: datetime
    environment: str
    uptime: str


router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check() -> HealthResponse:
    """
    Health check endpoint.
    
    Returns:
        HealthResponse: Service health status and metadata
    """
    return HealthResponse(
        status="healthy",
        service=settings.app_name,
        version=settings.app_version,
        timestamp=datetime.utcnow(),
        environment=settings.environment,
        uptime="0s"  # TODO: Implement actual uptime calculation
    )


@router.get("/health/ready", tags=["Health"])
async def readiness_check() -> Dict[str, Any]:
    """
    Readiness check endpoint for Kubernetes/Docker health checks.
    
    Returns:
        Dict: Simple ready status
    """
    return {"status": "ready"}


@router.get("/health/live", tags=["Health"])
async def liveness_check() -> Dict[str, Any]:
    """
    Liveness check endpoint for Kubernetes/Docker health checks.
    
    Returns:
        Dict: Simple alive status
    """
    return {"status": "alive"}

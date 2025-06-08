"""Base models for MemVid Service."""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class BaseResponse(BaseModel):
    """Base response model with common fields."""
    
    success: bool = True
    message: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class ErrorResponse(BaseModel):
    """Error response model."""
    
    success: bool = False
    error: str
    detail: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class PaginationParams(BaseModel):
    """Pagination parameters for list endpoints."""
    
    page: int = Field(default=1, ge=1, description="Page number")
    size: int = Field(default=20, ge=1, le=100, description="Items per page")
    
    @property
    def offset(self) -> int:
        """Calculate offset for database queries."""
        return (self.page - 1) * self.size


class PaginatedResponse(BaseResponse):
    """Paginated response model."""
    
    page: int
    size: int
    total: int
    pages: int

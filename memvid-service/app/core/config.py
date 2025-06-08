"""Configuration settings for MemVid Service."""

from typing import List, Optional
from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # Application Settings
    app_name: str = Field(default="MemVid Service", alias="APP_NAME")
    app_version: str = Field(default="1.0.0", alias="APP_VERSION")
    debug: bool = Field(default=False, alias="DEBUG")
    environment: str = Field(default="production", alias="ENVIRONMENT")
    
    # Server Configuration
    host: str = Field(default="0.0.0.0", alias="HOST")
    port: int = Field(default=8000, alias="PORT")
    
    # API Configuration
    api_v1_prefix: str = Field(default="/api/v1", alias="API_V1_PREFIX")
    docs_url: Optional[str] = Field(default="/docs", alias="DOCS_URL")
    redoc_url: Optional[str] = Field(default="/redoc", alias="REDOC_URL")
    
    # CORS Configuration
    allowed_origins: List[str] = Field(
        default=["http://localhost:3000", "http://localhost:5173", "http://localhost"],
        alias="ALLOWED_ORIGINS"
    )
    allowed_methods: List[str] = Field(
        default=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        alias="ALLOWED_METHODS"
    )
    allowed_headers: List[str] = Field(default=["*"], alias="ALLOWED_HEADERS")
    
    # Logging Configuration
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    log_format: str = Field(default="json", alias="LOG_FORMAT")
    
    # File Upload Configuration
    max_file_size: str = Field(default="100MB", alias="MAX_FILE_SIZE")
    upload_dir: str = Field(default="./uploads", alias="UPLOAD_DIR")
    
    class Config:
        """Pydantic configuration."""
        env_file = ".env"
        case_sensitive = False


# Global settings instance
settings = Settings()

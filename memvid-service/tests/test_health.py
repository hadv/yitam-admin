"""Tests for health check endpoints."""

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_check():
    """Test the health check endpoint."""
    response = client.get("/health")
    assert response.status_code == 200
    
    data = response.json()
    assert data["status"] == "healthy"
    assert data["service"] == "MemVid Service"
    assert data["version"] == "1.0.0"
    assert "timestamp" in data
    assert "environment" in data


def test_readiness_check():
    """Test the readiness check endpoint."""
    response = client.get("/health/ready")
    assert response.status_code == 200
    
    data = response.json()
    assert data["status"] == "ready"


def test_liveness_check():
    """Test the liveness check endpoint."""
    response = client.get("/health/live")
    assert response.status_code == 200
    
    data = response.json()
    assert data["status"] == "alive"


def test_root_endpoint():
    """Test the root endpoint."""
    response = client.get("/")
    assert response.status_code == 200
    
    data = response.json()
    assert data["service"] == "MemVid Service"
    assert data["version"] == "1.0.0"
    assert data["status"] == "running"

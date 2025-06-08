#!/usr/bin/env python3
"""Development script for MemVid Service."""

import subprocess
import sys
from pathlib import Path


def run_command(command: str, cwd: Path = None) -> int:
    """Run a shell command and return the exit code."""
    print(f"Running: {command}")
    result = subprocess.run(command, shell=True, cwd=cwd)
    return result.returncode


def main():
    """Main development script."""
    if len(sys.argv) < 2:
        print("Usage: python scripts/dev.py <command>")
        print("Commands:")
        print("  install    - Install dependencies")
        print("  run        - Run the development server")
        print("  test       - Run tests")
        print("  lint       - Run linting")
        print("  format     - Format code")
        return 1
    
    command = sys.argv[1]
    project_root = Path(__file__).parent.parent
    
    if command == "install":
        return run_command("pip install -r requirements.txt -r requirements-dev.txt", project_root)
    elif command == "run":
        return run_command("uvicorn app.main:app --reload --host 0.0.0.0 --port 8000", project_root)
    elif command == "test":
        return run_command("pytest", project_root)
    elif command == "lint":
        exit_code = 0
        exit_code |= run_command("flake8 app tests", project_root)
        exit_code |= run_command("mypy app", project_root)
        return exit_code
    elif command == "format":
        exit_code = 0
        exit_code |= run_command("black app tests", project_root)
        exit_code |= run_command("isort app tests", project_root)
        return exit_code
    else:
        print(f"Unknown command: {command}")
        return 1


if __name__ == "__main__":
    sys.exit(main())

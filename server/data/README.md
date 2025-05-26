# Data Directory

This directory contains runtime data files that are generated during application execution.

## Contents

- `jobs/` - Contains job queue persistence files
- Other runtime data will be stored in appropriate subdirectories

## Note

The contents of this directory are not tracked by Git (except this README file), as they contain 
environment-specific runtime data. The directory structure is maintained for application functionality.

To ensure the application works correctly after a fresh clone, the necessary subdirectories will be 
created automatically when the application runs. 
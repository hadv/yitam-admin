# Jobs Directory

This directory stores job queue persistence files in JSON format. The files contain:

- Processing history for YouTube videos
- Current job status
- Job results

## Note

The contents of this directory are not tracked by Git (except this README file), as they contain environment-specific runtime data.

The job queue system will automatically create the necessary files when the application runs. 
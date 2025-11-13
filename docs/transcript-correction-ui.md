# Transcript Correction UI Guide

## Overview

The Transcript Correction UI provides a visual interface for fixing spelling mistakes in YouTube transcripts, titles, and summaries stored in the vector database. This is particularly useful for correcting Buddhist terminology that may be incorrectly transcribed.

**Fields corrected:**
- Transcript content (both original and LLM-enhanced)
- Chunk titles
- Chunk summaries

## Accessing the UI

1. Start the server and client:
   ```bash
   # Terminal 1 - Start server
   cd server
   npm run dev

   # Terminal 2 - Start client
   cd client
   npm run dev
   ```

2. Open your browser and navigate to `http://localhost:5173`

3. Click on the **"Transcript Correction"** tab in the navigation menu

## Features

The UI has three main tabs:

### 1. Run Correction Tab

This tab allows you to correct transcripts in the database.

**Options:**
- **Video ID (Optional)**: Enter a specific YouTube video ID to correct only that video's transcript. Leave empty to correct all YouTube transcripts.

**Actions:**
- **Dry Run (Preview)**: Preview what changes will be made without actually modifying the database
- **Run Correction**: Apply the corrections to the database

**Results Display:**
- Total chunks processed
- Number of chunks modified
- Total number of replacements made
- Processing time
- Detailed breakdown of each correction rule and how many times it was applied

**Example Usage:**
1. Leave Video ID empty to correct all transcripts
2. Click "Dry Run (Preview)" to see what will be changed
3. Review the statistics
4. If satisfied, click "Run Correction" to apply changes

### 2. Preview Tab

Test correction rules on sample text before applying them to the database.

**How to Use:**
1. Enter or paste sample text in the text area
2. Click "Preview Corrections"
3. View the original and corrected text side-by-side
4. See which rules were applied and how many times

**Example:**
```
Original: Trong thiền định, chúng ta cần rộng lặng tâm và không dính mắt vào bất cứ điều gì.
Corrected: Trong thiền định, chúng ta cần rỗng lặng tâm và không dính mắc vào bất cứ điều gì.
```

### 3. Correction Rules Tab

View and manage correction rules.

**Features:**
- View all default Buddhist terminology correction rules
- Add custom correction rules
- Edit existing rules
- Remove rules
- Reset to default rules
- Toggle case sensitivity for each rule

**Default Rules:**
1. "dính mắt" → "dính mắc"
2. "rộng lặng" → "rỗng lặng"

**Note:** Custom rules in the UI are currently for preview purposes only. The actual correction API uses the default rules defined in the server.

## Visual Indicators

### Color Coding

- **Blue**: Information and statistics
- **Green**: Success messages and modified chunks
- **Orange**: Processing time
- **Purple**: Total replacements
- **Red**: Errors

### Status Messages

- **Success**: Green background with checkmark icon
- **Error**: Red background with alert icon
- **Dry Run**: Blue info message indicating no changes were made

## Best Practices

### 1. Always Use Dry Run First

Before making actual changes to the database:
1. Run a dry run to preview changes
2. Review the statistics carefully
3. Check the replacement details
4. Only then proceed with actual correction

### 2. Test on Specific Videos First

If you're unsure about the corrections:
1. Start with a single video ID
2. Run dry run on that video
3. Verify the results
4. Then apply to all videos

### 3. Use Preview for Testing

Before running corrections on the database:
1. Use the Preview tab to test your text
2. Verify the corrections are correct
3. Check that no unwanted replacements occur

### 4. Monitor Processing Time

- Large databases may take time to process
- The UI shows processing time for each operation
- Be patient during actual corrections

## Troubleshooting

### No Changes Detected

If dry run shows 0 modifications:
- The transcripts may already be correct
- Check if the video ID is valid
- Verify the correction rules match the errors in your data

### Error Messages

Common errors and solutions:

1. **"Failed to correct transcripts"**
   - Check server is running
   - Verify API endpoint is accessible
   - Check server logs for details

2. **"No transcript found for this video ID"**
   - Verify the video ID is correct
   - Make sure the video has been processed first
   - Check the video exists in the database

3. **"Please enter some text to preview"**
   - Enter text in the preview text area before clicking preview

## API Integration

The UI communicates with these API endpoints:

- `GET /api/youtube/correction-rules` - Get default rules
- `POST /api/youtube/correct-youtube-transcripts` - Run correction
- `POST /api/youtube/preview-corrections` - Preview corrections

For API documentation, see [transcript-correction.md](./transcript-correction.md)

## Screenshots

### Run Correction Tab
Shows video ID input, action buttons, and results with statistics.

### Preview Tab
Displays original and corrected text side-by-side with change details.

### Correction Rules Tab
Lists all correction rules with edit and delete options.

## Future Enhancements

Potential improvements:
- Batch processing with progress bar
- Export correction reports
- Custom rule persistence
- Undo functionality
- Correction history
- Multi-language support


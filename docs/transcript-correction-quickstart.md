# Transcript Correction - Quick Start Guide

## 🚀 Quick Start

### 1. Start the Application

```bash
# Terminal 1: Start Server
cd server
npm run dev

# Terminal 2: Start Client  
cd client
npm run dev
```

### 2. Access the UI

Open browser: `http://localhost:5173`

Click on **"Transcript Correction"** tab

## 📋 Common Use Cases

### Use Case 1: Preview Changes (Dry Run)

**Goal:** See what will be changed without modifying the database

**Steps:**
1. Go to "Run Correction" tab
2. Leave "Video ID" empty (to check all videos)
3. Click **"Dry Run (Preview)"** button
4. Review the statistics:
   - How many chunks will be modified
   - What replacements will be made
   - Processing time estimate

**Example Output:**
```
✓ YouTube transcript correction completed (dry run)
  
Statistics:
- Total chunks processed: 150
- Chunks modified: 45
- Total replacements: 67
- Processing time: 12.5s

Replacement Details:
- dính mắt → dính mắc: 34 occurrences
- rộng lặng → rỗng lặng: 33 occurrences
```

### Use Case 2: Correct All Transcripts

**Goal:** Fix all spelling mistakes in all YouTube transcripts

**Steps:**
1. First, run a dry run (see Use Case 1)
2. Review the results carefully
3. If satisfied, click **"Run Correction"** button
4. Wait for processing to complete
5. Review the final statistics

**⚠️ Warning:** This will modify the database. Always dry run first!

### Use Case 3: Correct Specific Video

**Goal:** Fix spelling mistakes in one specific video

**Steps:**
1. Enter the YouTube video ID in the "Video ID" field
   - Example: `dQw4w9WgXcQ`
2. Click **"Dry Run (Preview)"** to preview changes
3. Review the results
4. Click **"Run Correction"** to apply changes

**When to use:**
- Testing corrections on a small dataset
- Fixing a specific video you just uploaded
- Troubleshooting issues with a particular video

### Use Case 4: Test Corrections on Sample Text

**Goal:** Verify correction rules work correctly

**Steps:**
1. Go to "Preview" tab
2. Enter sample text with known errors:
   ```
   Trong thiền định, chúng ta cần rộng lặng tâm và không dính mắt vào bất cứ điều gì.
   ```
3. Click **"Preview Corrections"**
4. Compare original vs corrected text:
   ```
   Original:  ...rộng lặng tâm và không dính mắt...
   Corrected: ...rỗng lặng tâm và không dính mắc...
   ```

**When to use:**
- Before running corrections on the database
- Testing new correction rules
- Verifying corrections are accurate

### Use Case 5: View Correction Rules

**Goal:** See what corrections will be applied

**Steps:**
1. Go to "Correction Rules" tab
2. View the default Buddhist terminology rules:
   - dính mắt → dính mắc
   - rộng lặng → rỗng lặng
3. Optionally add custom rules for testing

## 🎯 Recommended Workflow

### First Time Setup

```
1. Preview Tab
   └─> Test sample text
       └─> Verify corrections are correct

2. Run Correction Tab  
   └─> Dry run on specific video
       └─> Review results
           └─> Dry run on all videos
               └─> Review results
                   └─> Run actual correction
```

### Regular Maintenance

```
1. New video uploaded
   └─> Run dry run on that video ID
       └─> If errors found, run correction
           └─> Verify results
```

### Bulk Correction

```
1. Dry run on all videos
   └─> Review statistics
       └─> If significant changes, test on sample first
           └─> Run correction on all
               └─> Monitor processing time
```

## 💡 Tips & Tricks

### Tip 1: Always Dry Run First
Never run corrections without a dry run. It's like a safety net!

### Tip 2: Start Small
Test on one video before correcting all videos.

### Tip 3: Monitor Statistics
Pay attention to:
- Number of chunks modified (should be reasonable)
- Replacement details (verify they make sense)
- Processing time (plan accordingly)

### Tip 4: Use Preview for Testing
The Preview tab is perfect for:
- Testing new correction rules
- Verifying edge cases
- Training team members

### Tip 5: Check Processing Time
For large databases:
- Dry run shows estimated time
- Plan corrections during low-traffic periods
- Be patient during processing

## ⚠️ Important Notes

### Database Modifications
- **Dry Run**: Safe, no changes made
- **Run Correction**: Modifies database permanently
- **No Undo**: Changes cannot be automatically reversed

### Re-embedding
When corrections are applied:
- Content is updated
- New embeddings are generated
- This takes time (API calls to Gemini)
- Rate limits may apply

### Video ID Format
Valid formats:
- `dQw4w9WgXcQ` (11 characters)
- Full URL: `https://www.youtube.com/watch?v=dQw4w9WgXcQ`
- Short URL: `https://youtu.be/dQw4w9WgXcQ`

## 🐛 Troubleshooting

### Problem: No changes detected
**Solution:** 
- Verify video ID is correct
- Check if transcripts already corrected
- Ensure video has been processed

### Problem: Processing takes too long
**Solution:**
- Normal for large databases
- Check server logs for progress
- Consider correcting in batches by video ID

### Problem: Unexpected replacements
**Solution:**
- Use Preview tab to test
- Review correction rules
- Check for case sensitivity issues

## 📞 Need Help?

1. Check server logs: `server/logs/`
2. Review API documentation: `docs/transcript-correction.md`
3. Test with sample data first
4. Use dry run extensively

## 🎉 Success Checklist

Before running actual corrections:
- [ ] Tested with Preview tab
- [ ] Ran dry run on sample video
- [ ] Reviewed statistics
- [ ] Verified replacement details
- [ ] Checked processing time is acceptable
- [ ] Confirmed correction rules are correct
- [ ] Ready to proceed with actual correction

Happy correcting! 🎊


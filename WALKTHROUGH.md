# Google Drive Rename Feature Walkthrough

This feature allows you to rename files in a Google Drive folder by matching YouTube Video IDs in their filenames.

## UI Usage

1.  Navigate to the **Server Files** page.
2.  Click on the **Rename YouTube Files** button (purple button next to Sync).
3.  If not authenticated, you will be redirected to sign in with Google.
4.  In the popup modal, enter the **Google Drive Folder URL**.
5.  Click **Start Rename**.
6.  Wait for the process to complete.
7.  The modal will show:
    *   Number of files renamed (with a list of changes).
    *   Number of files skipped (already correct).
    *   Any errors encountered.

## API Usage

**Endpoint:** `POST /api/google-drive/rename-youtube-files`

**Headers:**
- `Authorization`: `Bearer <YOUR_ACCESS_TOKEN>`
- `Content-Type`: `application/json`

**Body:**
```json
{
  "folderUrl": "https://drive.google.com/drive/folders/10Rvxq7ZYm5kLgiCjenbrUYIQUFKA8WEq"
}
```

## Logic Verification

### 1. File Renaming Logic (Index + Publish Date)
Files are sorted by their **YouTube Publish Date** (oldest to newest) and given an index prefix.

Input Filename: `3L6kXsAOZ4w_dch_cn_kinh_l_g_dck_1_tm_s_312.mp4`
YouTube Title: `dịch cân kinh là gì ?dck 1_tám s 3/12`
YouTube Publish Date: `2023-01-15T...` (Sorted Position: 0)
New Filename: `01_dịch cân kinh là gì ?dck 1_tám s 3_12_3L6kXsAOZ4w.mp4`

Input Filename: `ANOTHERID11_video.mp4` (or `Previous_Title_ANOTHERID11.mp4`)
YouTube Publish Date: `2023-02-20T...` (Sorted Position: 1)
New Filename: `02_Another Title_ANOTHERID11.mp4`

**Step-by-step:**

1.  The app lists all files in the provided Google Drive folder.
2.  It identifies files by extracting the YouTube Video ID from:
    *   **Suffix**: `..._VIDEO_ID.ext` (e.g. `My_Video_VIDEOID11.mp4`)
    *   **Prefix**: `VIDEO_ID...ext` (e.g. `VIDEOID11_My_Video.mp4`)
3.  It fetches **Title** and **Publish Date** for all extracted IDs from YouTube Data API (in batches).
4.  It **sorts** the files based on Publish Date (oldest first).
5.  It renames the files using the format: `[Index]_[Title]_[ID].[Extension]`, where `[Index]` is a zero-padded number starting from `01` (`01`, `02`, ...).

> [!NOTE]
> Files matching `[Index]_[Title]_[ID].[ext]` exactly are skipped.

# Google Drive File Renaming with YouTube Titles

## Goal
Implement a backend feature to rename files in a specified Google Drive folder. The feature will identify YouTube video IDs at the beginning of filenames, fetch the corresponding video titles from YouTube, and rename the files to include the title while preserving the ID and extension.

## User Review Required
> [!IMPORTANT]
> This feature requires the Google Drive API to have `https://www.googleapis.com/auth/drive.metadata` or similar scope to rename files. The existing scopes in `GOOGLE_DRIVE_SYNC.md` include `https://www.googleapis.com/auth/drive.file`. We need to verify if this is sufficient for renaming files that might not have been created by this app (if the user inputs *any* folder).
> If the app needs to rename files it didn't create, it might need `https://www.googleapis.com/auth/drive`.
> **Assumption**: The user will provide a folder where the app has permission to edit files.

## Proposed Changes

### Server

#### [MODIFY] [google-drive.ts](file:///Users/hadv/yitam-admin/server/src/services/google-drive.ts)
- Add helper `extractFolderIdFromUrl(url: string): string | null`.
- Add function `renameFilesInDrive(folderId: string, userId: string): Promise<RenameResult>`.
    - List files in folder.
    - Loop through files.
    - Match ID regex `^[a-zA-Z0-9_-]{11}`.
    - Call `getVideoDetails(id)`.
    - Rename file using `drive.files.update`.

#### [MODIFY] [controller.ts](file:///Users/hadv/yitam-admin/server/src/controllers/google-drive.ts)
- Add controller `renameYoutubeFiles`.
    - valid `folderUrl` from body.
    - call `renameFilesInDrive`.

#### [MODIFY] [routes.ts](file:///Users/hadv/yitam-admin/server/src/routes/google-drive.ts)
- Add route `POST /api/google-drive/rename-youtube-files`.

## Verification Plan

### Automated Tests
- I will create a test script `scripts/test-drive-rename-logic.ts` that mocks the Google Drive API and YouTube fetcher to verify the regex extraction and renaming logic without making actual API calls.

### Manual Verification
- The user can trigger the API endpoint manually using a tool like Postman or curl with a valid bearer token and a Google Drive folder link.
- Command:
```bash
curl -X POST http://localhost:3001/api/google-drive/rename-youtube-files \
  -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"folderUrl": "https://drive.google.com/drive/folders/..."}'
```

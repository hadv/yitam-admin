# Google Drive Rename UI Implementation Plan

## Goal
Implement a UI in the `FileBrowser` component to trigger the Google Drive file renaming feature.
**Update**: The backend logic has been updated to use the format `[Title]_[ID].[ext]` as requested.

## Proposed Changes

### Client

#### [MODIFY] [google-drive.ts](file:///Users/hadv/yitam-admin/client/src/types/google-drive.ts)
- Add `RenameRequest` interface.
- Add `RenameResult` interface.

#### [MODIFY] [googleDriveService.ts](file:///Users/hadv/yitam-admin/client/src/services/googleDriveService.ts)
- Add `renameYoutubeFiles(request: RenameRequest): Promise<RenameResult>` method.

#### [MODIFY] [FileBrowser.tsx](file:///Users/hadv/yitam-admin/client/src/components/FileBrowser.tsx)
- Add a "Rename YouTube Files" button to the header (next to Sync).
- Implement `RenameModal` component (internal to FileBrowser or separate).
    - Input: Folder URL.
    - Button: "Rename".
    - Progress/Result display similar to Sync modal.
- Add handlers for opening modal and submitting request.

## Verification Plan

### Manual Verification
1.  Open the application in the browser.
2.  Navigate to the File Browser.
3.  Click "Rename YouTube Files".
4.  Enter a valid Google Drive Folder URL (e.g. one containing `3L6kXsAOZ4w_dch_cn_kinh_l_g_dck_1_tm_s_312.mp4`).
5.  Click "Rename".
6.  Verify the file is renamed to `[Title]_[ID].mp4`.

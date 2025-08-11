import axios from 'axios';
import {
  DriveFile,
  DriveFolder,
  SyncResult,
  SyncRequest,
  CreateFolderRequest,
  UploadFileRequest,
  CheckFileRequest
} from '@/types/google-drive';

class GoogleDriveService {
  private getAuthHeaders() {
    const token = localStorage.getItem('googleAccessToken');
    if (!token) {
      throw new Error('No Google access token found. Please authenticate first.');
    }
    
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Sync files from server directory to Google Drive folder
   */
  async syncFiles(request: SyncRequest): Promise<SyncResult> {
    try {
      const response = await axios.post('/api/google-drive/sync', request, {
        headers: this.getAuthHeaders()
      });
      
      return response.data.result;
    } catch (error) {
      console.error('Error syncing files to Google Drive:', error);
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Authentication failed. Please re-authenticate with Google.');
        }
        throw new Error(error.response?.data?.message || 'Failed to sync files to Google Drive');
      }
      throw new Error('Failed to sync files to Google Drive');
    }
  }

  /**
   * Create or find a folder in Google Drive
   */
  async createFolder(request: CreateFolderRequest): Promise<DriveFolder> {
    try {
      const response = await axios.post('/api/google-drive/folder', request, {
        headers: this.getAuthHeaders()
      });
      
      return response.data.folder;
    } catch (error) {
      console.error('Error creating folder in Google Drive:', error);
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Authentication failed. Please re-authenticate with Google.');
        }
        throw new Error(error.response?.data?.message || 'Failed to create folder in Google Drive');
      }
      throw new Error('Failed to create folder in Google Drive');
    }
  }

  /**
   * Upload a single file to Google Drive
   */
  async uploadFile(request: UploadFileRequest): Promise<DriveFile> {
    try {
      const response = await axios.post('/api/google-drive/upload', request, {
        headers: this.getAuthHeaders()
      });
      
      return response.data.file;
    } catch (error) {
      console.error('Error uploading file to Google Drive:', error);
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Authentication failed. Please re-authenticate with Google.');
        }
        if (error.response?.status === 404) {
          throw new Error('File not found on server');
        }
        throw new Error(error.response?.data?.message || 'Failed to upload file to Google Drive');
      }
      throw new Error('Failed to upload file to Google Drive');
    }
  }

  /**
   * Check if a file exists in Google Drive
   */
  async checkFileExists(request: CheckFileRequest): Promise<{ exists: boolean; file?: DriveFile }> {
    try {
      const params = new URLSearchParams();
      params.append('fileName', request.fileName);
      if (request.folderId) {
        params.append('folderId', request.folderId);
      }

      const response = await axios.get(`/api/google-drive/check?${params.toString()}`, {
        headers: this.getAuthHeaders()
      });
      
      return {
        exists: response.data.exists,
        file: response.data.file
      };
    } catch (error) {
      console.error('Error checking file in Google Drive:', error);
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Authentication failed. Please re-authenticate with Google.');
        }
        throw new Error(error.response?.data?.message || 'Failed to check file in Google Drive');
      }
      throw new Error('Failed to check file in Google Drive');
    }
  }

  /**
   * Check if user is authenticated with Google
   */
  isAuthenticated(): boolean {
    const token = localStorage.getItem('googleAccessToken');
    return !!token;
  }

  /**
   * Get stored access token
   */
  getAccessToken(): string | null {
    return localStorage.getItem('googleAccessToken');
  }

  /**
   * Store access token
   */
  setAccessToken(token: string): void {
    localStorage.setItem('googleAccessToken', token);
  }

  /**
   * Remove stored access token
   */
  clearAccessToken(): void {
    localStorage.removeItem('googleAccessToken');
  }

  /**
   * Redirect to Google OAuth for authentication
   */
  async authenticate(): Promise<void> {
    try {
      // Get the auth URL from the server
      const response = await axios.get('/api/auth/google');
      const authUrl = response.data.authUrl;
      
      // Redirect to Google OAuth
      window.location.href = authUrl;
    } catch (error) {
      console.error('Error getting Google auth URL:', error);
      throw new Error('Failed to initiate Google authentication');
    }
  }
}

// Export singleton instance
export const googleDriveService = new GoogleDriveService();
export default googleDriveService;

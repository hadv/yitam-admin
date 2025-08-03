export interface ServerFile {
  fileName: string;
  filePath: string;
  relativePath: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
  type: 'document' | 'video' | 'unknown';
  extension: string;
  directory: 'uploads' | 'downloads';
}

export interface FileStatistics {
  total: number;
  byType: {
    document: number;
    video: number;
    unknown: number;
  };
  byDirectory: {
    uploads: number;
    downloads: number;
  };
  totalSize: number;
  averageSize: number;
}

export interface FileListResponse {
  files: ServerFile[];
  total: number;
  hasMore: boolean;
  statistics: FileStatistics;
}

export type FileFilterType = 'all' | 'document' | 'video' | 'unknown';
export type DirectoryFilterType = 'all' | 'uploads' | 'downloads';
export type SortField = 'fileName' | 'size' | 'createdAt' | 'modifiedAt' | 'type';
export type SortDirection = 'asc' | 'desc';

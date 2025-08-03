import { useState, useEffect, useMemo } from 'react';
import axios from '@/utils/axiosConfig';
import {
  FiFile,
  FiVideo,
  FiImage,
  FiDownload,
  FiTrash2,
  FiSearch,
  FiFilter,
  FiRefreshCw,
  FiEye,
  FiFolder,
  FiHardDrive,
  FiBarChart,
  FiChevronDown,
  FiChevronUp
} from 'react-icons/fi';
import {
  ServerFile,
  FileStatistics,
  FileFilterType,
  DirectoryFilterType,
  SortField,
  SortDirection
} from '@/types/file-manager';

const FileBrowser = () => {
  const [files, setFiles] = useState<ServerFile[]>([]);
  const [statistics, setStatistics] = useState<FileStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<FileFilterType>('all');
  const [directoryFilter, setDirectoryFilter] = useState<DirectoryFilterType>('all');
  const [sortField, setSortField] = useState<SortField>('modifiedAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [showFilters, setShowFilters] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Load files on component mount and when filters change
  useEffect(() => {
    loadFiles();
  }, []);

  const loadFiles = async () => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (searchTerm.trim()) {
        params.append('search', searchTerm.trim());
      }
      if (typeFilter !== 'all') {
        params.append('type', typeFilter);
      }
      if (directoryFilter !== 'all') {
        params.append('directory', directoryFilter);
      }

      const response = await axios.get(`/api/files?${params.toString()}`);
      setFiles(response.data.files || []);
      setStatistics(response.data.statistics);
    } catch (err) {
      console.error('Error loading files:', err);
      if (axios.isAxiosError(err) && err.response) {
        setError(err.response.data.message || 'Failed to load files');
      } else {
        setError('Failed to load files');
      }
    } finally {
      setLoading(false);
    }
  };

  // Sort and filter files locally
  const sortedFiles = useMemo(() => {
    const sorted = [...files].sort((a, b) => {
      let aValue: any = a[sortField];
      let bValue: any = b[sortField];

      // Handle date fields
      if (sortField === 'createdAt' || sortField === 'modifiedAt') {
        aValue = new Date(aValue).getTime();
        bValue = new Date(bValue).getTime();
      }

      // Handle string fields
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        aValue = aValue.toLowerCase();
        bValue = bValue.toLowerCase();
      }

      if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    return sorted;
  }, [files, sortField, sortDirection]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    loadFiles();
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const deleteFile = async (file: ServerFile) => {
    if (!confirm(`Are you sure you want to delete ${file.fileName}?`)) {
      return;
    }

    try {
      setDeleting(file.fileName);
      setError(null);

      await axios.delete(`/api/files/${file.fileName}?directory=${file.directory}`);

      // Remove from local state
      setFiles(prev => prev.filter(f => f.fileName !== file.fileName));
      
      // Update statistics
      if (statistics) {
        setStatistics({
          ...statistics,
          total: statistics.total - 1,
          byType: {
            ...statistics.byType,
            [file.type]: statistics.byType[file.type] - 1
          },
          byDirectory: {
            ...statistics.byDirectory,
            [file.directory]: statistics.byDirectory[file.directory] - 1
          },
          totalSize: statistics.totalSize - file.size
        });
      }
    } catch (err) {
      console.error('Error deleting file:', err);
      if (axios.isAxiosError(err) && err.response) {
        setError(err.response.data.message || 'Failed to delete file');
      } else {
        setError('Failed to delete file');
      }
    } finally {
      setDeleting(null);
    }
  };

  const getFileIcon = (file: ServerFile) => {
    switch (file.type) {
      case 'video':
        return <FiVideo className="h-5 w-5 text-red-500" />;
      case 'document':
        if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp'].includes(file.extension)) {
          return <FiImage className="h-5 w-5 text-green-500" />;
        }
        return <FiFile className="h-5 w-5 text-blue-500" />;
      default:
        return <FiFile className="h-5 w-5 text-gray-500" />;
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getDirectoryIcon = (directory: string) => {
    return directory === 'uploads' ? (
      <FiFolder className="h-4 w-4 text-blue-500" />
    ) : (
      <FiHardDrive className="h-4 w-4 text-green-500" />
    );
  };

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="bg-white rounded-lg shadow-lg">
        {/* Header */}
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-gray-900 flex items-center">
              <FiHardDrive className="mr-3 text-blue-600" />
              Server Files
            </h1>
            <button
              onClick={loadFiles}
              disabled={loading}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
            >
              <FiRefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>

          {/* Statistics */}
          {statistics && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="bg-blue-50 p-4 rounded-lg">
                <div className="flex items-center">
                  <FiBarChart className="h-5 w-5 text-blue-600 mr-2" />
                  <div>
                    <p className="text-sm font-medium text-blue-600">Total Files</p>
                    <p className="text-2xl font-bold text-blue-900">{statistics.total}</p>
                  </div>
                </div>
              </div>
              <div className="bg-green-50 p-4 rounded-lg">
                <div className="flex items-center">
                  <FiFile className="h-5 w-5 text-green-600 mr-2" />
                  <div>
                    <p className="text-sm font-medium text-green-600">Documents</p>
                    <p className="text-2xl font-bold text-green-900">{statistics.byType.document}</p>
                  </div>
                </div>
              </div>
              <div className="bg-red-50 p-4 rounded-lg">
                <div className="flex items-center">
                  <FiVideo className="h-5 w-5 text-red-600 mr-2" />
                  <div>
                    <p className="text-sm font-medium text-red-600">Videos</p>
                    <p className="text-2xl font-bold text-red-900">{statistics.byType.video}</p>
                  </div>
                </div>
              </div>
              <div className="bg-purple-50 p-4 rounded-lg">
                <div className="flex items-center">
                  <FiHardDrive className="h-5 w-5 text-purple-600 mr-2" />
                  <div>
                    <p className="text-sm font-medium text-purple-600">Total Size</p>
                    <p className="text-lg font-bold text-purple-900">{formatFileSize(statistics.totalSize)}</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Search and Filters */}
          <div className="space-y-4">
            <form onSubmit={handleSearch} className="flex items-center space-x-4">
              <div className="flex-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <FiSearch className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Search files by name..."
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
              >
                Search
              </button>
              <button
                type="button"
                onClick={() => setShowFilters(!showFilters)}
                className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                <FiFilter className="mr-2 h-4 w-4" />
                Filters
                {showFilters ? <FiChevronUp className="ml-2 h-4 w-4" /> : <FiChevronDown className="ml-2 h-4 w-4" />}
              </button>
            </form>

            {/* Filter Controls */}
            {showFilters && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">File Type</label>
                  <select
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value as FileFilterType)}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="all">All Types</option>
                    <option value="document">Documents</option>
                    <option value="video">Videos</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Directory</label>
                  <select
                    value={directoryFilter}
                    onChange={(e) => setDirectoryFilter(e.target.value as DirectoryFilterType)}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="all">All Directories</option>
                    <option value="uploads">Uploads</option>
                    <option value="downloads">Downloads</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="p-4 bg-red-50 border-l-4 border-red-400">
            <p className="text-red-700">{error}</p>
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="p-8 text-center">
            <FiRefreshCw className="animate-spin h-8 w-8 text-blue-600 mx-auto mb-4" />
            <p className="text-gray-600">Loading files...</p>
          </div>
        )}

        {/* Files Table */}
        {!loading && sortedFiles.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('fileName')}
                  >
                    <div className="flex items-center">
                      File Name
                      {sortField === 'fileName' && (
                        sortDirection === 'asc' ? <FiChevronUp className="ml-1 h-4 w-4" /> : <FiChevronDown className="ml-1 h-4 w-4" />
                      )}
                    </div>
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Directory
                  </th>
                  <th
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('size')}
                  >
                    <div className="flex items-center">
                      Size
                      {sortField === 'size' && (
                        sortDirection === 'asc' ? <FiChevronUp className="ml-1 h-4 w-4" /> : <FiChevronDown className="ml-1 h-4 w-4" />
                      )}
                    </div>
                  </th>
                  <th
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('modifiedAt')}
                  >
                    <div className="flex items-center">
                      Modified
                      {sortField === 'modifiedAt' && (
                        sortDirection === 'asc' ? <FiChevronUp className="ml-1 h-4 w-4" /> : <FiChevronDown className="ml-1 h-4 w-4" />
                      )}
                    </div>
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {sortedFiles.map((file) => (
                  <tr key={`${file.directory}-${file.fileName}`} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        {getFileIcon(file)}
                        <div className="ml-3">
                          <div className="text-sm font-medium text-gray-900 truncate max-w-xs" title={file.fileName}>
                            {file.fileName}
                          </div>
                          <div className="text-sm text-gray-500">{file.extension}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                        file.type === 'document' ? 'bg-blue-100 text-blue-800' :
                        file.type === 'video' ? 'bg-red-100 text-red-800' :
                        'bg-gray-100 text-gray-800'
                      }`}>
                        {file.type}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        {getDirectoryIcon(file.directory)}
                        <span className="ml-2 text-sm text-gray-900">{file.directory}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {formatFileSize(file.size)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {formatDate(file.modifiedAt)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center justify-end space-x-2">
                        {/* View/Download button */}
                        <a
                          href={`/api/files/${file.fileName}/serve?directory=${file.directory}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-900"
                          title="View/Download file"
                        >
                          <FiEye className="h-4 w-4" />
                        </a>
                        
                        {/* Download button */}
                        <a
                          href={`/api/files/${file.fileName}/serve?directory=${file.directory}&download=true`}
                          className="text-green-600 hover:text-green-900"
                          title="Download file"
                        >
                          <FiDownload className="h-4 w-4" />
                        </a>
                        
                        {/* Delete button */}
                        <button
                          onClick={() => deleteFile(file)}
                          disabled={deleting === file.fileName}
                          className="text-red-600 hover:text-red-900 disabled:opacity-50"
                          title="Delete file"
                        >
                          <FiTrash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Empty State */}
        {!loading && sortedFiles.length === 0 && (
          <div className="p-8 text-center">
            <FiFile className="mx-auto h-12 w-12 text-gray-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No files found</h3>
            <p className="text-gray-500">
              {searchTerm || typeFilter !== 'all' || directoryFilter !== 'all'
                ? 'Try adjusting your search or filters'
                : 'Upload some documents or download some videos to see them here'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default FileBrowser;

import { useState } from 'react'
import axios from '@/utils/axiosConfig'
import { FiFolder, FiFileText, FiTrash2, FiChevronRight, FiChevronDown, FiSearch } from 'react-icons/fi'

interface DocumentChunk {
  id: string
  documentName: string
  content: string
  title?: string
  summary?: string
  domains?: string[]
  score: number
}

interface DocumentManagementProps {
  onChunksDeleted?: () => void
}

const DocumentManagement = ({ onChunksDeleted }: DocumentManagementProps) => {
  const [searchResults, setSearchResults] = useState<string[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedDocument, setSelectedDocument] = useState<string | null>(null)
  const [documentChunks, setDocumentChunks] = useState<DocumentChunk[]>([])
  const [selectedChunks, setSelectedChunks] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionStatus, setActionStatus] = useState<string | null>(null)
  const [expandedChunks, setExpandedChunks] = useState<{ [key: string]: boolean }>({})

  // Handle search form submission
  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    
    if (searchTerm.trim().length < 2) {
      setSearchResults([])
      return
    }
    
    setSearchLoading(true)
    setError(null)
    
    try {
      // Properly encode Vietnamese characters
      const encodedTerm = encodeURIComponent(searchTerm.trim());
      
      // First try with proxy
      const apiUrl = `/api/documents/search-by-name?term=${encodedTerm}`;
      
      try {
        console.log(`Searching for documents with term: ${searchTerm} (encoded: ${encodedTerm})`);
        const response = await axios.get(apiUrl, {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Accept': 'application/json; charset=utf-8'
          }
        });
        setSearchResults(response.data.documents || []);
      } catch (err) {
        // Fall back to direct URL if proxy fails
        console.error('Error searching documents with proxy:', err);
        const directUrl = `http://localhost:3001/api/documents/search-by-name?term=${encodedTerm}`;
        const response = await axios.get(directUrl, { 
          withCredentials: true,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Accept': 'application/json; charset=utf-8'
          }
        });
        setSearchResults(response.data.documents || []);
      }
    } catch (err) {
      console.error('Error searching documents:', err);
      setError('Failed to search documents. Please try again.');
    } finally {
      setSearchLoading(false);
    }
  };

  // Handle search input change
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  };

  // Fetch chunks for a document
  const fetchDocumentChunks = async (documentName: string) => {
    setLoading(true)
    setError(null)
    setSelectedChunks([])
    
    // Add retry logic
    let retries = 0;
    const maxRetries = 3;
    let useDirectUrl = false;
    
    while (retries < maxRetries) {
      try {
        const encodedName = encodeURIComponent(documentName);
        const apiUrl = useDirectUrl 
          ? `http://localhost:3001/api/documents/chunks/${encodedName}`
          : `/api/documents/chunks/${encodedName}`;
        
        console.log(`Fetching chunks for document (attempt ${retries + 1}): ${documentName} from ${apiUrl}`);
        
        const response = await axios.get(apiUrl, { 
          headers: { 'Content-Type': 'application/json' },
          withCredentials: useDirectUrl, // Only send credentials for cross-origin requests
          timeout: 10000 // 10 second timeout
        });
        
        console.log('Document chunks response:', response.data);
        setDocumentChunks(response.data.chunks || [])
        setSelectedDocument(documentName)
        setLoading(false) // Make sure we set loading to false on success
        return; // Success, exit
      } catch (err: any) {
        console.error(`Error fetching document chunks (attempt ${retries + 1}):`, err)
        retries++;
        
        // After the first retry, try using direct URL
        if (retries === 2) {
          useDirectUrl = true;
          console.log('Switching to direct URL for the next attempt...');
        }
        
        if (retries >= maxRetries) {
          const errorMessage = err.code === 'ECONNABORTED' 
            ? 'Request timed out. The server may be busy.' 
            : 'Failed to load document chunks. Please try again.';
          setError(errorMessage)
          setDocumentChunks([]) // Reset chunks to empty array on final failure
        } else {
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    setLoading(false) // Make sure loading is set to false even after all retries fail
  }

  // Toggle chunk selection
  const toggleChunkSelection = (chunkId: string) => {
    setSelectedChunks(prev => 
      prev.includes(chunkId)
        ? prev.filter(id => id !== chunkId)
        : [...prev, chunkId]
    )
  }

  // Select all chunks
  const selectAllChunks = () => {
    if (loading) return; // Don't allow selection during loading
    
    if (selectedChunks.length === documentChunks.length) {
      // If all are selected, deselect all
      setSelectedChunks([])
    } else {
      // Otherwise, select all
      setSelectedChunks(documentChunks.map(chunk => chunk.id))
    }
  }

  // Toggle chunk expansion
  const toggleChunkExpansion = (chunkId: string) => {
    setExpandedChunks(prev => ({
      ...prev,
      [chunkId]: !prev[chunkId]
    }))
  }

  // Delete selected chunks
  const deleteSelectedChunks = async () => {
    if (selectedChunks.length === 0 || loading) return
    
    if (!confirm(`Are you sure you want to delete ${selectedChunks.length} selected chunks?`)) {
      return
    }
    
    setLoading(true)
    setError(null)
    setActionStatus(null)
    
    // Add retry logic
    let retries = 0;
    const maxRetries = 3;
    let useDirectUrl = false;
    
    while (retries < maxRetries) {
      try {
        const apiUrl = useDirectUrl 
          ? 'http://localhost:3001/api/documents/chunks'
          : '/api/documents/chunks';
        
        console.log(`Attempting to delete chunks (attempt ${retries + 1}) via ${apiUrl}...`);
        
        const response = await axios.delete(apiUrl, {
          data: { chunkIds: selectedChunks },
          headers: { 'Content-Type': 'application/json' },
          withCredentials: useDirectUrl, // Only send credentials for cross-origin requests
          timeout: 10000 // 10 second timeout
        });
        
        console.log('Delete response:', response.data);
        setActionStatus(`Successfully deleted ${response.data.deletedCount} chunks`)
        
        // Refresh the document chunks list
        if (selectedDocument) {
          await fetchDocumentChunks(selectedDocument)
          return; // Skip setting loading to false here as fetchDocumentChunks will do it
        }
        
        // Clear selection
        setSelectedChunks([])
        
        // Notify parent if callback exists
        if (onChunksDeleted) {
          onChunksDeleted()
        }
        
        setLoading(false)
        return; // Success, exit
      } catch (err: any) {
        console.error(`Error deleting chunks (attempt ${retries + 1}):`, err)
        retries++;
        
        // After the first retry, try using direct URL
        if (retries === 2) {
          useDirectUrl = true;
          console.log('Switching to direct URL for the next attempt...');
        }
        
        if (retries >= maxRetries) {
          const errorMessage = err.code === 'ECONNABORTED' 
            ? 'Request timed out. The server may be busy.' 
            : 'Failed to delete chunks. Please try again.';
          setError(errorMessage)
        } else {
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    setLoading(false)
  }

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <h2 className="p-4 text-xl font-bold text-gray-800 border-b bg-blue-50">Document Management</h2>
      
      {actionStatus && (
        <div className="p-3 bg-green-100 text-green-800 border-b font-medium">
          {actionStatus}
        </div>
      )}
      
      {error && (
        <div className="p-3 bg-red-100 text-red-800 border-b font-medium">
          {error}
        </div>
      )}
      
      <div className="flex flex-col md:flex-row">
        {/* Documents list panel */}
        <div className="w-full md:w-1/3 border-r">
          <div className="p-3 bg-blue-100 border-b">
            <h3 className="font-bold text-gray-800 flex items-center">
              <FiFolder className="mr-2 text-blue-600" />
              Document Search
            </h3>
          </div>
          
          {/* Search input with form */}
          <form onSubmit={handleSearch} className="p-3 border-b">
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <FiSearch className="text-gray-500" />
              </div>
              <input
                type="text"
                value={searchTerm}
                onChange={handleSearchChange}
                className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Enter document name..."
              />
              <button
                type="submit"
                className="mt-2 w-full bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded-md font-medium"
                disabled={searchLoading || searchTerm.trim().length < 2}
              >
                {searchLoading ? 'Searching...' : 'Search Documents'}
              </button>
            </div>
            {searchLoading && (
              <p className="text-xs text-gray-500 mt-1">Searching...</p>
            )}
            {searchResults.length > 0 && !searchLoading && (
              <p className="text-xs text-gray-500 mt-1">
                {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
              </p>
            )}
          </form>
          
          {!searchLoading && searchResults.length === 0 && searchTerm && (
            <div className="p-4 text-gray-700 text-center">No documents found matching "{searchTerm}"</div>
          )}
          
          {!searchTerm && !searchLoading && (
            <div className="p-4 text-gray-700 text-center">
              <p>Enter a document name and press Search</p>
            </div>
          )}
          
          <ul className="max-h-96 overflow-y-auto">
            {searchResults.map(document => (
              <li 
                key={document} 
                className={`p-3 border-b hover:bg-blue-100 cursor-pointer flex items-center ${
                  selectedDocument === document ? 'bg-blue-200 text-blue-800' : 'text-gray-800'
                }`}
                onClick={() => fetchDocumentChunks(document)}
              >
                <FiFileText className="mr-2 text-blue-600" />
                <span className="truncate font-medium">{document}</span>
              </li>
            ))}
          </ul>
        </div>
        
        {/* Document chunks panel */}
        <div className="w-full md:w-2/3">
          {selectedDocument ? (
            <>
              <div className="p-3 bg-blue-100 border-b flex justify-between items-center">
                <h3 className="font-bold text-gray-800">
                  Chunks for: <span className="text-blue-700">{selectedDocument}</span>
                </h3>
                
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={selectAllChunks}
                    className="text-sm font-bold text-blue-700 hover:text-blue-900 mr-4"
                    disabled={loading || documentChunks.length === 0}
                  >
                    {selectedChunks.length === documentChunks.length && documentChunks.length > 0
                      ? 'Deselect All' 
                      : 'Select All'
                    }
                  </button>
                  
                  <button
                    type="button"
                    onClick={deleteSelectedChunks}
                    disabled={loading || selectedChunks.length === 0}
                    className={`flex items-center px-3 py-1 rounded text-white font-bold ${
                      loading || selectedChunks.length === 0
                        ? 'bg-gray-400 cursor-not-allowed'
                        : 'bg-red-600 hover:bg-red-700'
                    }`}
                  >
                    <FiTrash2 className="mr-1" />
                    Delete ({selectedChunks.length})
                  </button>
                </div>
              </div>
              
              {loading && (
                <div className="p-4 text-gray-700 text-center font-medium">
                  <div className="animate-pulse flex flex-col items-center">
                    <div className="w-8 h-8 rounded-full bg-blue-400 mb-2"></div>
                    <p>Loading chunks...</p>
                  </div>
                </div>
              )}
              
              {!loading && documentChunks.length === 0 && (
                <div className="p-4 text-gray-700 text-center">No chunks found for this document</div>
              )}
              
              <ul className="max-h-96 overflow-y-auto">
                {documentChunks.map(chunk => (
                  <li key={chunk.id} className="border-b">
                    <div 
                      className={`p-3 hover:bg-blue-50 cursor-pointer flex items-start ${
                        selectedChunks.includes(chunk.id) ? 'bg-blue-100' : ''
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-1 mr-2"
                        checked={selectedChunks.includes(chunk.id)}
                        onChange={() => toggleChunkSelection(chunk.id)}
                      />
                      
                      <div className="flex-1 overflow-hidden">
                        <div 
                          className="flex items-center cursor-pointer"
                          onClick={() => toggleChunkExpansion(chunk.id)}
                        >
                          {expandedChunks[chunk.id] ? (
                            <FiChevronDown className="mr-1 text-blue-600" />
                          ) : (
                            <FiChevronRight className="mr-1 text-blue-600" />
                          )}
                          
                          <span className="font-bold text-gray-800">
                            {chunk.title || `Chunk ${chunk.id.substring(0, 8)}...`}
                          </span>
                        </div>
                        
                        {expandedChunks[chunk.id] && (
                          <div className="mt-2">
                            <div className="bg-white border border-gray-200 p-3 text-sm rounded shadow-sm">
                              <p className="whitespace-pre-line break-words text-gray-800">{chunk.content}</p>
                            </div>
                            
                            {chunk.domains && chunk.domains.length > 0 && (
                              <div className="mt-2 text-sm text-gray-700">
                                <span className="font-bold">Domains:</span> {chunk.domains.join(', ')}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="p-8 text-center text-gray-700">
              <FiFileText className="mx-auto text-blue-500 text-4xl mb-3" />
              <p className="font-medium">Select a document to view its chunks</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default DocumentManagement 
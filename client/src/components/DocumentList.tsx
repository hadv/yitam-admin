import { useState, useEffect } from 'react'
import axios from 'axios'
import { FiFileText, FiSearch, FiTrash, FiDownload } from 'react-icons/fi'

interface Document {
  id: string
  filename: string
  uploadedAt: string
  contentType: string
  path: string
  preview?: string
}

const DocumentList = () => {
  const [documents, setDocuments] = useState<Document[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const fetchDocuments = async () => {
    try {
      setLoading(true)
      const response = await axios.get('/api/documents')
      setDocuments(response.data)
      setError(null)
    } catch (err) {
      console.error('Error fetching documents:', err)
      setError('Failed to load documents')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchDocuments()
  }, [])

  const handleDelete = async (id: string) => {
    try {
      await axios.delete(`/api/documents/${id}`)
      setDocuments(documents.filter(doc => doc.id !== id))
    } catch (err) {
      console.error('Error deleting document:', err)
      setError('Failed to delete document')
    }
  }

  const handleDownload = (doc: Document) => {
    // Extract the filename from the path
    const filename = doc.path.split('/').pop() || doc.filename
    // Create download URL
    const downloadUrl = `/uploads/${filename}`
    
    // Create a temporary link element
    const link = document.createElement('a')
    link.href = downloadUrl
    link.setAttribute('download', doc.filename)
    link.setAttribute('target', '_blank')
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleSearch = async () => {
    if (!searchQuery) {
      fetchDocuments()
      return
    }

    try {
      setLoading(true)
      const response = await axios.get(`/api/documents/search?query=${encodeURIComponent(searchQuery)}`)
      setDocuments(response.data)
      setError(null)
    } catch (err) {
      console.error('Error searching documents:', err)
      setError('Failed to search documents')
    } finally {
      setLoading(false)
    }
  }

  // Filter documents by filename
  const filteredDocuments = documents.filter(
    doc => doc.filename.toLowerCase().includes(searchQuery.toLowerCase())
  )

  if (loading) {
    return (
      <div className="bg-white shadow rounded-lg p-4 flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-white shadow rounded-lg p-4">
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="p-4 border-b">
        <div className="flex items-center">
          <div className="relative flex-grow">
            <input
              type="text"
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring focus:ring-blue-500 focus:ring-opacity-50 pl-10 py-2"
              placeholder="Search documents..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
            />
            <div className="absolute left-3 top-2.5 text-gray-400">
              <FiSearch />
            </div>
          </div>
          <button
            onClick={handleSearch}
            className="ml-2 px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50"
          >
            Search
          </button>
        </div>
      </div>

      {filteredDocuments.length === 0 ? (
        <div className="p-6 text-center text-gray-500">
          No documents found
        </div>
      ) : (
        <ul className="divide-y divide-gray-200">
          {filteredDocuments.map((doc) => (
            <li key={doc.id} className="px-4 py-3 hover:bg-gray-50">
              <div className="flex items-center justify-between">
                <div className="flex-grow">
                  <div className="flex items-center">
                    <FiFileText className="text-blue-500 mr-3" size={20} />
                    <div>
                      <p className="font-medium text-gray-800">{doc.filename}</p>
                      <p className="text-sm text-gray-500">
                        {new Date(doc.uploadedAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  {doc.preview && (
                    <p className="text-sm text-gray-600 mt-1 ml-8 line-clamp-2">
                      {doc.preview}
                    </p>
                  )}
                </div>
                <div className="flex space-x-2 ml-4">
                  <button
                    onClick={() => handleDownload(doc)}
                    className="text-blue-500 hover:text-blue-700 focus:outline-none"
                    title="Download"
                  >
                    <FiDownload size={18} />
                  </button>
                  <button
                    onClick={() => handleDelete(doc.id)}
                    className="text-red-500 hover:text-red-700 focus:outline-none"
                    title="Delete"
                  >
                    <FiTrash size={18} />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default DocumentList 
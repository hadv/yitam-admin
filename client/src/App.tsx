import { useState } from 'react'
import DocumentUpload from '@components/DocumentUpload'
import YoutubeUpload from '@components/YoutubeUpload'
import YoutubeDelete from '@components/YoutubeDelete'

function App() {
  const [uploadSuccess, setUploadSuccess] = useState<boolean>(false)
  const [deleteSuccess, setDeleteSuccess] = useState<boolean>(false)
  const [activeTab, setActiveTab] = useState<'document' | 'youtube'>('document')

  const handleUploadSuccess = () => {
    setUploadSuccess(true)
    // Reset after a short delay
    setTimeout(() => setUploadSuccess(false), 3000)
  }

  const handleDeleteSuccess = () => {
    setDeleteSuccess(true)
    // Reset after a short delay
    setTimeout(() => setDeleteSuccess(false), 3000)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold text-gray-900">Document Vector Storage</h1>
        </div>
      </header>
      <main>
        <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="px-4 py-6 sm:px-0">
            {uploadSuccess && (
              <div className="mb-4 bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded">
                Content processed and embedded successfully!
              </div>
            )}
            
            {deleteSuccess && (
              <div className="mb-4 bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded">
                YouTube video chunks deleted successfully!
              </div>
            )}
            
            {/* Tab navigation */}
            <div className="border-b border-gray-200 mb-6">
              <nav className="-mb-px flex space-x-8">
                <button
                  onClick={() => setActiveTab('document')}
                  className={`pb-4 px-1 border-b-2 font-medium text-sm ${
                    activeTab === 'document'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Document Upload
                </button>
                <button
                  onClick={() => setActiveTab('youtube')}
                  className={`pb-4 px-1 border-b-2 font-medium text-sm ${
                    activeTab === 'youtube'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  YouTube Transcript
                </button>
              </nav>
            </div>
            
            {/* Tab content */}
            {activeTab === 'document' ? (
            <div>
              <h2 className="text-xl font-semibold mb-4">Upload Document</h2>
              <DocumentUpload onUploadSuccess={handleUploadSuccess} />
            </div>
            ) : (
              <div>
                <h2 className="text-xl font-semibold mb-4">YouTube Transcript Management</h2>
                <div className="mb-8">
                  <h3 className="text-lg font-semibold mb-4">Process YouTube Transcript</h3>
                  <YoutubeUpload onUploadSuccess={handleUploadSuccess} />
                </div>
                <div className="mt-10">
                  <h3 className="text-lg font-semibold mb-4">Delete YouTube Transcript</h3>
                  <YoutubeDelete onDeleteSuccess={handleDeleteSuccess} />
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
      <footer className="bg-white shadow mt-auto">
        <div className="max-w-7xl mx-auto py-4 px-4 sm:px-6 lg:px-8">
          <p className="text-center text-sm text-gray-500">
            Document Vector Storage - Powered by Qdrant
          </p>
        </div>
      </footer>
    </div>
  )
}

export default App 
import { useState } from 'react'
import DocumentUpload from './components/DocumentUpload'
import DocumentList from './components/DocumentList'

function App() {
  const [uploadSuccess, setUploadSuccess] = useState<boolean>(false)

  const handleUploadSuccess = () => {
    setUploadSuccess(true)
    // Reset after a short delay
    setTimeout(() => setUploadSuccess(false), 3000)
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
                Document uploaded and embedded successfully!
              </div>
            )}
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div>
                <h2 className="text-xl font-semibold mb-4">Upload Document</h2>
                <DocumentUpload onUploadSuccess={handleUploadSuccess} />
              </div>
              <div>
                <h2 className="text-xl font-semibold mb-4">Recent Documents</h2>
                <DocumentList />
              </div>
            </div>
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
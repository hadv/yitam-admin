import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import axios from 'axios'
import { FiUpload, FiFile } from 'react-icons/fi'

interface DocumentUploadProps {
  onUploadSuccess: () => void
}

const DocumentUpload = ({ onUploadSuccess }: DocumentUploadProps) => {
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return

    const file = acceptedFiles[0]
    setIsUploading(true)
    setError(null)
    setUploadProgress(0)

    try {
      const formData = new FormData()
      formData.append('document', file)

      await axios.post('/api/documents/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        },
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total)
            setUploadProgress(progress)
          }
        }
      })

      onUploadSuccess()
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        setError(err.response.data.message || 'Failed to upload document')
      } else {
        setError('An unexpected error occurred')
      }
    } finally {
      setIsUploading(false)
      setUploadProgress(0)
    }
  }, [onUploadSuccess])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'text/plain': ['.txt'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    },
    maxFiles: 1,
    disabled: isUploading
  })

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div
        {...getRootProps()}
        className={`dropzone ${isDragActive ? 'dropzone-active' : ''} ${isUploading ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <input {...getInputProps()} />
        <div className="flex flex-col items-center justify-center">
          {isUploading ? (
            <>
              <div className="mb-4 text-blue-500">
                <svg className="animate-spin h-8 w-8" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              </div>
              <p className="text-sm text-gray-600">Uploading... {uploadProgress}%</p>
            </>
          ) : (
            <>
              <div className="mb-4 text-blue-500">
                {isDragActive ? <FiFile size={48} /> : <FiUpload size={48} />}
              </div>
              <p className="text-lg font-medium">
                {isDragActive ? 'Drop the document here' : 'Drag & drop a document here'}
              </p>
              <p className="text-sm text-gray-500 mt-1">
                or click to browse (PDF, TXT, DOCX)
              </p>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 mt-4 rounded">
          {error}
        </div>
      )}
    </div>
  )
}

export default DocumentUpload 
import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import axios from 'axios'
import { FiUpload, FiFile, FiFolder, FiList } from 'react-icons/fi'
import { availableDomains } from '../constants/domains'
import DocumentManagement from './DocumentManagement'

interface DocumentUploadProps {
  onUploadSuccess: () => void
}

const DocumentUpload = ({ onUploadSuccess }: DocumentUploadProps) => {
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [selectedDomains, setSelectedDomains] = useState<string[]>([])
  const [documentTitle, setDocumentTitle] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [uploadMode, setUploadMode] = useState<'single' | 'folder'>('single')
  const [currentStep, setCurrentStep] = useState(1) // 1: Select document, 2: Configure, 3: Review & Submit
  const [activeTab, setActiveTab] = useState<'upload' | 'manage'>('upload')

  const handleDomainChange = (domain: string) => {
    setSelectedDomains(prev => 
      prev.includes(domain) 
        ? prev.filter(d => d !== domain) 
        : [...prev, domain]
    )
  }

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return

    if (uploadMode === 'single') {
      const file = acceptedFiles[0]
      setSelectedFile(file)
      // Suggest a document title based on filename
      const fileName = file.name.split('.')[0] // Remove extension
      setDocumentTitle(fileName)
      setSelectedFiles([])
    } else {
      // Filter only image files for folder upload
      const imageFiles = acceptedFiles.filter(file => 
        file.type.startsWith('image/')
      )
      
      if (imageFiles.length === 0) {
        setError('No image files found. Please upload PNG, JPEG, or TIFF files.')
        return
      }
      
      setSelectedFiles(imageFiles)
      setSelectedFile(null)
      
      // Set document title based on common prefix of filenames if possible
      if (imageFiles.length > 0) {
        const baseNames = imageFiles.map(file => file.name.split('-')[0])
        const mostCommonPrefix = findMostCommonPrefix(baseNames)
        setDocumentTitle(mostCommonPrefix || 'Scanned Document')
      }
    }
    
    setCurrentStep(2) // Move to configuration step after file selection
  }, [uploadMode])
  
  // Helper function to find the most common prefix from an array of strings
  const findMostCommonPrefix = (strings: string[]): string => {
    if (strings.length === 0) return '';
    
    // Count occurrences of each prefix
    const prefixCounts = new Map<string, number>();
    for (const str of strings) {
      const prefix = str.trim();
      if (prefix) {
        prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
      }
    }
    
    // Find the most common prefix
    let mostCommonPrefix = '';
    let maxCount = 0;
    for (const [prefix, count] of prefixCounts.entries()) {
      if (count > maxCount) {
        mostCommonPrefix = prefix;
        maxCount = count;
      }
    }
    
    return mostCommonPrefix;
  };
  
  const handleSubmit = async () => {
    if (uploadMode === 'single' && !selectedFile) return
    if (uploadMode === 'folder' && selectedFiles.length === 0) return
    
    setIsUploading(true)
    setError(null)
    setUploadProgress(0)

    try {
      const formData = new FormData()
      
      if (uploadMode === 'single') {
        formData.append('document', selectedFile as File)
      } else {
        // For folder upload, append all files
        selectedFiles.forEach((file) => {
          formData.append('documents', file)
        })
      }
      
      formData.append('domains', JSON.stringify(selectedDomains))
      
      // Add document title
      if (documentTitle) {
        formData.append('documentTitle', documentTitle)
      }

      const endpoint = uploadMode === 'single' 
        ? '/api/documents/upload' 
        : '/api/documents/upload-folder'

      await axios.post(endpoint, formData, {
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
      // Reset form
      setSelectedFile(null)
      setSelectedFiles([])
      setSelectedDomains([])
      setDocumentTitle('')
      setCurrentStep(1)
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
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: uploadMode === 'single' 
      ? {
          'application/pdf': ['.pdf'],
          'text/plain': ['.txt'],
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
        }
      : {
          'image/png': ['.png'],
          'image/jpeg': ['.jpg', '.jpeg'],
          'image/tiff': ['.tiff', '.tif'],
        },
    maxFiles: uploadMode === 'single' ? 1 : 50,
    disabled: isUploading || currentStep !== 1
  })

  const goBack = () => {
    if (currentStep > 1) {
      setCurrentStep(prev => prev - 1)
    }
  }

  // Handle document deletion success
  const handleDocumentDeleted = () => {
    // You could refresh any related data or show a notification
    // This is called when DocumentManagement component successfully deletes chunks
  }

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      {/* Tab navigation */}
      <div className="flex border-b">
        <button
          className={`px-4 py-3 font-medium ${
            activeTab === 'upload' 
              ? 'text-blue-600 border-b-2 border-blue-500' 
              : 'text-gray-500 hover:text-gray-700'
          }`}
          onClick={() => setActiveTab('upload')}
        >
          <div className="flex items-center">
            <FiUpload className="mr-2" />
            <span>Upload Document</span>
          </div>
        </button>
        
        <button
          className={`px-4 py-3 font-medium ${
            activeTab === 'manage' 
              ? 'text-blue-600 border-b-2 border-blue-500' 
              : 'text-gray-500 hover:text-gray-700'
          }`}
          onClick={() => setActiveTab('manage')}
        >
          <div className="flex items-center">
            <FiList className="mr-2" />
            <span>Manage Documents</span>
          </div>
        </button>
      </div>

      {activeTab === 'upload' ? (
        <>
          {/* Progress indicator */}
          <div className="px-4 pt-4">
            <div className="flex justify-between mb-4">
              <div className={`flex flex-col items-center ${currentStep >= 1 ? 'text-blue-600' : 'text-gray-400'}`}>
                <div className={`w-8 h-8 flex items-center justify-center rounded-full border-2 ${currentStep >= 1 ? 'border-blue-600 bg-blue-100' : 'border-gray-300'}`}>1</div>
                <span className="text-xs mt-1">Select Document</span>
              </div>
              <div className={`flex-1 h-0.5 self-center ${currentStep >= 2 ? 'bg-blue-600' : 'bg-gray-300'}`}></div>
              <div className={`flex flex-col items-center ${currentStep >= 2 ? 'text-blue-600' : 'text-gray-400'}`}>
                <div className={`w-8 h-8 flex items-center justify-center rounded-full border-2 ${currentStep >= 2 ? 'border-blue-600 bg-blue-100' : 'border-gray-300'}`}>2</div>
                <span className="text-xs mt-1">Configure</span>
              </div>
              <div className={`flex-1 h-0.5 self-center ${currentStep >= 3 ? 'bg-blue-600' : 'bg-gray-300'}`}></div>
              <div className={`flex flex-col items-center ${currentStep >= 3 ? 'text-blue-600' : 'text-gray-400'}`}>
                <div className={`w-8 h-8 flex items-center justify-center rounded-full border-2 ${currentStep >= 3 ? 'border-blue-600 bg-blue-100' : 'border-gray-300'}`}>3</div>
                <span className="text-xs mt-1">Submit</span>
              </div>
            </div>
          </div>

          {/* Upload mode selection */}
          {currentStep === 1 && (
            <div className="px-4 pb-4">
              <div className="flex space-x-4 mb-4">
                <button
                  type="button"
                  onClick={() => setUploadMode('single')}
                  className={`flex-1 py-2 px-4 rounded-md ${
                    uploadMode === 'single' 
                      ? 'bg-blue-600 text-white' 
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  <div className="flex items-center justify-center">
                    <FiFile className="mr-2" />
                    <span>Single Document</span>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setUploadMode('folder')}
                  className={`flex-1 py-2 px-4 rounded-md ${
                    uploadMode === 'folder' 
                      ? 'bg-blue-600 text-white' 
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  <div className="flex items-center justify-center">
                    <FiFolder className="mr-2" />
                    <span>Image Folder</span>
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* Step 1: Select document */}
          {currentStep === 1 && (
            <div
              {...getRootProps()}
              className={`dropzone ${isDragActive ? 'dropzone-active' : ''} ${isUploading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <input {...getInputProps()} />
              <div className="flex flex-col items-center justify-center p-6">
                <div className="mb-4 text-blue-500">
                  {isDragActive 
                    ? uploadMode === 'single' ? <FiFile size={48} /> : <FiFolder size={48} />
                    : <FiUpload size={48} />
                  }
                </div>
                <p className="text-lg font-medium">
                  {isDragActive 
                    ? uploadMode === 'single' ? 'Drop the document here' : 'Drop the image files here'
                    : uploadMode === 'single' ? 'Drag & drop a document here' : 'Drag & drop multiple image files here'
                  }
                </p>
                <p className="text-sm text-gray-500 mt-1">
                  {uploadMode === 'single' 
                    ? 'or click to browse (PDF, TXT, DOCX)'
                    : 'or click to browse (PNG, JPEG, TIFF)'
                  }
                </p>
                {uploadMode === 'folder' && (
                  <p className="text-xs text-gray-400 mt-1">
                    For best results, use filenames with page numbers (e.g., document-001.png)
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Step 2: Configure title and domains */}
          {currentStep === 2 && (
            <div className="p-4">
              <div className="mb-4">
                <h3 className="font-medium mb-2">
                  {uploadMode === 'single' ? 'Selected Document:' : 'Selected Image Files:'}
                </h3>
                {uploadMode === 'single' && selectedFile && (
                  <div className="bg-gray-100 p-3 rounded flex items-center">
                    <FiFile className="text-blue-500 mr-2" />
                    <span className="text-sm">{selectedFile?.name}</span>
                  </div>
                )}
                {uploadMode === 'folder' && (
                  <div className="bg-gray-100 p-3 rounded">
                    <div className="flex items-center mb-2">
                      <FiFolder className="text-blue-500 mr-2" />
                      <span className="text-sm font-medium">{selectedFiles.length} image files</span>
                    </div>
                    <div className="max-h-20 overflow-y-auto text-xs">
                      {selectedFiles.slice(0, 5).map((file, index) => (
                        <div key={index} className="text-gray-600">{file.name}</div>
                      ))}
                      {selectedFiles.length > 5 && (
                        <div className="text-gray-500">...and {selectedFiles.length - 5} more</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              
              <div className="mb-4">
                <h3 className="font-medium mb-2">Document Title:</h3>
                <input
                  type="text"
                  value={documentTitle}
                  onChange={(e) => setDocumentTitle(e.target.value)}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring focus:ring-blue-500 focus:ring-opacity-50 py-2"
                  placeholder="Enter a title for your document"
                  disabled={isUploading}
                />
                <p className="text-xs text-gray-500 mt-1">
                  This title will be used for all chunks of your document
                </p>
              </div>
              
              <h3 className="font-medium mb-2">Select Domains:</h3>
              <div className="max-h-60 overflow-y-auto">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {availableDomains.map(domain => (
                    <div key={domain} className="flex items-center">
                      <input
                        type="checkbox"
                        id={`domain-${domain}`}
                        className="w-4 h-4 text-blue-600 rounded"
                        checked={selectedDomains.includes(domain)}
                        onChange={() => handleDomainChange(domain)}
                        disabled={isUploading}
                      />
                      <label 
                        htmlFor={`domain-${domain}`} 
                        className="ml-2 text-sm text-gray-700 cursor-pointer"
                      >
                        {domain}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
              
              <div className="mt-6 flex space-x-2">
                <button
                  onClick={goBack}
                  className="px-4 py-2 rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
                  disabled={isUploading}
                >
                  Back
                </button>
                <button
                  onClick={() => setCurrentStep(3)}
                  className="px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                  disabled={isUploading}
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Review and Submit */}
          {currentStep === 3 && (
            <div className="p-4">
              <h3 className="font-medium mb-4">Review and Submit</h3>
              
              <div className="bg-gray-50 p-4 rounded-md mb-4">
                <div className="mb-2">
                  <span className="text-sm font-medium">Document Type:</span>
                  <span className="text-sm ml-2">
                    {uploadMode === 'single' ? 'Single Document' : 'Image Folder'}
                  </span>
                </div>
                <div className="mb-2">
                  <span className="text-sm font-medium">Title:</span>
                  <span className="text-sm ml-2">{documentTitle || 'Untitled'}</span>
                </div>
                <div className="mb-2">
                  <span className="text-sm font-medium">Selected files:</span>
                  <span className="text-sm ml-2">
                    {uploadMode === 'single' ? selectedFile?.name : `${selectedFiles.length} image files`}
                  </span>
                </div>
                <div>
                  <span className="text-sm font-medium">Domains:</span>
                  <span className="text-sm ml-2">
                    {selectedDomains.length > 0 
                      ? selectedDomains.join(', ') 
                      : 'Default'
                    }
                  </span>
                </div>
              </div>
              
              {error && (
                <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-md">
                  {error}
                </div>
              )}
              
              {isUploading && (
                <div className="mb-4">
                  <div className="flex justify-between text-sm mb-1">
                    <span>Uploading...</span>
                    <span>{uploadProgress}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div 
                      className="bg-blue-600 h-2 rounded-full" 
                      style={{ width: `${uploadProgress}%` }}
                    ></div>
                  </div>
                </div>
              )}
              
              <div className="flex space-x-2">
                <button
                  onClick={goBack}
                  className="px-4 py-2 rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
                  disabled={isUploading}
                >
                  Back
                </button>
                <button
                  onClick={handleSubmit}
                  className="px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                  disabled={isUploading}
                >
                  {isUploading ? 'Uploading...' : 'Submit'}
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <DocumentManagement onChunksDeleted={handleDocumentDeleted} />
      )}
    </div>
  )
}

export default DocumentUpload 
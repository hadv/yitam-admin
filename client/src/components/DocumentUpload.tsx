import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import axios from 'axios'
import { FiUpload, FiFile } from 'react-icons/fi'

interface DocumentUploadProps {
  onUploadSuccess: () => void
}

// List of available domains
const availableDomains = [
  'đông y',
  'y học cổ truyền',
  'y tông tâm lĩnh',
  'hải thượng lãn ông',
  'lê hữu trác',
  'y quán',
  'y quán đường',
  'âm dương ngũ hành',
  'dịch lý',
  'lão kinh',
  'lão tử',
  'phong thủy',
  'đạo phật',
  'thích nhất hạnh',
  'viên minh'
]

const DocumentUpload = ({ onUploadSuccess }: DocumentUploadProps) => {
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [selectedDomains, setSelectedDomains] = useState<string[]>([])
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [currentStep, setCurrentStep] = useState(1) // 1: Select document, 2: Select domains, 3: Review & Submit

  const handleDomainChange = (domain: string) => {
    setSelectedDomains(prev => 
      prev.includes(domain) 
        ? prev.filter(d => d !== domain) 
        : [...prev, domain]
    )
  }

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return

    const file = acceptedFiles[0]
    setSelectedFile(file)
    setCurrentStep(2) // Move to domain selection step after file selection
  }, [])
  
  const handleSubmit = async () => {
    if (!selectedFile) return
    
    setIsUploading(true)
    setError(null)
    setUploadProgress(0)

    try {
      const formData = new FormData()
      formData.append('document', selectedFile)
      formData.append('domains', JSON.stringify(selectedDomains))

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
      // Reset form
      setSelectedFile(null)
      setSelectedDomains([])
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
    accept: {
      'application/pdf': ['.pdf'],
      'text/plain': ['.txt'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    },
    maxFiles: 1,
    disabled: isUploading || currentStep !== 1
  })

  const goBack = () => {
    if (currentStep > 1) {
      setCurrentStep(prev => prev - 1)
    }
  }

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
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
            <span className="text-xs mt-1">Select Domains</span>
          </div>
          <div className={`flex-1 h-0.5 self-center ${currentStep >= 3 ? 'bg-blue-600' : 'bg-gray-300'}`}></div>
          <div className={`flex flex-col items-center ${currentStep >= 3 ? 'text-blue-600' : 'text-gray-400'}`}>
            <div className={`w-8 h-8 flex items-center justify-center rounded-full border-2 ${currentStep >= 3 ? 'border-blue-600 bg-blue-100' : 'border-gray-300'}`}>3</div>
            <span className="text-xs mt-1">Submit</span>
          </div>
        </div>
      </div>

      {/* Step 1: Select document */}
      {currentStep === 1 && (
        <div
          {...getRootProps()}
          className={`dropzone ${isDragActive ? 'dropzone-active' : ''} ${isUploading ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <input {...getInputProps()} />
          <div className="flex flex-col items-center justify-center p-6">
            <div className="mb-4 text-blue-500">
              {isDragActive ? <FiFile size={48} /> : <FiUpload size={48} />}
            </div>
            <p className="text-lg font-medium">
              {isDragActive ? 'Drop the document here' : 'Drag & drop a document here'}
            </p>
            <p className="text-sm text-gray-500 mt-1">
              or click to browse (PDF, TXT, DOCX)
            </p>
          </div>
        </div>
      )}

      {/* Step 2: Select domains */}
      {currentStep === 2 && (
        <div className="p-4">
          <div className="mb-4">
            <h3 className="font-medium mb-2">Selected Document:</h3>
            <div className="bg-gray-100 p-3 rounded flex items-center">
              <FiFile className="text-blue-500 mr-2" />
              <span className="text-sm">{selectedFile?.name}</span>
            </div>
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
                  <label htmlFor={`domain-${domain}`} className="ml-2 text-sm text-gray-700">
                    {domain}
                  </label>
                </div>
              ))}
            </div>
          </div>
          {selectedDomains.length > 0 && (
            <div className="mt-2 text-sm text-gray-600">
              Selected: {selectedDomains.length} domain{selectedDomains.length !== 1 ? 's' : ''}
            </div>
          )}
          
          <div className="mt-4 flex justify-between">
            <button 
              onClick={goBack} 
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
            >
              Back
            </button>
            <button 
              onClick={() => setCurrentStep(3)} 
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Review & Submit */}
      {currentStep === 3 && (
        <div className="p-4">
          <h3 className="font-medium mb-2">Review Your Submission:</h3>
          
          <div className="mb-4">
            <div className="text-sm font-medium text-gray-700">Document:</div>
            <div className="bg-gray-100 p-3 rounded flex items-center">
              <FiFile className="text-blue-500 mr-2" />
              <span className="text-sm">{selectedFile?.name}</span>
            </div>
          </div>
          
          <div className="mb-4">
            <div className="text-sm font-medium text-gray-700">Selected Domains ({selectedDomains.length}):</div>
            {selectedDomains.length > 0 ? (
              <div className="bg-gray-100 p-3 rounded">
                <div className="flex flex-wrap gap-2">
                  {selectedDomains.map(domain => (
                    <span key={domain} className="bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded">
                      {domain}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <div className="bg-gray-100 p-3 rounded text-sm text-gray-500">
                No domains selected
              </div>
            )}
          </div>
          
          {isUploading && (
            <div className="mb-4">
              <div className="flex items-center justify-center">
                <div className="mr-2 text-blue-500">
                  <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <p className="text-sm text-gray-600">Uploading... {uploadProgress}%</p>
              </div>
            </div>
          )}
          
          <div className="mt-4 flex justify-between">
            <button 
              onClick={goBack} 
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
              disabled={isUploading}
            >
              Back
            </button>
            <button 
              onClick={handleSubmit} 
              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
              disabled={isUploading}
            >
              {isUploading ? 'Uploading...' : 'Submit Document'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 m-4 rounded">
          {error}
        </div>
      )}
    </div>
  )
}

export default DocumentUpload 
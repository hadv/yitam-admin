import { useState, useEffect } from 'react';
import axios from '@/utils/axiosConfig';
import {
  FiCheckCircle,
  FiAlertCircle,
  FiRefreshCw,
  FiPlay,
  FiEye,
  FiList,
  FiEdit3,
  FiSave
} from 'react-icons/fi';
import {
  CorrectionRule,
  CorrectionResponse,
  CorrectionRulesResponse,
  PreviewCorrectionResponse,
  CorrectionRequest
} from '@/types/transcript-correction';

const TranscriptCorrection = () => {
  const [videoId, setVideoId] = useState('');
  const [correctionRules, setCorrectionRules] = useState<CorrectionRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [result, setResult] = useState<CorrectionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState('');
  const [previewResult, setPreviewResult] = useState<PreviewCorrectionResponse | null>(null);
  const [activeTab, setActiveTab] = useState<'correct' | 'preview' | 'rules'>('correct');

  // Load default correction rules on mount
  useEffect(() => {
    loadDefaultRules();
  }, []);

  const loadDefaultRules = async () => {
    try {
      const response = await axios.get<CorrectionRulesResponse>('/api/youtube/correction-rules');
      if (response.data.success) {
        setCorrectionRules(response.data.rules);
      }
    } catch (err: any) {
      console.error('Error loading correction rules:', err);
    }
  };

  const handleCorrection = async (dryRun: boolean) => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // Filter out empty rules
      const validRules = correctionRules.filter(
        rule => rule.incorrect.trim() && rule.correct.trim()
      );

      if (validRules.length === 0) {
        setError('Please add at least one valid correction rule');
        setLoading(false);
        return;
      }

      const requestData: CorrectionRequest = {
        dryRun,
        correctionRules: validRules,
        ...(videoId && { videoId: videoId.trim() })
      };

      const response = await axios.post<CorrectionResponse>(
        '/api/youtube/correct-youtube-transcripts',
        requestData
      );

      setResult(response.data);
    } catch (err: any) {
      console.error('Error correcting transcripts:', err);
      setError(err.response?.data?.message || 'Failed to correct transcripts');
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = async () => {
    if (!previewText.trim()) {
      setError('Please enter some text to preview');
      return;
    }

    setPreviewLoading(true);
    setError(null);
    setPreviewResult(null);

    try {
      // Filter out empty rules
      const validRules = correctionRules.filter(
        rule => rule.incorrect.trim() && rule.correct.trim()
      );

      if (validRules.length === 0) {
        setError('Please add at least one valid correction rule');
        setPreviewLoading(false);
        return;
      }

      const response = await axios.post<PreviewCorrectionResponse>(
        '/api/youtube/preview-corrections',
        {
          text: previewText,
          correctionRules: validRules
        }
      );

      setPreviewResult(response.data);
    } catch (err: any) {
      console.error('Error previewing corrections:', err);
      setError(err.response?.data?.message || 'Failed to preview corrections');
    } finally {
      setPreviewLoading(false);
    }
  };

  const addNewRule = () => {
    setCorrectionRules([...correctionRules, { incorrect: '', correct: '', caseSensitive: false }]);
  };

  const updateRule = (index: number, field: keyof CorrectionRule, value: string | boolean) => {
    const newRules = [...correctionRules];
    newRules[index] = { ...newRules[index], [field]: value };
    setCorrectionRules(newRules);
  };

  const removeRule = (index: number) => {
    setCorrectionRules(correctionRules.filter((_, i) => i !== index));
  };

  const renderStats = (stats: CorrectionResponse['stats']) => {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-blue-50 p-4 rounded-lg">
          <div className="text-sm text-blue-600 font-medium">Chunks Processed</div>
          <div className="text-2xl font-bold text-blue-900">{stats.totalChunksProcessed}</div>
        </div>
        <div className="bg-green-50 p-4 rounded-lg">
          <div className="text-sm text-green-600 font-medium">Chunks Modified</div>
          <div className="text-2xl font-bold text-green-900">{stats.chunksModified}</div>
        </div>
        <div className="bg-purple-50 p-4 rounded-lg">
          <div className="text-sm text-purple-600 font-medium">Total Replacements</div>
          <div className="text-2xl font-bold text-purple-900">{stats.totalReplacements}</div>
        </div>
        <div className="bg-orange-50 p-4 rounded-lg">
          <div className="text-sm text-orange-600 font-medium">Processing Time</div>
          <div className="text-2xl font-bold text-orange-900">{(stats.processingTimeMs / 1000).toFixed(2)}s</div>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="bg-white rounded-lg shadow-lg p-6">
        {/* Header */}
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-gray-900 flex items-center">
            <FiEdit3 className="mr-3 text-blue-600" />
            Transcript Correction
          </h2>
          <p className="text-gray-600 mt-2">
            Fix spelling mistakes in YouTube transcripts stored in the vector database
          </p>
        </div>

        {/* Tab Navigation */}
        <div className="border-b border-gray-200 mb-6">
          <nav className="-mb-px flex space-x-8">
            <button
              onClick={() => setActiveTab('correct')}
              className={`pb-4 px-1 border-b-2 font-medium text-sm flex items-center ${
                activeTab === 'correct'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <FiPlay className="mr-2" />
              Run Correction
            </button>
            <button
              onClick={() => setActiveTab('preview')}
              className={`pb-4 px-1 border-b-2 font-medium text-sm flex items-center ${
                activeTab === 'preview'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <FiEye className="mr-2" />
              Preview
            </button>
            <button
              onClick={() => setActiveTab('rules')}
              className={`pb-4 px-1 border-b-2 font-medium text-sm flex items-center ${
                activeTab === 'rules'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <FiList className="mr-2" />
              Correction Rules
            </button>
          </nav>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex items-start">
            <FiAlertCircle className="mr-2 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Tab Content */}
        {activeTab === 'correct' && (
          <div>
            {/* Video ID Input */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Video ID (Optional)
              </label>
              <input
                type="text"
                value={videoId}
                onChange={(e) => setVideoId(e.target.value)}
                placeholder="Leave empty to correct all YouTube transcripts"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={loading}
              />
              <p className="text-sm text-gray-500 mt-1">
                Enter a specific YouTube video ID to correct only that video, or leave empty to correct all videos
              </p>
            </div>

            {/* Action Buttons */}
            <div className="flex space-x-4 mb-6">
              <button
                onClick={() => handleCorrection(true)}
                disabled={loading}
                className="flex-1 inline-flex items-center justify-center px-6 py-3 border border-blue-600 text-blue-600 font-medium rounded-lg hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <FiEye className="mr-2" />
                {loading ? 'Processing...' : 'Dry Run (Preview)'}
              </button>
              <button
                onClick={() => handleCorrection(false)}
                disabled={loading}
                className="flex-1 inline-flex items-center justify-center px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <FiPlay className="mr-2" />
                {loading ? 'Processing...' : 'Run Correction'}
              </button>
            </div>

            {/* Results */}
            {result && (
              <div className="mt-6">
                <div className={`mb-4 p-4 rounded-lg flex items-start ${
                  result.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'
                }`}>
                  <FiCheckCircle className={`mr-2 mt-0.5 flex-shrink-0 ${
                    result.success ? 'text-green-600' : 'text-red-600'
                  }`} />
                  <div>
                    <p className={`font-medium ${result.success ? 'text-green-900' : 'text-red-900'}`}>
                      {result.message}
                    </p>
                    {result.dryRun && (
                      <p className="text-sm text-gray-600 mt-1">
                        This was a dry run. No changes were made to the database.
                      </p>
                    )}
                  </div>
                </div>

                {renderStats(result.stats)}

                {/* Replacement Details */}
                {result.stats.replacementDetails.length > 0 && (
                  <div className="bg-gray-50 p-4 rounded-lg">
                    <h3 className="font-medium text-gray-900 mb-3">Replacement Details</h3>
                    <div className="space-y-2">
                      {result.stats.replacementDetails.map((detail, index) => (
                        <div key={index} className="flex justify-between items-center bg-white p-3 rounded">
                          <span className="text-gray-700">{detail.rule}</span>
                          <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm font-medium">
                            {detail.count} occurrence{detail.count !== 1 ? 's' : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'preview' && (
          <div>
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Sample Text
              </label>
              <textarea
                value={previewText}
                onChange={(e) => setPreviewText(e.target.value)}
                placeholder="Enter text to preview corrections..."
                rows={6}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={previewLoading}
              />
            </div>

            <button
              onClick={handlePreview}
              disabled={previewLoading || !previewText.trim()}
              className="w-full inline-flex items-center justify-center px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <FiEye className="mr-2" />
              {previewLoading ? 'Processing...' : 'Preview Corrections'}
            </button>

            {previewResult && (
              <div className="mt-6 space-y-4">
                <div className="bg-gray-50 p-4 rounded-lg">
                  <h3 className="font-medium text-gray-900 mb-2">Original Text</h3>
                  <p className="text-gray-700 whitespace-pre-wrap">{previewResult.originalText}</p>
                </div>

                <div className={`p-4 rounded-lg ${
                  previewResult.hasChanges ? 'bg-green-50 border border-green-200' : 'bg-gray-50'
                }`}>
                  <h3 className="font-medium text-gray-900 mb-2">Corrected Text</h3>
                  <p className="text-gray-700 whitespace-pre-wrap">{previewResult.correctedText}</p>
                </div>

                {previewResult.hasChanges && previewResult.replacements.length > 0 && (
                  <div className="bg-blue-50 p-4 rounded-lg">
                    <h3 className="font-medium text-gray-900 mb-3">Changes Made</h3>
                    <div className="space-y-2">
                      {previewResult.replacements.map((replacement, index) => (
                        <div key={index} className="flex justify-between items-center bg-white p-3 rounded">
                          <span className="text-gray-700">{replacement.rule}</span>
                          <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm font-medium">
                            {replacement.count} change{replacement.count !== 1 ? 's' : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!previewResult.hasChanges && (
                  <div className="bg-gray-50 p-4 rounded-lg text-center text-gray-600">
                    No corrections needed for this text
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'rules' && (
          <div>
            <div className="mb-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-medium text-gray-900">Correction Rules</h3>
                <div className="flex space-x-2">
                  <button
                    onClick={loadDefaultRules}
                    className="inline-flex items-center px-4 py-2 border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50"
                  >
                    <FiRefreshCw className="mr-2" />
                    Reset to Default
                  </button>
                  <button
                    onClick={addNewRule}
                    className="inline-flex items-center px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700"
                  >
                    <FiSave className="mr-2" />
                    Add Rule
                  </button>
                </div>
              </div>

              <div className="space-y-4">
                {correctionRules.map((rule, index) => (
                  <div key={index} className="bg-gray-50 p-4 rounded-lg">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Incorrect Text
                        </label>
                        <input
                          type="text"
                          value={rule.incorrect}
                          onChange={(e) => updateRule(index, 'incorrect', e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          placeholder="e.g., dính mắt"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Correct Text
                        </label>
                        <input
                          type="text"
                          value={rule.correct}
                          onChange={(e) => updateRule(index, 'correct', e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          placeholder="e.g., dính mắc"
                        />
                      </div>
                    </div>
                    <div className="mt-3 flex justify-between items-center">
                      <label className="flex items-center text-sm text-gray-700">
                        <input
                          type="checkbox"
                          checked={rule.caseSensitive || false}
                          onChange={(e) => updateRule(index, 'caseSensitive', e.target.checked)}
                          className="mr-2 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        Case Sensitive
                      </label>
                      <button
                        onClick={() => removeRule(index)}
                        className="text-red-600 hover:text-red-800 text-sm font-medium"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}

                {correctionRules.length === 0 && (
                  <div className="text-center py-8 text-gray-500">
                    No correction rules defined. Click "Add Rule" to create one.
                  </div>
                )}
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 p-4 rounded-lg">
              <h4 className="font-medium text-blue-900 mb-2">How to Use</h4>
              <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
                <li>Add or modify correction rules above</li>
                <li>Use the "Preview" tab to test your rules on sample text</li>
                <li>Use the "Run Correction" tab to apply rules to your database</li>
                <li>Always run a "Dry Run" first to preview changes before applying them</li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TranscriptCorrection;


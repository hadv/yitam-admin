import axios from 'axios';

// Increase timeout for long-running operations like web scraping
axios.defaults.timeout = 120000; // 2 minutes for web scraping operations

// Request interceptor
axios.interceptors.request.use(config => {
  console.log(`[Axios Request] ${config.method?.toUpperCase()} ${config.url}`);
  return config;
}, error => {
  console.error('[Axios Request Error]', error);
  return Promise.reject(error);
});

// Response interceptor
axios.interceptors.response.use(response => {
  console.log(`[Axios Response] ${response.status} ${response.config.method?.toUpperCase()} ${response.config.url}`);
  return response;
}, error => {
  if (error.response) {
    // The request was made and the server responded with a status code
    // that falls out of the range of 2xx
    console.error('[Axios Response Error]', {
      status: error.response.status,
      headers: error.response.headers,
      data: error.response.data,
      url: error.config?.url
    });
  } else if (error.request) {
    // The request was made but no response was received
    // This is likely a network connection issue
    console.error('[Axios Network Error]', error);
    
    // Add custom property to identify network errors for better handling
    error.isNetworkError = true;
    
    // Check if this might be a timeout
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      error.customMessage = 'The request timed out. YouTube transcript extraction can take longer for some videos. Please try again or try with a shorter video.';
      error.isTimeout = true;
    } else {
      error.customMessage = 'Network connection error. The server may be unavailable or your internet connection is disrupted.';
    }
  } else {
    // Something happened in setting up the request that triggered an Error
    console.error('[Axios Error]', {
      message: error.message,
      url: error.config?.url
    });
  }
  
  return Promise.reject(error);
});

export default axios; 
import axios from 'axios';

// Default timeout
axios.defaults.timeout = 10000; // 10 seconds

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
    console.error('[Axios Network Error]', {
      request: error.request,
      url: error.config?.url,
      message: 'No response received from server'
    });
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
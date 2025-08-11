import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import googleDriveService from '@/services/googleDriveService';

const AuthCallback = () => {
  const navigate = useNavigate();

  useEffect(() => {
    const handleCallback = async () => {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');
        const error = urlParams.get('error');

        if (error) {
          console.error('OAuth error:', error);
          navigate('/?auth_error=' + encodeURIComponent(error));
          return;
        }

        if (code) {
          // Send code to backend to exchange for token
          const response = await fetch('/api/auth/google/callback?' + urlParams.toString(), {
            headers: {
              'X-Requested-With': 'XMLHttpRequest'
            }
          });

          if (response.ok) {
            const result = await response.json();

            if (result.success && result.access_token && result.user_id) {
              // Store token
              googleDriveService.setAccessToken(result.access_token);

              console.log('Authentication successful, token stored');
              navigate('/?auth_success=true');
            } else {
              throw new Error('Failed to get token from response');
            }
          } else {
            throw new Error('Failed to exchange code for token');
          }
        } else {
          navigate('/?auth_error=No authorization code received');
        }
      } catch (error) {
        console.error('Auth callback error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        navigate('/?auth_error=' + encodeURIComponent(errorMessage));
      }
    };

    handleCallback();
  }, [navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
        <p className="text-gray-600">Completing authentication...</p>
      </div>
    </div>
  );
};

export default AuthCallback;

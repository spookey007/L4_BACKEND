/**
 * JWT Authentication Utility for WebSocket
 * Validates JWT tokens and extracts user information
 */

const jwt = require('jsonwebtoken');

class JWTAuth {
  constructor() {
    this.secretKey = process.env.JWT_SECRET || 'your-secret-key';
    this.algorithm = 'HS256';
  }

  /**
   * Verify and decode JWT token
   * @param {string} token - JWT token to verify
   * @returns {Object|null} - Decoded token payload or null if invalid
   */
  verifyToken(token) {
    try {
      if (!token) {
        console.log('🔐 [JWT] No token provided');
        return null;
      }

      // Verify the token
      const decoded = jwt.verify(token, this.secretKey, { 
        algorithms: [this.algorithm] 
      });

      console.log('🔐 [JWT] Token verified successfully:', {
        walletAddress: decoded.walletAddress,
        iat: new Date(decoded.iat * 1000).toISOString(),
        exp: new Date(decoded.exp * 1000).toISOString()
      });

      return decoded;
    } catch (error) {
      console.log('🔐 [JWT] Token verification failed:', error.message);
      return null;
    }
  }

  /**
   * Check if token is expired
   * @param {Object} decoded - Decoded token payload
   * @returns {boolean} - True if expired, false otherwise
   */
  isTokenExpired(decoded) {
    if (!decoded || !decoded.exp) {
      return true;
    }

    const currentTime = Math.floor(Date.now() / 1000);
    const isExpired = decoded.exp < currentTime;

    if (isExpired) {
      console.log('🔐 [JWT] Token is expired:', {
        exp: new Date(decoded.exp * 1000).toISOString(),
        current: new Date(currentTime * 1000).toISOString()
      });
    }

    return isExpired;
  }

  /**
   * Validate authentication payload
   * @param {Object} payload - Authentication payload
   * @returns {Object|null} - Validated user info or null if invalid
   */
  validateAuthPayload(payload) {
    try {
      if (!payload) {
        console.log('🔐 [JWT] No payload provided');
        return null;
      }

      const { walletAddress, jwtToken } = payload;

      if (!walletAddress || !jwtToken) {
        console.log('🔐 [JWT] Missing required fields:', { 
          hasWalletAddress: !!walletAddress, 
          hasJwtToken: !!jwtToken 
        });
        return null;
      }

      // Verify the JWT token
      const decoded = this.verifyToken(jwtToken);
      if (!decoded) {
        return null;
      }

      // Check if token is expired
      if (this.isTokenExpired(decoded)) {
        return null;
      }

      // Verify wallet address matches
      if (decoded.walletAddress !== walletAddress) {
        console.log('🔐 [JWT] Wallet address mismatch:', {
          tokenWallet: decoded.walletAddress,
          providedWallet: walletAddress
        });
        return null;
      }

      console.log('🔐 [JWT] Authentication successful for wallet:', walletAddress);
      
      return {
        walletAddress: decoded.walletAddress,
        iat: decoded.iat,
        exp: decoded.exp,
        isValid: true
      };

    } catch (error) {
      console.log('🔐 [JWT] Authentication validation error:', error.message);
      return null;
    }
  }

  /**
   * Generate a new JWT token (for testing purposes)
   * @param {string} walletAddress - Wallet address
   * @param {number} expiresIn - Expiration time in seconds (default: 1 hour)
   * @returns {string} - JWT token
   */
  generateToken(walletAddress, expiresIn = 3600) {
    const payload = {
      walletAddress,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expiresIn
    };

    return jwt.sign(payload, this.secretKey, { algorithm: this.algorithm });
  }
}

module.exports = new JWTAuth();

const express = require('express');
const multer = require('multer');
const router = express.Router();

// Test route to verify MinIO router is working
router.get('/test', (req, res) => {
  res.json({ message: 'MinIO router is working!', timestamp: new Date().toISOString() });
});

// Test route to verify image access without auth
router.get('/test-image', (req, res) => {
  res.json({ message: 'Image access test - no auth required', timestamp: new Date().toISOString() });
});
const minioService = require('../lib/minio');
const { prisma } = require('../lib/prisma');

// Authentication middleware for MinIO routes
async function authenticateUser(req, res, next) {
  try {
    console.log('🔐 [MINIO AUTH] Authenticating user...');
    console.log('🔐 [MINIO AUTH] Request headers:', {
      authorization: req.headers.authorization ? 'Present' : 'Missing',
      cookie: req.cookies?.l4_session ? 'Present' : 'Missing'
    });
    
    // Get current user from session - try cookies first, then Authorization header
    let token = req.cookies?.l4_session;
    
    // Fallback: check Authorization header if no cookie
    if (!token && req.headers.authorization) {
      const authHeader = req.headers.authorization;
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
        console.log('🔍 [MINIO AUTH] Using token from Authorization header');
      }
    }
    
    if (!token) {
      console.log('❌ [MINIO AUTH] No l4_session token found in cookies or Authorization header');
      return res.status(401).json({ error: 'Authentication required' });
    }

    console.log('🔍 [MINIO AUTH] Found token:', token.substring(0, 20) + '...');

    const session = await prisma.session.findUnique({ 
      where: { token }, 
      include: { user: true } 
    });
    
    if (!session || session.expiresAt < new Date()) {
      console.log('❌ [MINIO AUTH] Session expired or not found');
      return res.status(401).json({ error: 'Session expired' });
    }

    // Add user to request object
    req.user = session.user;
    console.log('✅ [MINIO AUTH] User authenticated:', session.user.username);
    
    next();
  } catch (error) {
    console.error('❌ [MINIO AUTH] Authentication error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}


// Configure multer for memory storage (we'll upload directly to MinIO)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit for videos
  },
  fileFilter: (req, file, cb) => {
    // Allow common file types including webm for voice recordings
    const allowedTypes = /jpeg|jpg|png|gif|webp|mp4|webm|mov|mp3|wav|ogg|pdf|txt|json|svg/;
    const extname = allowedTypes.test(file.originalname.toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images, videos, audio, and documents are allowed.'));
    }
  }
});

/**
 * GET /api/minio/image/:fileName
 * Proxy images from MinIO to frontend (bypasses CORS and auth issues)
 */
// Handle image proxy with path parameter - single segment (public access for viewing)
router.get('/image/:path', async (req, res) => {
  try {
    // Extract filename from path parameter
    const fileName = req.params.path;
    // No user authentication required for viewing images
    await handleImageProxy(req, res, fileName, null);
  } catch (error) {
    console.error('❌ [MINIO API] Image proxy error:', error);
    res.status(404).json({ error: 'Image not found', details: error.message });
  }
});

// Handle image proxy with nested path - two segments (public access for viewing)
router.get('/image/:segment1/:segment2', async (req, res) => {
  try {
    const fileName = `${req.params.segment1}/${req.params.segment2}`;
    // No user authentication required for viewing images
    await handleImageProxy(req, res, fileName, null);
  } catch (error) {
    console.error('❌ [MINIO API] Image proxy error:', error);
    res.status(404).json({ error: 'Image not found', details: error.message });
  }
});

// Handle image proxy with deeply nested path - three segments (public access for viewing)
router.get('/image/:segment1/:segment2/:segment3', async (req, res) => {
  try {
    const fileName = `${req.params.segment1}/${req.params.segment2}/${req.params.segment3}`;
    // No user authentication required for viewing images
    await handleImageProxy(req, res, fileName, null);
  } catch (error) {
    console.error('❌ [MINIO API] Image proxy error:', error);
    res.status(404).json({ error: 'Image not found', details: error.message });
  }
});

// Common image proxy handler
async function handleImageProxy(req, res, fileName, userId) {
  console.log('🖼️ [MINIO API] Proxying image:', fileName);
  console.log('🖼️ [MINIO API] Request URL:', req.url);
  console.log('🖼️ [MINIO API] Request path:', req.path);
  console.log('🖼️ [MINIO API] Current user ID:', userId);
  console.log('🖼️ [MINIO API] File path parts:', fileName.split('/'));

  // Security check: Allow access to user's own files OR chat files
  // Chat files are stored under users/{userId}/ but should be accessible to all authenticated users
  if (!fileName.startsWith(`users/`)) {
    return res.status(403).json({ error: 'Access denied - invalid file path' });
  }

  // Additional security: Check if the file is in a valid user directory
  const pathParts = fileName.split('/');
  if (pathParts.length < 3 || pathParts[0] !== 'users') {
    return res.status(403).json({ error: 'Access denied - invalid file structure' });
  }

  // Get the file from MinIO
  const fileStream = await minioService.client.getObject(minioService.bucketName, fileName);
  
  // Determine content type from file extension
  const fileExtension = fileName.split('.').pop().toLowerCase();
  const contentTypes = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg'
  };
  const contentType = contentTypes[fileExtension] || 'application/octet-stream';
  
  // Set appropriate headers
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Pipe the file stream to the response
  fileStream.pipe(res);
  
  console.log('✅ [MINIO API] Image proxied successfully:', fileName);
}

/**
 * GET /api/minio/presigned/:fileName
 * Get a fresh presigned URL for an existing file
 */
router.get('/presigned/:fileName', authenticateUser, async (req, res) => {
  try {
    const { fileName } = req.params;
    const userId = req.user.id;

    console.log('🔗 [MINIO API] Generating presigned URL for:', fileName);

    // Verify the file is in a valid user directory (security check)
    if (!fileName.startsWith(`users/`)) {
      return res.status(403).json({ error: 'Access denied - invalid file path' });
    }

    // Generate fresh presigned URL
    const presignedResult = await minioService.getPresignedUrl(fileName, 7 * 24 * 60 * 60);
    console.log('🔗 [MINIO API] Fresh presigned URL generated:', presignedResult.url);

    res.json({
      success: true,
      fileName: presignedResult.fileName,
      url: presignedResult.url,
      expiry: presignedResult.expiry
    });
  } catch (error) {
    console.error('❌ [MINIO API] Presigned URL generation error:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL', details: error.message });
  }
});

/**
 * POST /api/minio/upload
 * Upload a file to MinIO
 */
router.post('/upload', (req, res, next) => {
  console.log('🚀 [MINIO ROUTE] Route hit - before auth middleware');
  next();
}, authenticateUser, upload.single('file'), async (req, res) => {
  try {
    console.log('📤 [MINIO API] Upload request received');
    console.log('📤 [MINIO API] Request details:', {
      hasFile: !!req.file,
      fileSize: req.file?.size,
      fileName: req.file?.originalname,
      mimeType: req.file?.mimetype,
      userId: req.user?.id
    });

    if (!req.file) {
      console.log('❌ [MINIO API] No file provided');
      return res.status(400).json({ error: 'No file provided' });
    }

    const userId = req.user.id; // User is guaranteed to exist due to auth middleware

    // Generate unique filename with user prefix
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const fileExtension = req.file.originalname.split('.').pop();
    const fileName = `users/${userId}/${timestamp}-${randomString}.${fileExtension}`;

    console.log('📤 [MINIO API] Generated filename:', fileName);
    console.log('📤 [MINIO API] File buffer size:', req.file.buffer.length);

    // Upload to MinIO
    console.log('📤 [MINIO API] Starting MinIO upload...');
    const result = await minioService.uploadFile(
      fileName,
      req.file.buffer,
      req.file.mimetype,
      {
        'original-name': req.file.originalname,
        'user-id': userId.toString(),
        'upload-time': new Date().toISOString()
      }
    );

    console.log('✅ [MINIO API] File uploaded successfully:', {
      fileName: result.fileName,
      bucketName: result.bucketName,
      size: result.size,
      etag: result.etag
    });

    // Generate proxy URL for secure access (no expiry issues)
    const proxyUrl = `${process.env.NEXT_PUBLIC_API_URL}/minio/image/${fileName}`;
    console.log('🔗 [MINIO API] Proxy URL generated:', proxyUrl);

    res.json({
      success: true,
      fileName: result.fileName,
      originalName: req.file.originalname,
      size: result.size,
      contentType: req.file.mimetype,
      etag: result.etag,
      url: proxyUrl
    });
  } catch (error) {
    console.error('❌ [MINIO API] Upload error:', error);
    console.error('❌ [MINIO API] Error details:', {
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
      stack: error.stack
    });
    res.status(500).json({ error: 'Failed to upload file', details: error.message });
  }
});

/**
 * GET /api/minio/download
 * Download a file from MinIO
 */
router.get('/download', async (req, res) => {
  try {
    const { fileName } = req.query;
    const userId = req.user?.id;
    
    if (!fileName) {
      return res.status(400).json({ error: 'File name is required' });
    }
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Security check: ensure user can only access their own files
    if (!fileName.startsWith(`users/${userId}/`)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await minioService.downloadFile(fileName);
    
    // Set appropriate headers
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileName.split('/').pop()}"`,
      'Content-Length': result.size
    });

    res.send(result.buffer);
  } catch (error) {
    console.error('❌ [MINIO API] Download error:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

/**
 * POST /api/minio/copy
 * Copy a file within MinIO
 */
router.post('/copy', async (req, res) => {
  try {
    const { sourceFileName, destFileName } = req.body;
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!sourceFileName || !destFileName) {
      return res.status(400).json({ error: 'Source and destination file names are required' });
    }

    // Security check: ensure user can only access their own files
    if (!sourceFileName.startsWith(`users/${userId}/`) || !destFileName.startsWith(`users/${userId}/`)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await minioService.copyFile(sourceFileName, destFileName, {
      'user-id': userId.toString(),
      'copy-time': new Date().toISOString()
    });

    console.log('✅ [MINIO API] File copied successfully:', sourceFileName, '->', destFileName);
    res.json({
      success: true,
      sourceFileName: result.sourceFileName,
      destFileName: result.destFileName,
      url: `${process.env.NEXT_PUBLIC_MINIO_ENDPOINT}/browser/${process.env.MINIO_BUCKET_NAME}/${result.destFileName}`
    });
  } catch (error) {
    console.error('❌ [MINIO API] Copy error:', error);
    res.status(500).json({ error: 'Failed to copy file' });
  }
});

/**
 * DELETE /api/minio/delete
 * Delete a file from MinIO
 */
router.delete('/delete', async (req, res) => {
  try {
    const { fileName } = req.query;
    const userId = req.user?.id;
    
    if (!fileName) {
      return res.status(400).json({ error: 'File name is required' });
    }
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Security check: ensure user can only delete their own files
    if (!fileName.startsWith(`users/${userId}/`)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await minioService.deleteFile(fileName);
    
    console.log('✅ [MINIO API] File deleted successfully:', fileName);
    res.json({
      success: true,
      fileName: result.fileName
    });
  } catch (error) {
    console.error('❌ [MINIO API] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

/**
 * GET /api/minio/list
 * List user's files
 */
router.get('/list', async (req, res) => {
  try {
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const prefix = `users/${userId}/`;
    const result = await minioService.listFiles(prefix, true);
    
    console.log(`✅ [MINIO API] Listed ${result.count} files for user ${userId}`);
    res.json({
      success: true,
      files: result.files,
      count: result.count
    });
  } catch (error) {
    console.error('❌ [MINIO API] List error:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

/**
 * GET /api/minio/info
 * Get file information
 */
router.get('/info', async (req, res) => {
  try {
    const { fileName } = req.query;
    const userId = req.user?.id;
    
    if (!fileName) {
      return res.status(400).json({ error: 'File name is required' });
    }
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Security check: ensure file is in a valid user directory
    if (!fileName.startsWith(`users/`)) {
      return res.status(403).json({ error: 'Access denied - invalid file path' });
    }

    const result = await minioService.getFileInfo(fileName);
    
    console.log('✅ [MINIO API] File info retrieved:', fileName);
    res.json({
      success: true,
      fileName: result.fileName,
      size: result.size,
      lastModified: result.lastModified,
      contentType: result.contentType,
      metadata: result.metadata
    });
  } catch (error) {
    console.error('❌ [MINIO API] Info error:', error);
    res.status(500).json({ error: 'Failed to get file info' });
  }
});

/**
 * GET /api/minio/presigned
 * Get presigned URL for file access
 */
router.get('/presigned', async (req, res) => {
  try {
    const { fileName, expiry = 3600 } = req.query; // Default 1 hour
    const userId = req.user?.id;
    
    if (!fileName) {
      return res.status(400).json({ error: 'File name is required' });
    }
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Security check: ensure user can only access their own files
    if (!fileName.startsWith(`users/${userId}/`)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await minioService.getPresignedUrl(fileName, parseInt(expiry));
    
    console.log('✅ [MINIO API] Presigned URL generated:', fileName);
    res.json({
      success: true,
      fileName: result.fileName,
      url: result.url,
      directUrl: result.directUrl,
      expiry: result.expiry
    });
  } catch (error) {
    console.error('❌ [MINIO API] Presigned URL error:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

/**
 * GET /api/minio/presigned-upload
 * Get presigned URL for file upload
 */
router.get('/presigned-upload', async (req, res) => {
  try {
    const { fileName, contentType = 'application/octet-stream', expiry = 3600 } = req.query;
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!fileName) {
      return res.status(400).json({ error: 'File name is required' });
    }

    // Generate unique filename with user prefix
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const fileExtension = fileName.split('.').pop();
    const uniqueFileName = `users/${userId}/${timestamp}-${randomString}.${fileExtension}`;

    const result = await minioService.getPresignedUploadUrl(uniqueFileName, parseInt(expiry));
    
    console.log('✅ [MINIO API] Presigned upload URL generated:', uniqueFileName);
    res.json({
      success: true,
      fileName: result.fileName,
      originalFileName: fileName,
      url: result.url,
      publicUrl: `${process.env.NEXT_PUBLIC_MINIO_ENDPOINT}/browser/${process.env.MINIO_BUCKET_NAME}/${result.fileName}`,
      expiry: result.expiry,
      contentType
    });
  } catch (error) {
    console.error('❌ [MINIO API] Presigned upload URL error:', error);
    res.status(500).json({ error: 'Failed to generate presigned upload URL' });
  }
});

/**
 * GET /api/minio/download-shared/:encodedUrl
 * Download a shared object using MinIO's download-shared-object API
 */
router.get('/download-shared/:encodedUrl', async (req, res) => {
  try {
    const { encodedUrl } = req.params;
    
    if (!encodedUrl) {
      return res.status(400).json({ error: 'Encoded URL is required' });
    }

    const result = await minioService.downloadSharedObject(encodedUrl);
    
    // Set appropriate headers
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${result.fileName}"`,
      'Content-Length': result.size
    });

    res.send(result.buffer);
  } catch (error) {
    console.error('❌ [MINIO API] Download shared object error:', error);
    res.status(500).json({ error: 'Failed to download shared object' });
  }
});

/**
 * GET /api/minio/shareable/:fileName
 * Generate a shareable download URL
 */
router.get('/shareable/:fileName', async (req, res) => {
  try {
    const { fileName } = req.params;
    const { expiry = 604800 } = req.query; // Default 7 days
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Security check: ensure user can only access their own files
    if (!fileName.startsWith(`users/${userId}/`)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await minioService.generateShareableUrl(fileName, parseInt(expiry));
    
    console.log('✅ [MINIO API] Shareable URL generated:', fileName);
    res.json({
      success: true,
      fileName: result.fileName,
      shareableUrl: result.shareableUrl,
      presignedUrl: result.presignedUrl,
      encodedUrl: result.encodedUrl,
      expiry: result.expiry
    });
  } catch (error) {
    console.error('❌ [MINIO API] Generate shareable URL error:', error);
    res.status(500).json({ error: 'Failed to generate shareable URL' });
  }
});

/**
 * GET /api/minio/health
 * Health check for MinIO service
 */
router.get('/health', async (req, res) => {
  try {
    const health = await minioService.healthCheck();
    res.json(health);
  } catch (error) {
    console.error('❌ [MINIO API] Health check error:', error);
    res.status(500).json({ 
      connected: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;

import axios from 'axios';
import FormData from 'form-data';

// 🔗 Point to your Python Microservice
const PY_SERVICE_URL = "http://127.0.0.1:8000";

// ==========================================
// 📡 STARTUP CHECK
// ==========================================
(async () => {
    try {
        const res = await axios.get(`${PY_SERVICE_URL}/`);
        if (res.status === 200) {
            console.log("✅ Python AI Bridge Connected Successfully!");
        }
    } catch (err) {
        console.log("⚠️ WARNING: Python AI Service NOT detected.");
        console.log("   - Make sure 'uvicorn ai_engine:app' is running.");
    }
})();

/**
 * Sends Images + Text + Property Type to Python for analysis.
 */
export const analyzeListingWithPython = async (photoUrls, title, description, propertyType) => {
  try {
    const form = new FormData();

    // 1. Add Text Fields
    form.append('title', title || "");
    form.append('description', description || "");
    form.append('property_type', propertyType || "House"); 

    // 2. Download & Stream ONLY the first 5 images
    let filesAttached = 0;
    const maxPhotos = Math.min(photoUrls.length, 5);
    
    for (let i = 0; i < maxPhotos; i++) {
        const url = photoUrls[i].url || photoUrls[i];
        if (!url) continue;

        try {
            // ✅ FIX 1: Add User-Agent to prevent 403 Forbidden from Cloudinary/S3
            const imgStream = await axios.get(url, { 
                responseType: 'stream',
                headers: { 
                    'User-Agent': 'KeyviaBot/1.0',
                    'Accept': 'image/*'
                }
            });
            
            form.append('files', imgStream.data, `image_${i}.jpg`);
            filesAttached++;
        } catch (err) {
            console.error(`⚠️ Failed to download image ${i}: ${url}`, err.message);
        }
    }

    // ✅ FIX 2: If 0 images were downloaded, ABORT. Sending 0 files causes the 422 Error.
    if (filesAttached === 0) {
        return {
            score: 0,
            flags: ["System could not access listing photos (Download Failed)."],
            verdict: "Rejected",
            details: { image_check: "failed" }
        };
    }

    // 3. Call Python API
    console.log(`📡 Sending ${filesAttached} images to AI Brain...`);
    const response = await axios.post(`${PY_SERVICE_URL}/analyze/listing`, form, {
        headers: { ...form.getHeaders() },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });

    return response.data;

  } catch (error) {
    console.error("❌ Python AI Error:", error.message);
    
    // ✅ FIX 3: Return SCORE 0 on failure so the Dashboard shows "Risk/Failed"
    return { 
        score: 0, 
        flags: [`AI Service Error: ${error.response?.status || error.message}`], 
        verdict: "Manual Review",
        details: { image_check: "failed" }
    };
  }
};

/**
 * Sends Video URL to Python for frame-by-frame analysis.
 */
export const analyzeVideoWithPython = async (videoUrl) => {
    if (!videoUrl) return null;

    try {
        console.log("🎥 Sending video to AI...");
        const form = new FormData();
        
        // Download video stream with headers
        const vidStream = await axios.get(videoUrl, { 
            responseType: 'stream',
            headers: { 'User-Agent': 'KeyviaBot/1.0' }
        });
        
        form.append('file', vidStream.data, 'listing_video.mp4');

        const response = await axios.post(`${PY_SERVICE_URL}/analyze/video`, form, {
            headers: { ...form.getHeaders() },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        return response.data;

    } catch (error) {
        console.error("❌ Video AI Error:", error.message);
        return { valid: true, score: 0, reason: "Video Analysis Skipped (Service Unavailable)" };
    }
};
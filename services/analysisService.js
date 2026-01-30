import { pool } from "../db.js";
import { analyzeListingWithPython, analyzeVideoWithPython } from "./aiService.js";

export const performFullAnalysis = async (listingId) => {
  const report = {
    listingId,
    score: 100,
    flags: [],
    details: {
        text_check: "passed",
        image_check: "pending",
        video_check: "skipped",
        location_consistency: "passed"
    },
    verdict: "Manual Review",
  };

  try {
    // 1. Fetch Listing & Agent Profile
    const res = await pool.query(`
      SELECT l.*, p.country as profile_country, p.role as user_role
      FROM listings l
      JOIN profiles p ON l.agent_unique_id = p.unique_id
      WHERE l.product_id = $1
    `, [listingId]);

    const data = res.rows[0];
    if (!data) throw new Error("Listing not found");

    // 2. PREPARE PHOTOS
    let photoUrls = [];
    try {
        photoUrls = typeof data.photos === 'string' 
            ? JSON.parse(data.photos) 
            : (data.photos || []);
    } catch { photoUrls = []; }

    if (photoUrls.length === 0) {
        report.score = 0;
        report.flags.push("No photos provided.");
        report.verdict = "Rejected"; 
        return await saveReport(report, listingId);
    }

    // =========================================================
    // 🧠 STEP 3: CALL PYTHON AI (IMAGES + TEXT)
    // =========================================================
    const aiResult = await analyzeListingWithPython(
        photoUrls,
        data.title,
        data.description,
        data.property_type 
    );

    // Merge AI Results
    report.score = aiResult.score; 
    report.flags = [...report.flags, ...aiResult.flags];
    
    // ✅ Logic Fix: If score is 0, force fail image check
    if (report.score === 0) {
        report.details.image_check = "failed";
    } else {
        report.details.image_check = aiResult.verdict === "Rejected" ? "failed" : "passed";
    }

    // =========================================================
    // 🎥 STEP 4: CALL PYTHON AI (VIDEO)
    // =========================================================
    if (data.video_url) {
        const videoResult = await analyzeVideoWithPython(data.video_url);
        
        if (videoResult) {
            if (videoResult.valid) {
                report.details.video_check = "passed";
                if (report.score > 0 && report.score < 100) report.score += 5; 
            } else {
                report.details.video_check = "failed";
                report.score -= 20;
                report.flags.push(`Video Flag: ${videoResult.reason}`);
            }
        }
    }

    // =========================================================
    // 🌍 STEP 5: LOCATION CONSISTENCY
    // =========================================================
    const userRole = data.user_role ? data.user_role.toLowerCase() : 'agent';
    
    if (userRole === 'agent' && data.country && data.profile_country) {
        const listingC = data.country.toLowerCase().trim();
        const profileC = data.profile_country.toLowerCase().trim();

        if (listingC !== profileC) {
            report.details.location_consistency = "warning";
            report.score -= 15;
            report.flags.push(`Agent Location (${data.profile_country}) does not match Property Country.`);
        }
    }

    // =========================================================
    // 🏁 FINAL VERDICT
    // =========================================================
    if (report.score < 0) report.score = 0;
    if (report.score > 100) report.score = 100;

    if (report.score >= 80) {
        report.verdict = "Safe to Approve";
    } else if (report.score <= 40) {
        report.verdict = "Rejected";
    } else {
        report.verdict = "Manual Review Needed";
    }

    await saveReport(report, listingId);
    return report;

  } catch (err) {
    console.error("Full Analysis Error:", err);
    report.verdict = "Error";
    report.flags.push("Internal Server Error during analysis");
    return report;
  }
};

// Helper to update DB
async function saveReport(report, listingId) {
    let status = 'pending';
    if (report.verdict === "Safe to Approve") status = 'approved';
    if (report.verdict === "Rejected") status = 'rejected'; 

    const notes = `AI Score: ${report.score}/100. Flags: ${report.flags.join(". ")}`;

    await pool.query(
        `UPDATE listings 
         SET admin_notes = $1, status = $2 
         WHERE product_id = $3`,
        [notes, status, listingId]
    );
    return report;
}
import { pool } from "../db.js";

export const getCompareListings = async (req, res) => {
  try {
    let ids = req.query.ids;

    if (!ids) {
      return res.status(400).json({ success: false, message: "No listing IDs provided." });
    }

    const idArray = String(ids)
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (idArray.length < 2) {
      return res.status(400).json({ success: false, message: "At least 2 listing IDs are required for comparison." });
    }

    if (idArray.length > 10) {
      return res.status(400).json({ success: false, message: "Maximum 10 listings can be compared at once." });
    }

    const placeholders = idArray.map((_, i) => `$${i + 1}`).join(",");

    const { rows } = await pool.query(
      `
      SELECT
        l.product_id,
        l.title,
        l.price,
        l.price_currency,
        l.listing_type,
        l.property_type,
        l.bedrooms,
        l.bathrooms,
        l.square_feet,
        l.lot_size,
        l.year_built,
        l.description,
        l.address,
        l.city,
        l.state,
        l.country,
        l.latitude,
        l.longitude,
        l.photos,
        l.amenities,
        l.views_count,
        l.saves_count,
        l.status,
        l.created_at,
        l.updated_at,
        l.mortgage_available,
        l.installment_available,
        l.rent_to_own_available,
        l.pets_policy,
        l.smoking_policy,
        l.guest_policy,
        l.furnishing,
        l.condition,
        l.floor_number,
        l.total_floors,
        l.parking_spaces,
        l.garage,
        l.hoa_fee,
        l.hoa_fee_frequency,
        l.estate_service_charge,
        l.estate_service_charge_frequency,
        l.property_tax_estimate,
        l.property_tax_frequency,
        l.insurance_estimate,
        l.insurance_frequency,
        l.closing_cost_estimate,
        u.name AS user_name,
        u.avatar_url AS user_avatar_url,
        u.role AS user_role,
        p.full_name AS profile_full_name,
        p.avatar_url AS profile_avatar_url
      FROM listings l
      LEFT JOIN users u ON l.uploaded_by_id = u.unique_id
      LEFT JOIN profiles p ON u.unique_id = p.unique_id
      WHERE l.product_id IN (${placeholders})
      `,
      idArray,
    );

    if (rows.length < 2) {
      return res.status(404).json({ success: false, message: "Could not find enough listings for comparison." });
    }

    return res.status(200).json({
      success: true,
      data: rows,
      count: rows.length,
    });
  } catch (err) {
    console.error("getCompareListings error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch listings for comparison." });
  }
};

export default { getCompareListings };

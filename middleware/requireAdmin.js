// middleware/requireAdmin.js
export default function requireAdmin(req, res, next) {
  // adapt depending on your JWT structure
  const user = req.user;
  if (!user)
    return res.status(401).json({ success: false, message: "Unauthorized" });

  // check common patterns
  const isAdmin =
    user.role === "Admin" ||
    user.role === "SuperAdmin" ||
    user.is_admin === true ||
    user.roles?.includes("Admin");
  if (!isAdmin)
    return res
      .status(403)
      .json({ success: false, message: "Admin access required" });

  next();
}

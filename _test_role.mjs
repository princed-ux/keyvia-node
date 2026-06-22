import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { pool } from "./db.js";
dotenv.config();
const URL = "http://localhost:5055";
const SECRET = process.env.ACCESS_TOKEN_SECRET;
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? " — " + d : ""}`); };
const api = async (m, p, { tok, body } = {}) => {
  const r = await fetch(URL + p, { method: m, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
};
try {
  const us = (await pool.query(`SELECT unique_id, role, is_super_admin FROM users WHERE role IN ('admin','super_admin') OR is_admin=true OR is_super_admin=true LIMIT 20`)).rows;
  const sa = us.find(u => u.is_super_admin || u.role === "super_admin");
  const ad = us.find(u => !u.is_super_admin && u.role === "admin");
  const saTok = jwt.sign({ unique_id: sa.unique_id, role: "super_admin", is_super_admin: true, name: "SA", email: "s@s.com", id: 1 }, SECRET, { expiresIn: "5m" });
  const adTok = ad ? jwt.sign({ unique_id: ad.unique_id, role: "admin", is_super_admin: false, name: "AD", email: "a@a.com", id: 2 }, SECRET, { expiresIn: "5m" }) : null;

  console.log("Super admin (overseer) sees everything:");
  const saGet = await api("GET", "/api/admin/settings", { tok: saTok });
  const saGroups = (saGet.json?.groups || []).map(g => g.id);
  check("super sees all 5 setting groups", saGroups.length === 5, `groups: ${saGroups.join(",")}`);
  check("super is_super_admin flag true", saGet.json?.is_super_admin === true, `${saGet.json?.is_super_admin}`);

  if (adTok) {
    console.log("\nAdmin (moderator) sees a focused subset:");
    const adGet = await api("GET", "/api/admin/settings", { tok: adTok });
    const adGroups = (adGet.json?.groups || []).map(g => g.id);
    check("admin sees only moderation_ai + notifications", adGroups.length === 2 && adGroups.includes("moderation_ai") && adGroups.includes("notifications"), `groups: ${adGroups.join(",")}`);
    check("admin does NOT see platform/security/registration", !adGroups.includes("platform") && !adGroups.includes("security"), `groups: ${adGroups.join(",")}`);
    check("admin is_super_admin flag false", adGet.json?.is_super_admin === false, `${adGet.json?.is_super_admin}`);

    console.log("\nAdmin cannot edit super-admin-only settings:");
    const adEditSuper = await api("PUT", "/api/admin/settings", { tok: adTok, body: { key: "maintenance_mode", value: "false" } });
    check("admin PUT maintenance_mode -> 403", adEditSuper.status === 403, `status ${adEditSuper.status}`);
    const adEditOwn = await api("PUT", "/api/admin/settings", { tok: adTok, body: { key: "ai_auto_scan_listings", value: "true" } });
    check("admin PUT ai_auto_scan_listings -> 200", adEditOwn.status === 200, `status ${adEditOwn.status}`);
  } else {
    console.log("\n(SKIP admin-scope tests: no plain admin user in DB)");
  }

  console.log("\nSuper admin can edit platform settings:");
  const saEdit = await api("PUT", "/api/admin/settings", { tok: saTok, body: { key: "default_currency", value: "USD" } });
  check("super PUT platform setting -> 200", saEdit.status === 200, `status ${saEdit.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
} catch (e) { console.error("ERR:", e.message); try { await pool.end(); } catch {} process.exit(1); }

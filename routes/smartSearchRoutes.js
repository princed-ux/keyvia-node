import { Router } from "express";
import { smartSearch } from "../controllers/smartSearchController.js";

const router = Router();

router.get("/", smartSearch);

export default router;

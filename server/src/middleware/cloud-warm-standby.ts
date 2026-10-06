import { Router, type RequestHandler } from "express";
import type { CloudWarmStandby } from "../services/cloud-warm-standby.js";

/** Mount after signed identity handoff and before session or tenant resolution. */
export function cloudWarmStandbyMiddleware(
  isStandby: CloudWarmStandby,
  health: RequestHandler,
) {
  const router = Router();
  router.use("/api/health", (req, res, next) => {
    if (isStandby() && (req.method === "GET" || req.method === "HEAD") && req.path === "/") {
      req.actor = { type: "none", source: "none" };
      health(req, res, next);
      return;
    }
    next();
  });
  router.use("/api", (_req, res, next) => {
    if (isStandby()) {
      res.status(503).json({ error: "workspace_unclaimed" });
      return;
    }
    next();
  });
  return router;
}

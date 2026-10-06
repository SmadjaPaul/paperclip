import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { cloudWarmStandbyMiddleware } from "../middleware/cloud-warm-standby.js";
import { healthRoutes } from "../routes/health.js";
import { emailChannelService } from "../services/email-channels.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";

const healthOptions = {
  deploymentMode: "authenticated" as const,
  deploymentExposure: "public" as const,
  authReady: true,
  companyDeletionEnabled: false,
  runtimeEnv: { PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "test-token" },
};
afterEach(() => vi.useRealTimers());

describe("unclaimed Cloud background work", () => {
  it("keeps probes and tenant requests out of SQL and auth until claim", async () => {
    let standby = true;
    const execute = vi.fn().mockResolvedValue([]);
    const db = { execute } as unknown as Db;
    const health = healthRoutes(db, { ...healthOptions, isWarmStandby: () => standby });
    const app = express();
    const auth = vi.fn((_req, _res, next) => next());
    app.use(cloudWarmStandbyMiddleware(() => standby, health));
    app.use(auth);
    app.use("/api/health", health);
    app.get("/api/companies", (_req, res) => res.json([]));
    for (let i = 0; i < 3; i++) {
      const probe = await request(app).get("/api/health").set("authorization", "Bearer ignored-in-standby");
      expect(probe.status).toBe(200);
      expect(probe.body.warmStandby).toBe(true);
      expect(probe.body.serverInfo).toBeUndefined();
    }
    expect((await request(app).head("/api/health")).status).toBe(200);
    expect((await request(app).get("/api/companies")).status).toBe(503);
    expect((await request(app).post("/api/health/dev-server/restart")).status).toBe(503);
    expect(auth).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    standby = false;
    expect((await request(app).get("/api/companies")).status).toBe(200);
    const claimed = await request(app).get("/api/health");
    expect(claimed.status).toBe(200);
    expect(claimed.body.warmStandby).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    execute.mockRejectedValueOnce(new Error("offline"));
    expect((await request(app).get("/api/health")).status).toBe(503);
  });

  it("email and plugin timers leave SQL idle, then resume without restarting", async () => {
    vi.useFakeTimers();
    let enabled = false;
    const select = vi.fn(() => { throw new Error("SQL probe"); });
    const db = { select } as unknown as Db;
    const email = emailChannelService(db, { heartbeat: { wakeup: vi.fn() }, isBackgroundWorkEnabled: () => enabled });
    const scheduler = createPluginJobScheduler({
      db,
      jobStore: {} as never,
      workerManager: {} as never,
      tickIntervalMs: 1000,
      isBackgroundWorkEnabled: () => enabled,
    });
    try {
      email.start();
      scheduler.start();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(select).not.toHaveBeenCalled();
      enabled = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect(select.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      scheduler.stop();
      await email.shutdown();
    }
  });
});

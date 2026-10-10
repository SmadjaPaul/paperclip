import { describe, it, expect, vi } from "vitest";
import {
  createSandboxCr,
  deleteSandboxCr,
  getSandboxCrStatus,
  findPodForSandbox,
  SandboxCrTimeoutError,
  waitForSandboxReady,
} from "../../src/sandbox-cr-orchestrator.js";

const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1beta1";
const SANDBOX_PLURAL = "sandboxes";

// Helpers to build mock v1beta1 CR objects with generation-fenced conditions.
function makeCr(phase: string, podName?: string): Record<string, unknown> {
  const ready = phase === "Ready";
  return {
    metadata: { uid: "sandbox-uid-123", generation: 1 },
    status: {
      conditions: [{
        type: "Ready",
        status: ready ? "True" : "False",
        reason: ready ? "Ready" : "DependenciesNotReady",
        observedGeneration: 1,
      }],
      ...(podName ? { podName } : {}),
    },
  };
}

describe("createSandboxCr", () => {
  it("calls custom.createNamespacedCustomObject with the correct params", async () => {
    const create = vi.fn().mockResolvedValue({ metadata: { uid: "test-uid" } });
    const clients = { custom: { createNamespacedCustomObject: create } };
    const manifest = {
      apiVersion: "agents.x-k8s.io/v1beta1",
      kind: "Sandbox",
      metadata: { name: "pc-abc", namespace: "paperclip-acme" },
    };
    const result = await createSandboxCr(clients as never, "paperclip-acme", manifest);
    expect(create).toHaveBeenCalledWith({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: "paperclip-acme",
      plural: SANDBOX_PLURAL,
      body: manifest,
    });
    expect(result.uid).toBe("test-uid");
  });

  it("throws if the API response has no UID", async () => {
    const create = vi.fn().mockResolvedValue({ metadata: {} });
    const clients = { custom: { createNamespacedCustomObject: create } };
    await expect(
      createSandboxCr(clients as never, "ns", {}),
    ).rejects.toThrow("Sandbox CR created without a UID");
  });
});

describe("getSandboxCrStatus", () => {
  it("maps an Agent Sandbox v1beta1 Ready condition", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "sandbox-uid-123", generation: 1 },
      status: {
        conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
      },
    });
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status).toMatchObject({
      phase: "Running",
      complete: false,
      active: 1,
      failed: 0,
    });
  });

  it("fails closed when Finished is present even alongside Ready", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "u1", generation: 1 },
      status: { conditions: [
        { type: "Ready", status: "True", observedGeneration: 1 },
        { type: "Finished", status: "True", reason: "PodFailed", observedGeneration: 1 },
      ] },
    });
    const status = await getSandboxCrStatus({ custom: { getNamespacedCustomObject: get } } as never, "ns", "pc-abc");
    expect(status).toMatchObject({ phase: "Failed", complete: false, failed: 1 });
    expect(status.succeeded).toBe(0);
  });

  it("does not interpret PodSucceeded as coding-agent success", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "u1", generation: 1 },
      status: { conditions: [{ type: "Finished", status: "True", reason: "PodSucceeded", observedGeneration: 1 }] },
    });
    const status = await getSandboxCrStatus({ custom: { getNamespacedCustomObject: get } } as never, "ns", "pc-abc");
    expect(status).toMatchObject({ phase: "Failed", complete: false, failed: 1, succeeded: 0 });
  });

  it("treats terminal Ready=False reasons as failure", async () => {
    for (const reason of [
      "InvalidConfiguration",
      "MultiplePods",
      "SandboxExpired",
      "SandboxSuspended",
      "PodSucceeded",
      "PodFailed",
    ]) {
      const get = vi.fn().mockResolvedValue({
        metadata: { uid: "u1", generation: 1 },
        status: { conditions: [{ type: "Ready", status: "False", reason, observedGeneration: 1 }] },
      });
      const status = await getSandboxCrStatus({ custom: { getNamespacedCustomObject: get } } as never, "ns", "pc-abc");
      expect(status.phase).toBe("Failed");
      expect(status.failed).toBe(1);
    }
  });

  it("keeps DependenciesNotReady and ReconcilerError transient", async () => {
    for (const reason of ["DependenciesNotReady", "ReconcilerError"]) {
      const get = vi.fn().mockResolvedValue({
        metadata: { uid: "u1", generation: 2 },
        status: { conditions: [{ type: "Ready", status: "False", reason, observedGeneration: 2 }] },
      });
      const status = await getSandboxCrStatus({ custom: { getNamespacedCustomObject: get } } as never, "ns", "pc-abc");
      expect(status.phase).toBe("Pending");
    }
  });

  it("does not authorize Ready without observedGeneration", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "u1", generation: 2 },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    });
    const status = await getSandboxCrStatus({ custom: { getNamespacedCustomObject: get } } as never, "ns", "pc-abc");
    expect(status.phase).toBe("Pending");
  });

  it("ignores stale conditions and does not use status.phase as a readiness fallback", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "u1", generation: 2 },
      status: { phase: "Ready", conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }] },
    });
    const status = await getSandboxCrStatus({ custom: { getNamespacedCustomObject: get } } as never, "ns", "pc-abc");
    expect(status.phase).toBe("Pending");
  });

  it("keeps ReconcilerError pending", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "u1" },
      status: { conditions: [{ type: "ReconcilerError", status: "True" }] },
    });
    const status = await getSandboxCrStatus({ custom: { getNamespacedCustomObject: get } } as never, "ns", "pc-abc");
    expect(status.phase).toBe("Pending");
  });

  it("maps a fenced Ready condition to SandboxStatus.phase=Running with active=1", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Ready"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status.phase).toBe("Running");
    expect(status.active).toBe(1);
    expect(status.complete).toBe(false);
  });

  it("maps a fenced Pending condition to SandboxStatus.phase=Pending", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status.phase).toBe("Pending");
    expect(status.active).toBe(0);
  });

  it("maps a terminal Ready=False condition to SandboxStatus.phase=Failed with failed=1", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "uid-1", generation: 1 },
      status: {
        conditions: [{ type: "Ready", status: "False", reason: "PodFailed", message: "no image", observedGeneration: 1 }],
      },
    });
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status.phase).toBe("Failed");
    expect(status.failed).toBe(1);
    expect(status.reason).toBe("PodFailed");
  });

  it("does not infer Terminating from the removed legacy phase field", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "uid-1", generation: 1 },
      status: { phase: "Terminating", conditions: [] },
    });
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status.phase).toBe("Pending");
    expect(status.reason).toBeUndefined();
  });
});

describe("findPodForSandbox", () => {
  it("returns status.podName from the Sandbox CR when set", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Ready", "pc-abc-pod-xyz"));
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { readNamespacedPod: vi.fn(), listNamespacedPod: vi.fn() },
    };
    const podName = await findPodForSandbox(clients as never, "ns", "pc-abc");
    expect(podName).toBe("pc-abc-pod-xyz");
    // Primary path succeeded: neither the exact-name GET nor the label list runs.
    expect(clients.core.readNamespacedPod).not.toHaveBeenCalled();
    expect(clients.core.listNamespacedPod).not.toHaveBeenCalled();
  });

  it("resolves the pod by EXACT NAME when the controller names it after the sandbox (v0.4.x: pods carry only agents.x-k8s.io/sandbox-name-hash, never the full-name label)", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Ready")); // no podName in status
    const read = vi.fn().mockResolvedValue({
      metadata: { name: "pc-abc", labels: { "agents.x-k8s.io/sandbox-name-hash": "1a2b3c" } },
      status: { phase: "Running" },
    });
    const list = vi.fn().mockResolvedValue({ items: [] }); // full-name label selector matches nothing on v0.4.x
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { readNamespacedPod: read, listNamespacedPod: list },
    };
    const podName = await findPodForSandbox(clients as never, "ns", "pc-abc");
    expect(read).toHaveBeenCalledWith({ namespace: "ns", name: "pc-abc" });
    expect(podName).toBe("pc-abc");
    expect(list).not.toHaveBeenCalled();
  });

  it("falls back to pod listing scoped by the unique sandbox-name label", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending")); // no podName
    const read = vi.fn().mockRejectedValue({ code: 404 }); // no exact-name pod
    const list = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: { name: "pc-abc-001", labels: { "agents.x-k8s.io/sandbox-name": "pc-abc" } },
          status: { phase: "Running" },
        },
      ],
    });
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { readNamespacedPod: read, listNamespacedPod: list },
    };
    const podName = await findPodForSandbox(clients as never, "ns", "pc-abc");
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ labelSelector: "agents.x-k8s.io/sandbox-name=pc-abc" }),
    );
    expect(podName).toBe("pc-abc-001");
  });

  it("never matches another sandbox's pod by name prefix", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending"));
    const list = vi.fn().mockResolvedValue({
      items: [
        {
          // Same name prefix, different sandbox label: must NOT match.
          metadata: { name: "pc-abc-zzz", labels: { "agents.x-k8s.io/sandbox-name": "pc-abc-zzz" } },
          status: { phase: "Running" },
        },
      ],
    });
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { readNamespacedPod: vi.fn().mockRejectedValue({ code: 404 }), listNamespacedPod: list },
    };
    const podName = await findPodForSandbox(clients as never, "ns", "pc-abc");
    expect(podName).toBeNull();
  });

  it("propagates non-404 errors from the exact-name pod GET instead of falling through", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending"));
    const read = vi.fn().mockRejectedValue({ code: 403, message: "forbidden" });
    const list = vi.fn();
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { readNamespacedPod: read, listNamespacedPod: list },
    };
    await expect(findPodForSandbox(clients as never, "ns", "pc-abc")).rejects.toMatchObject({
      code: 403,
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("returns null when no pod is found in fallback", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending"));
    const list = vi.fn().mockResolvedValue({ items: [] });
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { readNamespacedPod: vi.fn().mockRejectedValue({ code: 404 }), listNamespacedPod: list },
    };
    const podName = await findPodForSandbox(clients as never, "ns", "pc-abc");
    expect(podName).toBeNull();
  });
});

describe("deleteSandboxCr", () => {
  it("calls custom.deleteNamespacedCustomObject with Foreground propagation", async () => {
    const del = vi.fn().mockResolvedValue({});
    const clients = { custom: { deleteNamespacedCustomObject: del } };
    await deleteSandboxCr(clients as never, "ns", "pc-abc");
    expect(del).toHaveBeenCalledWith(
      expect.objectContaining({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: "ns",
        plural: SANDBOX_PLURAL,
        name: "pc-abc",
        propagationPolicy: "Foreground",
      }),
    );
  });
});

describe("waitForSandboxReady", () => {
  it("resolves immediately when Sandbox is already Ready", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Ready"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await waitForSandboxReady(
      clients as never,
      "ns",
      "pc-abc",
      { timeoutMs: 5000, pollMs: 10 },
    );
    expect(status.phase).toBe("Running"); // Ready maps to Running
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("polls until Ready", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(makeCr("Pending"))
      .mockResolvedValueOnce(makeCr("Pending"))
      .mockResolvedValueOnce(makeCr("Ready"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await waitForSandboxReady(
      clients as never,
      "ns",
      "pc-abc",
      { timeoutMs: 5000, pollMs: 10 },
    );
    expect(status.phase).toBe("Running");
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("fails before returning when Ready and Finished are both current", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "u1", generation: 2 },
      status: {
        conditions: [
          { type: "Ready", status: "True", observedGeneration: 2 },
          { type: "Finished", status: "True", reason: "PodSucceeded", observedGeneration: 2 },
        ],
      },
    });
    await expect(
      waitForSandboxReady({ custom: { getNamespacedCustomObject: get } } as never, "ns", "pc-abc", {
        timeoutMs: 5000,
        pollMs: 10,
      }),
    ).rejects.toThrow(/failed.*PodSucceeded/i);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([
    "InvalidConfiguration",
    "MultiplePods",
    "SandboxExpired",
    "SandboxSuspended",
    "PodSucceeded",
    "PodFailed",
  ])(
    "fails before returning when Ready=False has terminal reason %s",
    async (terminalType) => {
      const get = vi.fn().mockResolvedValue({
        metadata: { uid: "u1", generation: 4 },
        status: {
          conditions: [{ type: "Ready", status: "False", reason: terminalType, observedGeneration: 4 }],
        },
      });
      await expect(
        waitForSandboxReady({ custom: { getNamespacedCustomObject: get } } as never, "ns", "pc-abc", {
          timeoutMs: 5000,
          pollMs: 10,
        }),
      ).rejects.toThrow(/failed/i);
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores an obsolete terminal condition and waits for the current Ready condition", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "u1", generation: 2 },
      status: {
        conditions: [
          { type: "Finished", status: "True", reason: "PodFailed", observedGeneration: 1 },
          { type: "Ready", status: "True", observedGeneration: 2 },
        ],
      },
    });
    const status = await waitForSandboxReady(
      { custom: { getNamespacedCustomObject: get } } as never,
      "ns",
      "pc-abc",
      { timeoutMs: 5000, pollMs: 10 },
    );
    expect(status).toMatchObject({ phase: "Running", active: 1, failed: 0 });
  });

  it("throws SandboxCrTimeoutError when deadline is exceeded", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    await expect(
      waitForSandboxReady(clients as never, "ns", "pc-abc", {
        timeoutMs: 50,
        pollMs: 10,
      }),
    ).rejects.toBeInstanceOf(SandboxCrTimeoutError);
  });

  it("throws an error describing the failure when Sandbox fails", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "u1", generation: 1 },
      status: { conditions: [{ type: "Ready", status: "False", reason: "PodFailed", message: "OOMKilled", observedGeneration: 1 }] },
    });
    const clients = { custom: { getNamespacedCustomObject: get } };
    await expect(
      waitForSandboxReady(clients as never, "ns", "pc-abc", {
        timeoutMs: 5000,
        pollMs: 10,
      }),
    ).rejects.toThrow(/failed.*PodFailed/i);
  });

  it("fails fast when the Sandbox is being deleted", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "u1", deletionTimestamp: "2026-10-10T00:00:00Z" },
      status: { conditions: [] },
    });
    await expect(
      waitForSandboxReady({ custom: { getNamespacedCustomObject: get } } as never, "ns", "pc-abc", {
        timeoutMs: 5000,
        pollMs: 10,
      }),
    ).rejects.toThrow(/being deleted/i);
  });
});

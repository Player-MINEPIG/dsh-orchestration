import {
  ExecutionCatalogCompletion,
  type ExecutionCatalogDelivery,
  type ExecutionCatalogResult,
} from "../execution-models.js";
import { ExecutionModelInventory } from "../executor-models.js";
import type { RecoveryStore } from "./store.js";
import { RemoteClient, RemoteLedgerClient } from "./client.js";
import { ProtocolError } from "./protocol.js";

/** Catalog discovery stays outside the shared, ordered transport send queue. */
export class ExecutorModelControl {
  private active = true;
  private paused = false;
  private identified = false;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private abort?: AbortController;
  private response?: ExecutionCatalogDelivery;
  constructor(
    private readonly options: {
      nodeId: string;
      client: RemoteClient;
      remote: RemoteLedgerClient;
      inventory: ExecutionModelInventory;
      store?: RecoveryStore;
      ownsClient?: boolean;
    },
  ) {
    this.response = options.store?.catalogDelivery(options.nodeId);
  }
  start(): void {
    this.timer = setInterval(() => {
      void this.pollNow();
    }, 1000);
    this.timer.unref();
    void this.pollNow();
  }
  pollNow(): Promise<void> {
    if (!this.active || this.paused) return Promise.resolve();
    if (this.pending) return this.pending;
    const controller = (this.abort = new AbortController());
    const pending = this.poll(controller.signal)
      .catch((error: unknown) => {
        if (controller.signal.aborted || !this.response) return;
        this.response.error = {
          kind:
            error instanceof ProtocolError &&
            error.status >= 400 &&
            error.status < 500 &&
            ![408, 429].includes(error.status)
              ? "rejected"
              : "uncertain",
          code:
            error instanceof ProtocolError
              ? error.code
              : "CATALOG_TRANSPORT_UNCERTAIN",
          at: Date.now(),
        };
        this.options.store?.saveCatalogDelivery(
          this.options.nodeId,
          this.response,
        );
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
        if (this.abort === controller) this.abort = undefined;
      });
    this.pending = pending;
    return pending;
  }
  private async poll(signal: AbortSignal): Promise<void> {
    const bounded = () => AbortSignal.any([signal, AbortSignal.timeout(1500)]);
    if (!this.identified) {
      await this.options.client.executorIdentity({
        diagnostic: true,
        signal: bounded(),
      });
      this.identified = true;
    }
    const requests = await this.options.remote.executionModelRequests(
      this.options.nodeId,
      { signal: bounded() },
    );
    if (
      this.response &&
      !requests.some(
        (request) =>
          `${request.requestId}:${request.generation}` === this.response!.key,
      )
    ) {
      this.response = undefined;
      this.options.store?.saveCatalogDelivery(this.options.nodeId, undefined);
    }
    for (const request of requests) {
      if (signal.aborted || !this.active || this.paused) return;
      const key = `${request.requestId}:${request.generation}`;
      if (
        this.response?.key === key &&
        this.response.error?.kind === "rejected"
      )
        continue;
      if (this.response?.key !== key) {
        const result = await this.options.inventory.collect(signal);
        if (signal.aborted || !this.active || this.paused) return;
        const pages: ExecutionCatalogResult[] =
          result.state === "failure"
            ? [result]
            : Array.from(
                { length: Math.max(1, Math.ceil(result.models.length / 32)) },
                (_, index) => ({
                  ...result,
                  models: result.models.slice(index * 32, (index + 1) * 32),
                }),
              );
        this.response = {
          key,
          expiresAt: request.expiresAt,
          next: 0,
          pages: pages.map((page, index) => ({
            nodeId: this.options.nodeId,
            requestId: request.requestId,
            generation: request.generation,
            result: page,
            ...(result.state === "success" && pages.length > 1
              ? { page: { index, total: pages.length } }
              : {}),
          })),
        };
      }
      this.options.store?.saveCatalogDelivery(
        this.options.nodeId,
        this.response,
      );
      const response = this.response;
      while (response.next < response.pages.length) {
        if (signal.aborted || !this.active || this.paused) return;
        const receipt = await this.options.remote.completeExecutionModels(
          `catalog:${request.requestId}:${response.next}`,
          response.pages[response.next]!,
          { signal: bounded() },
        );
        const completion = ExecutionCatalogCompletion.parse(receipt.value);
        if (!completion.accepted) {
          response.error = {
            kind: "rejected",
            code: completion.catalogError.code,
            at: Date.now(),
          };
          this.options.store?.saveCatalogDelivery(
            this.options.nodeId,
            response,
          );
          return;
        }
        response.next++;
        delete response.error;
        this.options.store?.saveCatalogDelivery(this.options.nodeId, response);
      }
    }
  }
  async beginConfigurationEdit(): Promise<() => void> {
    this.paused = true;
    this.abort?.abort(new Error("Executor catalog configuration is changing"));
    await this.pending;
    return () => {
      this.paused = false;
      if (this.active) void this.pollNow();
    };
  }
  async dispose(): Promise<void> {
    this.active = false;
    clearInterval(this.timer);
    this.abort?.abort(new Error("Executor catalog control is draining"));
    await this.pending;
    if (this.options.ownsClient !== false) await this.options.client.dispose();
  }
}

/** Observe only selected app-server fields. Never retain auth, prompts or protocol bodies. */
export function observeOfficialWire(subprocess, proof) {
  const spawn = subprocess.spawn.bind(subprocess);
  subprocess.spawn = (spec) => {
    const handle = spawn(spec),
      methods = new Map();
    let incoming = "";
    const write = handle.stdin?.write.bind(handle.stdin);
    if (write)
      handle.stdin.write = (chunk, ...args) => {
        const raw = String(chunk);
        for (const line of raw.split("\n")) {
          try {
            const message = JSON.parse(line);
            methods.set(message.id, message.method);
            if (message.method === "thread/start")
              proof.push({
                kind: "request",
                method: message.method,
                model: message.params?.model,
                ephemeral: message.params?.ephemeral,
                approvalPolicy: message.params?.approvalPolicy,
              });
          } catch {}
        }
        return write(chunk, ...args);
      };
    handle.stdout?.on("data", (chunk) => {
      incoming += chunk;
      for (;;) {
        const index = incoming.indexOf("\n");
        if (index < 0) break;
        const line = incoming.slice(0, index);
        incoming = incoming.slice(index + 1);
        try {
          const message = JSON.parse(line),
            method = methods.get(message.id);
          if (method === "thread/start" && message.result)
            proof.push({
              kind: "response",
              method,
              productThreadId: message.result.thread?.id,
              ephemeral: message.result.thread?.ephemeral,
              model: message.result.model,
              reasoningEffort: message.result.reasoningEffort,
            });
          if (message.method === "turn/completed")
            proof.push({
              kind: "event",
              method: message.method,
              productThreadId: message.params?.threadId,
              status: message.params?.turn?.status,
              errorCode: message.params?.turn?.error?.codexErrorInfo,
            });
        } catch {}
      }
    });
    return handle;
  };
  return () => {
    subprocess.spawn = spawn;
  };
}
